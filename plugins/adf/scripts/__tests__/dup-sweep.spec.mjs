// dup.mjs mark and sweep.mjs inputs and filter: the DUP marker, the accepted debt, the sweep's
// range and second question, and the findings a marker accepts.
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { commentFor, coveringMarker, locate, parseMarker, sameDuplicate } from '../lib/dup.mjs'
import { recordReply } from '../lib/attempts.mjs'
import { appendRecord, listRecords } from '../lib/ledger.mjs'
import { sweepState } from '../lib/loop.mjs'
import { removalsIn } from '../lib/sweep.mjs'
import { run as dup } from '../dup.mjs'
import { run as sweep } from '../sweep.mjs'
import { run as dispatch } from '../dispatch.mjs'
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

test('sweep filter drops a finding a marker accepts and computes the verdict; a refused reply is no verdict', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'const x = 1\n// ADF DUP src/a.ts:12 -- kept\nexport function parse() {}\n')
  mkdirSync(join(change, 'r'), { recursive: true })
  const reply = (findings) => JSON.stringify({ role: 'sweep', findings })
  writeFileSync(join(change, 'r/one.json'), reply([{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'same parser' }]))
  assert.deepEqual(sweep(['filter', 'r/one.json', '--root', change]), {
    ok: true,
    verdict: 'CLEAN',
    findings: [],
    dropped: [{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'same parser', marker: 'src/b.ts:2' }]
  })
  writeFileSync(join(change, 'r/two.json'), reply([{ introduced: 'src/b.ts:3', existing: 'src/c.ts:1', why: 'other' }]))
  assert.equal(sweep(['filter', 'r/two.json', '--root', change]).verdict, 'FINDINGS')
  // The reply states no verdict, and one that states it is refused.
  writeFileSync(join(change, 'r/bad.json'), '{"role":"sweep","verdict":"CLEAN","findings":[{"introduced":"a","existing":"b","why":"c"}]}')
  assert.deepEqual(sweep(['filter', 'r/bad.json', '--root', change]).reasons, ['$: verdict is not allowed'])
  assert.equal(sweep(['filter', 'r/none.json', '--root', change]).ok, false)
  assert.equal(coveringMarker([{ file: 'a.ts', line: 5, existing: 'x', wholeFile: false }], { introduced: 'aSymbol', existing: 'x' }), null)
})

test('sweep filter --record turns each disposition into a debt record, once', () => {
  const { change } = host()
  mkdirSync(join(change, 'r'), { recursive: true })
  const dispositions = [
    { requirement: 'Old thing', disposition: 'deleted with its route; the old path is unreachable' },
    { requirement: 'New name', disposition: 'renamed in code; the old export is still reachable from src/x.ts' }
  ]
  writeFileSync(join(change, 'r/s.json'), JSON.stringify({ role: 'sweep', findings: [], dispositions }))
  const out = sweep(['filter', 'r/s.json', '--record', '--change', 'add-x', '--root', change])
  assert.deepEqual(out.debt, [{ requirement: 'Old thing', id: 'debt-1' }, { requirement: 'New name', id: 'debt-2' }])
  const debts = listRecords(change, 'add-x')
  assert.deepEqual(debts.map((d) => [d.what, d.reason]), dispositions.map((d) => [`the Code Disposition of the removed or renamed requirement "${d.requirement}"`, d.disposition]))
  assert.match(sweep(['filter', 'r/s.json', '--record', '--change', 'add-x', '--root', change]).debt[0].skipped, /debt-1/)
  assert.equal(listRecords(change, 'add-x').length, 2)
  assert.equal(sweep(['filter', 'r/s.json', '--root', change]).debt, undefined)
  assert.throws(() => sweep(['filter', 'r/s.json', '--record', '--root', change]), /usage/)
  writeFileSync(join(change, 'r/bad.json'), '{"role":"sweep"}')
  assert.equal(sweep(['filter', 'r/bad.json', '--record', '--change', 'add-x', '--root', change]).ok, false)
  assert.equal(listRecords(change, 'add-x').length, 2)
})

