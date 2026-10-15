// Flow regression checks carried over from the origin project's `adf-regression` set, each one
// a defect the flow made there once. They run on the real files of this repository; the
// synthetic fixtures beside them only prove the detector can fire, because the origin's
// detectors were tested on fixtures alone and a detector that silently matches nothing on the
// real tree looks exactly like a passing guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOrder, loadSchema } from '../lib/schema.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const adf = join(repo, 'plugins', 'adf')
const rel = (path) => relative(repo, path).split(sep).join('/')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

// --- Every script has a test -------------------------------------------------------------

// The origin required `__tests__/<name>.spec.mjs` beside each script. There, the check fired on
// an untested regression runner, and the test written for it at once found a real defect: the
// runner's file filter picked up its own test file as a check. This repository names specs by
// behaviour, not by module (a CLI and its library are often covered by one spec of another
// name), so the rule here is weaker and has no allowlist: every script must be named, by its
// basename, in at least one spec of its own plugin.
export function untestedScripts(plugins) {
  const missing = []
  for (const plugin of readdirSync(plugins)) {
    const scripts = join(plugins, plugin, 'scripts')
    let files
    try {
      files = walk(scripts)
    } catch {
      continue
    }
    const tests = join(scripts, '__tests__')
    const specs = files.filter((f) => f.startsWith(tests + sep) && f.endsWith('.spec.mjs')).map((f) => readFileSync(f, 'utf8'))
    for (const file of files.filter((f) => f.endsWith('.mjs') && !f.startsWith(tests + sep))) {
      const name = basename(file).replace(/[.]/g, '\\.')
      const named = new RegExp(`(^|[^\\w.-])${name}\\b`)
      if (!specs.some((text) => named.test(text))) missing.push(rel(file))
    }
  }
  return missing.sort()
}

test('every script under plugins/*/scripts is named in a spec of its own plugin', () => {
  const missing = untestedScripts(join(repo, 'plugins'))
  assert.deepEqual(missing, [], `scripts no spec names:\n  ${missing.join('\n  ')}`)
})

// --- One normative rule, stated in full on one surface ------------------------------------

// The surfaces an agent acts on. A README is documentation for people, not a surface.
function surfaces() {
  const folders = [join(adf, 'schema', 'instructions'), join(adf, 'commands'), join(adf, 'agents'), join(adf, 'host')]
  return folders.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)))
}

// Normalisation copied from the origin's normative-duplication check. Any capitalisation of
// the five modals counts: the origin once matched only all-caps and lower case, and a
// sentence-initial "Always" slipped through.
const NORMATIVE = /\b(MUST|SHALL|NEVER|ALWAYS)\b|\bDO NOT\b/i

function stripNonProse(text) {
  const kept = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || /^\s*\|/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

const splitSentences = (text) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

export const normalise = (sentence) =>
  sentence
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/[*_]/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

// Takes { name: text } and returns every normative sentence found in more than one of them.
export function normativeDuplicates(texts) {
  const seen = new Map()
  for (const [name, text] of Object.entries(texts)) {
    for (const sentence of splitSentences(stripNonProse(text))) {
      if (!NORMATIVE.test(sentence)) continue
      const key = normalise(sentence)
      if (!seen.has(key)) seen.set(key, new Set())
      seen.get(key).add(name)
    }
  }
  return [...seen].filter(([, files]) => files.size > 1).map(([sentence, files]) => ({ sentence, files: [...files].sort() }))
}

// Debt to resolve in this iteration, each pinned to its exact normalised sentence so that a
// different restatement still fires. Remove an entry in the same edit that resolves it.
const KNOWN_DUPLICATES = new Set([])

test('the duplicate detector fires on a restated rule and ignores code, tables and plain prose', () => {
  const found = normativeDuplicates({
    'a.md': 'Intro. - A change **MUST** run `foo`   now.\n\n```\nNever run git add -A.\n```\n| Never in a table. |',
    'b.md': 'A change MUST run foo now. Never run git add -A. Plain prose repeats.',
    'c.md': 'Plain prose repeats. *Always* let the user choose.',
    'd.md': 'always let the user choose.'
  })
  assert.deepEqual(found, [
    { sentence: 'a change must run foo now.', files: ['a.md', 'b.md'] },
    { sentence: 'always let the user choose.', files: ['c.md', 'd.md'] }
  ])
})

test('no normative rule is stated in full on more than one surface', () => {
  const files = surfaces()
  assert.ok(files.length > 10, 'the surfaces were not found')
  const texts = Object.fromEntries(files.map((f) => [rel(f), readFileSync(f, 'utf8')]))
  const found = normativeDuplicates(texts).filter((d) => !KNOWN_DUPLICATES.has(d.sentence))
  assert.deepEqual(found, [], found.map((d) => `"${d.sentence}" in ${d.files.join(', ')}`).join('\n'))
})

// --- No count literals -------------------------------------------------------------------

// The origin drifted: one file said "the other eleven checks", another "the other eight checks",
// for the same check. A count written into prose goes stale the day a member is added. Only the
// plural is matched: "one step" or "one more step" is a quantity of one in an imperative, not a
// count of a set, and does not drift.
const COUNT =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|\d+) (other |more |remaining |further )?(checks|steps|artifacts|rules|sections|gates|phases|stages)\b/gi

