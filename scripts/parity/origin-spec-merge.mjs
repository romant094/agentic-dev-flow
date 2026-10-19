#!/usr/bin/env node
// Dev tool: replays every archived change's spec merge of the origin with the port's merge and
// compares the result with the main specs the origin committed. Nothing is written in the
// origin: every git command run on it is read-only (`ls-tree`, `log`, `show`, `merge-base`).
//
//   node scripts/parity/origin-spec-merge.mjs <origin project root> [--all]
//
// --all also prints every capability's comparison and every three-way finding.
//
// The replay, on the integration branch `origin/develop`:
//   1. every archive directory `openspec/changes/archive/<dir>` with delta specs is found in the
//      first-parent history: the commit that added its `proposal.md` (its directory when it has
//      none); the changes one commit added form a group, applied in the order their files were
//      first added (the archive date), then by name;
//   2. each delta is applied with the port's `buildUpdatedSpec` (plugins/adf/scripts/lib/specs.mjs)
//      to the main spec at the commit's first parent, or to the result of the group's earlier
//      change; a refusal leaves the capability as it was;
//   3. every capability the group touched is compared with the main spec the commit holds, by
//      requirement block: the blocks under `## Requirements`, keyed by header, with whitespace
//      runs and `---` separator lines normalised. The Purpose and the other prose are not
//      compared: the port writes a new capability's Purpose separately.
//
// The three-way check (the port's `findConflicts`, both sides as the port's archive runs them),
// where the branch base is reachable. The port now snapshots each touched requirement's base
// text at propose (`specs-base.json`, `specs.mjs base`), because a rebase moves the merge base;
// the origin has no snapshot, so this replay runs the port's fallback, the merge base: for a merge commit, base = merge-base(commit^1, commit^2);
// each delta's MODIFIED, REMOVED and RENAMED requirements whose text at the base differs from
// the text on commit^1 (side `base-branch`) or in the replay before this change (side
// `worktree`: the group's earlier changes already merged) are flagged.
// A merge whose branch was rebased onto commit^1 has commit^1 as its base: the base the change
// was proposed on is not reachable, and only the `worktree` side can flag anything (counted as
// `commitsRebased`; `commitsWithoutBase` counts commits that are not merges). The tool reports
// which differing files the check flags; the check never fails the tool. The stale-sibling
// differences are not flagged: each delta was written before an earlier-archived change
// edited the same requirement, and the branch was rebased, so no reachable base holds the text
// the delta was written against.
//
// Deliberate differences (named below by commit and capability; anything else fails the tool,
// and so does an expected one that is absent):
//   stale-sibling  a MODIFIED block written before an earlier-archived change edited the same
//                  requirement: the origin's hand merge kept that edit, the mechanical merge
//                  replaces the whole block
//   hand-edit      the origin edited the main spec by hand in the archive commit, before the flow
//                  merged deltas mechanically
//   order          the block of a delta refused for order (below): the origin holds that delta's
//                  block, which the replay could not apply
//   unsynced       the origin archived the change without merging its deltas (the commit leaves
//                  `openspec/specs/` untouched): the deltas contradicted the main spec
// Expected refusals (anything else fails the tool):
//   order          a delta MODIFIES a capability no main spec holds yet at its place in the group
//                  (the archive dates tie; the origin merged it after the sibling that adds the
//                  capability)
//   unsynced       a delta of a change archived without its merge names a requirement the main
//                  spec does not hold
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildUpdatedSpec, findConflicts, parseDeltaSpec } from '../../plugins/adf/scripts/lib/specs.mjs'

