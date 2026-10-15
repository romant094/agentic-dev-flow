// dup.mjs mark and sweep.mjs inputs and filter: the DUP marker, the accepted debt, the sweep's
// range and second question, and the findings a marker accepts.
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { commentFor, coveringMarker, parseMarker } from '../lib/dup.mjs'
import { listRecords } from '../lib/ledger.mjs'
import { removalsIn } from '../lib/sweep.mjs'
import { run as dup } from '../dup.mjs'
import { run as sweep } from '../sweep.mjs'
import { commitIn, git, host } from './git-host.mjs'

const mark = (root, extra) =>
  dup(['mark', '--change', 'add-x', '--existing', 'src/a.ts:12', '--why', 'both parse the header', '--reason', 'the wire format differs', '--root', root, ...extra])

test('a marker goes above the introduced line in the file syntax, and the debt is recorded accepted', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export function a() {}\n\n  export function parse() {}\n')
  const out = mark(change, ['--file', 'src/b.ts', '--line', '3', '--task', '2'])
  assert.deepEqual([out.line, out.marker, out.already, out.debt], [3, '// ADF DUP src/a.ts:12 -- the wire format differs', false, { id: 'debt-1' }])
  assert.equal(readFileSync(join(change, 'src/b.ts'), 'utf8'), 'export function a() {}\n\n  // ADF DUP src/a.ts:12 -- the wire format differs\n  export function parse() {}\n')
  const [debt] = listRecords(change, 'add-x')
  assert.deepEqual([debt.what, debt.reason, debt.accepted, debt.task], ['duplicate: src/b.ts:3 repeats src/a.ts:12', 'both parse the header', 'the wire format differs', '2'])
  const again = mark(change, ['--file', 'src/b.ts', '--line', '4'])
  assert.equal(again.already, true)
  assert.match(again.debt.skipped ?? '', /debt-1/)
})

test('a whole-file marker sits on the first line, below a #! line; CRLF is kept; no syntax is refused', () => {
  const { change } = host()
  commitIn(change, 'run.sh', '#!/bin/sh\necho hi\n')
  commitIn(change, 'doc.md', 'Title\r\nText\r\n')
  commitIn(change, 'data.json', '{}\n')
  assert.equal(mark(change, ['--file', 'run.sh']).line, 2)
  assert.equal(readFileSync(join(change, 'run.sh'), 'utf8'), '#!/bin/sh\n# ADF DUP src/a.ts:12 -- the wire format differs\necho hi\n')
  mark(change, ['--file', 'doc.md'])
  assert.equal(readFileSync(join(change, 'doc.md'), 'utf8'), '<!-- ADF DUP src/a.ts:12 -- the wire format differs -->\r\nTitle\r\nText\r\n')
  assert.throws(() => mark(change, ['--file', 'data.json']), /no comment syntax/)
  assert.equal(readFileSync(join(change, 'data.json'), 'utf8'), '{}\n')
  assert.throws(() => mark(change, ['--file', 'run.sh', '--line', '99']), /not a line/)
  assert.equal(commentFor('Dockerfile').open, '#')
  assert.deepEqual(parseMarker('/* ADF DUP x.css:1 -- kept */'), { existing: 'x.css:1', reason: 'kept' })
})

test('sweep inputs: the range from the base, the REMOVED and RENAMED requirements, the markers', () => {
  const spec = [
    '# Delta',
    '',
    '## REMOVED Requirements',
    '',
    '### Requirement: Old export',
    '',
    '**Reason**: gone',
    '',
    '**Migration**: none',
    '',
    '**Code Disposition:** deleted with',
    'its tests; not reachable',
    '',
    '### Requirement: Old import',
    '',
    '**Reason**: gone',
    '',
    '## RENAMED Requirements',
    '',
    '- FROM: `### Requirement: Alpha`',
    '- TO: `### Requirement: Beta`',
    '',
    '**Code Disposition:** renamed in place',
    ''
  ].join('\n')
  const { change } = host({ 'specs/cap/spec.md': spec })
  const base = git(change, 'merge-base', 'develop', 'HEAD')
  commitIn(change, 'src/b.ts', '// ADF DUP src/a.ts:12 -- kept\nexport const b = 1\n')
  const out = sweep(['inputs', '--change', 'add-x', '--root', change])
  assert.deepEqual([out.base, out.mergeBase, out.range], ['develop', base, `${base}..${git(change, 'rev-parse', 'HEAD')}`])
  assert.equal(out.secondQuestion, true)
  assert.deepEqual(out.removedOrRenamed, [
    { op: 'REMOVED', requirement: 'Old export', codeDisposition: 'deleted with its tests; not reachable', spec: 'specs/cap/spec.md' },
    { op: 'REMOVED', requirement: 'Old import', codeDisposition: null, spec: 'specs/cap/spec.md' },
    { op: 'RENAMED', requirement: 'Beta', from: 'Alpha', codeDisposition: 'renamed in place', spec: 'specs/cap/spec.md' }
  ])
  assert.deepEqual(out.missingDisposition, ['Old import'])
  assert.deepEqual(out.dupMarkers, [{ file: 'src/b.ts', line: 1, existing: 'src/a.ts:12', reason: 'kept', wholeFile: true }])
  assert.deepEqual(removalsIn('## ADDED Requirements\n\n### Requirement: X\n'), [])
})

test('sweep filter drops a finding a marker accepts and recomputes the verdict; a refused reply is no verdict', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'const x = 1\n// ADF DUP src/a.ts:12 -- kept\nexport function parse() {}\n')
  mkdirSync(join(change, 'r'), { recursive: true })
  const reply = (findings) => JSON.stringify({ role: 'sweep', verdict: findings.length ? 'FINDINGS' : 'CLEAN', findings })
  writeFileSync(join(change, 'r/one.json'), reply([{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'same parser' }]))
  assert.deepEqual(sweep(['filter', 'r/one.json', '--root', change]), {
    ok: true,
    verdict: 'CLEAN',
    findings: [],
    dropped: [{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'same parser', marker: 'src/b.ts:2' }]
  })
  writeFileSync(join(change, 'r/two.json'), reply([{ introduced: 'src/b.ts:3', existing: 'src/c.ts:1', why: 'other' }]))
  assert.equal(sweep(['filter', 'r/two.json', '--root', change]).verdict, 'FINDINGS')
  writeFileSync(join(change, 'r/bad.json'), '{"role":"sweep","verdict":"CLEAN","findings":[{"introduced":"a","existing":"b","why":"c"}]}')
  assert.equal(sweep(['filter', 'r/bad.json', '--root', change]).ok, false)
  assert.equal(sweep(['filter', 'r/none.json', '--root', change]).ok, false)
  assert.equal(coveringMarker([{ file: 'a.ts', line: 5, existing: 'x', wholeFile: false }], { introduced: 'aSymbol', existing: 'x' }), null)
})
