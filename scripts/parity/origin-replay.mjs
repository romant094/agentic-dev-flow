#!/usr/bin/env node
// Dev tool: the behaviour check of iteration 14 (step 7). It replays the origin's archived changes
// through the port (lib/sandbox.mjs, lib/replay-candidates.mjs, lib/replay-host.mjs,
// lib/replay-replies.mjs, lib/replay-drive.mjs) and compares each run with what the origin
// produced, as far as git holds it:
//
//   phases     every phase reached, the finished archive resumes to the same result
//   branch     the branch name and its base (the candidate's base, then the host setup commit)
//   worktree   the change worktree and every group worktree removed by archive (the origin's
//              worktree paths are not in git)
//   artifacts  the archive directory's files and each shared Markdown file's headings
//   gates      propose's gates on the origin's artifacts, verify's checks against the origin's
//              verify.md, the review verdict
//   groups     the Execution Graph as the port schedules it against the origin plan's table, and
//              the group branches merged
//   commits    the change branch's first-parent commits by phase (only when the origin's branch
//              survives: a squash keeps one commit)
//   ledger     every origin record against the port's, by kind and fields
//   review     verdict, rounds, counts and dispositions of review.md
//   specs      each capability the change touches, the main spec after the merge
//   tree       the final openspec/ and .claude/memory/ paths, and the content of each file the
//              origin's merge changed there
//   mr         the fake glab's merge request and its call log against the merge commit (target,
//              source, squash, final state, title); a Draft or a description is not in git
//
// Each difference is classified by the rules of lib/replay-rules.json: `explained` (it cites a
// lessons row, resolved to docs/lessons/<file>:<line>), `older-origin`, `injected` (a
// synthesized reply, an injected step, the D3 base) or `defect`. A strong difference (D7) no rule
// matches is a `defect`; a weak one is recorded only. The tool exits 1 when any difference is a
// `defect`, or when the origin changed during the run.
//
//   node scripts/parity/origin-replay.mjs <origin> [--fresh a,b] [--mid c] [--author <name>]
//        [--since <rev>] [--sandbox <kept sandbox>] [--out <dir>] [--keep]
//
// The candidates are named at run time only, never in this repository: --fresh / --mid, or
// ADF_REPLAY_FRESH / ADF_REPLAY_MID (comma-separated change names); the author is --author or
// ADF_AUTHOR. Without an author or a candidate the tool reports itself skipped and exits 0, so
// `npm run parity -- <origin>` runs it without them. --sandbox (ADF_REPLAY_SANDBOX) compares the
// run records of a kept sandbox instead of driving again; --out (ADF_REPLAY_OUT) writes
// compare.json and compare.md there; --keep (ADF_REPLAY_KEEP=1) keeps the new sandbox.
//
// The origin is only read (git --no-optional-locks); its refs, status and stash are compared
// before and after the run.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from '../lib/main.mjs'
import { cells } from '../check-lessons.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO = join(here, '..', '..')
export const RULES_FILE = join(here, 'lib', 'replay-rules.json')
export const loadRules = (file = RULES_FILE) => JSON.parse(readFileSync(file, 'utf8'))

// ---------------------------------------------------------------- git

function gitAt(dir) {
  const run = (...args) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trimEnd()
  run.orNull = (...args) => {
    try {
      return run(...args)
    } catch {
      return null
    }
  }
  run.lines = (...args) => (run.orNull(...args) ?? '').split('\n').filter(Boolean)
  return run
}

// The origin's refs as { ref: sha }.
const refsOf = (dir) => Object.fromEntries(gitAt(dir).lines('for-each-ref', '--format=%(refname) %(objectname)').map((l) => l.split(' ')))

// The refs that moved on the origin during a run, each `replay` when its new commit is one a
// sandbox repository holds (only the replay's own pushes could put it there: the sandbox is
// cloned from the origin before the run), else `foreign`: work in flight on the origin by
// someone else, reported and not failed. A deleted ref cannot be traced and counts as the
// replay's. `repos` are the sandbox repositories to look in.
export function movedRefs(before, after, repos) {
  const holds = (sha) => repos.some((dir) => gitAt(dir).orNull('cat-file', '-e', `${sha}^{commit}`) !== null)
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((ref) => before[ref] !== after[ref])
    .sort()
    .map((ref) => ({ ref, before: before[ref] ?? null, after: after[ref] ?? null, by: after[ref] && !holds(after[ref]) ? 'foreign' : 'replay' }))
}

// The added and removed lines of a unified diff, each through `rewrite` (the content rules) and
// sorted, blank lines left out: two edits of one file compare equal when they add and remove
// the same lines, wherever the hunks fall.
export function editLines(diff, rewrite = (t) => t) {
  return (diff ?? '')
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l) && l.slice(1).trim() !== '')
    .map((l) => `${l[0]}${rewrite(l.slice(1))}`)
    .sort()
}

// The origin's state a run must leave as it is: refs, status and stash, hashed.
export function originState(dir) {
  const git = gitAt(dir)
  const hash = (s) => createHash('sha256').update(s ?? '').digest('hex').slice(0, 16)
  return { refs: hash(git.orNull('for-each-ref')), status: hash(git.orNull('status', '--porcelain')), stash: hash(git.orNull('stash', 'list')), head: git.orNull('rev-parse', 'HEAD') }
}

// ---------------------------------------------------------------- lessons citations

// The lessons row holding `phrase` (whitespace collapsed) in `file`, read as check-lessons reads
// the tables: { file, line, decision } or null.
export function citeLessons({ file, phrase }, root = REPO) {
  const path = join(root, file)
  if (!/^docs\/lessons\/[^/]+\.md$/.test(file) || !existsSync(path)) return null
  const collapse = (t) => t.replace(/\s+/g, ' ')
  const lines = readFileSync(path, 'utf8').split('\n')
  const header = lines.findIndex((l) => l.startsWith('| Rule |'))
  if (header === -1) return null
  for (let i = header + 2; i < lines.length && lines[i].startsWith('| '); i++) {
    if (!collapse(lines[i]).includes(collapse(phrase))) continue
    const row = cells(lines[i])
    if (row.length !== 5) return null
    return { file, line: i + 1, decision: row[2].split(/\s[—–-]\s/)[0].trim() }
  }
  return null
}

