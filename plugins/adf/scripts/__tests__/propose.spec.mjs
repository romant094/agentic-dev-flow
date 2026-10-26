// propose.mjs, lib/propose.mjs and the propose subcommands of changes.mjs (next, done, skip,
// status --report, find's choices), the proposal and delta gates of specs.mjs, and forge.mjs
// reading its input from state. Against real git repositories in temp directories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { findChoices, inferChange, statusReport } from '../lib/changes.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { createChange, GATE_RUNNERS, markDone, nextArtifact, redirectTarget } from '../lib/propose.mjs'
import { pointerOf } from '../lib/active.mjs'
import { initRegistry, readRegistry, writeRegistry } from '../lib/registry.mjs'
import { forgeInput, forgeReport, titleFrom } from '../lib/roles.mjs'
import { GATES, loadSchema } from '../lib/schema.mjs'
import { deltaAgainstMain, parseProposalCapabilities } from '../lib/specs.mjs'
import { run as changesCli } from '../changes.mjs'
import { run as proposeCli } from '../propose.mjs'
import { run as specsCli } from '../specs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const schema = loadSchema()
const env = { CLAUDE_CODE_SESSION_ID: 'session-1' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const node = (script, args, cwd) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [join(here, '..', script), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

function host() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-propose-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  mkdirSync(join(root, 'openspec', 'specs', 'thing-store'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'specs', 'thing-store', 'spec.md'), MAIN_SPEC)
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: ['main'] })
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

const MAIN_SPEC = `# thing-store

## Purpose

Where things are kept, and how long they stay there before the store drops them.

## Requirements

### Requirement: Things are kept
The store SHALL keep every thing it is given.

#### Scenario: Keep
- **WHEN** a thing is given
- **THEN** it is kept
`

const PROPOSAL = (caps = '- `thing-export`: export things') => `## Why

Things cannot leave the store today, and every team asks for an export of them.

## What Changes

- An export.

## Capabilities

### New Capabilities
${caps}

### Modified Capabilities
<!-- None. -->

## Impact

None.
`

const DELTA = `## ADDED Requirements

### Requirement: Things are exported
The system SHALL export every thing on request.

#### Scenario: Export
- **WHEN** an export is asked for
- **THEN** every thing is exported
`

const TASKS = '## 1. Export\n\n- [ ] 1.1 Add the export\n'

const PLAN = `# Export Implementation Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1 | \`src/a.ts\` | 1 |

| Group A | Group B | Coupling | Reasoning (required if medium) |
|---|---|---|---|

---

### Task 1: the export

> Implements \`tasks.md\` 1.1.

**Files:**
- Modify: \`src/a.ts\` — the export

**Interfaces:** none

**Level:** mechanical

**Behaviour and acceptance:** the export works.

- [ ] **Step 1: Commit** — \`feat: export\`
`

function started(change = 'add-thing') {
  const main = host()
  const made = createChange(main, { change, branch: `feat/${change}`, base: 'integration' }, schema, { env })
  return { main, root: made.root, made, dir: join(made.root, 'openspec', 'changes', change) }
}

const write = (dir, file, text) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), text)
}

test('every gate the schema may declare has a runner', () => {
  assert.deepEqual([...GATE_RUNNERS].sort(), [...GATES].sort())
})

test('create makes the worktree, the change with its base, and the propose session', () => {
  const { root, made, main } = started()
  assert.deepEqual([made.ok, made.branch, made.base, made.root], [true, 'feat/add-thing', 'develop', join(main, '.claude', 'worktrees', 'add-thing')])
  assert.equal(JSON.parse(readFileSync(join(root, 'openspec', 'changes', 'add-thing', '.adf.json'), 'utf8')).base, 'develop')
  assert.equal(made.ledger.recorded, true)
  assert.equal(git(root, 'branch', '--show-current'), 'feat/add-thing')
  // The new change is the worktree's active change (lib/active.mjs).
  assert.deepEqual([made.active.key, pointerOf(root).change], ['feat/add-thing', 'add-thing'])
})

