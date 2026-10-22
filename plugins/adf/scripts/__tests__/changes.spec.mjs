import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyInstructions,
  archiveChange,
  artifactInstructions,
  changeStatus,
  listChanges,
  newChange,
  parseTasks,
  readChangeMeta,
  resolveOutputs
} from '../lib/changes.mjs'
import { setBranches } from '../lib/branches.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { loadSchema } from '../lib/schema.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'changes.mjs')
const schema = loadSchema()
const host = () => mkdtempSync(join(tmpdir(), 'adf-changes-'))
const write = (root, path, text = 'x') => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const statuses = (status) => Object.fromEntries(status.artifacts.map((a) => [a.id, a.status]))

test('new writes the change directory and its metadata, once', () => {
  const root = host()
  const created = newChange(root, 'add-thing', schema, { today: '2026-10-13' })
  assert.equal(created.schema, 'adf')
  const meta = JSON.parse(readFileSync(join(root, 'openspec/changes/add-thing/.adf.json'), 'utf8'))
  assert.deepEqual(meta, { schema: 'adf', schemaVersion: 1, created: '2026-10-13' })
  assert.throws(() => newChange(root, 'add-thing', schema), /already exists/)
  assert.throws(() => newChange(root, 'Add_Thing', schema), /kebab-case/)
  assert.throws(() => newChange(root, 'archive', schema), /kebab-case/)
})

test('a change an earlier flow created takes its base from .openspec.yaml, else the integration branch', () => {
  const root = host()
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: [] })
  const dir = join(root, 'openspec/changes/add-thing')
  mkdirSync(dir, { recursive: true })
  assert.equal(readChangeMeta(root, dir), null)
  write(root, 'openspec/changes/add-thing/.openspec.yaml', 'schema: sdd\ncreated: 2026-10-20\n')
  assert.deepEqual(readChangeMeta(root, dir), { base: 'develop', from: '.openspec.yaml' })
  write(root, 'openspec/changes/add-thing/.openspec.yaml', 'schema: sdd\nbase: release\n')
  assert.deepEqual(readChangeMeta(root, dir), { base: 'release', from: '.openspec.yaml' })
  // The port's own metadata wins, even without a base: it is never completed from elsewhere.
  write(root, 'openspec/changes/add-thing/.adf.json', '{"schema":"adf"}\n')
  assert.deepEqual(readChangeMeta(root, dir), { schema: 'adf' })
  write(root, 'openspec/changes/add-thing/.adf.json', '{"base":"main"}\n')
  assert.deepEqual(readChangeMeta(root, dir), { base: 'main' })
  write(root, 'openspec/changes/add-thing/.adf.json', '{')
  assert.equal(readChangeMeta(root, dir), null)
})

test('a glob output matches nested files only under its pattern', () => {
  const root = host()
  const dir = join(root, 'c')
  write(root, 'c/specs/a/spec.md')
  write(root, 'c/specs/b/c/spec.md')
  write(root, 'c/specs/notes.txt')
  write(root, 'c/specs.md')
  assert.deepEqual(resolveOutputs(dir, 'specs/**/*.md'), [join(dir, 'specs/a/spec.md'), join(dir, 'specs/b/c/spec.md')])
  assert.deepEqual(resolveOutputs(dir, 'specs.md'), [join(dir, 'specs.md')])
  assert.deepEqual(resolveOutputs(dir, 'missing.md'), [])
})

test('status follows the graph as artifacts appear', () => {
  const root = host()
  newChange(root, 'c', schema)
  let status = changeStatus(root, 'c', schema)
  assert.equal(statuses(status).brainstorm, 'ready')
  assert.deepEqual(status.artifacts.find((a) => a.id === 'proposal').missingDeps, ['brainstorm'])

  write(root, 'openspec/changes/c/brainstorm.md')
  status = changeStatus(root, 'c', schema)
  assert.equal(statuses(status).proposal, 'ready')
  assert.equal(statuses(status).design, 'ready')

  write(root, 'openspec/changes/c/proposal.md')
  write(root, 'openspec/changes/c/specs/cap/spec.md')
  status = changeStatus(root, 'c', schema)
  assert.equal(statuses(status).specs, 'done')
  assert.equal(statuses(status).tasks, 'ready')
  assert.equal(status.isComplete, false)
  assert.deepEqual(status.applyRequires, ['plan'])
  assert.throws(() => changeStatus(root, 'nope', schema), /no change "nope"/)
})

