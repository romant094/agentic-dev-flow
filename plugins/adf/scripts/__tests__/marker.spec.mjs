// lib/marker.mjs and review.mjs markers/mark: the ADF IGNORE, IGNORE-START/END and DUP markers,
// their grammar, their placement in each comment syntax and the scan of a tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as dup from '../lib/dup.mjs'
import { commentFor, COMMENTS, KEY, markIgnore, pairErrors, parseMarker, scanMarkers } from '../lib/marker.mjs'
import { FINDINGS_SCHEMA_PATH, readSchema } from '../lib/review.mjs'
import { run as review } from '../review.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function repo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-marker-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  for (const [file, text] of Object.entries({ 'a.txt': 'a\n', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

test('dup.mjs reads the comment syntax table from lib/marker.mjs', () => {
  assert.equal(dup.COMMENTS, COMMENTS)
  assert.equal(dup.commentFor, commentFor)
  assert.deepEqual(dup.parseMarker('// ADF DUP src/a.ts:12 -- kept'), { existing: 'src/a.ts:12', reason: 'kept' })
})

test('the IGNORE grammar parses in every comment syntax, and refuses a keyless marker', () => {
  assert.deepEqual(parseMarker('  // ADF IGNORE CWE-79 -- escaped by the template'), { kind: 'ignore', key: 'CWE-79', reason: 'escaped by the template' })
  assert.deepEqual(parseMarker('# ADF IGNORE-START DUP -- kept on purpose'), { kind: 'start', key: 'DUP', reason: 'kept on purpose' })
  assert.deepEqual(parseMarker('<!-- ADF IGNORE CWE-20 -- static text -->'), { kind: 'ignore', key: 'CWE-20', reason: 'static text' })
  assert.deepEqual(parseMarker('/* ADF IGNORE-END */'), { kind: 'end' })
  assert.match(parseMarker('// ADF IGNORE -- setForm calls are safe here').error, /^keyless/)
  assert.match(parseMarker('// ADF IGNORE').error, /^keyless/)
  assert.match(parseMarker('// ADF IGNORE setForm calls are safe -- x').error, /is not a marker key/)
  assert.match(parseMarker('// ADF IGNORE cwe-79 -- x').error, /is not a marker key/)
  assert.match(parseMarker('// ADF IGNORE CWE-79').error, /no reason/)
  assert.match(parseMarker('// ADF IGNORE-END CWE-79').error, /takes no key/)
  assert.match(parseMarker('// ADF DUP src/a.ts:12').error, /no reason/)
})

test('prose about a marker is not a marker', () => {
  assert.equal(parseMarker('// write `ADF IGNORE <key> -- <reason>` above the line'), null)
  assert.equal(parseMarker("const text = 'ADF IGNORE CWE-79 -- x'"), null)
  assert.equal(parseMarker('// ADF IGNORED nothing'), null)
  assert.equal(parseMarker('// review-ignore: CWE-79 -- origin form'), null)
})

test('START and END pair within a file', () => {
  const at = (kind, line) => ({ kind, line })
  assert.deepEqual(pairErrors([at('start', 1), at('end', 5)]), [])
  assert.deepEqual(pairErrors([at('end', 2)]).map((e) => e.error), ['IGNORE-END with no IGNORE-START above it'])
  assert.deepEqual(pairErrors([at('start', 1)]).map((e) => e.error), ['IGNORE-START with no IGNORE-END below it'])
  assert.deepEqual(pairErrors([at('start', 1), at('start', 3), at('end', 5)]).map((e) => [e.line, e.error]), [[3, 'IGNORE-START inside the block opened on line 1']])
})

test('the marker key grammar is the findings schema key pattern', () => {
  assert.equal(readSchema(FINDINGS_SCHEMA_PATH).$defs.finding.properties.key.pattern, KEY.source)
})