test('next hands out each artifact in order, done gates it, and commit takes only the change', async () => {
  const { main, root, dir } = started()
  let next = await nextArtifact(root, 'add-thing', schema)
  assert.deepEqual([next.artifact, next.optional], ['brainstorm', false])
  assert.equal(next.instructions.artifactId, 'brainstorm')

  // The brainstorming skill wrote its design to its default folder in the main checkout.
  write(main, 'docs/superpowers/specs/2026-10-15-thing-design.md', '# Design\n')
  write(dir, 'brainstorm.md', '# Brainstorm\n')
  const brainstorm = await markDone(root, 'add-thing', 'brainstorm', schema)
  assert.equal(brainstorm.ok, true)
  assert.deepEqual(brainstorm.moved.map((m) => m.to), ['openspec/changes/add-thing/design.md'])
  assert.equal(existsSync(join(main, 'docs/superpowers/specs/2026-10-15-thing-design.md')), false)

  next = await nextArtifact(root, 'add-thing', schema)
  assert.equal(next.artifact, 'proposal')
  assert.deepEqual(next.dependencyFiles, [join(dir, 'brainstorm.md')])
  write(dir, 'proposal.md', PROPOSAL())
  assert.equal((await markDone(root, 'add-thing', 'proposal', schema)).ok, true)

  next = await nextArtifact(root, 'add-thing', schema)
  assert.deepEqual([next.artifact, next.gates], ['specs', ['specs-validate', 'specs-capabilities', 'specs-against-main', 'specs-base']])
  write(dir, 'specs/thing-export/spec.md', DELTA)
  const specs = await markDone(root, 'add-thing', 'specs', schema)
  assert.deepEqual(specs.gates.map((g) => [g.gate, g.ok]), [['specs-validate', true], ['specs-capabilities', true], ['specs-against-main', true], ['specs-base', true]])

  assert.equal((await nextArtifact(root, 'add-thing', schema)).artifact, 'tasks')
  write(dir, 'tasks.md', TASKS)
  assert.equal((await markDone(root, 'add-thing', 'tasks', schema)).ok, true)

  assert.equal((await nextArtifact(root, 'add-thing', schema)).artifact, 'plan')
  write(dir, 'plan.md', PLAN)
  const plan = await markDone(root, 'add-thing', 'plan', schema)
  assert.deepEqual(plan.gates.map((g) => [g.gate, g.ok]), [['plan-symbols', true], ['plan-lint', true]])

  assert.deepEqual(await nextArtifact(root, 'add-thing', schema), { ok: true, done: true, change: 'add-thing' })

  write(root, 'stray.txt', 'not the change\n')
  const commit = await proposeCli(['commit', '--root', root])
  assert.equal(commit.code, 0, JSON.stringify(commit.result))
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(openspec): propose add-thing')
  assert.ok(commit.result.files.every((f) => f.startsWith('openspec/changes/add-thing/')))
  assert.ok(commit.result.files.includes('openspec/changes/add-thing/specs-base.json'), 'the specs-base gate wrote the snapshot, and the commit holds it')
  assert.equal(git(root, 'status', '--porcelain'), '?? stray.txt')

  const report = node('changes.mjs', ['status', '--report', '--root', root], root).out.report
  assert.match(report, /^Change: add-thing\nBranch: feat\/add-thing\n/)
  assert.match(report, /Base: develop\n/)
  assert.match(report, /- plan: done\n/)
  assert.doesNotMatch(report, /Merge request/, 'the merge request is the forge call\'s own report')
  assert.match(node('changes.mjs', ['status', '--report', '--root', root, '--forge', '{"state":"none"}'], root).out.error, /status takes no "--forge"/)
  assert.match(report, /Next: \/adf:apply$/)
})

test('a written artifact that fails its gate blocks next and the commit', async () => {
  const { root, dir } = started()
  write(dir, 'brainstorm.md', '# B\n')
  write(dir, 'proposal.md', PROPOSAL('- `thing-export`: export\n- `export`: one word'))
  write(dir, 'specs/thing-export/spec.md', DELTA)
  const next = await nextArtifact(root, 'add-thing', schema)
  assert.equal(next.ok, false)
  assert.equal(next.blockedBy, 'specs')
  const caps = next.gates.find((g) => g.gate === 'specs-capabilities')
  assert.deepEqual([caps.ok, caps.missingSpec, caps.badName], [false, ['export'], ['export']])
  write(dir, 'tasks.md', TASKS)
  write(dir, 'plan.md', PLAN)
  const commit = await proposeCli(['commit', '--change', 'add-thing', '--root', root])
  assert.equal(commit.code, 1)
  assert.match(commit.result.refusal, /specs\/specs-capabilities/)
})