export function countLiterals(texts) {
  return Object.entries(texts).flatMap(([name, text]) => [...text.matchAll(COUNT)].map((m) => `${name}: ${m[0]}`))
}

// Debt to resolve in this iteration, each an exact `file: text` hit.
const KNOWN_COUNTS = new Set([])

test('the count detector fires on a count of a set and ignores a quantity of one', () => {
  assert.deepEqual(
    countLiterals({ 'a.md': 'Run the other eleven checks. Then the 8 remaining steps.', 'b.md': 'Take one more step. Do one step.' }),
    ['a.md: eleven checks', 'a.md: 8 remaining steps']
  )
})

test('no surface states how many checks, steps, artifacts or rules there are', () => {
  const texts = Object.fromEntries(surfaces().map((f) => [rel(f), readFileSync(f, 'utf8')]))
  const found = countLiterals(texts).filter((hit) => !KNOWN_COUNTS.has(hit))
  assert.deepEqual(found, [])
})

// --- Prose that lists the workflow's shape agrees with the schema ---------------------------

// The origin's `check-workflow-shape.mjs`: documentation contradicted the workflow's real shape,
// so the shape is derived from the files that define it, never remembered. `schema.json` holds
// the artifacts and their order; `commands/*.md` are the commands. Only the declaration sites
// are checked, the places that enumerate a set: the origin's first version matched every count
// or id near "artifact" anywhere, and its findings were dominated by sentences naming a subset or
// using an id as the plain English word it is. A missing site is a finding, never silence: the
// person most likely to move its anchor is the one changing the shape.
//
// The schema has no "optional" field; nothing in lib/schema.mjs or lib/changes.mjs marks one.
// Optional is derived the origin's way, from `requires`: the artifacts the last artifact of the
// build order does not depend on, directly or through others, are side branches a change may
// skip (today `design`, required by nothing).
export function workflowShape(schema, commandFiles) {
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  const needed = new Set()
  const queue = [buildOrder(schema).at(-1)]
  while (queue.length > 0) {
    const id = queue.shift()
    if (needed.has(id)) continue
    needed.add(id)
    queue.push(...byId.get(id).requires)
  }
  const optional = schema.artifacts.filter((a) => !needed.has(a.id))
  return {
    mandatory: schema.artifacts.filter((a) => needed.has(a.id)).map((a) => a.id),
    optional: optional.map((a) => a.id),
    generates: schema.artifacts.map((a) => a.generates),
    optionalGenerates: optional.map((a) => a.generates),
    commands: commandFiles.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort()
  }
}

const differs = (file, site, listed, expected) =>
  JSON.stringify(listed) === JSON.stringify(expected) ? [] : [`${file} [${site}]: lists ${listed.join(', ') || '(none)'}; the schema has ${expected.join(', ') || '(none)'}`]
const missing = (file, site) => [`${file} [${site}]: the list was not found`]
const sorted = (list) => [...new Set(list)].sort()

// Site: the schema's own `description`, "<intro>: a, b, c. x is optional: ...". The list keeps
// the schema's order, so order is compared too.
export function schemaDescriptionFindings(file, description, shape) {
  const list = description.match(/:\s*([^.:]+)\./)
  if (!list) return missing(file, 'description-sequence')
  const named = list[1].split(/,\s*|\s+and\s+/).map((s) => s.trim())
  const optional = [...description.matchAll(/\b([a-z][a-z-]*(?:(?:,\s*|\s+and\s+)[a-z][a-z-]*)*)\s+(?:is|are)\s+optional\b/g)].flatMap((m) =>
    m[1].split(/,\s*|\s+and\s+/)
  )
  return [...differs(file, 'description-sequence', named, shape.mandatory), ...differs(file, 'description-optional', sorted(optional), sorted(shape.optional))]
}

