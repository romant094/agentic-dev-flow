// lib/replay-replies.mjs on a fixture origin shaped like the real one: a change whose local branch
// survives (propose, a group branch merged, a task committed on the change branch, the apply
// record, verify, review with a fixed finding, archive and ingest), squash-merged on develop, and
// the same change once its branch is gone. Every reply the records give is built and passes the
// port's own check; what they cannot give is missing with its reason; each carries its source.
// The opt-in live check (ADF_ORIGIN) sets up the host and builds the replies of the smallest
// candidate of the real origin, which it leaves unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSandbox } from '../lib/sandbox.mjs'
import { findCandidates } from '../lib/replay-candidates.mjs'
import { buildReplies, c8Reply, completeImpl, ingestStaleAnswers, replyReport, specMergeReply } from '../lib/replay-replies.mjs'
import { editReport, hostEdits, setupHost } from '../lib/replay-host.mjs'

const DEV = { name: 'Dev One', email: 'dev@example.com' }
const CHANGE = 'add-thing'
const BRANCH = 'feat/K-1/add-thing'
const ARCHIVED = '2026-10-05-add-thing'

const MAIN_SPEC = (extra = '') => `# cap Specification

## Purpose

The cap capability is a fixture capability whose purpose text is long enough for validation.

## Requirements

### Requirement: Thing

The system SHALL do the thing.

#### Scenario: thing

- **WHEN** a thing happens
- **THEN** the thing is done
${extra}`

const DELTA = `## MODIFIED Requirements

### Requirement: Thing

The system SHALL do the thing twice.

#### Scenario: thing

- **WHEN** a thing happens
- **THEN** the thing is done twice
`

const PLAN = `# Add Thing — Implementation Plan

**Goal:** add the thing.

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1 | \`src/one.ts\` | 1 |
| B | 2 | \`src/two.ts\` | 1 |

---

### Task 1: One

> Implements \`tasks.md\` 1.1.

**Files:**
- Create: \`src/one.ts\`

**Level:** mechanical

- [ ] **Step 1: Write** — write it.
- [ ] **Step 2: Commit** — \`feat(x): one\`

---

### Task 2: Two

> Implements \`tasks.md\` 1.2.

**Files:**
- Create: \`src/two.ts\`

**Level:** mechanical

- [ ] **Step 1: Write** — write it.
- [ ] **Step 2: Commit** — \`feat(x): two\`
`

const TASKS = (tick) => `## 1. Thing\n\n- [${tick}] 1.1 One\n- [${tick}] 1.2 Two\n`

const PROPOSAL = `## Why\n\nThe thing.\n\n## What Changes\n\n- The thing.\n\n## Capabilities\n\n### New Capabilities\n\n### Modified Capabilities\n\n- \`cap\`: twice\n\n## Impact\n\nNone.\n`

const VERIFY = `# Verification Report

## 1. Structural Validation

**Result**: one invalid main spec, pre-existing.

## 4. Design / Specs Coherence

This change has no \`design.md\`.

**Drift between two documents** (warning, non-blocking):

- none

**Contradiction between two executable surfaces** (blocking — the verdict is FAIL):

- none

## 8. Stale-Skill Check

**Approved skill-edit commit(s)**: none

**Findings**:

| Skill | Classification | Detail | Resolution |
|---|---|---|---|
| foo (\`.claude/skills/foo/SKILL.md:3\`) | PLAUSIBLE | Names the old thing; still true. | none needed |
| other skills | none | No match. | — |
`

const REVIEW = (sha) => `# AI Code Review Record

**Verdict**: PASS

**Rounds**: \`2\` (round 1: \`REQUEST CHANGES\`; round 2: \`APPROVE\`)

**Counts**: CRITICAL \`0\` | HIGH \`1\` | MEDIUM \`0\` | LOW \`0\`

## Findings

| # | Severity | Where | Disposition |
|---|---|---|---|
| 1 | HIGH | \`src/two.ts:2\` | fixed in \`${sha}\` |

Finding 1: two returned one when the input was empty, so the caller stored a wrong count. The fix
returns two in that case.
`