test('an optional artifact can be skipped, a required one cannot', async () => {
  const { root, dir } = started()
  write(dir, 'brainstorm.md', '# B\n')
  const next = await nextArtifact(root, 'add-thing', schema)
  assert.deepEqual([next.artifact, next.optional], ['design', true])
  assert.equal(node('changes.mjs', ['skip', 'proposal', '--root', root], root).code, 1)
  assert.deepEqual(node('changes.mjs', ['skip', 'design', '--root', root], root).out.skipped, ['design'])
  assert.equal((await nextArtifact(root, 'add-thing', schema)).artifact, 'proposal')
})

test('done refuses a project rule copied into the artifact, and a missing output', async () => {
  const { root, dir } = started()
  write(root, 'openspec/rules/proposal.md', '- Name every capability after the domain, never after a screen.\n')
  write(dir, 'brainstorm.md', '# B\n')
  assert.match((await markDone(root, 'add-thing', 'proposal', schema)).refusal, /has no output/)
  write(dir, 'proposal.md', `${PROPOSAL()}\nName every capability after the domain, never after a screen.\n`)
  const done = await markDone(root, 'add-thing', 'proposal', schema)
  assert.equal(done.ok, false)
  assert.deepEqual(done.copied.map((c) => [c.kind, c.source]), [['rule', 'openspec/rules/proposal.md']])
})

test('the writing subcommands refuse the main checkout; status infers the one change in a worktree', () => {
  const { main, root } = started()
  assert.match(node('changes.mjs', ['next', '--change', 'add-thing', '--root', main], main).out.error, /is the main checkout/)
  assert.equal(node('changes.mjs', ['status', '--root', root], root).out.changeName, 'add-thing')
  assert.throws(() => inferChange(main, undefined, schema), /holds no active change/)
})

test('a skill file goes to the change file it belongs in', () => {
  assert.equal(redirectTarget('brainstorm', '2026-10-15-x-design.md'), 'design.md')
  assert.equal(redirectTarget('brainstorm', '2026-10-15-x-brainstorm.md'), 'brainstorm.md')
  assert.equal(redirectTarget('plan', '2026-10-15-x.md'), 'plan.md')
})

test('the proposal capabilities parser skips placeholders, None and comments', () => {
  const text = PROPOSAL('- `<name>`: template\n- **data-export**: bold\n- None.\n<!-- - `hidden-cap`: no -->').replace('<!-- None. -->', '- `thing-store`: changed')
  assert.deepEqual(parseProposalCapabilities(text), { new: ['data-export'], modified: ['thing-store'], section: true })
})

test('specs.mjs capabilities and validate --against-main report the contract and the deltas', () => {
  const { root, dir } = started()
  write(dir, 'proposal.md', PROPOSAL('- `thing-store`: collides').replace('<!-- None. -->', '- `no-such-cap`: missing'))
  write(dir, 'specs/thing-store/spec.md', DELTA)
  write(dir, 'specs/extra-cap/spec.md', DELTA)
  const caps = specsCli(['capabilities', '--root', root])
  assert.deepEqual([caps.ok, caps.newCollides, caps.modifiedNotFound, caps.missingSpec, caps.unlistedSpec], [false, ['thing-store'], ['no-such-cap'], ['no-such-cap'], ['extra-cap']])
  const against = specsCli(['validate', '--change', 'add-thing', '--against-main', '--root', root])
  assert.equal(against.againstMain.ok, true)
  assert.equal(against.items[0].valid, true)
  assert.equal(specsCli(['validate', '--change', 'add-thing', '--root', root]).againstMain, undefined)
})

test('deltaAgainstMain names every unmatched header and every missing field', () => {
  const delta = `## ADDED Requirements

### Requirement: Things are kept
The store SHALL keep every thing, forever.

#### Scenario: K
- **WHEN** x
- **THEN** y

## MODIFIED Requirements

### Requirement: Things are Kept
The store SHALL keep things.

#### Scenario: K
- **WHEN** x
- **THEN** y

## REMOVED Requirements

### Requirement: Nothing like this

**Reason**: gone

## RENAMED Requirements

- FROM: \`### Requirement: Things are kept\`
- TO: \`### Requirement: Things are stored\`
`
  const findings = deltaAgainstMain(delta, MAIN_SPEC).map((f) => [f.kind, f.operation, f.requirement])
  assert.deepEqual(findings, [
    ['already-in-main', 'ADDED', 'Things are kept'],
    ['unmatched-header', 'MODIFIED', 'Things are Kept'],
    ['unmatched-header', 'REMOVED', 'Nothing like this'],
    ['missing-field', 'REMOVED', 'Nothing like this'],
    ['missing-field', 'REMOVED', 'Nothing like this'],
    ['missing-field', 'RENAMED', 'Things are kept']
  ])
  assert.deepEqual(deltaAgainstMain(DELTA, null), [])
})

