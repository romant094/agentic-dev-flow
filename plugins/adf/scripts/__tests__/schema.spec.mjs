import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOrder, loadSchema, SCHEMA_DIR, validateSchema } from '../lib/schema.mjs'
import { CHECKS, REPLACEABLE } from '../lib/verify.mjs'

const artifact = (id, requires = [], extra = {}) => ({ id, generates: `${id}.md`, description: id, requires, ...extra })
const graph = (...artifacts) => ({ name: 'test', version: 1, artifacts })
const dir = mkdtempSync(join(tmpdir(), 'adf-schema-'))

test('the shipped schema loads, and its order puts brainstorm first and review last', () => {
  const schema = loadSchema()
  const order = buildOrder(schema)
  assert.equal(order[0], 'brainstorm')
  assert.equal(order.at(-1), 'review')
  assert.deepEqual(schema.apply.requires, ['plan'])
})

test('a valid graph has no errors', () => {
  assert.deepEqual(validateSchema(graph(artifact('a'), artifact('b', ['a'])), dir), [])
})

test('every structural error is named', () => {
  const errors = validateSchema({ name: '', version: 0, artifacts: [artifact('A'), artifact('b', ['zzz']), artifact('b')] }, dir)
  assert.ok(errors.includes('name is required'))
  assert.ok(errors.includes('version must be a positive integer'))
  assert.ok(errors.some((e) => /"A" is not kebab-case/.test(e)))
  assert.ok(errors.some((e) => /"b" is duplicated/.test(e)))
  assert.ok(errors.some((e) => /unknown artifact "zzz"/.test(e)))
})

test('a cycle is refused', () => {
  assert.deepEqual(validateSchema(graph(artifact('a', ['b']), artifact('b', ['a'])), dir), ['the artifact graph has a cycle'])
})

test('a template, an instruction or an apply block that points at nothing is refused', () => {
  const schema = { ...graph(artifact('a', [], { template: 'a.md', instruction: 'a.md' })), apply: { requires: ['x'] } }
  const errors = validateSchema(schema, dir)
  assert.ok(errors.includes('artifact "a": template templates/a.md does not exist'))
  assert.ok(errors.includes('artifact "a": instruction instructions/a.md does not exist'))
  assert.ok(errors.includes('apply requires unknown artifact "x"'))
})

test('loadSchema throws with every error', () => {
  const bad = mkdtempSync(join(tmpdir(), 'adf-schema-'))
  writeFileSync(join(bad, 'schema.json'), JSON.stringify(graph(artifact('a', ['a']))))
  assert.throws(() => loadSchema(bad), /cycle/)
  mkdirSync(join(bad, 'templates'))
  writeFileSync(join(bad, 'templates', 'a.md'), 'x')
  writeFileSync(join(bad, 'schema.json'), JSON.stringify(graph(artifact('a', [], { template: 'a.md' }))))
  assert.equal(loadSchema(bad).name, 'test')
})

test('guides must name markdown files', () => {
  const bad = { ...artifact('a'), guides: ['../escape.md'] }
  assert.ok(validateSchema(graph(bad), dir).some((e) => /guides must list file names/.test(e)))
  assert.deepEqual(validateSchema(graph({ ...artifact('a'), guides: ['planning.md'] }), dir), [])
})

test('the core text an agent copies from is written in English', () => {
  const root = join(SCHEMA_DIR, '..')
  const files = ['schema', 'commands', 'host'].flatMap((folder) =>
    readdirSync(join(root, folder), { recursive: true }).map((f) => join(root, folder, f)).filter((f) => f.endsWith('.md') || f.endsWith('.json'))
  )
  assert.ok(files.length > 10)
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /[Ѐ-ӿ　-〿一-鿿＀-￯]/, file)
  }
})

test('no dispatch-facing text asks for a repository-wide git mutation', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const files = [
    'schema/instructions/apply.md',
    'commands/apply.md',
    'schema/instructions/verify.md',
    'commands/verify.md',
    ...readdirSync(join(root, 'agents')).map((f) => `agents/${f}`),
    ...readdirSync(join(root, 'schema', 'prompts')).map((f) => `schema/prompts/${f}`)
  ]
  const unsafe = [/git add (-A|--all|\.)(\s|$|`)/, /git checkout -- /, /git restore\b/, /git stash push/, /git clean\b/]
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const pattern of unsafe) assert.doesNotMatch(text, pattern, `${file} asks for ${pattern}`)
  }
})

// A check exists only when the instruction states it and the template has its section; the
// origin added one to the schema alone and the record had nowhere to put it.
test('the verify instruction and template carry every check, one section each, and the verdict line last', () => {
  const schema = loadSchema()
  const verify = schema.artifacts.find((a) => a.id === 'verify')
  assert.deepEqual([verify.template, verify.instruction, verify.requires], ['verify.md', 'verify.md', ['plan']])
  const instruction = readFileSync(join(SCHEMA_DIR, 'instructions', 'verify.md'), 'utf8')
  const template = readFileSync(join(SCHEMA_DIR, 'templates', 'verify.md'), 'utf8')
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  const dispatched = { c4: 'Design and specs coherence', c8: 'Stale skills' }
  for (const [id, title] of [...Object.entries(CHECKS), ...Object.entries(dispatched)]) {
    assert.equal(headings.filter((h) => h === title).length, 1, `the template has no single section "${title}"`)
    assert.match(instruction, new RegExp(`\`${id}\``), `the instruction does not name ${id}`)
  }
  for (const id of REPLACEABLE) assert.match(instruction, new RegExp(`\| \`${id}\` \|`), `no dispatch writes ${id}`)
  for (const name of ['verify c4', 'verify c8', 'verify assemble']) assert.match(instruction, new RegExp(`\`${name}\``))
  assert.match(template.trimEnd().split('\n').at(-1), /^Verdict: /)
})
