import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, check, entryBody, insertEntry, links, utcStamp } from '../lib/memory.mjs'
import { main } from '../memory.mjs'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(pluginDir, 'scripts', 'memory.mjs')
const PREFIX = '# Log\n\n> Rotated monthly.\n'
const entry = (ts, title, body = '- a line') => `## [${ts}] task | ${title} | Dev\n${body}\n`
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// A git host with the plugin's skeleton copied in, as /adf:add does, and committed.
function host({ name = 'Dev Person', logText } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-host-')))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'd@example.com')
  if (name) git(root, 'config', 'user.name', name)
  const declaration = JSON.parse(readFileSync(join(pluginDir, 'adf-extension.json'), 'utf8'))
  for (const { from, to } of declaration.hostFiles) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    writeFileSync(join(root, to), readFileSync(join(pluginDir, from), 'utf8'))
  }
  if (logText) writeFileSync(join(root, BASE, 'log.md'), logText)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init', '--no-verify')
  return root
}

const logPath = (root) => join(root, BASE, 'log.md')
const read = (path) => readFileSync(path, 'utf8')
const at = (iso) => ({ now: new Date(iso) })
const role = (root, operation, input, opts) => main([operation], () => JSON.stringify({ root, config: {}, input }), opts)

test('the declaration provides knowledge with every operation and names contract 1.3', () => {
  const declared = JSON.parse(read(join(pluginDir, 'adf-extension.json')))
  assert.equal(declared.contract, '1.3')
  assert.deepEqual(declared.provides.knowledge.operations, ['context', 'log', 'check'])
  for (const { from } of declared.hostFiles) assert.equal(existsSync(join(pluginDir, from)), true, from)
})

test('context names the index, the instructions and the paths an ingest may write', () => {
  const root = host()
  const { code, result } = role(root, 'context', {})
  assert.equal(code, 0)
  assert.deepEqual({ ...result, instructions: Object.keys(result.instructions) }, {
    state: 'done',
    base: '.claude/memory',
    index: '.claude/memory/index.md',
    exists: true,
    instructions: ['ingest', 'query', 'lint', 'fix'],
    paths: ['.claude/memory/**']
  })
  for (const path of Object.values(result.instructions)) assert.equal(existsSync(path), true, path)
})