test('dispatch.mjs reply records an accepted sweep and its dispositions as debt in one call', () => {
  const spec = '## REMOVED Requirements\n\n### Requirement: Old thing\n\n**Reason**: gone\n\n**Code Disposition:** deleted\n'
  const { change } = host({ 'specs/cap/spec.md': spec })
  mkdirSync(join(change, 'r'), { recursive: true })
  const reply = (body, name = 'sweep p1') => {
    writeFileSync(join(change, 'r/s.json'), JSON.stringify(body))
    return dispatch(['reply', '--change', 'add-x', '--name', name, '--file', 'r/s.json', '--root', change], { main: change })
  }
  // A refused reply records no debt.
  const refused = reply({ role: 'sweep', findings: [] })
  assert.deepEqual([refused.valid, refused.debt], [false, undefined])
  assert.equal(listRecords(change, 'add-x').length, 0)
  const disposition = 'deleted with its route; the old path is unreachable'
  const out = reply({ role: 'sweep', findings: [], dispositions: [{ requirement: 'Old thing', disposition }] })
  assert.deepEqual([out.valid, out.result.verdict, out.debt], [true, 'CLEAN', [{ requirement: 'Old thing', id: 'debt-1' }]])
  assert.deepEqual(listRecords(change, 'add-x').map((d) => [d.kind, d.what, d.reason]), [['debt', 'the Code Disposition of the removed or renamed requirement "Old thing"', disposition]])
  // The second pass answers the same requirement in its own words: it is recorded once.
  const second = reply({ role: 'sweep', findings: [], dispositions: [{ requirement: 'Old thing', disposition: 'removed; nothing reaches the old path' }] }, 'sweep p2')
  assert.deepEqual([second.valid, second.debt[0].skipped], [true, 'debt-1 already records it'])
  assert.equal(listRecords(change, 'add-x').length, 1)
})

test('dup mark --commit commits the marked file alone, with the fixed message', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export function parse() {}\n')
  writeFileSync(join(change, 'other.txt'), 'untouched\n')
  const out = mark(change, ['--file', 'src/b.ts', '--line', '1', '--commit'])
  assert.match(out.commit, /^[0-9a-f]{40}$/)
  assert.equal(git(change, 'log', '-1', '--format=%s'), 'chore: mark the accepted duplicate in src/b.ts')
  assert.equal(git(change, 'show', '--name-only', '--format=', 'HEAD'), 'src/b.ts')
  assert.equal(git(change, 'status', '--porcelain', '--', 'other.txt'), '?? other.txt')
  assert.equal(mark(change, ['--file', 'src/b.ts', '--line', '2', '--commit']).commit, null)
})

// Accepted sweep replies in the events log, each with the HEAD it ran on: the first call records
// the first sweep's two passes, `sweep p1` with `findings` and `sweep p2` with `p2` (the same by
// default); every later call a re-sweep `sweep r<k>`.
const sweeps = new Map()
function swept(change, findings, p2 = findings) {
  const head = git(change, 'rev-parse', 'HEAD')
  const result = (list) => ({ verdict: list.length ? 'FINDINGS' : 'CLEAN', findings: list, dropped: [], head })
  const k = sweeps.get(change) ?? 0
  sweeps.set(change, k + 1)
  if (k > 0) return recordReply(change, 'add-x', { name: `sweep r${k}`, file: `sweep-r${k}.json`, result: result(findings) })
  recordReply(change, 'add-x', { name: 'sweep p1', file: 'sweep-p1.json', result: result(findings) })
  return recordReply(change, 'add-x', { name: 'sweep p2', file: 'sweep-p2.json', result: result(p2) })
}

test('a sweep finding stays open across sweeps until consolidated, marked or dismissed by a ruling', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export const b = 1\n')
  commitIn(change, 'src/c.ts', 'export const c = 1\n')
  assert.deepEqual(sweepState(change, 'add-x'), { ran: false, ids: [], open: [], cleared: [] })
  const b = { introduced: 'src/b.ts:1', existing: 'src/a.ts:12', why: 'Same constant.' }
  const c = { introduced: 'src/c.ts:1', existing: 'src/a.ts:12', why: 'Same constant.' }
  swept(change, [b, c])
  assert.deepEqual(sweepState(change, 'add-x').open.map((f) => [f.id, f.introduced]), [['S1', 'src/b.ts:1'], ['S2', 'src/c.ts:1']])
  // A CLEAN on an unchanged branch launders nothing.
  swept(change, [])
  assert.deepEqual(sweepState(change, 'add-x').open.map((f) => f.id), ['S1', 'S2'])
  // A consolidation changes the introduced file; the next sweep no longer reports it.
  commitIn(change, 'src/b.ts', "export { a as b } from './a.ts'\n")
  swept(change, [c])
  const after = sweepState(change, 'add-x')
  assert.deepEqual([after.ids, after.open.map((f) => f.id), after.cleared], [['S1', 'S2'], ['S2'], [{ id: 'S1', by: 'consolidated' }]])
  // The developer's dismissal: a DUP marker, or a ruling where no marker fits.
  appendRecord(change, 'add-x', 'ruling', { subject: 'sweep', finding: 'S2', as: 'dismissed', decision: 'kept per module' })
  assert.deepEqual(sweepState(change, 'add-x').open, [])
  const { change: other } = host()
  commitIn(other, 'src/c.ts', 'export const c = 1\n')
  swept(other, [c])
  mark(other, ['--file', 'src/c.ts', '--line', '1'])
  const marked = sweepState(other, 'add-x')
  assert.deepEqual([marked.open, marked.cleared], [[], [{ id: 'S1', by: 'marker', marker: 'src/c.ts:1' }]])
})

