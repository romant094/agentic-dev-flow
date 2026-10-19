import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotate, rotateFiles, splitEntries } from '../lib/rotate.mjs'

const PREFIX = '# Log\n\n> Rotated monthly.\n'
const entry = (ts, title, body = '- a line') => `## [${ts}] task | ${title} | Dev\n${body}\n`
const log = (...entries) => `${PREFIX}\n${entries.join('\n')}`

test('does nothing when every entry is from the current month', () => {
  const text = log(entry('2026-09-30 10:00', 'a'), entry('2026-09-01 10:00', 'b'))
  const r = rotate({ logText: text, archives: {}, currentMonth: '2026-09' })
  assert.equal(r.logText, text)
  assert.deepEqual(r.report, [])
})

test('moves an older month into a new archive file, newest first, and out of the log', () => {
  const text = log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late'), entry('2026-09-02 10:00', 'early'))
  const r = rotate({ logText: text, archives: {}, currentMonth: '2026-10' })
  assert.equal(r.logText, log(entry('2026-10-01 09:00', 'new')))
  const archived = splitEntries(r.archives['2026-09']).entries.map((e) => e.header)
  assert.deepEqual(archived, ['## [2026-09-30 10:00] task | late | Dev', '## [2026-09-02 10:00] task | early | Dev'])
  assert.match(r.archives['2026-09'], /^# Log Archive — 2026-09\n\n/)
})

test('removes an entry a half-done rotation already archived without copying it again', () => {
  const archive = `# Log Archive — 2026-09\n\n${entry('2026-09-02 10:00', 'early')}`
  const text = log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late'), entry('2026-09-02 10:00', 'early'))
  const r = rotate({ logText: text, archives: { '2026-09': archive }, currentMonth: '2026-10' })
  assert.equal(splitEntries(r.archives['2026-09']).entries.length, 2)
  assert.deepEqual(r.report, ['2026-09: 1 copied, 1 already archived and removed from log.md'])
})

test('keeps an entry body exactly, blank lines inside it included', () => {
  const body = '- first\n\n- second with `code` and | pipes |'
  const text = log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late', body))
  const r = rotate({ logText: text, archives: {}, currentMonth: '2026-10' })
  assert.ok(r.archives['2026-09'].includes(`## [2026-09-30 10:00] task | late | Dev\n${body}\n`))
})

test('stops instead of writing an archive that would hold an entry twice', () => {
  const archive = `# Log Archive — 2026-09\n\n${entry('2026-09-02 10:00', 'early')}\n${entry('2026-09-02 10:00', 'early')}`
  const text = log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late'))
  assert.throws(() => rotate({ logText: text, archives: { '2026-09': archive }, currentMonth: '2026-10' }), /twice/)
})

test('leaves text before the first entry where it is', () => {
  const text = `${PREFIX}\nstray prose\n\n${entry('2026-10-01 09:00', 'new')}\n${entry('2026-09-30 10:00', 'late')}`
  assert.ok(rotate({ logText: text, archives: {}, currentMonth: '2026-10' }).logText.startsWith(`${PREFIX}\nstray prose\n`))
})

test('a legacy header with a zone suffix starts an entry of its own and rotates with its month', () => {
  const zoned = '## [2026-07-13 15:40 +03] task | zoned | Dev\n- z\n'
  const text = log(entry('2026-08-01 09:00', 'new'), zoned, entry('2026-07-01 10:00', 'old'))
  const { entries } = splitEntries(text)
  assert.deepEqual(entries.map((e) => e.month), ['2026-08', '2026-07', '2026-07'])
  const r = rotate({ logText: text, archives: {}, currentMonth: '2026-08' })
  assert.equal(r.logText, log(entry('2026-08-01 09:00', 'new')))
  assert.deepEqual(splitEntries(r.archives['2026-07']).entries.map((e) => e.header), ['## [2026-07-13 15:40 +03] task | zoned | Dev', '## [2026-07-01 10:00] task | old | Dev'])
})

test('rotateFiles creates log-archive/ when it is missing, and writes nothing when there is nothing to move', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rotate-'))
  writeFileSync(join(dir, 'log.md'), log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late')))
  assert.deepEqual(rotateFiles(dir, '2026-09'), { rotated: [], report: [] })
  assert.equal(existsSync(join(dir, 'log-archive')), false)
  const r = rotateFiles(dir, '2026-10')
  assert.deepEqual(r.rotated, ['2026-09'])
  assert.match(readFileSync(join(dir, 'log-archive', '2026-09.md'), 'utf8'), /late/)
  assert.doesNotMatch(readFileSync(join(dir, 'log.md'), 'utf8'), /late/)
  // A second run finds nothing more to move.
  assert.deepEqual(rotateFiles(dir, '2026-10').rotated, [])
})

test('rotateFiles merges into an existing archive and leaves both files alone on a duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rotate-'))
  mkdirSync(join(dir, 'log-archive'))
  const twice = `# Log Archive — 2026-09\n\n${entry('2026-09-02 10:00', 'early')}\n${entry('2026-09-02 10:00', 'early')}`
  writeFileSync(join(dir, 'log-archive', '2026-09.md'), twice)
  const text = log(entry('2026-10-01 09:00', 'new'), entry('2026-09-30 10:00', 'late'))
  writeFileSync(join(dir, 'log.md'), text)
  assert.throws(() => rotateFiles(dir, '2026-10'), /twice/)
  assert.equal(readFileSync(join(dir, 'log.md'), 'utf8'), text)
  assert.equal(readFileSync(join(dir, 'log-archive', '2026-09.md'), 'utf8'), twice)
})