test('instructions carry the template, the project guidance and the graph neighbours', () => {
  const root = host()
  newChange(root, 'c', schema)
  write(root, 'openspec/context.md', '# Project\n\nA project.\n')
  write(root, 'openspec/rules/proposal.md', '# Proposal rules\n\n- Name the capability.\n- Keep it short.\n')
  write(root, 'openspec/changes/c/brainstorm.md')
  const result = artifactInstructions(root, 'c', 'proposal', schema)
  assert.match(result.template, /^## Why/)
  assert.equal(result.context, '# Project\n\nA project.')
  assert.deepEqual(result.rules, ['Name the capability.', 'Keep it short.'])
  assert.deepEqual(result.dependencies, [{ id: 'brainstorm', done: true, path: 'brainstorm.md', description: schema.artifacts[0].description }])
  assert.deepEqual(result.unlocks, ['specs'])
  assert.match(result.instruction, /^Create the proposal document from the brainstorming output\./)
  assert.throws(() => artifactInstructions(root, 'c', 'nope', schema), /no artifact "nope"/)
})

test('apply is blocked until plan exists and its tasks exist, then tracks progress', () => {
  const root = host()
  newChange(root, 'c', schema)
  assert.deepEqual(applyInstructions(root, 'c', schema).missingArtifacts, ['plan'])
  for (const file of ['brainstorm.md', 'proposal.md', 'specs/a/spec.md', 'plan.md']) write(root, `openspec/changes/c/${file}`)
  assert.match(applyInstructions(root, 'c', schema).instruction, /tasks\.md is missing/)
  write(root, 'openspec/changes/c/tasks.md', '## 1. Group\n')
  assert.match(applyInstructions(root, 'c', schema).instruction, /lists no tasks/)
  write(root, 'openspec/changes/c/tasks.md', '## 1. Group\n\n- [x] 1.1 One\n- [ ] 1.2 Two\n')
  const ready = applyInstructions(root, 'c', schema)
  assert.equal(ready.state, 'ready')
  assert.deepEqual(ready.progress, { total: 2, complete: 1, remaining: 1 })
  write(root, 'openspec/changes/c/tasks.md', '- [x] 1.1 One\n* [X] 1.2 Two\n')
  assert.equal(applyInstructions(root, 'c', schema).state, 'all_done')
})

test('tasks: only unindented checkboxes count', () => {
  const tasks = parseTasks('- [ ] a\n  - [ ] nested\n- [x] b\n-[ ] tight\n* [X] c\n')
  assert.deepEqual(tasks.map((t) => [t.description, t.done]), [['a', false], ['b', true], ['c', true]])
})

test('list skips the archive and reports task progress', () => {
  const root = host()
  assert.deepEqual(listChanges(root, schema), { changes: [] })
  newChange(root, 'one', schema)
  newChange(root, 'two', schema)
  write(root, 'openspec/changes/archive/2026-01-01-old/proposal.md')
  write(root, 'openspec/changes/two/tasks.md', '- [x] a\n- [ ] b\n')
  const byName = Object.fromEntries(listChanges(root, schema).changes.map((c) => [c.name, c]))
  assert.deepEqual(Object.keys(byName).sort(), ['one', 'two'])
  assert.equal(byName.one.status, 'no-tasks')
  assert.equal(byName.two.status, 'in-progress')
  assert.equal(byName.two.completedTasks, 1)
})

test('the CLI prints JSON and exits 1 on a refusal', () => {
  const root = host()
  const run = (...args) => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root], { encoding: 'utf8' })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }
  assert.equal(run('new', 'add-thing').code, 0)
  assert.equal(run('status', '--change', 'add-thing').out.artifacts[0].status, 'ready')
  assert.equal(run('instructions', 'apply', '--change', 'add-thing').out.state, 'blocked')
  const refused = run('new', 'add-thing')
  assert.equal(refused.code, 1)
  assert.match(refused.out.error, /already exists/)
  assert.equal(run('schema').out.name, 'adf')
})

test('new records the base branch when given one', () => {
  const root = host()
  newChange(root, 'add-thing', schema, { base: 'develop', today: '2026-10-14' })
  const meta = JSON.parse(readFileSync(join(root, 'openspec/changes/add-thing/.adf.json'), 'utf8'))
  assert.equal(meta.base, 'develop')
})

test('instructions deliver the project guides the artifact names, or null text when missing', () => {
  const root = host()
  newChange(root, 'add-thing', schema)
  assert.deepEqual(artifactInstructions(root, 'add-thing', 'plan', schema).guides, [
    { path: 'openspec/planning.md', text: null }
  ])
  write(root, 'openspec/planning.md', '# Planning Guide\n\nRun the bench.\n')
  assert.deepEqual(artifactInstructions(root, 'add-thing', 'plan', schema).guides, [
    { path: 'openspec/planning.md', text: '# Planning Guide\n\nRun the bench.' }
  ])
  assert.deepEqual(artifactInstructions(root, 'add-thing', 'tasks', schema).guides, [])
})