test('locate reads path:line and path:line-line, and drops text after the line that older records carry', () => {
  assert.deepEqual(locate('src/b.ts:16'), { file: 'src/b.ts', line: 16, end: 16 })
  assert.deepEqual(locate('src/b.ts:12-30'), { file: 'src/b.ts', line: 12, end: 30 })
  assert.deepEqual(locate('src/b.ts:16 toChanges'), { file: 'src/b.ts', line: 16, end: 16 })
  assert.deepEqual(locate('src/b.ts:12-30 projectRow()'), { file: 'src/b.ts', line: 12, end: 30 })
  assert.deepEqual(locate('src/b.ts'), { file: 'src/b.ts', line: null, end: null })
  assert.equal(locate('toChanges'), null)
})

test('a finding recorded with a symbol after its line still clears when its file is consolidated', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export const b = 1\n')
  const b = { introduced: 'src/b.ts:1 b', existing: 'src/a.ts:12 a', why: 'Same constant.' }
  swept(change, [b])
  assert.deepEqual(sweepState(change, 'add-x').open.map((f) => f.id), ['S1'])
  commitIn(change, 'src/b.ts', "export { a as b } from './a.ts'\n")
  swept(change, [])
  assert.deepEqual(sweepState(change, 'add-x'), { ran: true, ids: ['S1'], open: [], cleared: [{ id: 'S1', by: 'consolidated' }] })
})

test('a sweep reply with text after the line of a location is refused, with the form expected; a bare path, path:line and path:line-line pass', () => {
  const { change } = host()
  mkdirSync(join(change, 'r'), { recursive: true })
  const finding = (introduced, existing) => ({ introduced, existing, why: 'Same projection.' })
  writeFileSync(join(change, 'r/s.json'), JSON.stringify({ role: 'sweep', findings: [finding('src/b.ts:16 toChanges', 'src/a.ts:33'), finding('src/b.ts:2-9', 'src/a.ts:4-8 pickKeys()')] }))
  const expected = [
    '$.findings[0].introduced: "src/b.ts:16 toChanges" has text after its line; write path, path:line or path:line-line, with nothing after the line',
    '$.findings[1].existing: "src/a.ts:4-8 pickKeys()" has text after its line; write path, path:line or path:line-line, with nothing after the line'
  ]
  assert.deepEqual(sweep(['filter', 'r/s.json', '--root', change]).reasons, expected)
  const out = dispatch(['reply', '--change', 'add-x', '--name', 'sweep p1', '--file', 'r/s.json', '--root', change], { main: change })
  assert.deepEqual([out.valid, out.next, out.errors], [false, 'retry', expected])
  writeFileSync(join(change, 'r/s.json'), JSON.stringify({ role: 'sweep', findings: [finding('src/b.ts:16', 'src/a.ts:33-40'), finding('src/c.ts', 'src/a.ts')] }))
  assert.equal(dispatch(['reply', '--change', 'add-x', '--name', 'sweep p1', '--file', 'r/s.json', '--root', change], { main: change }).valid, true)
})