const REF = 'origin/develop'
const EXPECTED_DIFFERENCES = [
  { commit: 'f2c2b3dd', capability: 'device-module-routing', explained: 'hand-edit' },
  { commit: '2406ec38', capability: 'change-workflow-schema', explained: 'stale-sibling' },
  { commit: 'ac9deac9', capability: 'device-form-schemas', explained: 'stale-sibling' },
  { commit: 'ac9deac9', capability: 'device-form-rendering', explained: 'stale-sibling' },
  { commit: '7f9d17a8', capability: 'discovered-device-inventory', explained: 'order' },
  { commit: '05e6e054', capability: 'config-snapshots', explained: 'unsynced' }
]
const EXPECTED_REFUSALS = [
  { commit: '7f9d17a8', change: '2026-09-04-live-network-scan-provenance', capability: 'discovered-device-inventory', explained: 'order' },
  { commit: '05e6e054', change: '2026-10-15-columnize-backups-table', capability: 'config-snapshots', explained: 'unsynced' }
]

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, '.git'))) {
  console.error('usage: origin-spec-merge.mjs <origin project root, a git checkout>')
  process.exit(2)
}
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const gitOrNull = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const lines = (text) => (text ?? '').split('\n').filter(Boolean)
const short = (sha) => sha.slice(0, 8)

