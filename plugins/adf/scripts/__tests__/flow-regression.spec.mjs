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
