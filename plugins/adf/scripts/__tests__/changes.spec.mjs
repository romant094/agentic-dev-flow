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
  resolveOutputs,
  skipArtifact,
  statusReport,
  unskipArtifact
} from '../lib/changes.mjs'
import { setBranches } from '../lib/branches.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { loadSchema } from '../lib/schema.mjs'
import { run } from '../changes.mjs'

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

test('a skipped artifact shows skipped with its reason, and meets what requires it', () => {
  const root = host()
  newChange(root, 'c', schema)
  write(root, 'openspec/changes/c/brainstorm.md')
  write(root, 'openspec/changes/c/proposal.md')
  assert.deepEqual(skipArtifact(root, 'c', 'design', schema), { changeName: 'c', skipped: ['design'] })
  assert.throws(() => skipArtifact(root, 'c', 'specs', schema), /specs is required before apply; skip it only with a reason/)
  assert.throws(() => skipArtifact(root, 'c', 'proposal', schema, { reason: 'why' }), /proposal is required before apply and cannot be skipped/)
  const reason = 'a refactor; no requirement changes'
  assert.deepEqual(skipArtifact(root, 'c', 'specs', schema, { reason }), { changeName: 'c', skipped: ['design', 'specs'], reason })
  const meta = JSON.parse(readFileSync(join(root, 'openspec/changes/c/.adf.json'), 'utf8'))
  assert.deepEqual([meta.skipped, meta.skipReasons], [['design', 'specs'], { specs: reason }])

  const status = changeStatus(root, 'c', schema)
  assert.deepEqual([statuses(status).design, statuses(status).specs, statuses(status).tasks], ['skipped', 'skipped', 'ready'])
  assert.equal(status.artifacts.find((a) => a.id === 'specs').reason, reason)
  assert.equal('reason' in status.artifacts.find((a) => a.id === 'design'), false)
  const report = statusReport(status, { root })
  assert.match(report, /\n- design: skipped\n/)
  assert.match(report, /\n- specs: skipped \(a refactor; no requirement changes\)\n/)
  const tasks = artifactInstructions(root, 'c', 'tasks', schema)
  assert.deepEqual(tasks.dependencies.map((d) => [d.id, d.done, d.skipped]), [['specs', false, reason]])

  // A skipped artifact whose output is written is a conflict, never done; unskip settles it.
  write(root, 'openspec/changes/c/design.md')
  const conflict = changeStatus(root, 'c', schema).artifacts.find((a) => a.id === 'design')
  assert.equal(conflict.status, 'conflict')
  assert.match(conflict.conflict, /design is skipped, yet design\.md is written: delete it, or run changes\.mjs unskip design/)
  assert.match(statusReport(changeStatus(root, 'c', schema), { root }), /\n- design: conflict: design is skipped/)
  assert.deepEqual(unskipArtifact(root, 'c', 'specs', schema), { changeName: 'c', skipped: ['design'] })
  assert.equal('skipReasons' in JSON.parse(readFileSync(join(root, 'openspec/changes/c/.adf.json'), 'utf8')), false)
  assert.deepEqual(unskipArtifact(root, 'c', 'design', schema), { changeName: 'c', skipped: [] })
  assert.equal(statuses(changeStatus(root, 'c', schema)).design, 'done')
  assert.throws(() => unskipArtifact(root, 'c', 'design', schema), /design is not skipped/)
  const other = host()
  newChange(other, 'c', schema)
  write(other, 'openspec/changes/c/design.md')
  assert.throws(() => skipArtifact(other, 'c', 'design', schema), /design is already written/)
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

// The apply instruction is delivered in parts, so the orchestrator reads the one its step needs
// rather than the whole procedure at once (14b N14); the parts together are the whole file.
test('apply instructions come in parts: the start part and an index, any part by name, nothing lost', () => {
  const root = host()
  newChange(root, 'c', schema)
  for (const file of ['brainstorm.md', 'proposal.md', 'specs/a/spec.md', 'plan.md']) write(root, `openspec/changes/c/${file}`)
  write(root, 'openspec/changes/c/tasks.md', '- [ ] 1.1 One\n')
  const ready = applyInstructions(root, 'c', schema)
  assert.equal(ready.part, 'start')
  assert.deepEqual(ready.parts.map((p) => p.name), ['start', 'dispatch', 'groups', 'finish', 'records'])
  for (const p of ready.parts) assert.ok(p.when.length > 10 && p.command.includes(`--part ${p.name}`), p.name)
  assert.ok(Buffer.byteLength(JSON.stringify(ready)) < 16 * 1024, 'the default output is short')
  const texts = ready.parts.map((p) => applyInstructions(root, 'c', schema, { part: p.name }).instruction)
  for (const [i, t] of texts.entries()) assert.ok(Buffer.byteLength(t) < 16 * 1024, ready.parts[i].name)
  assert.equal(texts[0], ready.instruction)
  assert.match(texts[1], /^\*\*Every dispatch comes from `dispatch\.mjs`\.\*\*/)
  const whole = readFileSync(join(schema.dir, 'instructions', schema.apply.instruction), 'utf8')
  const strip = (t) => t.replace(/^<!-- part: .* -->\n/gm, '').replace(/\s+/g, ' ').trim()
  assert.equal(texts.join('\n\n').replace(/\s+/g, ' ').trim(), strip(whole))
  assert.throws(() => applyInstructions(root, 'c', schema, { part: 'nope' }), /no apply part "nope"; known: start, dispatch/)
  const out = JSON.parse(execFileSync('node', [cli, 'instructions', 'apply', '--part', 'groups', '--change', 'c', '--root', root], { encoding: 'utf8' }))
  assert.equal(out.part, 'groups')
  assert.match(out.instruction, /^\*\*Work added during apply is recorded against the plan\.\*\*/)
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

test('instructions output names no ${CLAUDE_PLUGIN_ROOT}', () => {
  const root = host()
  newChange(root, 'c', schema)
  const plain = readFileSync(join(schema.dir, 'instructions', 'plan.md'), 'utf8')
  assert.match(plain, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  const { instruction } = run(['instructions', 'plan', '--change', 'c', '--root', root])
  assert.doesNotMatch(instruction, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.ok(instruction.includes(join(dirname(fileURLToPath(import.meta.url)), '..', '..')))
})