const LEDGER = [
  { id: 'session-1', kind: 'session', phase: 'propose' },
  { id: 'session-2', kind: 'session', phase: 'apply' },
  { id: 'deviation-1', kind: 'deviation', rule: 'fan-out of wave-1 groups into sibling worktrees', reason: 'group B is one small task' },
  { id: 'ruling-1', kind: 'ruling', task: '2', finding: 'two misses the empty case', decision: 'pre-existing; not blocking' },
  { id: 'debt-1', kind: 'debt', task: '2', what: 'two duplicates one', reason: 'out of scope' },
  { id: 'session-3', kind: 'session', phase: 'verify' },
  { id: 'ruling-2', kind: 'ruling', finding: 'verify Check 1: main spec invalid', decision: 'accepted as pre-existing' },
  { id: 'session-4', kind: 'session', phase: 'review' },
  { id: 'session-5', kind: 'session', phase: 'archive' },
  { id: 'resolve-1', kind: 'resolve', debt: 'debt-1', as: 'flow-debt', where: '.claude/memory/adf/deferred.md' }
].map((r, i) => JSON.stringify({ ...r, at: `2026-10-05T10:0${i}:00.000Z`, sessionId: 's' })).join('\n') + '\n'

const PAGE = '# A\n\nA page.\n'
const PAGE_AFTER = `# A

A page.

**Invariant: the thing is done twice.** Nothing else holds it.
**What a future implementer would most plausibly get wrong:** doing it once again.
`
const LOG = '# Log\n\n## [2026-10-01 10:00] task | earlier | Dev One\n- earlier.\n'
const LOG_AFTER = `# Log

## [2026-10-05 12:00] ingest | add-thing: the thing twice | Dev One
- The thing is done twice now.
- Pages: [[a]] (the invariant and the trap).

## [2026-10-01 10:00] task | earlier | Dev One
- earlier.
`

function fixture() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-replies-origin-'))), 'origin')
  execFileSync('git', ['init', '-q', '-b', 'develop', dir])
  let clock = Date.parse('2026-10-05T09:00:00Z')
  const git = (...args) => {
    clock += 60_000
    const at = new Date(clock).toISOString()
    const env = { ...process.env, GIT_AUTHOR_NAME: DEV.name, GIT_AUTHOR_EMAIL: DEV.email, GIT_COMMITTER_NAME: DEV.name, GIT_COMMITTER_EMAIL: DEV.email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, path), { force: true })
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
    }
  }
  const commit = (files, message) => {
    write(files)
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const change = (files) => Object.fromEntries(Object.entries(files).map(([f, t]) => [`openspec/changes/${CHANGE}/${f}`, t]))

  commit({ 'openspec/specs/cap/spec.md': MAIN_SPEC(), '.claude/memory/index.md': '# Index\n', '.claude/memory/concepts/a.md': PAGE, '.claude/memory/log.md': LOG, 'src/.keep': '' }, 'init')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', BRANCH)
  const propose = commit(change({ 'brainstorm.md': '# Brainstorm\n\nThe thing.\n', 'proposal.md': PROPOSAL, 'specs/cap/spec.md': DELTA, 'tasks.md': TASKS(' '), 'plan.md': PLAN }), `docs(openspec): propose ${CHANGE}`)
  git('checkout', '-q', '-b', `${BRANCH}--group-A`)
  const one = commit({ 'src/one.ts': 'export const one = 1\n' }, 'feat(x): one')
  git('checkout', '-q', BRANCH)
  git('merge', '-q', '--no-ff', '-m', `Merge branch '${BRANCH}--group-A' into ${BRANCH}`, `${BRANCH}--group-A`)
  const two = commit({ 'src/two.ts': 'export const two = 2\n' }, 'feat(x): two')
  const record = commit(change({ '.apply-test-record.md': '# Apply test record\n', 'tasks.md': TASKS('x') }), `chore(openspec): record apply of ${CHANGE}`)
  commit(change({ 'verify.md': VERIFY }), `docs(openspec): verify ${CHANGE}`)
  const fix = commit({ 'src/two.ts': 'export const two = () => 2\n' }, 'fix(x): two in the empty case')
  commit(change({ 'review.md': REVIEW(fix) }), `docs(openspec): review ${CHANGE}`)
  for (const f of ['brainstorm.md', 'proposal.md', 'specs/cap/spec.md', 'tasks.md', 'plan.md', '.apply-test-record.md', 'verify.md', 'review.md']) {
    mkdirSync(dirname(join(dir, `openspec/changes/archive/${ARCHIVED}/${f}`)), { recursive: true })
    execFileSync('git', ['-C', dir, 'mv', `openspec/changes/${CHANGE}/${f}`, `openspec/changes/archive/${ARCHIVED}/${f}`])
  }
  const archive = commit({ [`openspec/changes/archive/${ARCHIVED}/ledger.jsonl`]: LEDGER, 'openspec/specs/cap/spec.md': MAIN_SPEC().replace('do the thing.', 'do the thing twice.') }, `docs(openspec): archive ${CHANGE}`)
  const ingest = commit({ '.claude/memory/concepts/a.md': PAGE_AFTER, '.claude/memory/log.md': LOG_AFTER, '.claude/memory/index.md': '# Index\n\n- [a](concepts/a.md) — the thing\n' }, `docs(memory): ingest what ${CHANGE} taught`)

  // GitLab's squash merge of the branch onto develop.
  git('checkout', '-q', 'develop')
  commit({ 'b.txt': 'b\n' }, 'unrelated')
  const parent = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'squash-tmp')
  git('checkout', '-q', BRANCH, '--', '.')
  git('add', '-A')
  git('commit', '-q', '-m', `feat: ${CHANGE}`)
  git('checkout', '-q', 'develop')
  git('merge', '-q', '--no-ff', '-m', `Merge branch '${BRANCH}' into 'develop'\n\nfeat: ${CHANGE}\n\nSee merge request group/repo!7`, 'squash-tmp')
  git('branch', '-q', '-D', 'squash-tmp')
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
  return { dir, base, parent, propose, one, two, record, fix, archive, ingest, merge: git('rev-parse', 'HEAD'), git }
}