test('find choices label every change and unresolved worktree, and name duplicates', () => {
  const c = (name, root) => ({ name, root, branch: `feat/${name}`, completedTasks: 1, totalTasks: 3 })
  const { duplicates, choices } = findChoices({ changes: [c('a-b', '/m'), c('a-b', '/w'), c('c-d', '/w2')], unresolved: [{ root: '/w3', branch: 'fix/x' }] })
  assert.deepEqual(duplicates, [{ name: 'a-b', roots: ['/m', '/w'] }])
  assert.deepEqual(choices.map((x) => x.name), ['a-b', 'a-b', 'c-d', null])
  assert.match(choices[3].label, /^change name unresolved — fix\/x, in \/w3$/)
  assert.match(choices[0].label, /1\/3 tasks.*one of two copies/)
})

test('forge.mjs renders its own report for each forge state', () => {
  assert.equal(forgeReport('open', { state: 'done', url: 'https://mr/1', reused: true }), 'Merge request: https://mr/1 (reused)')
  assert.equal(forgeReport('open', { state: 'done', url: 'https://mr/1', reused: false }), 'Merge request: https://mr/1 (opened as a draft)')
  assert.equal(forgeReport('finalize', { state: 'done', number: 7 }), 'Merge request: !7 (out of draft, ready to merge)')
  assert.equal(forgeReport('push', { state: 'done' }), 'Push: done')
  assert.equal(forgeReport('open', { state: 'degraded', hint: 'log in', fallback: ['git push'] }), 'Merge request: not done yet. log in\n  git push')
  assert.equal(forgeReport('open', { state: 'refused', error: 'boom' }), 'Merge request: refused; boom')
  assert.match(forgeReport('push', { state: 'none' }), /^Push: none; no forge plugin is enabled/)
  const status = { changeName: 'x', applyRequires: ['plan'], artifacts: [{ id: 'plan', status: 'ready' }] }
  assert.match(statusReport(status, { root: '/w', branch: 'feat/x', base: 'develop' }), /Next: \/adf:propose x to finish its artifacts$/)
})