// Site: the propose command's paragraph "This command writes, under ...: `a.md`, `b.md`
// (optional), ... `x.md` and `y.md` are written later": every generated file, and the optional
// ones marked as such.
export function proposeFilesFindings(file, text, shape) {
  const paragraph = text.split(/\n\s*\n/).find((p) => /^This command writes\b/.test(p.trim()))
  if (!paragraph) return missing(file, 'propose-files')
  const files = [...paragraph.matchAll(/`([^`<>]+\.md)`(\s*\(optional\))?/g)]
  return [
    ...differs(file, 'propose-files', sorted(files.map((m) => m[1])), sorted(shape.generates)),
    ...differs(file, 'propose-optional', sorted(files.filter((m) => m[2]).map((m) => m[1])), sorted(shape.optionalGenerates))
  ]
}

// Sites: the README's command block after "in the host project:" and its layout line for
// `commands/`. Each lists every command, in an order of its own, so sets are compared.
export function readmeCommandFindings(file, text, shape) {
  const block = text.match(/in the host project:\s*\n\s*```[^\n]*\n([\s\S]*?)```/)
  const layout = text.match(/^\s*commands\/\s+(.+)$/m)
  const names = (source) => sorted([...source.matchAll(/\/adf:([a-z][a-z-]*)/g)].map((m) => m[1]))
  return [
    ...(block ? differs(file, 'readme-command-block', names(block[1]), shape.commands) : missing(file, 'readme-command-block')),
    ...(layout ? differs(file, 'readme-layout-commands', names(layout[1]), shape.commands) : missing(file, 'readme-layout-commands'))
  ]
}

test('the shape detectors fire on a drifted list and on a missing site, and pass a matching one', () => {
  const schema = {
    artifacts: [
      { id: 'a', generates: 'a.md', requires: [] },
      { id: 'side', generates: 'side.md', requires: ['a'] },
      { id: 'b', generates: 'b/**/*.md', requires: ['a'] },
      { id: 'c', generates: 'c.md', requires: ['b'] }
    ]
  }
  const shape = workflowShape(schema, ['go.md', 'init.md', 'notes.txt'])
  assert.deepEqual([shape.mandatory, shape.optional, shape.commands], [['a', 'b', 'c'], ['side'], ['go', 'init']])

  assert.deepEqual(schemaDescriptionFindings('s', 'Flow: a, b, c. side is optional: never required.', shape), [])
  assert.deepEqual(schemaDescriptionFindings('s', 'Flow: a, c, b. side and b are optional.', shape), [
    's [description-sequence]: lists a, c, b; the schema has a, b, c',
    's [description-optional]: lists b, side; the schema has side'
  ])
  assert.deepEqual(schemaDescriptionFindings('s', 'No list here', shape), ['s [description-sequence]: the list was not found'])

  const propose = 'Intro.\n\nThis command writes, under `x/<name>/`: `a.md`, `side.md` (optional),\n`b/**/*.md` and `c.md`.\n\nMore.'
  assert.deepEqual(proposeFilesFindings('p', propose, shape), [])
  assert.deepEqual(proposeFilesFindings('p', propose.replace(' (optional)', '').replace('`c.md`', '`d.md`'), shape), [
    'p [propose-files]: lists a.md, b/**/*.md, d.md, side.md; the schema has a.md, b/**/*.md, c.md, side.md',
    'p [propose-optional]: lists (none); the schema has side.md'
  ])
  assert.deepEqual(proposeFilesFindings('p', 'Nothing.', shape), ['p [propose-files]: the list was not found'])

  const readme = 'Then, in the host project:\n\n```\n/adf:init\n/adf:go <x>\n```\n\n  commands/   /adf:go, /adf:init\n'
  assert.deepEqual(readmeCommandFindings('r', readme, shape), [])
  assert.deepEqual(readmeCommandFindings('r', readme.replace('/adf:go <x>', '/adf:gone').replace(', /adf:init', ''), shape), [
    'r [readme-command-block]: lists gone, init; the schema has go, init',
    'r [readme-layout-commands]: lists go; the schema has go, init'
  ])
  assert.deepEqual(readmeCommandFindings('r', 'Nothing.', shape), [
    'r [readme-command-block]: the list was not found',
    'r [readme-layout-commands]: the list was not found'
  ])
})

test('every prose list of the artifacts and commands matches the schema and the commands folder', () => {
  const schema = loadSchema()
  const shape = workflowShape(schema, readdirSync(join(adf, 'commands')))
  assert.ok(shape.optional.length > 0 && shape.commands.length > 0, 'the shape was not derived')
  const read = (path) => readFileSync(join(repo, path), 'utf8')
  const found = [
    ...schemaDescriptionFindings('plugins/adf/schema/schema.json', schema.description, shape),
    ...proposeFilesFindings('plugins/adf/commands/propose.md', read('plugins/adf/commands/propose.md'), shape),
    ...readmeCommandFindings('README.md', read('README.md'), shape)
  ]
  assert.deepEqual(found, [], found.join('\n'))
})