const norm = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '---')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
// The requirement blocks of a main spec: header -> normalised block.
function blocks(text) {
  const map = new Map()
  if (text === null) return map
  const t = text.replace(/\r\n/g, '\n')
  const at = t.search(/^## Requirements/m)
  if (at < 0) return map
  for (const block of t.slice(at).split(/^(?=### Requirement:)/m).slice(1)) {
    const header = block.split('\n')[0].replace(/^###\s*Requirement:\s*/, '').trim()
    map.set(header, norm(block.split(/^## /m)[0]))
  }
  return map
}
const specAt = (rev, capability) => gitOrNull('show', `${rev}:openspec/specs/${capability}/spec.md`)

// 1. The archived changes with delta specs, grouped by the first-parent commit that added them.
const archive = 'openspec/changes/archive'
const groups = new Map()
for (const dir of lines(git('ls-tree', '--name-only', `${REF}:${archive}`))) {
  const capabilities = lines(gitOrNull('ls-tree', '--name-only', `${REF}:${archive}/${dir}/specs`))
  if (capabilities.length === 0) continue
  const path = gitOrNull('cat-file', '-e', `${REF}:${archive}/${dir}/proposal.md`) === null ? `${archive}/${dir}` : `${archive}/${dir}/proposal.md`
  const commit = lines(git('log', REF, '--first-parent', '-m', '--diff-filter=A', '--format=%H', '--', path)).pop()
  const time = Number(lines(git('log', REF, '--diff-filter=A', '--format=%ct', '--', path)).pop())
  if (!groups.has(commit)) groups.set(commit, [])
  groups.get(commit).push({ dir, capabilities, time })
}

// 2 and 3. Replay each group, compare, and run the three-way check.
const totals = { commits: 0, changes: 0, files: 0, equal: 0, identicalFiles: 0, differ: 0, refused: 0 }
const differences = []
const refusals = []
const files = []
const threeWay = { commitsWithBase: 0, commitsRebased: 0, commitsWithoutBase: 0, capabilitiesChecked: 0, flagged: [] }
for (const [commit, changes] of groups) {
  totals.commits++
  changes.sort((a, b) => a.time - b.time || a.dir.localeCompare(b.dir))
  const parents = lines(git('rev-list', '--parents', '-n', '1', commit))[0].split(' ').slice(1)
  const base = parents.length > 1 ? gitOrNull('merge-base', parents[0], parents[1])?.trim() || null : null
  if (!base) threeWay.commitsWithoutBase++
  else if (base === parents[0]) threeWay.commitsRebased++
  else threeWay.commitsWithBase++
  const state = new Map()
  for (const { dir, capabilities } of changes) {
    totals.changes++
    for (const capability of capabilities) {
      if (!state.has(capability)) state.set(capability, specAt(`${commit}^1`, capability))
      const deltaText = git('show', `${commit}:${archive}/${dir}/specs/${capability}/spec.md`)
      const plan = parseDeltaSpec(deltaText)
      if (base && state.get(capability) !== null && plan.modified.length + plan.removed.length + plan.renamed.length > 0) {
        threeWay.capabilitiesChecked++
        const baseText = specAt(base, capability)
        const found = findConflicts(plan, deltaText, { baseText, nowText: specAt(`${commit}^1`, capability), side: 'base-branch' })
        const named = new Set(found.map((c) => c.requirement))
        found.push(...findConflicts(plan, deltaText, { baseText, nowText: state.get(capability), side: 'worktree' }).filter((c) => !named.has(c.requirement)))
        if (found.length > 0) threeWay.flagged.push({ commit: short(commit), change: dir, capability, requirements: found.map((c) => `${c.side} ${c.operation} ${c.requirement}`) })
      }
      try {
        state.set(capability, buildUpdatedSpec({ capability, plan, mainText: state.get(capability) }).rebuilt)
      } catch (error) {
        totals.refused++
        refusals.push({ commit: short(commit), change: dir, capability, error: error.message.split('\n')[0] })
      }
    }
  }
  for (const [capability, mine] of state) {
    totals.files++
    const theirs = specAt(commit, capability)
    if (mine !== null && theirs !== null && norm(mine) === norm(theirs)) totals.identicalFiles++
    const a = blocks(mine)
    const b = blocks(theirs)
    const diffs = []
    for (const [k, v] of a) {
      if (!b.has(k)) diffs.push(`+port ${k}`)
      else if (b.get(k) !== v) diffs.push(`~ ${k}`)
    }
    for (const k of b.keys()) if (!a.has(k)) diffs.push(`+origin ${k}`)
    files.push({ commit: short(commit), capability, equal: diffs.length === 0 })
    if (diffs.length === 0) {
      totals.equal++
      continue
    }
    totals.differ++
    const expected = EXPECTED_DIFFERENCES.find((e) => e.commit === short(commit) && e.capability === capability)
    differences.push({ commit: short(commit), changes: changes.map((c) => c.dir), capability, requirements: diffs, explained: expected?.explained ?? null })
  }
}

for (const r of refusals) r.explained = EXPECTED_REFUSALS.find((e) => e.commit === r.commit && e.change === r.change && e.capability === r.capability)?.explained ?? null
const absent = [
  ...EXPECTED_DIFFERENCES.filter((e) => !differences.some((d) => d.commit === e.commit && d.capability === e.capability)).map((e) => ({ difference: e })),
  ...EXPECTED_REFUSALS.filter((e) => !refusals.some((r) => r.commit === e.commit && r.change === e.change && r.capability === e.capability)).map((e) => ({ refusal: e }))
]
const unexplained = [...differences.filter((d) => d.explained === null), ...refusals.filter((r) => r.explained === null)]
const flaggedKey = new Set(threeWay.flagged.map((f) => `${f.commit} ${f.capability}`))
console.log(
  JSON.stringify(
    {
      ref: REF,
      ...totals,
      differences: differences.map(({ commit, capability, explained, requirements }) => ({ commit, capability, explained, requirements })),
      refusals,
      threeWay: {
        commitsWithBase: threeWay.commitsWithBase,
        commitsRebased: threeWay.commitsRebased,
        commitsWithoutBase: threeWay.commitsWithoutBase,
        capabilitiesChecked: threeWay.capabilitiesChecked,
        flagged: threeWay.flagged.length,
        differingFlagged: differences.filter((d) => flaggedKey.has(`${d.commit} ${d.capability}`)).map((d) => `${d.commit} ${d.capability}`),
        differingNotFlagged: differences.filter((d) => !flaggedKey.has(`${d.commit} ${d.capability}`)).map((d) => `${d.commit} ${d.capability}`),
        equalFlagged: threeWay.flagged.filter((f) => files.some((x) => x.equal && `${x.commit} ${x.capability}` === `${f.commit} ${f.capability}`)).map((f) => `${f.commit} ${f.capability}`)
      },
      absent,
      unexplained,
      ...(listAll ? { files, flagged: threeWay.flagged, all: differences } : {})
    },
    null,
    2
  )
)
process.exitCode = unexplained.length === 0 && absent.length === 0 ? 0 : 1