// ---------------------------------------------------------------- classification

const test = (re, value) => value !== undefined && value !== null && new RegExp(re).test(String(value))

// Whether `rule.match` holds for the difference `d` of the run `record`.
function matches(match, d, record) {
  const hints = d.hints ?? []
  if (match.area && match.area !== d.area) return false
  if (match.key && !test(match.key, d.key)) return false
  if (match.what && !test(match.what, d.what)) return false
  if (match.evidence && !test(match.evidence, JSON.stringify(d.evidence ?? ''))) return false
  if (match.mode && match.mode !== record?.mode) return false
  if (match.flag && !(d.flags ?? []).includes(match.flag)) return false
  if (match.hint && !hints.includes(match.hint)) return false
  if (match.notHint && hints.includes(match.notHint)) return false
  if (match.stepNamed && !(record?.steps ?? []).some((s) => test(match.stepNamed, s.step) && s.classification?.some((c) => c.kind === 'injected'))) return false
  return true
}

export const isStrong = (key, rules) => rules.strong.some((re) => new RegExp(re).test(key))

// The difference with its class: { ...d, strong, class, rule, cite?, fix?, decision?, why }.
// `class` is null for a weak difference no rule matches (recorded only, D7).
export function classify(d, record, rules, root = REPO) {
  const strong = isStrong(d.key, rules)
  const rule = rules.rules.find((r) => matches(r.match ?? {}, d, record))
  if (!rule) return { ...d, strong, class: strong ? 'defect' : null, rule: null, why: strong ? 'a strong difference (D7) no rule explains' : 'recorded only (D7): no rule matches a weak difference' }
  if (!rules.classes.includes(rule.class)) return { ...d, strong, class: 'defect', rule: rule.id, why: `rule ${rule.id} names an unknown class ${rule.class}` }
  const out = { ...d, strong, class: rule.class, rule: rule.id, why: rule.why ?? '' }
  if (rule.fix) out.fix = rule.fix
  if (rule.decision) out.decision = rule.decision
  if (rule.class === 'explained') {
    const cite = rule.cite ? citeLessons(rule.cite, root) : null
    if (!cite) return { ...out, class: 'defect', why: `rule ${rule.id} cites no lessons row (${rule.cite ? `${rule.cite.file}: "${rule.cite.phrase}"` : 'no cite'})` }
    out.cite = cite
  }
  return out
}

// ---------------------------------------------------------------- parsers

export const headings = (text) => String(text ?? '').split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim())

const LEVELS = [['PASS WITH WARNINGS', 'warn'], ['PASS', 'pass'], ['WARN', 'warn'], ['FAIL', 'fail'], ['N/A', 'pass']]
const level = (word) => LEVELS.find(([w]) => w === word.toUpperCase())?.[1] ?? null