test('next records the propose session of a continued change once per session', async () => {
  const { root } = started()
  const ledger = () => readFileSync(join(root, '.superpowers', 'sdd', 'add-thing', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual((await changesCli(['next', '--root', root], { env })).ledger, { recorded: false, id: 'session-1', already: true }, 'create recorded this session')
  const later = { CLAUDE_CODE_SESSION_ID: 'session-2' }
  const first = await changesCli(['next', '--root', root], { env: later })
  assert.equal(first.artifact, 'brainstorm')
  assert.deepEqual([first.ledger.recorded, first.ledger.id], [true, 'session-2'])
  assert.deepEqual((await changesCli(['next', '--root', root], { env: later })).ledger, { recorded: false, id: 'session-2', already: true })
  assert.deepEqual(ledger().map((r) => [r.kind, r.phase, r.sessionId]), [['session', 'propose', 'session-1'], ['session', 'propose', 'session-2']])
  assert.match((await changesCli(['next', '--root', root], { env: {} })).ledger.error, /CLAUDE_CODE_SESSION_ID/)
  await assert.rejects(changesCli(['next', '--change', 'no-such', '--root', root], { env: later }))
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', 'no-such')), false, 'no ledger for a change that does not exist')
})

test('next gives brainstorm the knowledge index from the knowledge role, and no index without a provider', async () => {
  const { root, dir } = started()
  const done = (index) => () => ({ state: 'done', plugin: 'memory', index })
  const first = await changesCli(['next', '--root', root], { env, knowledge: done('.claude/memory/index.md') })
  assert.equal(first.artifact, 'brainstorm')
  assert.deepEqual(first.knowledge, { state: 'done', index: join(root, '.claude/memory/index.md'), report: 'Knowledge: index .claude/memory/index.md' })
  const none = await changesCli(['next', '--root', root], { env, knowledge: () => ({ state: 'none', point: 'knowledge' }) })
  assert.equal(none.knowledge.index, null)
  assert.match(none.knowledge.report, /brainstorm reads no index/)
  const failed = await changesCli(['next', '--root', root], {
    env,
    knowledge: () => {
      throw new Error('boom')
    }
  })
  assert.deepEqual([failed.knowledge.state, failed.knowledge.index], ['refused', null])
  write(dir, 'brainstorm.md', '# B\n')
  await markDone(root, 'add-thing', 'brainstorm', schema)
  const later = await changesCli(['next', '--root', root], { env, knowledge: done('x.md') })
  assert.notEqual(later.artifact, 'brainstorm')
  assert.equal('knowledge' in later, false, 'only brainstorm reads the index')
})

test('the forge input comes from state: branch, base, protected, and the title type from the branch', () => {
  assert.equal(titleFrom('feat/add-x', 'core: add x'), 'feat(core): add x')
  assert.equal(titleFrom('fix/DEV-1/y', 'repair y'), 'fix: repair y')
  assert.throws(() => titleFrom('add-x', 'x'), /no Conventional Commits type/)
  const state = { change: 'add-x', branch: 'feat/add-x', base: 'develop', protected: ['develop', 'main'] }
  assert.deepEqual(forgeInput('open', state, { summary: 'core: add x' }), { ...state, title: 'feat(core): add x', draft: true })
  assert.deepEqual(forgeInput('push', state), { change: 'add-x', branch: 'feat/add-x', protected: ['develop', 'main'] })
  assert.throws(() => forgeInput('open', state, { input: { branch: 'other' }, title: 't' }), /input.branch is "other", but the core reads "feat\/add-x"/)
  assert.throws(() => forgeInput('open', { ...state, base: null }, { title: 't' }), /records no base/)
  assert.throws(() => forgeInput('finalize', state), /needs a title/)
})

const ECHO = `let t='';process.stdin.on('data',(d)=>t+=d).on('end',()=>{console.log(JSON.stringify({state:'done',input:JSON.parse(t).input}))})`

test('forge.mjs open --change sends what the core read, and refuses the main checkout', () => {
  const { main, root } = started()
  mkdirSync(join(root, 'plugins', 'fake', 'scripts'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'fake', 'adf-extension.json'), JSON.stringify({ name: 'fake', contract: '1.2', provides: { forge: { script: 'scripts/f.mjs', operations: ['check', 'open', 'push', 'finalize'] } } }))
  writeFileSync(join(root, 'plugins', 'fake', 'scripts', 'f.mjs'), ECHO)
  writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/fake' }] })
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const opened = node('forge.mjs', ['open', '--summary', 'core: add thing', '--root', root, '--home', home], root)
  assert.deepEqual(opened.out.input, { change: 'add-thing', branch: 'feat/add-thing', base: 'develop', protected: ['develop', 'main'], title: 'feat(core): add thing', draft: true })
  assert.match(node('forge.mjs', ['push', '--change', 'add-thing', '--root', main, '--home', home], main).out.error, /is the main checkout/)
  assert.equal(opened.out.report, 'Merge request: no link returned (opened as a draft)')
})

test('forge.mjs --summary on a branch the developer named without a type prefix refuses and asks for --title', () => {
  const { root } = started()
  mkdirSync(join(root, 'plugins', 'fake', 'scripts'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'fake', 'adf-extension.json'), JSON.stringify({ name: 'fake', contract: '1.2', provides: { forge: { script: 'scripts/f.mjs', operations: ['check', 'open', 'push', 'finalize'] } } }))
  writeFileSync(join(root, 'plugins', 'fake', 'scripts', 'f.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(root, 'called'))}, 'x')\n${ECHO}`)
  writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/fake' }] })
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  for (const branch of ['add-thing-edited', 'anton/add-thing']) {
    git(root, 'branch', '-m', branch)
    const refused = node('forge.mjs', ['open', '--change', 'add-thing', '--summary', 'core: add thing', '--root', root, '--home', home], root)
    assert.equal(refused.code, 1)
    assert.equal(refused.out.state, 'refused')
    assert.match(refused.out.error, new RegExp(`the branch "${branch}" has no Conventional Commits type prefix .*pass --title "<type>\\(<scope>\\): <description>" in full`))
    assert.match(refused.out.report, /^Merge request: refused; /)
    assert.equal(existsSync(join(root, 'called')), false, 'nothing reached the forge')
  }
  const titled = node('forge.mjs', ['open', '--change', 'add-thing', '--title', 'feat(core): add thing', '--root', root, '--home', home], root)
  assert.equal(titled.out.input.title, 'feat(core): add thing')
  assert.equal(existsSync(join(root, 'called')), true, 'the full title reaches the forge')
})