test('a sweep location absolute under the root is recorded relative; one outside the root refuses the reply', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export const b = 1\n')
  mkdirSync(join(change, 'r'), { recursive: true })
  const reply = (introduced, existing) => JSON.stringify({ role: 'sweep', findings: [{ introduced, existing, why: 'Same constant.' }] })
  writeFileSync(join(change, 'r/abs.json'), reply(join(change, 'src/b.ts:1'), join(change, 'src/a.ts')))
  assert.deepEqual(sweep(['filter', 'r/abs.json', '--root', change]).findings, [{ introduced: 'src/b.ts:1', existing: 'src/a.ts', why: 'Same constant.' }])
  const out = dispatch(['reply', '--change', 'add-x', '--name', 'sweep p1', '--file', 'r/abs.json', '--root', change], { main: change })
  assert.equal(out.valid, true)
  assert.equal(dispatch(['reply', '--change', 'add-x', '--name', 'sweep p2', '--file', 'r/abs.json', '--root', change], { main: change }).valid, true)
  assert.deepEqual(sweepState(change, 'add-x').open.map((f) => [f.introduced, f.existing]), [['src/b.ts:1', 'src/a.ts']])
  writeFileSync(join(change, 'r/out.json'), reply('/elsewhere/src/b.ts:1', 'src/a.ts:2'))
  const expected = ['$.findings[0].introduced: "/elsewhere/src/b.ts:1" is outside the repository; write the path relative to the repository root']
  assert.deepEqual(sweep(['filter', 'r/out.json', '--root', change]).reasons, expected)
  assert.deepEqual(dispatch(['reply', '--change', 'add-x', '--name', 'sweep p1', '--file', 'r/out.json', '--root', change], { main: change }).errors, expected)
})

test('mark writes an absolute existing location relative, in the marker and in the debt', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'x\n\nexport function parse() {}\n')
  const out = dup(['mark', '--change', 'add-x', '--file', join(change, 'src/b.ts'), '--line', '3', '--existing', join(change, 'src/a.ts:12'), '--why', 'same', '--reason', 'kept', '--root', change])
  assert.equal(out.marker, '// ADF DUP src/a.ts:12 -- kept')
  assert.equal(listRecords(change, 'add-x')[0].what, 'duplicate: src/b.ts:3 repeats src/a.ts:12')
})

test('a marker covers a finding recorded with absolute locations', () => {
  const { change } = host()
  commitIn(change, 'src/c.ts', 'x\n// ADF DUP src/a.ts:12 -- kept\nexport const c = 1\n')
  swept(change, [{ introduced: join(change, 'src/c.ts:3'), existing: join(change, 'src/a.ts:12'), why: 'Same constant.' }])
  const state = sweepState(change, 'add-x')
  assert.deepEqual([state.open, state.cleared], [[], [{ id: 'S1', by: 'marker', marker: 'src/c.ts:2' }]])
})

test('a finding dismissed with mark --commit is cleared as dismissed, not consolidated, though its marker shifted the line', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'x\n\nexport function parse() {}\n')
  swept(change, [{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'both parse the header' }])
  mark(change, ['--file', 'src/b.ts', '--line', '3', '--commit'])
  // The re-sweep reports the duplicate at line 4, which the marker accepts, so it is silent.
  swept(change, [])
  assert.deepEqual(sweepState(change, 'add-x').cleared, [{ id: 'S1', by: 'dismissed', debt: 'debt-1' }])
})

test('mark --finding reads existing and why from the sweep reply, so no prose passes through the shell', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'x\n\nexport function parse() {}\n')
  mkdirSync(join(change, 'r'), { recursive: true })
  const why = 'both map the `columns` of the header'
  writeFileSync(join(change, 'r/s.json'), JSON.stringify({ role: 'sweep', findings: [{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why }] }))
  for (const name of ['sweep p1', 'sweep p2']) assert.equal(dispatch(['reply', '--change', 'add-x', '--name', name, '--file', 'r/s.json', '--root', change], { main: change }).valid, true)
  const byId = (id) => dup(['mark', '--change', 'add-x', '--finding', 'r/s.json', '--id', id, '--reason', 'the wire format differs', '--root', change])
  assert.throws(() => byId('S9'), /S9 is no open sweep finding/)
  const out = byId('S1')
  assert.deepEqual([out.file, out.line, out.marker], ['src/b.ts', 3, '// ADF DUP src/a.ts:12 -- the wire format differs'])
  const [debt] = listRecords(change, 'add-x')
  assert.deepEqual([debt.what, debt.reason, debt.accepted], ['duplicate: src/b.ts:3 repeats src/a.ts:12', why, 'the wire format differs'])
  assert.throws(() => dup(['mark', '--change', 'add-x', '--finding', 'r/s.json', '--id', 'S1', '--existing', 'x', '--reason', 'r', '--root', change]), /usage/)
})