test('log writes the header in UTC with the git author, below the heading and its note', () => {
  const root = host()
  const { code, result } = role(root, 'log', { type: 'ingest', title: 'first', bullets: ['one', '- two'] }, at('2026-10-19T21:30:00+03:00'))
  assert.equal(code, 0)
  assert.equal(result.entry, '## [2026-10-19 18:30] ingest | first | Dev Person\n- one\n- two\n')
  assert.deepEqual(result.rotated, [])
  const text = read(logPath(root))
  assert.match(text, /^# Log\n\n> Rotated monthly\.[^\n]*\n\n## \[2026-10-19 18:30\] ingest \| first \| Dev Person\n- one\n- two\n$/)
})

test('log inserts an entry at its timestamp\'s place, keeping the log\'s separation', () => {
  const tight = `${PREFIX}\n${entry('2026-10-12 18:00', 'c')}${entry('2026-10-12 16:00', 'b')}${entry('2026-10-11 09:00', 'a')}`
  const inserted = insertEntry(tight, ['## [2026-10-12 17:00] task | mid | X', '- m'])
  assert.equal(inserted, `${PREFIX}\n${entry('2026-10-12 18:00', 'c')}## [2026-10-12 17:00] task | mid | X\n- m\n${entry('2026-10-12 16:00', 'b')}${entry('2026-10-11 09:00', 'a')}`)
  const spaced = `${PREFIX}\n${entry('2026-10-12 18:00', 'c')}\n${entry('2026-10-11 09:00', 'a')}`
  assert.equal(insertEntry(spaced, ['## [2026-10-10 08:00] task | old | X', '- o']), `${spaced}\n## [2026-10-10 08:00] task | old | X\n- o\n`)
  assert.equal(insertEntry(spaced, ['## [2026-10-13 08:00] task | top | X', '- t']), `${PREFIX}\n## [2026-10-13 08:00] task | top | X\n- t\n\n${entry('2026-10-12 18:00', 'c')}\n${entry('2026-10-11 09:00', 'a')}`)
  // An entry of the same minute goes above: it was written later.
  assert.match(insertEntry(spaced, ['## [2026-10-12 18:00] task | same | X', '- s']), /> Rotated monthly\.\n\n## \[2026-10-12 18:00\] task \| same/)
})

test('log rotates first: a new month\'s entry lands above an archived previous month', () => {
  const root = host({ logText: `${PREFIX}\n${entry('2026-09-30 10:00', 'late')}` })
  assert.equal(existsSync(join(root, BASE, 'log-archive')), false, 'the skeleton ships no log-archive/')
  const { result } = role(root, 'log', { type: 'task', title: 'october', bullets: ['o'] }, at('2026-10-01T00:05:00Z'))
  assert.deepEqual(result.rotated, ['2026-09'])
  assert.match(read(join(root, BASE, 'log-archive', '2026-09.md')), /late/)
  assert.doesNotMatch(read(logPath(root)), /late/)
})

test('log --commit --reason writes the one-line form', () => {
  const root = host()
  const one = role(root, 'log', { type: 'task', title: 'fix typo', commit: 'abc1234', reason: 'a typo in the help' }, at('2026-10-19T10:00:00Z')).result
  assert.equal(one.entry, '## [2026-10-19 10:00] task | fix typo | Dev Person\n- see commit abc1234 — a typo in the help\n')
  assert.deepEqual(entryBody({ commit: 'abc1234, def5678', reason: 'r' }), { lines: ['- see commits abc1234, def5678 — r'] })
})

test('log refuses bad input and writes nothing', () => {
  const root = host()
  const before = read(logPath(root))
  const refusals = [
    [{ type: 'note', title: 't', bullets: ['b'] }, /type must be one of ingest, query, lint, task/],
    [{ type: 'task', title: 'a | b', bullets: ['b'] }, /title must be one non-empty line without "\|"/],
    [{ type: 'task', title: 't' }, /give either bullets, or commit and reason/],
    [{ type: 'task', title: 't', bullets: ['b'], commit: 'abc1234', reason: 'r' }, /give either bullets, or commit and reason/],
    [{ type: 'task', title: 't', bullets: ['one\n\ntwo'] }, /blank line inside an entry/],
    [{ type: 'task', title: 't', commit: 'not-a-sha', reason: 'r' }, /commit must be one or more commit hashes/],
    [{ type: 'task', title: 't', commit: 'abc1234', reason: '' }, /reason must be one non-empty line/]
  ]
  for (const [input, error] of refusals) {
    const { code, result } = role(root, 'log', input, at('2026-10-19T10:00:00Z'))
    assert.equal(code, 1)
    assert.match(result.error, error)
  }
  assert.equal(read(logPath(root)), before)
  const anonymous = host({ name: '' })
  const unnamed = role(anonymous, 'log', { type: 'task', title: 't', bullets: ['b'] }, at('2026-10-19T10:00:00Z'))
  // A global user.name on the machine running the test would fill it; only assert when unset.
  if (unnamed.code === 1) assert.match(unnamed.result.error, /git config user\.name is not set/)
})

test('log --amend replaces the uncommitted entry of the same title, and is refused without one', () => {
  const root = host()
  const refusedAmend = role(root, 'log', { type: 'task', title: 'work', bullets: ['x'], amend: true }, at('2026-10-19T10:00:00Z'))
  assert.equal(refusedAmend.code, 1)
  assert.match(refusedAmend.result.error, /no uncommitted log entry titled "work"/)
  role(root, 'log', { type: 'task', title: 'work', bullets: ['first pass'] }, at('2026-10-19T10:00:00Z'))
  role(root, 'log', { type: 'query', title: 'other', bullets: ['q'] }, at('2026-10-19T10:30:00Z'))
  const amended = role(root, 'log', { type: 'task', title: 'work', bullets: ['first pass', 'second pass'], amend: true }, at('2026-10-19T11:00:00Z'))
  assert.equal(amended.result.amended, true)
  const text = read(logPath(root))
  assert.doesNotMatch(text, /10:00\] task \| work/)
  assert.match(text, /## \[2026-10-19 11:00\] task \| work \| Dev Person\n- first pass\n- second pass\n\n## \[2026-10-19 10:30\] query \| other/)
  // Once committed, the entry is no longer amendable.
  git(root, 'commit', '-q', '-am', 'log', '--no-verify')
  assert.equal(role(root, 'log', { type: 'task', title: 'work', bullets: ['x'], amend: true }, at('2026-10-19T12:00:00Z')).code, 1)
})

test('check reports unindexed pages, broken links, malformed headers and entries out of order', () => {
  const root = host()
  const mem = join(root, BASE)
  mkdirSync(join(mem, 'concepts'), { recursive: true })
  mkdirSync(join(mem, 'entities'), { recursive: true })
  writeFileSync(join(mem, 'concepts', 'listed.md'), '# Listed\n\nSee [the orphan](../entities/orphan.md) and [gone](gone.md#part).\n\n```\n[not a link](nowhere.md)\n```\nAnd `[code](nowhere.md)`, [web](https://example.com), [anchor](#top).\n')
  writeFileSync(join(mem, 'entities', 'orphan.md'), '# Orphan\n')
  writeFileSync(join(mem, 'index.md'), `${read(join(mem, 'index.md'))}| [Listed](concepts/listed.md) | a page |\n`)
  writeFileSync(join(mem, 'log.md'), `${PREFIX}\n${entry('2026-10-11 09:00', 'early')}${entry('2026-10-12 16:24', 'late')}## [2026-10-10] task | no time | Dev\n- x\n## [2026-10-09 10:00 +03] task | zoned | Dev\n- z\n`)
  mkdirSync(join(mem, 'log-archive'))
  writeFileSync(join(mem, 'log-archive', '2026-09.md'), '# Log Archive — 2026-09\n\n[old](missing.md)\n')
  const { code, result } = main(['check', '--root', root], () => '')
  assert.equal(code, 0)
  assert.equal(result.pages, 4)
  assert.deepEqual(result.findings, [
    { kind: 'broken-link', path: '.claude/memory/concepts/listed.md', line: 3, target: 'gone.md#part' },
    { kind: 'unindexed', path: '.claude/memory/entities/orphan.md' },
    { kind: 'malformed-header', path: '.claude/memory/log.md', line: 9, text: '## [2026-10-10] task | no time | Dev' },
    { kind: 'out-of-order', path: '.claude/memory/log.md', line: 7, header: '## [2026-10-12 16:24] task | late | Dev', above: '## [2026-10-11 09:00] task | early | Dev' }
  ])
})

test('check on a host without the knowledge base names what is missing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-empty-')))
  assert.deepEqual(check(root), { state: 'done', pages: 0, findings: [{ kind: 'missing', path: '.claude/memory/index.md' }, { kind: 'missing', path: '.claude/memory/log.md' }] })
})