test('verify is ready once the plan exists, and its instructions carry the procedure, the template and the planning guide', () => {
  const root = host()
  newChange(root, 'c', schema)
  for (const file of ['brainstorm.md', 'proposal.md', 'specs/a/spec.md', 'tasks.md']) write(root, `openspec/changes/c/${file}`)
  assert.deepEqual(changeStatus(root, 'c', schema).artifacts.find((a) => a.id === 'verify').missingDeps, ['plan'])
  write(root, 'openspec/changes/c/plan.md')
  assert.equal(statuses(changeStatus(root, 'c', schema)).verify, 'ready')
  write(root, 'openspec/planning.md', '# Planning Guide\n\n## Whole-suite command\n\nnpm test\n')
  const result = artifactInstructions(root, 'c', 'verify', schema)
  assert.equal(result.outputPath, 'verify.md')
  assert.match(result.instruction, /verify\.mjs" run --change/)
  assert.match(result.instruction, /verify\.mjs" verdict --change/)
  assert.match(result.template, /^Verdict: /m)
  assert.deepEqual(result.guides, [{ path: 'openspec/planning.md', text: '# Planning Guide\n\n## Whole-suite command\n\nnpm test' }])
  assert.deepEqual(result.dependencies.map((d) => [d.id, d.done]), [['plan', true]])
  assert.deepEqual(result.unlocks, ['review'])
  write(root, 'openspec/changes/c/verify.md')
  assert.equal(statuses(changeStatus(root, 'c', schema)).verify, 'done')
})

test('archive copies the ledger once, moves the change under its UTC date, and reports a second run', () => {
  const root = host()
  write(root, 'openspec/changes/add-x/proposal.md', '# add-x\n')
  write(root, '.superpowers/sdd/add-x/ledger.jsonl', '{"id":"debt-1"}\n')
  const now = new Date('2026-10-19T23:30:00Z')
  const out = archiveChange(root, 'add-x', { now })
  assert.deepEqual(out, { changeName: 'add-x', from: 'openspec/changes/add-x', target: 'openspec/changes/archive/2026-10-19-add-x', ledger: 'copied', already: false })
  assert.equal(existsSync(join(root, 'openspec/changes/add-x')), false)
  assert.equal(readFileSync(join(root, out.target, 'ledger.jsonl'), 'utf8'), '{"id":"debt-1"}\n')
  assert.equal(readFileSync(join(root, out.target, 'proposal.md'), 'utf8'), '# add-x\n')
  assert.deepEqual(archiveChange(root, 'add-x', { now }), { ...out, already: true })
  assert.throws(() => archiveChange(root, 'add-y', { now }), /no change "add-y"/)
})

test('archive refuses an existing target, and a failed ledger copy moves nothing; a missing ledger is no failure', () => {
  const root = host()
  const now = new Date('2026-10-19T10:00:00Z')
  write(root, 'openspec/changes/add-x/proposal.md')
  write(root, 'openspec/changes/archive/2026-10-19-add-x/proposal.md')
  assert.throws(() => archiveChange(root, 'add-x', { now }), /2026-10-19-add-x already exists; rename the change, delete the duplicate archive if it is one, or archive it tomorrow/)
  assert.equal(existsSync(join(root, 'openspec/changes/add-x')), true)

  write(root, 'openspec/changes/add-y/proposal.md')
  mkdirSync(join(root, '.superpowers/sdd/add-y/ledger.jsonl'), { recursive: true })
  assert.throws(() => archiveChange(root, 'add-y', { now }), /the ledger could not be copied into openspec\/changes\/add-y .*nothing was moved/)
  assert.equal(existsSync(join(root, 'openspec/changes/add-y')), true)
  assert.equal(existsSync(join(root, 'openspec/changes/archive/2026-10-19-add-y')), false)

  write(root, 'openspec/changes/add-z/proposal.md')
  assert.equal(archiveChange(root, 'add-z', { now }).ledger, 'none')
})

test('changes.mjs archive moves the change and refuses the main checkout of a repository', () => {
  const root = host()
  write(root, 'openspec/changes/add-x/proposal.md')
  const out = JSON.parse(execFileSync('node', [cli, 'archive', '--change', 'add-x', '--root', root], { encoding: 'utf8' }))
  assert.match(out.target, /^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-add-x$/)
  execFileSync('git', ['init', '-q', root])
  write(root, 'openspec/changes/add-y/proposal.md')
  let refused
  try {
    execFileSync('node', [cli, 'archive', '--change', 'add-y', '--root', root], { encoding: 'utf8' })
  } catch (error) {
    refused = JSON.parse(error.stdout)
  }
  assert.match(refused.error, /is the main checkout/)
})