test('a marker placed on a recorded finding covers it without a re-sweep, though the code moved below it', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'x\n\nexport function parse() {}\n')
  swept(change, [{ introduced: 'src/b.ts:3', existing: 'src/a.ts:12', why: 'both parse the header' }])
  mark(change, ['--file', 'src/b.ts', '--line', '3'])
  assert.deepEqual(sweepState(change, 'add-x').cleared, [{ id: 'S1', by: 'marker', marker: 'src/b.ts:3' }])
})

test('an accepted dismissal debt clears a finding without a re-sweep where no marker fits', () => {
  const { change } = host()
  commitIn(change, 'data.json', '{}\n')
  swept(change, [{ introduced: 'data.json', existing: 'src/a.json', why: 'Same defaults.' }])
  appendRecord(change, 'add-x', 'debt', { what: 'duplicate: data.json repeats src/a.json', reason: 'Same defaults.', accepted: 'kept per environment' })
  const state = sweepState(change, 'add-x')
  assert.deepEqual([state.open, state.cleared], [[], [{ id: 'S1', by: 'dismissed', debt: 'debt-1' }]])
})

test('the two passes of the first sweep are one run: a p2 finding matching a p1 finding by overlapping lines is dropped', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'export const b = 1\n'.repeat(12))
  const head = git(change, 'rev-parse', 'HEAD')
  const pass = (n, findings) => recordReply(change, 'add-x', { name: `sweep p${n}`, file: `p${n}.json`, result: { verdict: 'FINDINGS', findings, dropped: [], head } })
  const b = { introduced: 'src/b.ts:2-5', existing: 'src/a.ts:10-20', why: 'Same mapper.' }
  const c = { introduced: 'src/c.ts:1', existing: 'src/a.ts:1', why: 'Same constant.' }
  pass(1, [b, c])
  // One pass alone is no sweep yet.
  assert.deepEqual(sweepState(change, 'add-x'), { ran: false, ids: [], open: [], cleared: [], missing: ['sweep p2'] })
  const again = { introduced: 'src/b.ts:4-8', existing: 'src/a.ts:15', why: 'The same mapper, worded otherwise.' }
  const d = { introduced: 'src/d.ts:1-3', existing: 'src/a.ts:30', why: 'Same guard.' }
  const below = { introduced: 'src/b.ts:9-12', existing: 'src/a.ts:10', why: 'Same parser.' }
  pass(2, [d, again, below])
  const state = sweepState(change, 'add-x')
  assert.deepEqual(state.ids, ['S1', 'S2', 'S3', 'S4'])
  assert.deepEqual(state.open.map((f) => [f.id, f.introduced, f.why]), [
    ['S1', 'src/b.ts:2-5', 'Same mapper.'],
    ['S2', 'src/c.ts:1', 'Same constant.'],
    ['S3', 'src/d.ts:1-3', 'Same guard.'],
    ['S4', 'src/b.ts:9-12', 'Same parser.']
  ])
  // A bare path overlaps every range; another file never matches.
  assert.equal(sameDuplicate({ introduced: 'src/b.ts', existing: 'src/a.ts:3' }, { introduced: 'src/b.ts:7', existing: 'src/a.ts:1-4' }), true)
  assert.equal(sameDuplicate({ introduced: 'src/b.ts:1', existing: 'src/a.ts:3' }, { introduced: 'src/b.ts:1', existing: 'src/e.ts:3' }), false)
})

test('a duplicate reported again at shifted lines keeps its S id', () => {
  const { change } = host()
  commitIn(change, 'src/b.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n')
  swept(change, [{ introduced: 'src/b.ts:3-6', existing: 'src/a.ts:12-20', why: 'Same parser.' }])
  // An edit above it moves the duplicate two lines down; the re-sweep reports it there.
  commitIn(change, 'src/b.ts', 'zero\nzero\none\ntwo\nthree\nfour\nfive\nsix\n')
  swept(change, [{ introduced: 'src/b.ts:5-8', existing: 'src/a.ts:12-20', why: 'The parser again.' }])
  const state = sweepState(change, 'add-x')
  assert.deepEqual([state.ids, state.open.map((f) => [f.id, f.introduced, f.why]), state.cleared], [['S1'], [['S1', 'src/b.ts:3-6', 'Same parser.']], []])
})