test('links skips URLs, anchors and code, and reads angle-bracket targets', () => {
  const found = links('[a](<with space.md>) [b](https://x) [c](#y) `[d](e.md)` [f](g.md "title")', '/base')
  assert.deepEqual(found.map((l) => [l.target, l.resolved]), [['with space.md', '/base/with space.md'], ['g.md', '/base/g.md']])
})

test('utcStamp formats the clock in UTC', () => {
  assert.equal(utcStamp(new Date('2026-10-19T00:59:00+03:00')), '2026-10-18 21:59')
})

test('the CLI: flags and stdin, exit 1 on a refusal and 2 on a usage error', () => {
  const root = host()
  const run = (args, input) => {
    const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', input: input ?? '', cwd: root })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  const byFlags = run(['log', '--type', 'task', '--title', 'by hand', '--bullet', 'b', '--root', root])
  assert.equal(byFlags.code, 0)
  assert.match(byFlags.out.entry, /^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] task \| by hand \| Dev Person\n- b\n$/)
  const byRole = run(['context'], JSON.stringify({ root, config: {}, input: {} }))
  assert.equal(byRole.out.index, '.claude/memory/index.md')
  assert.equal(run(['check']).out.state, 'done', 'an empty stdin reads the current directory')
  assert.equal(run(['log', '--type', 'note', '--title', 't', '--bullet', 'b']).code, 1)
  const usage = run(['log', '--colour'])
  assert.equal(usage.code, 2)
  assert.match(usage.out.usage, /^usage:/)
  assert.equal(run(['merge']).code, 2)
  assert.equal(run(['check', '--type', 'task']).code, 2)
  assert.equal(run(['context'], '{not json').code, 2)
})