const F = fixture()
const snapshot = (dir) => execFileSync('git', ['-C', dir, 'for-each-ref'], { encoding: 'utf8' }) + execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
const find = (result, name) => Object.values(result.phases).flat().find((i) => i.name === name)

function withReplies(fn) {
  const [candidate] = findCandidates(F.dir, { author: DEV.name, since: F.base })
  const sandbox = createSandbox({ origin: F.dir })
  try {
    fn(buildReplies(sandbox, candidate), sandbox, candidate)
  } finally {
    sandbox.destroy()
  }
}

test('a kept branch: the artifacts as first committed, the task replies from the commits, every built reply valid, each with its source', () => {
  const before = snapshot(F.dir)
  withReplies((r, sandbox, candidate) => {
    assert.equal(candidate.history, 'branch')
    assert.equal(r.counts.invalid, 0, replyReport(r))

    // propose
    const tasks = find(r, 'tasks.md')
    assert.equal(tasks.source[0].commit, F.propose)
    assert.match(tasks.text, /- \[ \] 1\.1/)
    assert.equal(tasks.injected, undefined)
    assert.deepEqual(r.phases.propose.map((i) => i.name), ['brainstorm.md', 'plan.md', 'proposal.md', 'specs/cap/spec.md', 'tasks.md'])
    for (const i of r.phases.propose) assert.equal(i.check.valid, true, `${i.name}: ${i.check.errors}`)

    // apply
    const t1 = find(r, 'T1 impl')
    assert.deepEqual(t1.reply.commits, [F.one])
    assert.equal(t1.reply.outcome, 'done')
    assert.deepEqual(t1.injected.map((x) => x.field), ['testRuns'])
    assert.match(t1.injected[0].value[0], /^\.superpowers\/sdd\/add-thing\/tests\/T1-impl-replay\.json$/)
    assert.deepEqual(completeImpl(t1, ['x.json']).testRuns, ['x.json'])
    assert.deepEqual(find(r, 'T2 impl').reply.commits, [F.two])
    assert.equal(find(r, 'T1 review').check.valid, true)
    assert.match(find(r, 'T2 review').missing, /ruling-1 names a finding of Task 2/)
    assert.equal(find(r, 'merge-review A').source[0].subject, `Merge branch '${BRANCH}--group-A' into ${BRANCH}`)
    assert.match(find(r, 'merge-review B').missing, /merged no branch of group B \(deviation-1: fan-out/)
    assert.deepEqual(find(r, 'sweep').reply, { role: 'sweep', findings: [] })
    assert.deepEqual(find(r, 'final-review').source.map((s) => s.commit), [F.two, F.record])
    assert.deepEqual(r.phases.apply.filter((i) => i.kind === 'ledger').map((i) => i.name), ['deviation deviation-1', 'ruling ruling-1', 'debt debt-1'])

    // verify
    const c4 = find(r, 'verify c4')
    assert.deepEqual([c4.reply.case, c4.reply.findings, c4.reply.proseEdits, c4.reply.removalAccounting], ['no-design', [], [], []])
    assert.deepEqual(c4.injected.map((x) => x.field), ['exercised'])
    const c8 = find(r, 'verify c8')
    assert.deepEqual(c8.rows.map((x) => [x.skill, x.class]), [['foo', 'PLAUSIBLE'], ['other skills', 'none']])
    const answered = c8Reply(c8, [{ file: '.claude/skills/foo/SKILL.md', line: 3, text: 'old thing' }, { file: '.claude/skills/bar/SKILL.md', line: 9, text: 'bar' }])
    assert.deepEqual(answered.reply.candidates.map((x) => [x.file, x.class]), [['.claude/skills/foo/SKILL.md', 'PLAUSIBLE'], ['.claude/skills/bar/SKILL.md', 'none']])
    assert.match(c8Reply({ rows: c8.rows.slice(0, 1) }, [{ file: '.claude/skills/bar/SKILL.md', line: 9 }]).missing, /answers \.claude\/skills\/bar\/SKILL\.md:9/)
    const check = find(r, 'ruling ruling-2 (check validation)')
    assert.deepEqual(check.record, { kind: 'ruling', fields: { check: 'validation', reason: 'accepted as pre-existing' } })
    assert.equal(check.check.valid, true)

    // review
    const r1 = find(r, 'ai-review r1')
    assert.match(r1.missing, /no category and no title/)
    assert.deepEqual(r1.partial.findings, [{ id: 'F1', severity: 'HIGH', file: 'src/two.ts', line: 2, body: 'two returned one when the input was empty, so the caller stored a wrong count. The fix returns two in that case.' }])
    assert.deepEqual(find(r, 'ai-review r2').reply, { summary: 'round 2: no finding', findings: [] })
    assert.deepEqual(find(r, 'ai-fix F1 r1').reply, { finding: 'F1', outcome: 'fixed', sha: F.fix, failureMode: 'two returned one when the input was empty, so the caller stored a wrong count.' })

    // archive
    const ingest = find(r, 'ingest')
    assert.equal(ingest.check.valid, true, ingest.check.errors.join('; '))
    assert.deepEqual(ingest.reply.pages.map((p) => [p.path, p.why]), [['.claude/memory/concepts/a.md', 'the invariant and the trap'], ['.claude/memory/index.md', 'the index lines the ingest added: - [a](concepts/a.md) — the thing']])
    assert.equal(ingest.reply.invariant, '**Invariant: the thing is done twice.** Nothing else holds it.')
    assert.equal(ingest.reply.likelyMistake, 'doing it once again.')
    assert.deepEqual(ingest.reply.log, { title: 'add-thing: the thing twice', bullets: ['The thing is done twice now.', 'Pages: [[a]] (the invariant and the trap).'] })
    assert.ok(ingest.source.every((s) => s.commit === F.ingest))
    assert.deepEqual(ingestStaleAnswers(ingest, [{ path: '.claude/memory/concepts/a.md' }]), { stale: [{ path: '.claude/memory/concepts/a.md', outcome: 'updated' }] })
    assert.match(ingestStaleAnswers(ingest, [{ path: '.claude/memory/concepts/b.md' }]).missing, /recorded no argument/)
    const resolve = find(r, 'resolve resolve-1')
    assert.deepEqual([resolve.record.fields.as, resolve.check.valid], ['adf-debt', true])
    assert.match(resolve.renamed, /flow-debt is adf-debt/)
    const merged = specMergeReply(sandbox, candidate, 'cap', [{ requirement: 'Thing', operation: 'MODIFIED' }])
    assert.equal(merged.check.valid, true, merged.check.errors.join('; '))
    assert.match(merged.reply[0].text, /^### Requirement: Thing\n\nThe system SHALL do the thing twice\./)

    // every built item names where it came from
    for (const item of Object.values(r.phases).flat().filter((i) => !i.missing)) assert.ok(item.source?.length, item.name)
    assert.equal(r.counts.built + r.counts.missing, Object.values(r.phases).flat().length)
  })
  assert.equal(snapshot(F.dir), before)
})

test('without the branch: the artifacts from the archive with tasks.md unticked, the task replies missing for want of history', () => {
  F.git('branch', '-q', '-m', BRANCH, 'kept-aside')
  try {
    withReplies((r, sandbox, candidate) => {
      assert.equal(candidate.history, 'no-branch')
      assert.equal(r.counts.invalid, 0, replyReport(r))
      const tasks = find(r, 'tasks.md')
      assert.equal(tasks.source[0].commit, F.merge)
      assert.match(tasks.text, /- \[ \] 1\.1/)
      assert.deepEqual(tasks.injected.map((x) => x.field), ['text'])
      assert.match(find(r, 'T1 impl').missing, /no per-commit history/)
      assert.equal(find(r, 'T1 review').check.valid, true, 'a review is built from the tick and the ledger alone')
      assert.match(find(r, 'final-review').missing, /no per-commit history/)
      assert.deepEqual(find(r, 'verify c4').injected.map((x) => x.field), ['exercised', 'proseEdits'])
      assert.equal(find(r, 'ingest').source[0].commit, F.merge)
      assert.equal(find(r, 'ingest').check.valid, true)
    })
  } finally {
    F.git('branch', '-q', '-m', 'kept-aside', BRANCH)
  }
})

test('a scope key has no recorded check, and the report names every item', () => {
  const [candidate] = findCandidates(F.dir, { author: DEV.name, since: F.base })
  const sandbox = createSandbox({ origin: F.dir })
  try {
    const r = buildReplies(sandbox, candidate, { scope: ['K-1'] })
    assert.match(find(r, 'scope-check K-1').missing, /no scope step/)
    const text = replyReport(r)
    assert.match(text, /^add-thing: \d+ built, \d+ missing, 0 invalid$/m)
    assert.match(text, /^apply\s+reply\s+T1 impl: built \(injected: testRuns\)$/m)
  } finally {
    sandbox.destroy()
  }
})

// ---------------------------------------------------------------- live

const LIVE = process.env.ADF_ORIGIN
test('live: the host set up and the replies built for the smallest candidate; the origin unchanged', { skip: !LIVE && 'ADF_ORIGIN is not set', timeout: 900_000 }, (t) => {
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', LIVE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim()
  const before = { refs: git('for-each-ref'), status: git('status', '--porcelain'), stash: git('stash', 'list'), head: git('rev-parse', 'HEAD') }
  const since = git('log', '--first-parent', 'origin/develop', '-1', '--format=%H', '--', 'openspec/schemas', '.claude/commands/opsx', '.claude/scripts')
  const author = process.env.ADF_AUTHOR ?? git('config', 'user.name')
  const found = findCandidates(LIVE, { author, since })
  assert.ok(found.length > 0, 'no candidate')
  const smallest = [...found].sort((a, b) => a.tasks - b.tasks || a.date.localeCompare(b.date))[0]
  const sandbox = createSandbox({ origin: LIVE })
  try {
    const c = sandbox.addCandidate('live', { base: smallest.base.commit })
    const host = setupHost(sandbox, c, { change: smallest.name })
    t.diagnostic(`candidate ${smallest.dir} (${smallest.tasks} tasks, ${smallest.history}, base ${smallest.base.commit.slice(0, 8)})`)
    t.diagnostic(`host edits (${hostEdits(host).length} paths):\n${editReport(host)}`)
    t.diagnostic(`host checks: ${JSON.stringify({ ok: host.ok, registry: host.checks.registry.ok, debt: host.checks.debt.ok, superpowers: host.checks.superpowers.ok, forge: host.checks.forge.state, tracker: host.checks.tracker.state, knowledge: `${host.checks.knowledge.state}, ${host.checks.knowledge.findings.length} finding(s)`, preflight: host.checks.preflight })}`)
    assert.equal(host.ok, true, editReport(host))
    const replies = buildReplies(sandbox, smallest)
    t.diagnostic(replyReport(replies))
    assert.equal(replies.counts.invalid, 0, replyReport(replies))
  } finally {
    sandbox.destroy()
  }
  assert.deepEqual({ refs: git('for-each-ref'), status: git('status', '--porcelain'), stash: git('stash', 'list'), head: git('rev-parse', 'HEAD') }, before)
})
