#!/usr/bin/env node
// Checks that every rule the origin project's flow holds is accounted for in the port
// (docs/lessons/README.md). Run by `npm test`. For every row of every lessons table:
//
// - the decision starts with `ported`, `changed` or `rejected`;
// - each evidence item is either `<path>`: `<phrase>`, where the file exists and contains the
//   phrase (whitespace collapsed), or `pending: iteration NN`, where iteration NN has no
//   record with a `## Result` yet; `—` only for a rejected rule.
//
// A pending item whose iteration is recorded as done fails: the iteration closed without the
// rule it promised.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lessons = join(root, 'docs', 'lessons')
const iterations = join(root, 'docs', 'iterations')
const collapse = (text) => text.replace(/\s+/g, ' ')

// An iteration's key is its file name's leading `\d+[a-z]?`: `10` and `10b` are distinct.
export function doneIterations(dir = iterations) {
  return new Set(
    readdirSync(dir)
      .filter((file) => /^\d+[a-z]?-.*\.md$/.test(file) && /^## Result$/m.test(readFileSync(join(dir, file), 'utf8')))
      .map((file) => /^\d+[a-z]?/.exec(file)[0])
  )
}

// A cell ends at a `|` that is neither escaped (`\|`) nor inside a code span, as in GitHub
// tables.
export function cells(line) {
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const out = []
  let cell = ''
  let code = false
  for (let i = 0; i < row.length; i++) {
    const c = row[i]
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (c === '`') {
      code = !code
      cell += c
    } else if (c === '|' && !code) {
      out.push(cell.trim())
      cell = ''
    } else cell += c
  }
  return [...out, cell.trim()]
}

export function checkEvidence(cell, decision, done = doneIterations()) {
  if (cell === '—') return decision.startsWith('rejected') ? [] : ['evidence "—" is allowed only for a rejected rule']
  const errors = []
  for (const item of cell.split('; ')) {
    const pending = /^pending: iteration (\d+[a-z]?)$/.exec(item)
    if (pending) {
      if (done.has(pending[1])) errors.push(`pending on iteration ${pending[1]}, which is done`)
      continue
    }
    const evidence = /^`([^`]+)`: `([^`]+)`$/.exec(item)
    if (!evidence) {
      errors.push(`evidence "${item}" is neither \`path\`: \`phrase\` nor "pending: iteration NN"`)
      continue
    }
    const [, path, phrase] = evidence
    if (!existsSync(join(root, path))) errors.push(`${path} does not exist`)
    else if (!collapse(readFileSync(join(root, path), 'utf8')).includes(collapse(phrase))) {
      errors.push(`${path} does not contain "${phrase}"`)
    }
  }
  return errors
}

export function checkLessons() {
  const errors = []
  const done = doneIterations()
  let rows = 0
  let pending = 0
  for (const file of readdirSync(lessons).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const lines = readFileSync(join(lessons, file), 'utf8').split('\n')
    const header = lines.findIndex((line) => line.startsWith('| Rule |'))
    if (header === -1) {
      errors.push(`${file}: no lessons table`)
      continue
    }
    if (cells(lines[header]).length !== 5) errors.push(`${file}: the table needs five columns, Evidence last`)
    for (let i = header + 2; i < lines.length && lines[i].startsWith('| '); i++) {
      rows++
      const row = cells(lines[i])
      const where = `${file}:${i + 1}`
      if (row.length !== 5) {
        errors.push(`${where}: ${row.length} cells, expected 5`)
        continue
      }
      const [, , decision, , evidence] = row
      if (!/^(ported|changed|rejected)\b/.test(decision)) errors.push(`${where}: no decision`)
      pending += (evidence.match(/pending: iteration/g) ?? []).length
      for (const error of checkEvidence(evidence, decision, done)) errors.push(`${where}: ${error}`)
    }
  }
  return { ok: errors.length === 0, rows, pending, errors }
}

if (isMain(import.meta.url)) {
  const result = checkLessons()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
