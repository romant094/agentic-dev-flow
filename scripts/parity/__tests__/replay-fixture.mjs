// A fixture origin for the phase drivers (replay-drive.spec.mjs): a host shaped like the real
// origin (a .gitignore, a debt tree with the `Jira` column, memory pages, a main spec) and one
// change made with the origin's flow on a kept branch: propose, a group branch merged, a task
// committed on the change branch, the apply record, verify, review with a fixed finding, archive
// and ingest; then GitLab's squash merge onto develop.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEV = { name: 'Dev One', email: 'dev@example.com' }
export const CHANGE = 'add-thing'
export const BRANCH = 'feat/K-1/add-thing'
export const ARCHIVED = '2026-10-05-add-thing'

// `then` is the scenario's outcome: the archive writes the delta's, so the merge result is the
// one the delta asks for.
const MAIN_SPEC = (verb = 'do the thing.', then = 'the thing is done') => `# cap Specification

## Purpose

The cap capability is a fixture capability whose purpose text is long enough for validation.

## Requirements

### Requirement: Thing

The system SHALL ${verb}

#### Scenario: thing

- **WHEN** a thing happens
- **THEN** ${then}
`

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

**Interfaces:** none

**Level:** mechanical

**Behaviour and acceptance:** one is exported.

- [ ] **Step 1: Write** — write it.
- [ ] **Step 2: Commit** — \`feat(x): one\`

---

### Task 2: Two

> Implements \`tasks.md\` 1.2.

**Files:**
- Create: \`src/two.ts\`

**Interfaces:** none

**Level:** mechanical

**Behaviour and acceptance:** two is exported.

- [ ] **Step 1: Write** — write it.
- [ ] **Step 2: Commit** — \`feat(x): two\`
`

const TASKS = (tick) => `## 1. Thing\n\n- [${tick}] 1.1 One\n- [${tick}] 1.2 Two\n`

const PROPOSAL = `## Why\n\nThe thing.\n\n## What Changes\n\n- The thing.\n\n## Capabilities\n\n### New Capabilities\n\n### Modified Capabilities\n\n- \`cap\`: twice\n\n## Impact\n\nNone.\n`

const VERIFY = `# Verification Report

## 1. Structural Validation

**Result**: valid.

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
| other skills | none | No match. | — |
`

const REVIEW = (sha) => `# AI Code Review Record

**Verdict**: PASS

**Rounds**: \`2\` (round 1: \`REQUEST CHANGES\`; round 2: \`APPROVE\`)

**Counts**: CRITICAL \`0\` | HIGH \`1\` | MEDIUM \`0\` | LOW \`0\`

## Findings

| # | Severity | Where | Disposition |
|---|---|---|---|
| 1 | HIGH | \`src/two.ts:1\` | fixed in \`${sha}\` |

Finding 1: two returned one when the input was empty, so the caller stored a wrong count. The fix
returns two in that case.
`

const LEDGER = [
  { id: 'session-1', kind: 'session', phase: 'propose' },
  { id: 'session-2', kind: 'session', phase: 'apply' },
  { id: 'debt-1', kind: 'debt', task: '2', what: 'two duplicates one', reason: 'out of scope' },
  { id: 'session-3', kind: 'session', phase: 'verify' },
  { id: 'session-4', kind: 'session', phase: 'review' },
  { id: 'session-5', kind: 'session', phase: 'archive' },
  { id: 'resolve-1', kind: 'resolve', debt: 'debt-1', as: 'follow-up', where: 'a later change' }
].map((r, i) => JSON.stringify({ ...r, at: `2026-10-05T10:0${i}:00.000Z`, sessionId: 's' })).join('\n') + '\n'

const ROOT_INDEX = '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`snmp`](snmp/index.md) | SNMP |\n'
const BLOCK = '| ID | Title | Anchors | Class | Source | Jira |\n|---|---|---|---|---|---|\n| `snmp-01` | Pool leaks | `pool.ts:10` | defect | `x` | K-9 |\n'

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