test('mark writes the IGNORE marker above the line, in the file syntax, with its indentation and line ending', () => {
  const root = repo({ 'src/a.ts': 'function f() {\n  run(x)\n}\n', 'run.py': 'a = 1\r\nb = 2\r\n', 'style.css': 'a {}\n', 'data.json': '{}\n' })
  const out = review(['mark', '--file', 'src/a.ts', '--line', '2', '--key', 'CWE-78', '--reason', 'x is a constant', '--root', root])
  assert.deepEqual(out, { ok: true, file: 'src/a.ts', line: 2, marker: '// ADF IGNORE CWE-78 -- x is a constant', already: false })
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'function f() {\n  // ADF IGNORE CWE-78 -- x is a constant\n  run(x)\n}\n')
  assert.equal(review(['mark', '--file', 'src/a.ts', '--line', '3', '--key', 'CWE-78', '--reason', 'again', '--root', root]).already, true)
  markIgnore(root, { file: 'run.py', line: 2, key: 'CWE-20', reason: 'trusted' })
  assert.equal(readFileSync(join(root, 'run.py'), 'utf8'), 'a = 1\r\n# ADF IGNORE CWE-20 -- trusted\r\nb = 2\r\n')
  assert.throws(() => markIgnore(root, { file: 'data.json', line: 1, key: 'CWE-20', reason: 'r' }), /no comment syntax/)
  assert.throws(() => markIgnore(root, { file: 'style.css', line: 1, key: 'CWE-20', reason: 'ends */ here' }), /close the comment/)
  assert.throws(() => markIgnore(root, { file: 'src/a.ts', line: 1, key: 'not a key', reason: 'r' }), /not a marker key/)
  assert.throws(() => markIgnore(root, { file: 'src/a.ts', line: 1, key: 'CWE-1', reason: 'two\nlines' }), /one line/)
  assert.throws(() => markIgnore(root, { file: 'src/a.ts', line: 99, key: 'CWE-1', reason: 'r' }), /is not a line/)
  assert.throws(() => review(['mark', '--file', 'src/a.ts', '--key', 'CWE-1', '--reason', 'r', '--root', root]), /mark needs/)
})

test('markers lists every marker of the tree and refuses a keyless or unpaired one', () => {
  const root = repo({
    'src/ok.ts': '// ADF IGNORE CWE-79 -- escaped\nx()\n// ADF IGNORE-START DUP -- kept\ny()\n// ADF IGNORE-END\n',
    'src/dup.ts': '// ADF DUP src/a.ts:3 -- the wire format differs\n',
    'src/keyless.tsx': '// ADF IGNORE -- setForm calls are safe\nz()\n',
    'lib/open.py': '# ADF IGNORE-START CWE-20 -- block\nq = 1\n',
    'openspec/changes/c/notes.ts': '// ADF IGNORE -- inside a change record\n',
    'docs/about.md': 'Write `ADF IGNORE <key> -- <reason>` above the line.\n'
  })
  writeFileSync(join(root, 'untracked.sh'), '# ADF IGNORE-END\n')
  const out = review(['markers', '--root', root])
  assert.equal(out.ok, false)
  assert.deepEqual(
    out.markers.map((m) => [m.file, m.line, m.kind, m.key ?? m.existing]),
    [
      ['lib/open.py', 1, 'start', 'CWE-20'],
      ['src/dup.ts', 1, 'dup', 'src/a.ts:3'],
      ['src/ok.ts', 1, 'ignore', 'CWE-79'],
      ['src/ok.ts', 3, 'start', 'DUP'],
      ['src/ok.ts', 5, 'end', undefined],
      ['untracked.sh', 1, 'end', undefined]
    ]
  )
  assert.deepEqual(
    out.invalid.map((m) => [m.file, m.line, m.error.split(':')[0]]),
    [
      ['lib/open.py', 1, 'IGNORE-START with no IGNORE-END below it'],
      ['src/keyless.tsx', 1, 'keyless'],
      ['untracked.sh', 1, 'IGNORE-END with no IGNORE-START above it']
    ]
  )
  assert.deepEqual(scanMarkers(repo()), { markers: [], invalid: [] })
})