// The origin's verify record by check: { checks: { <id>: level }, verdict }. A check whose
// section states no result is left out.
export function originVerify(text, titles) {
  const lines = String(text ?? '').split('\n')
  const heads = []
  lines.forEach((l, i) => {
    const m = /^##\s+(\d+)\.\s+(.+?)\s*(?:\(.*\))?\s*$/.exec(l)
    if (m) heads.push({ title: m[2].replace(/`/g, '').trim().toLowerCase(), start: i })
  })
  const checks = {}
  heads.forEach((h, k) => {
    const id = titles[h.title]
    if (!id) return
    const body = lines.slice(h.start + 1, k + 1 < heads.length ? heads[k + 1].start : lines.length).join('\n')
    const m = /Result\**:?\**\s*`?(?:C\d+:\s*)?(PASS WITH WARNINGS|PASS|FAIL|WARN|N\/A)\b/i.exec(body) ?? /`C\d+:\s*(PASS WITH WARNINGS|PASS|FAIL|WARN)`/.exec(body)
    if (m) checks[id] = level(m[1])
    else if (/^- \[x\]/m.test(body) && !/^- \[ \]/m.test(body)) checks[id] = 'pass'
  })
  const verdict = /^Verdict:\s*(PASS WITH WARNINGS|PASS|FAIL)\s*$/m.exec(text)?.[1] ?? /^- \[x\]\s*\S*\s*(PASS WITH WARNINGS|PASS|FAIL)\b/m.exec(text)?.[1] ?? /The verdict is (PASS WITH WARNINGS|PASS|FAIL)/.exec(text)?.[1] ?? null
  return { checks, verdict }
}

// review.md's verdict, rounds, counts and dispositions (fixed, recorded, accepted, dismissed).
export function reviewRecord(text) {
  const t = String(text ?? '')
  const verdict = /^\*\*Verdict\*\*:\s*`?([A-Z ]+?)`?\s*$/m.exec(t)?.[1] ?? null
  const rounds = Number(/^\*\*Rounds\*\*:\s*`?(\d+)/m.exec(t)?.[1] ?? NaN)
  const c = /^\*\*Counts\*\*:\s*CRITICAL\s*`?(\d+)`?\s*\|\s*HIGH\s*`?(\d+)`?\s*\|\s*MEDIUM\s*`?(\d+)`?\s*\|\s*LOW\s*`?(\d+)/m.exec(t)
  const counts = c ? { CRITICAL: +c[1], HIGH: +c[2], MEDIUM: +c[3], LOW: +c[4] } : null
  const dispositions = { fixed: 0, recorded: 0, accepted: 0, dismissed: 0 }
  for (const l of t.split('\n')) {
    if (!/^\|\s*F?\d+\s*\|/.test(l)) continue
    const last = cells(l).at(-1).toLowerCase()
    for (const k of Object.keys(dispositions)) if (last.startsWith(k)) dispositions[k]++
  }
  return { verdict, rounds: Number.isNaN(rounds) ? null : rounds, counts, dispositions }
}

// The Execution Graph table: [{ letter, tasks, wave }], and the plan's task numbers.
export function planGraph(text) {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex((l) => /^##\s+Execution Graph\s*$/.test(l))
  const groups = []
  if (at !== -1) {
    let header = null
    for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      if (!lines[i].trim().startsWith('|')) {
        if (header && groups.length) break
        continue
      }
      const row = cells(lines[i])
      if (!header) {
        if (/group/i.test(row[0]) && /tasks/i.test(row[1] ?? '')) header = row.map((c) => c.toLowerCase())
        continue
      }
      if (/^:?-+/.test(row[0])) continue
      const letter = /\b([A-Z])\b/.exec(row[0].replace(/[`*]/g, ''))?.[1]
      if (!letter) continue
      const w = header.indexOf('wave')
      groups.push({ letter, tasks: (row[1].match(/\d+/g) ?? []).map(Number), wave: w === -1 ? 1 : Number(/\d+/.exec(row[w] ?? '')?.[0] ?? 1) })
    }
  }
  const tasks = [...String(text ?? '').matchAll(/^###\s+Task\s+(\d+)\b/gm)].map((m) => Number(m[1]))
  return { groups, tasks }
}

export const commitKind = (subject, rules) => rules.commitKinds.find((k) => new RegExp(k.subject).test(subject))?.kind ?? 'work'

// The first-parent subjects of a branch split by phase: each commit belongs to the first phase
// whose last end-marker commit is at or after it.
export function byPhase(subjects, rules) {
  const ends = []
  let floor = -1
  for (const p of rules.phases) {
    let end = subjects.length - 1
    if (p.end) {
      const idx = subjects.map((s, i) => (new RegExp(p.end).test(s) ? i : -1)).filter((i) => i > floor)
      end = idx.length ? idx.at(-1) : floor
    }
    ends.push({ phase: p.phase, end })
    floor = Math.max(floor, end)
  }
  const out = Object.fromEntries(rules.phases.map((p) => [p.phase, []]))
  subjects.forEach((s, i) => out[(ends.find((e) => e.end >= i) ?? ends.at(-1)).phase].push(s))
  return out
}

const LEDGER_SKIP = new Set(['id', 'at', 'sessionId'])
export const ledgerRecords = (text) => String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const canon = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !LEDGER_SKIP.has(k)).sort(([a], [b]) => a.localeCompare(b))))

// Origin and port ledger records matched by kind and fields (id, time and session left out):
// { lost: [origin records], invented: [port records] }.
// `renames` ([{ kind, field, origin, port }]) are values the port names otherwise: an origin
// record matches with the port's value, and the pair is listed in `renamed`.
export function compareLedgers(origin, port, renames = []) {
  const left = port.map((r) => ({ r, key: canon(r), used: false }))
  const lost = []
  const renamed = []
  for (const r of origin) {
    let hit = left.find((x) => !x.used && x.key === canon(r))
    const rename = hit ? null : renames.find((n) => n.kind === r.kind && r[n.field] === n.origin)
    if (rename) hit = left.find((x) => !x.used && x.key === canon({ ...r, [rename.field]: rename.port }))
    if (hit) {
      hit.used = true
      if (rename) renamed.push({ origin: r, port: hit.r, rename })
    } else lost.push(r)
  }
  return { lost, invented: left.filter((x) => !x.used).map((x) => x.r), renamed }
}

const multisetDiff = (a, b) => {
  const rest = [...b]
  const onlyA = []
  for (const x of a) {
    const i = rest.indexOf(x)
    if (i === -1) onlyA.push(x)
    else rest.splice(i, 1)
  }
  return { onlyA, onlyB: rest }
}

// ---------------------------------------------------------------- one run against the origin

// The steps of a record that the difference rests on, with their hints.
const stepsMatching = (record, pred) => record.steps.filter(pred)
const hintsOf = (steps) => [...new Set(steps.flatMap((s) => (s.classification ?? []).map((c) => c.kind)))]

// Compares one run record with the origin. `ctx`: { cache, main, record, candidate, forge,
// glabCalls, rules }; `cache` holds every origin object, `main` is the run's main checkout.
// Returns { differences, compared, notCompared, summary }.
export function compareRun({ cache, main, record, candidate, forge = [], glabCalls = [], rules }) {
  const O = gitAt(cache)
  const P = gitAt(main)
  const diffs = []
  const compared = []
  const notCompared = []
  const add = (area, key, what, extra = {}) => diffs.push({ area, key, what, ...extra })
  const name = candidate.name
  const m = candidate.merge
  const m1 = O.orNull('rev-parse', `${m}^1`)
  const base = candidate.base.commit
  const branch = record.candidate.branch ?? candidate.branch
  const originTip = candidate.history === 'branch' && candidate.branch ? O.orNull('rev-parse', '--verify', `refs/remotes/origin/${candidate.branch}^{commit}`) ?? O.orNull('rev-parse', '--verify', `refs/heads/${candidate.branch}^{commit}`) : null
  const portTip = P.orNull('rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
  const host = P.orNull('rev-parse', '--verify', 'refs/heads/develop^{commit}')
  const drift = new Set(m1 && base ? O.lines('diff', '--no-renames', '--name-only', base, m1) : [])
  const hostFiles = new Set(host ? P.lines('diff-tree', '--no-renames', '--no-commit-id', '-r', '--name-only', host) : [])
  const flagsOf = (path) => [drift.has(path) ? 'base-drift' : null, hostFiles.has(path) ? 'host-setup' : null].filter(Boolean)

  // phases
  compared.push('phases')
  for (const [phase, state] of Object.entries(record.phases ?? {})) {
    if (state.reached) continue
    const at = state.stopped?.step ? stepsMatching(record, (s) => s.n === state.stopped.step) : []
    add('phases', `phase-stopped:${phase}`, `the ${phase} phase stopped: ${String(state.stopped?.reason ?? 'not reached').split('\n')[0]}`, { evidence: { step: state.stopped?.step ?? null }, hints: hintsOf(at) })
  }
  if (record.resume && !record.resume.same) add('phases', 'archive-resume', `the resumed archive differs: ${JSON.stringify(record.resume)}`)

  // the driver's own differences, one per phase and finding
  for (const d of record.differences ?? []) {
    const ruling = /^the verdict needs rulings the origin's ledger does not hold: (.+)$/.exec(d.what)
    if (ruling) continue // compared check by check below
    const steps = stepsMatching(record, (s) => s.phase === d.phase && s.refusal && typeof d.evidence === 'string' && (s.refusal === d.evidence || d.evidence === `step ${s.n}`))
    add('driver', `driver:${d.phase}`, d.what, { evidence: { steps: steps.map((s) => s.n), detail: typeof d.evidence === 'string' ? d.evidence.slice(0, 600) : d.evidence }, hints: hintsOf(steps) })
  }

  // branch and base
  compared.push('branch', 'base')
  if (!portTip) add('branch', 'branch', `the port's branch ${branch} does not exist in the run`)
  else if (branch !== candidate.branch) add('branch', 'branch', `the port's branch is ${branch}, the origin's ${candidate.branch}`)
  const hostParent = host ? P.orNull('rev-parse', `${host}^`) : null
  if (hostParent !== base) add('branch', 'base', `the host setup commit's parent is ${hostParent?.slice(0, 12)}, the candidate's base ${base?.slice(0, 12)}`)
  else if (portTip && P.orNull('merge-base', '--is-ancestor', host, portTip) === null) add('branch', 'base', `the port's branch does not hold the host setup commit ${host.slice(0, 12)}`)
  if (!candidate.base.exact) notCompared.push({ what: 'the exact base', why: 'the origin branch is gone; the replay starts from the merge\'s first parent (D3), so a difference that comes only from that base is injected' })

  // worktree
  compared.push('worktree (port only)')
  const worktrees = P.lines('worktree', 'list', '--porcelain').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
  for (const w of worktrees.filter((w) => w !== realpathSync(main) && w !== main)) add('worktree', 'worktree-left', `a worktree is left after archive: ${relative(main, w)}`)
  notCompared.push({ what: 'the origin\'s worktree paths', why: 'git does not record a worktree path; the port\'s is .claude/worktrees/<change>' })

  // artifacts
  const oArch = `openspec/changes/archive/${candidate.dir}`
  const pDir = portTip ? P.lines('ls-tree', '--name-only', `${portTip}:openspec/changes/archive/`).find((d) => d.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name) : null
  const pArch = pDir ? `openspec/changes/archive/${pDir}` : null
  if (!pArch) add('artifacts', 'artifact-archive', `the port's branch holds no archive directory of ${name}`)
  else {
    compared.push('artifacts', 'headings')
    const oFiles = O.lines('ls-tree', '-r', '--name-only', `${m}:${oArch}`)
    const pFiles = P.lines('ls-tree', '-r', '--name-only', `${portTip}:${pArch}`)
    for (const f of pFiles.filter((f) => !oFiles.includes(f))) add('artifacts', `artifact-only-port:${f}`, `${f} is in the port's archive directory, not in the origin's`)
    for (const f of oFiles.filter((f) => !pFiles.includes(f))) add('artifacts', `artifact-only-origin:${f}`, `${f} is in the origin's archive directory, not in the port's`)
    for (const f of oFiles.filter((f) => pFiles.includes(f) && f.endsWith('.md'))) {
      const { onlyA, onlyB } = multisetDiff(headings(O.orNull('show', `${m}:${oArch}/${f}`)), headings(P.orNull('show', `${portTip}:${pArch}/${f}`)))
      if (onlyA.length || onlyB.length) add('artifacts', `artifact-headings:${f}`, `${f}: ${onlyA.length} heading(s) only in the origin's, ${onlyB.length} only in the port's`, { evidence: { origin: onlyA.slice(0, 12), port: onlyB.slice(0, 12) } })
    }
  }

  // gates: propose's gates, verify's checks, the review verdict
  compared.push('gates')
  for (const s of stepsMatching(record, (s) => /^node changes\.mjs done /.test(s.command ?? ''))) {
    for (const g of (s.result?.gates ?? []).filter((g) => !g.ok)) add('gates', `gate:${g.gate}`, `propose's ${g.gate} gate refuses the origin's ${s.command.split(' ')[3]}`, { evidence: { step: s.n }, hints: hintsOf([s]) })
  }
  const verdicts = stepsMatching(record, (s) => /^node verify\.mjs verdict /.test(s.command ?? ''))
  const firstVerdict = verdicts[0]?.result
  const oVerify = originVerify(O.orNull('show', `${m}:${oArch}/verify.md`), rules.verifyTitles)
  if (firstVerdict?.checks) {
    for (const c of firstVerdict.checks) {
      const mine = c.verdict === 'not-run' ? 'fail' : c.verdict
      const theirs = oVerify.checks[c.id]
      if (theirs === undefined) {
        if (mine === 'fail') add('gates', `verify-check:${c.id}`, `verify's ${c.id} fails (${c.summary}); the origin's verify.md has no such check`, { evidence: { step: verdicts[0].n } })
        continue
      }
      if (mine === theirs || (mine !== 'fail' && theirs !== 'fail')) continue
      // A port failure the origin passed would stop verify (strong); the other way round is recorded.
      add('gates', `${mine === 'fail' ? 'verify-check' : 'verify-check-passes'}:${c.id}`, `verify's ${c.id} is ${mine} (${c.summary}); the origin's is ${theirs}`, { evidence: { step: verdicts[0].n } })
    }
    for (const id of Object.keys(oVerify.checks).filter((id) => !firstVerdict.checks.some((c) => c.id === id))) notCompared.push({ what: `verify check ${id}`, why: 'the port runs no such check' })
  } else notCompared.push({ what: 'verify\'s checks', why: 'the run has no verify verdict' })
  for (const d of record.differences ?? []) {
    const ruling = /^the verdict needs rulings the origin's ledger does not hold: (.+)$/.exec(d.what)
    if (!ruling) continue
    for (const id of ruling[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (diffs.some((x) => x.key === `verify-check:${id}`)) continue
      const c = firstVerdict?.checks?.find((x) => x.id === id)
      add('gates', `verify-ruling:${id}`, `verify's ${id} needed a ruling the origin's ledger does not hold${c ? ` (${c.summary})` : ''}`, { evidence: { step: verdicts[0]?.n ?? null } })
    }
  }

  // groups and waves
  const oPlan = planGraph(O.orNull('show', `${m}:${oArch}/plan.md`))
  const sched = stepsMatching(record, (s) => /^node plan\.mjs schedule /.test(s.command ?? ''))[0]
  if (sched?.result?.groups) {
    compared.push('groups', 'waves')
    const mine = sched.result.groups
    for (const g of oPlan.groups) {
      const p = mine.find((x) => x.letter === g.letter)
      if (!p) add('groups', `groups:${g.letter}:missing`, `the port schedules no group ${g.letter}`, { evidence: { step: sched.n } })
      else {
        if (p.tasks.join(',') !== g.tasks.join(',')) add('groups', `groups:${g.letter}:tasks`, `group ${g.letter}: the port schedules tasks ${p.tasks.join(', ')}, the origin's plan ${g.tasks.join(', ')}`, { evidence: { step: sched.n } })
        if (p.wave !== g.wave) add('groups', `groups:${g.letter}:wave`, `group ${g.letter}: wave ${p.wave} in the port, ${g.wave} in the origin's plan`, { evidence: { step: sched.n } })
      }
    }
    for (const p of mine.filter((x) => !oPlan.groups.some((g) => g.letter === x.letter))) add('groups', `groups:${p.letter}:extra`, `the port schedules a group ${p.letter} the origin's plan has not`, { evidence: { step: sched.n } })
    const grouped = new Set(oPlan.groups.flatMap((g) => g.tasks))
    const loose = oPlan.tasks.filter((t) => !grouped.has(t))
    if (oPlan.groups.length && loose.length) notCompared.push({ what: `the schedule of origin Tasks ${loose.join(', ')}`, why: 'the origin plan puts them in no group' })
  } else if (record.mode === 'fresh' || record.phases?.apply?.reached) notCompared.push({ what: 'groups and waves', why: 'the run has no schedule' })
  const groupMerges = (git, from, to) => (from && to ? git.lines('log', '--merges', '--format=%s', `${from}..${to}`) : []).map((s) => /--group-([A-Za-z0-9]+)'/.exec(s)?.[1]).filter(Boolean).sort()
  if (originTip && portTip) {
    compared.push('group merges')
    const o = groupMerges(O, base, originTip)
    const p = groupMerges(P, host, portTip).map((x) => (/^\d+$/.test(x) ? mineLetter(sched, x) : x))
    if (o.join(',') !== p.join(',')) add('groups', 'group-merges', `group branches merged: the origin ${o.join(', ') || 'none'}, the port ${p.join(', ') || 'none'}`)
  } else notCompared.push({ what: 'the group branches merged', why: originTip ? 'the port has no branch' : 'the origin branch is gone (D10)' })

  // commits by phase
  if (originTip && portTip) {
    compared.push('commits by phase')
    // First-parent subjects, each group merge preceded by the commits it brought in.
    const subjects = (git, from, to) => git.lines('log', '--first-parent', '--reverse', '--format=%H %P', `${from}..${to}`).flatMap((l) => {
      const [sha, p1, p2] = l.split(' ')
      const subject = git('show', '-s', '--format=%s', sha)
      return p2 && commitKind(subject, rules) === 'group-merge' ? [...git.lines('log', '--no-merges', '--reverse', '--format=%s', `${p1}..${p2}`), subject] : [subject]
    })
    const o = byPhase(subjects(O, base, originTip), rules)
    const p = byPhase(subjects(P, host, portTip), rules)
    for (const phase of Object.keys(o)) {
      if (record.mode === 'mid-flight' && phase === 'propose') continue
      const work = (list) => list.filter((s) => commitKind(s, rules) === 'work')
      const { onlyA, onlyB } = multisetDiff(work(o[phase]), work(p[phase]))
      if (onlyA.length) add('commits', `commits:${phase}:lost`, `${onlyA.length} origin commit(s) of ${phase} have no port commit of the same subject`, { evidence: { subjects: onlyA.slice(0, 10) } })
      if (onlyB.length) add('commits', `commits:${phase}:extra`, `${onlyB.length} port commit(s) of ${phase} have no origin commit of the same subject`, { evidence: { subjects: onlyB.slice(0, 10) } })
      const kinds = (list) => list.map((s) => commitKind(s, rules)).filter((k) => k !== 'work')
      const ko = kinds(o[phase])
      const kp = kinds(p[phase])
      for (const k of new Set([...ko, ...kp])) {
        const a = ko.filter((x) => x === k).length
        const b = kp.filter((x) => x === k).length
        if (a !== b) add('commits', `commits:${phase}:${k}`, `${phase}: ${a} origin ${k} commit(s), ${b} in the port`)
      }
    }
  } else notCompared.push({ what: 'the commit sequence by phase', why: originTip ? 'the port has no branch' : 'the origin branch is gone; a squash keeps one commit (D10)' })

  // ledger
  if (pArch) {
    compared.push('ledger')
    const o = ledgerRecords(O.orNull('show', `${m}:${oArch}/ledger.jsonl`))
    const p = ledgerRecords(P.orNull('show', `${portTip}:${pArch}/ledger.jsonl`))
    const { lost, invented, renamed } = compareLedgers(o, p, rules.ledgerRenames ?? [])
    for (const x of renamed) add('ledger', `ledger-renamed:${x.rename.kind}:${x.rename.field}`, `the origin's ${x.origin.id} has ${x.rename.field} ${x.rename.origin}, the port's ${x.port.id} ${x.rename.port}`, { evidence: { origin: x.origin.id, port: x.port.id } })
    for (const r of lost) add('ledger', `ledger-lost:${r.kind}`, `the origin's ${r.id} (${canon(r).slice(0, 300)}) has no port record`, { evidence: { origin: r.id } })
    for (const r of invented) {
      const steps = stepsMatching(record, (s) => /^node ledger\.mjs /.test(s.command ?? '') && s.result?.record?.id === r.id)
      add('ledger', `ledger-invented:${r.kind}`, `the port's ${r.id} (${canon(r).slice(0, 300)}) has no origin record`, { evidence: { port: r.id, steps: steps.map((s) => s.n) }, hints: hintsOf(steps) })
    }
  }

  // review verdict and counts
  if (pArch) {
    compared.push('review')
    const o = reviewRecord(O.orNull('show', `${m}:${oArch}/review.md`))
    const p = reviewRecord(P.orNull('show', `${portTip}:${pArch}/review.md`))
    if (o.verdict !== p.verdict) add('review', 'review:verdict', `review verdict: the origin ${o.verdict}, the port ${p.verdict}`)
    if (o.rounds !== p.rounds) add('review', 'review:rounds', `review rounds: the origin ${o.rounds}, the port ${p.rounds}`)
    if (JSON.stringify(o.counts) !== JSON.stringify(p.counts)) add('review', 'review:counts', `review counts: the origin ${JSON.stringify(o.counts)}, the port ${JSON.stringify(p.counts)}`)
    if (JSON.stringify(o.dispositions) !== JSON.stringify(p.dispositions)) add('review', 'review:dispositions', `review dispositions: the origin ${JSON.stringify(o.dispositions)}, the port ${JSON.stringify(p.dispositions)}`)
  }

  // the main specs after the merge
  const caps = [...new Set(O.lines('ls-tree', '-r', '--name-only', `${m}:${oArch}/specs`).map((f) => f.split('/')[0]))]
  if (portTip && caps.length) {
    compared.push('main specs')
    const norm = (t) => (t ?? '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
    const portSubjects = new Set(P.lines('log', '--format=%s', `${host}..${portTip}`))
    // An origin commit on the branch that edits the spec outside the archive and that the replay
    // did not make (no port commit of its subject).
    const unreplayed = (path) => (originTip ? O.lines('log', '--no-merges', '--format=%s', `${base}..${originTip}`, '--', path) : []).filter((s) => commitKind(s, rules) !== 'archive' && !portSubjects.has(s))
    for (const cap of caps) {
      const path = `openspec/specs/${cap}/spec.md`
      const o = O.orNull('show', `${m}:${path}`)
      const p = P.orNull('show', `${portTip}:${path}`)
      if (norm(o) === norm(p)) continue
      // Layout only: the same text once blank lines and the title line are left out.
      const bare = (t) => norm(t).split('\n').filter((l) => l.trim() && !/^#\s/.test(l)).join('\n')
      if (o !== null && p !== null && bare(o) === bare(p)) {
        add('specs', `spec-format:${cap}`, `${path} after the merge differs in blank lines or the title line only`, { evidence: { originTitle: o.split('\n')[0], portTitle: p.split('\n')[0] } })
        continue
      }
      const oLines = norm(o).split('\n')
      const pLines = norm(p).split('\n')
      const { onlyA, onlyB } = multisetDiff(oLines, pLines)
      const edits = unreplayed(path)
      add('specs', `spec-merge:${cap}`, `${path} after the merge: ${onlyA.length} line(s) only in the origin's, ${onlyB.length} only in the port's`, { flags: [...flagsOf(path), ...(edits.length ? ['unreplayed-edit'] : [])], evidence: { origin: onlyA.slice(0, 6), port: onlyB.slice(0, 6), unreplayed: edits } })
    }
  }

  // the final openspec/ and memory tree
  if (portTip) {
    compared.push('openspec/ and memory tree')
    const roots = ['openspec/', '.claude/memory/']
    const list = (git, rev, arch) => git.lines('ls-tree', '-r', '--name-only', rev, '--', ...roots).filter((f) => !f.startsWith(`${arch}/`) && !f.startsWith(`openspec/changes/${name}/`))
    const o = new Set(list(O, m, oArch))
    const p = new Set(list(P, portTip, pArch ?? oArch))
    for (const f of [...p].filter((f) => !o.has(f))) add('tree', `tree-only-port:${f}`, `${f} is in the port's final tree, not the origin's`, { flags: flagsOf(f) })
    for (const f of [...o].filter((f) => !p.has(f))) add('tree', `tree-only-origin:${f}`, `${f} is in the origin's final tree, not the port's`, { flags: flagsOf(f) })
    const touched = m1 ? O.lines('diff', '--no-renames', '--name-only', m1, m, '--', ...roots).filter((f) => !f.startsWith(`${oArch}/`) && !f.startsWith('openspec/specs/') && o.has(f) && p.has(f)) : []
    for (const f of touched) {
      if (O.orNull('rev-parse', `${m}:${f}`) === P.orNull('rev-parse', `${portTip}:${f}`)) continue
      const rewrite = (t) => (rules.contentNormalize ?? []).filter((n) => new RegExp(n.path).test(f)).reduce((x, n) => x.replace(new RegExp(n.pattern, n.flags ?? 'gm'), n.replace), t ?? '')
      const same = rewrite(O.orNull('show', `${m}:${f}`)) === rewrite(P.orNull('show', `${portTip}:${f}`))
      // A file the origin's integration branch changed between the base and the merge (D3) that
      // the port edited exactly as the origin's change did: the difference is that drift alone.
      const driftOnly = drift.has(f) && !same && editLines(O.orNull('diff', '--no-renames', m1, m, '--', f), rewrite).join('\n') === editLines(P.orNull('diff', '--no-renames', base, portTip, '--', f), rewrite).join('\n')
      add('tree', `${same ? 'tree-content-normalized' : 'tree-content'}:${f}`, `${f}, which the origin's merge changed, differs in the port${same ? ' only where the rules normalize (time, author)' : driftOnly ? ' only by the origin\'s base drift: the port made the same edit' : ''}`, { flags: [...flagsOf(f), ...(driftOnly ? ['drift-only'] : [])] })
    }
  }

  // the merge request
  compared.push('merge request')
  const oMsg = O.orNull('show', '-s', '--format=%B', m) ?? ''
  const oTarget = /^Merge branch '[^']+' into '([^']+)'/m.exec(oMsg)?.[1] ?? null
  const m2 = O.orNull('rev-parse', `${m}^2`)
  const oSquash = m2 ? (originTip ? m2 !== originTip : O.lines('rev-list', '--parents', '-n', '1', m2)[0]?.split(' ').length === 2) : null
  const oTitle = m2 ? O.orNull('show', '-s', '--format=%s', m2) : null
  const mrs = forge.filter((x) => x.source_branch === branch)
  if (mrs.length !== 1) add('mr', 'mr:count', `${mrs.length} merge request(s) of ${branch} in the fake glab; the origin's merge names one (!${candidate.mergeRequest})`)
  const mr = mrs.at(-1)
  if (mr) {
    if (oTarget && mr.target_branch !== oTarget) add('mr', 'mr:target', `the merge request targets ${mr.target_branch}, the origin's ${oTarget}`)
    if (mr.source_branch !== candidate.branch) add('mr', 'mr:source', `the merge request's source is ${mr.source_branch}, the origin's ${candidate.branch}`)
    if (oSquash !== null && mr.squash !== oSquash) add('mr', 'mr:squash', `squash: the port ${mr.squash}, the origin ${oSquash}`)
    if (mr.state !== 'merged') add('mr', 'mr:state', `the merge request ends ${mr.state}${mr.draft ? ' (Draft)' : ''}; the origin's was merged`)
    const title = mr.title.replace(/^Draft:\s*/, '')
    if (oTitle && title !== oTitle) add('mr', 'mr:title', `the title is "${mr.title}", the origin's squash subject "${oTitle}"`)
  }
  const sequence = glabCalls.map((c) => c.argv).filter((a) => a[0] === 'mr' && ['create', 'update'].includes(a[1])).map((a) => (a[1] === 'create' ? (a.includes('--draft') ? 'create draft' : 'create ready') : a.includes('--ready') ? 'update ready' : 'update'))
  if (record.draft && !record.draft.ok) add('mr', 'mr:finalize', `finalize left ${JSON.stringify({ ...record.draft, description: undefined })}`)
  notCompared.push({ what: 'the merge request\'s Draft and ready transitions, description, labels and pipeline', why: 'git holds only the merge commit; `glab mr view` is not run (no network)' })

  return {
    differences: diffs,
    compared,
    notCompared,
    summary: {
      origin: { branch: candidate.branch, base: base?.slice(0, 12), exactBase: candidate.base.exact, history: candidate.history, mergeRequest: candidate.mergeRequest, target: oTarget, squash: oSquash, verify: oVerify.verdict, review: reviewRecord(O.orNull('show', `${m}:${oArch}/review.md`)).verdict },
      port: { branch, archive: pArch, mr: mr ? { state: mr.state, draft: mr.draft, target: mr.target_branch, squash: mr.squash } : null, glab: sequence, verify: verdicts.at(-1)?.result?.verdict ?? null, review: pArch ? reviewRecord(P.orNull('show', `${portTip}:${pArch}/review.md`)).verdict : null, phases: Object.fromEntries(Object.entries(record.phases ?? {}).map(([k, v]) => [k, v.reached ? 'reached' : 'stopped'])) }
    }
  }
}

// A group merge named by number (`--group-2`) as its letter in the schedule.
function mineLetter(sched, n) {
  return sched?.result?.groups?.find((g) => String(g.n) === String(n))?.letter ?? n
}

// ---------------------------------------------------------------- report

export function report(runs) {
  const all = runs.flatMap((r) => r.differences)
  const by = (cls) => all.filter((d) => d.class === cls).length
  const lines = ['# Replay comparison', '', `Runs: ${runs.length}. Differences: ${all.length} (explained ${by('explained')}, older-origin ${by('older-origin')}, injected ${by('injected')}, defect ${by('defect')}, recorded only ${by(null)}).`, '']
  for (const r of runs) {
    lines.push(`## ${r.candidate} (${r.mode})`, '', `Phases: ${Object.entries(r.summary.port.phases).map(([k, v]) => `${k} ${v}`).join(', ')}. Verify: origin ${r.summary.origin.verify}, port ${r.summary.port.verify}. Review: origin ${r.summary.origin.review}, port ${r.summary.port.review}. Merge request: ${r.summary.port.glab.join(' -> ') || 'no call'}${r.summary.port.mr ? `, ends ${r.summary.port.mr.state}` : ''}.`, '')
    lines.push('| Class | Area | Difference | Evidence | Lessons |', '|---|---|---|---|---|')
    const order = ['defect', 'older-origin', 'explained', 'injected', null]
    for (const d of [...r.differences].sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class))) {
      const ev = d.evidence ? JSON.stringify(d.evidence).replaceAll('|', '\\|').slice(0, 160) : ''
      lines.push(`| ${d.class ?? 'recorded'}${d.strong ? ' (strong)' : ''} | ${d.area} | ${String(d.what).replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 300)} | ${ev} | ${d.cite ? `${d.cite.file}:${d.cite.line}` : d.rule ?? ''} |`)
    }
    lines.push('', `Not compared: ${r.notCompared.map((n) => `${n.what} (${n.why})`).join('; ')}.`, '')
  }
  const defects = all.filter((d) => d.class === 'defect')
  if (defects.length) {
    lines.push('## Defects', '')
    for (const d of defects) lines.push(`- ${d.candidate} (${d.mode}) ${d.key}: ${d.what.split('\n')[0].slice(0, 200)}${d.fix ? ` Fix: ${d.fix}` : ''}${d.decision === 'developer' ? ' (developer decision)' : ''}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- the run

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function args(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    origin: argv[0] && !argv[0].startsWith('--') ? argv[0] : process.env.ADF_ORIGIN,
    fresh: list(value('--fresh') ?? process.env.ADF_REPLAY_FRESH),
    mid: list(value('--mid') ?? process.env.ADF_REPLAY_MID),
    author: value('--author') ?? process.env.ADF_AUTHOR,
    since: value('--since') ?? process.env.ADF_REPLAY_SINCE,
    sandbox: value('--sandbox') ?? process.env.ADF_REPLAY_SANDBOX,
    out: value('--out') ?? process.env.ADF_REPLAY_OUT,
    keep: argv.includes('--keep') || process.env.ADF_REPLAY_KEEP === '1'
  }
}

const asOf = (mode, name) => `${mode === 'fresh' ? 'f' : 'm'}-${name}`.slice(0, 60)

// A kept sandbox, read only: its cache, its fake glab state and log, its run records.
function openSandbox(root) {
  const S = realpathSync(root)
  if (!S.startsWith(join(realpathSync(tmpdir()), 'adf-replay-')) || !existsSync(join(S, 'cache')) || !existsSync(join(S, 'runs'))) throw new Error(`${root} is not a kept replay sandbox`)
  return { root: S, cache: join(S, 'cache'), forge: join(S, 'forge.json'), log: join(S, 'log') }
}

const calls = (S, tool) => {
  const file = join(S.log ?? join(S.root, 'log'), `${tool}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv)
  if (!a.origin) {
    console.error('usage: origin-replay.mjs <origin> [--fresh a,b] [--mid c] [--author <name>] [--since <rev>] [--sandbox <dir>] [--out <dir>] [--keep]')
    return 2
  }
  if (!a.author || a.fresh.length + a.mid.length === 0) {
    console.log(`SKIP origin-replay: ${!a.author ? 'no author (ADF_AUTHOR)' : 'no candidate named (ADF_REPLAY_FRESH, ADF_REPLAY_MID)'}`)
    return 0
  }
  const rules = loadRules()
  const before = originState(a.origin)
  const beforeRefs = refsOf(a.origin)
  const O = gitAt(a.origin)
  const { findCandidates } = await import('./lib/replay-candidates.mjs')
  const since = a.since ?? O('log', '--first-parent', 'origin/develop', '-1', '--format=%H', '--', 'openspec/schemas', '.claude/commands/opsx', '.claude/scripts')
  const found = findCandidates(a.origin, { author: a.author, since, names: [...new Set([...a.fresh, ...a.mid])] })
  const pick = (n) => found.find((c) => c.name === n || c.dir === n)
  const jobs = [...a.fresh.map((n) => ['fresh', pick(n)]), ...a.mid.map((n) => ['mid-flight', pick(n)])]
  if (jobs.some(([, c]) => !c)) {
    console.log('SKIP origin-replay: a named change is not a candidate')
    return 0
  }

  let S
  let sandbox = null
  if (a.sandbox) S = openSandbox(a.sandbox)
  else {
    const { createSandbox } = await import('./lib/sandbox.mjs')
    sandbox = createSandbox({ origin: a.origin })
    S = sandbox
  }
  const runs = []
  let after
  let moved = []
  try {
    const { buildReplies } = await import('./lib/replay-replies.mjs')
    const { drive, driveMidFlight, writeRunRecord } = await import('./lib/replay-drive.mjs')
    for (const [mode, candidate] of jobs) {
      const as = asOf(mode, candidate.name)
      let record
      if (sandbox) {
        const replies = buildReplies(sandbox, candidate)
        record = mode === 'fresh' ? drive(sandbox, candidate, replies) : driveMidFlight(sandbox, candidate, replies)
        writeRunRecord(sandbox, record)
      } else record = JSON.parse(readFileSync(join(S.root, 'runs', `${as}.json`), 'utf8'))
      const forge = existsSync(S.forge) ? JSON.parse(readFileSync(S.forge, 'utf8'))[as]?.mrs ?? [] : []
      const glabCalls = calls(S, 'glab').filter((c) => c.cwd === join(S.root, as) || c.cwd.startsWith(`${join(S.root, as)}/`))
      const result = compareRun({ cache: S.cache, main: join(S.root, as, 'main'), record, candidate, forge, glabCalls, rules })
      const differences = result.differences.map((d) => classify({ ...d, candidate: candidate.name, mode: record.mode }, record, rules))
      runs.push({ candidate: candidate.name, mode: record.mode, as, ...result, differences })
    }
    // Read while the sandbox still exists: a moved ref is traced to its repositories.
    after = originState(a.origin)
    const repos = [S.cache, ...jobs.flatMap(([mode, c]) => ['main', 'remote.git'].map((r) => join(S.root, asOf(mode, c.name), r)))].filter((d) => existsSync(d))
    moved = movedRefs(beforeRefs, refsOf(a.origin), repos)
  } finally {
    if (sandbox && !a.keep) sandbox.destroy()
  }
  // Unchanged: status, stash and HEAD as before, and every moved ref someone else's.
  const foreign = moved.filter((m) => m.by === 'foreign')
  const unchanged = ['status', 'stash', 'head'].every((k) => before[k] === after[k]) && foreign.length === moved.length
  const out = { origin: { unchanged, before, after, moved }, sandbox: sandbox && !a.keep ? null : S.root, runs }
  const md = `${report(runs)}\nOrigin unchanged: ${unchanged} (refs ${after.refs}, status ${after.status}, stash ${after.stash}).${foreign.length ? ` Moved during the run by work in flight on the origin, not by the replay: ${foreign.map((m) => m.ref).join(', ')}.` : ''}\n`
  if (a.out) {
    mkdirSync(a.out, { recursive: true })
    writeFileSync(join(a.out, 'compare.json'), `${JSON.stringify(out, null, 2)}\n`)
    writeFileSync(join(a.out, 'compare.md'), md)
  }
  const defects = runs.flatMap((r) => r.differences).filter((d) => d.class === 'defect')
  console.log(md)
  return defects.length === 0 && unchanged ? 0 : 1
}

if (isMain(import.meta.url)) process.exitCode = await main()