export function fixtureOrigin() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-drive-origin-'))), 'origin')
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

  commit({
    '.gitignore': '.claude/worktrees/\nnode_modules\n.env\n',
    'package.json': '{ "name": "host", "private": true }\n',
    'openspec/specs/cap/spec.md': MAIN_SPEC(),
    '.claude/memory/index.md': '# Index\n',
    '.claude/memory/concepts/a.md': PAGE,
    '.claude/memory/log.md': LOG,
    '.claude/memory/tech-debt/index.md': ROOT_INDEX,
    '.claude/memory/tech-debt/snmp/index.md': BLOCK,
    'src/.keep': ''
  }, 'init')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', BRANCH)
  const propose = commit(change({ '.openspec.yaml': 'schema: sdd-plus-superpowers\ncreated: 2026-10-05\n', 'brainstorm.md': '# Brainstorm\n\nThe thing.\n', 'proposal.md': PROPOSAL, 'specs/cap/spec.md': DELTA, 'tasks.md': TASKS(' '), 'plan.md': PLAN }), `docs(openspec): propose ${CHANGE}`)
  git('checkout', '-q', '-b', `${BRANCH}--group-A`)
  const one = commit({ 'src/one.ts': 'export const one = 1\n' }, 'feat(x): one')
  git('checkout', '-q', BRANCH)
  git('merge', '-q', '--no-ff', '-m', `Merge branch '${BRANCH}--group-A' into ${BRANCH}`, `${BRANCH}--group-A`)
  const two = commit({ 'src/two.ts': 'export const two = 2\n' }, 'feat(x): two')
  const record = commit(change({ '.apply-test-record.md': '# Apply test record\n', 'tasks.md': TASKS('x') }), `chore(openspec): record apply of ${CHANGE}`)
  commit(change({ 'verify.md': VERIFY }), `docs(openspec): verify ${CHANGE}`)
  const fix = commit({ 'src/two.ts': 'export const two = () => 2\n' }, 'fix(x): two in the empty case')
  commit(change({ 'review.md': REVIEW(fix) }), `docs(openspec): review ${CHANGE}`)
  for (const f of ['.openspec.yaml', 'brainstorm.md', 'proposal.md', 'specs/cap/spec.md', 'tasks.md', 'plan.md', '.apply-test-record.md', 'verify.md', 'review.md']) {
    mkdirSync(dirname(join(dir, `openspec/changes/archive/${ARCHIVED}/${f}`)), { recursive: true })
    execFileSync('git', ['-C', dir, 'mv', `openspec/changes/${CHANGE}/${f}`, `openspec/changes/archive/${ARCHIVED}/${f}`])
  }
  const archive = commit({ [`openspec/changes/archive/${ARCHIVED}/ledger.jsonl`]: LEDGER, 'openspec/specs/cap/spec.md': MAIN_SPEC('do the thing twice.', 'the thing is done twice') }, `docs(openspec): archive ${CHANGE}`)
  const ingest = commit({ '.claude/memory/concepts/a.md': PAGE_AFTER, '.claude/memory/log.md': LOG_AFTER, '.claude/memory/index.md': '# Index\n\n- [a](concepts/a.md) — the thing\n' }, `docs(memory): ingest what ${CHANGE} taught`)

  // GitLab's squash merge of the branch onto develop.
  git('checkout', '-q', 'develop')
  commit({ 'b.txt': 'b\n' }, 'unrelated')
  const parent = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'squash-tmp')
  git('checkout', '-q', BRANCH, '--', '.')
  git('add', '-A')
  git('commit', '-q', '-m', `feat(x): add the thing (K-1)`)
  git('checkout', '-q', 'develop')
  git('merge', '-q', '--no-ff', '-m', `Merge branch '${BRANCH}' into 'develop'\n\nfeat(x): add the thing (K-1)\n\nSee merge request group/repo!7`, 'squash-tmp')
  git('branch', '-q', '-D', 'squash-tmp')
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
  return { dir, base, parent, propose, one, two, record, fix, archive, ingest, merge: git('rev-parse', 'HEAD'), git }
}
