import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { encodeKeys } from '../lib/transcripts.mjs'
import { run } from '../runlog.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const put = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const list = (archive) => execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean)
const readIn = (archive, name) => execFileSync('tar', ['-xzOf', archive, name], { encoding: 'utf8' })

// A project with one worktree, and an empty runtime home; removed by the caller.
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'adf-runlog-spec-')))
  const main = join(base, 'project')
  mkdirSync(main)
  git(main, 'init', '-q')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  const worktree = join(main, '.claude', 'worktrees', 'my-change')
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'feat/my-change')
  return { base, main, worktree, home: join(base, 'home') }
}
const rollout = (home, date, name, cwd) => {
  const [y, m, d] = date.split('-')
  put(join(home, 'sessions', y, m, d, name), `${JSON.stringify({ timestamp: `${date}T10:00:00Z`, type: 'session_meta', payload: { id: name, cwd } })}\n{"type":"x"}\n`)
}
const collectIn = (s, runtime, extra = []) => run(['collect', '--from', '2026-11-01', '--to', '2026-11-04', '--root', s.main, ...extra], { env: { ADF_RUNTIME: runtime, CODEX_HOME: s.home, CLAUDE_CONFIG_DIR: s.home } })

test('codex rollouts of the project and its worktrees are packed, others are not', () => {
  const s = setup()
  try {
    rollout(s.home, '2026-11-02', 'rollout-a.jsonl', s.main)
    rollout(s.home, '2026-11-03', 'rollout-b.jsonl', s.worktree)
    rollout(s.home, '2026-11-03', 'rollout-c.jsonl', join(s.main, 'sub'))
    rollout(s.home, '2026-11-03', 'rollout-other.jsonl', join(s.base, 'elsewhere'))
    rollout(s.home, '2026-10-01', 'rollout-old.jsonl', s.main)
    put(join(s.home, 'auth.json'), '{"token":"secret"}')
    put(join(s.main, '.superpowers', 'sdd', 'my-change', 'ledger.jsonl'), `${JSON.stringify({ id: 'x-1', kind: 'note', at: '2026-11-02T09:00:00Z' })}\n`)
    for (const secret of ['.env', '.envrc', '.env.local', '.ENV', 'tls.pem', 'id.key']) put(join(s.main, '.superpowers', 'sdd', 'my-change', secret), 'SECRET=1')
    put(join(s.main, 'openspec', 'changes', 'my-change', '.env.local'), 'SECRET=1')
    put(join(s.main, 'openspec', 'changes', 'my-change', 'proposal.md'), '# p')
    put(join(s.main, '.superpowers', 'sdd', 'old-change', 'ledger.jsonl'), `${JSON.stringify({ id: 'x-1', kind: 'note', at: '2026-09-02T09:00:00Z' })}\n`)
    const result = collectIn(s, 'codex')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.archive, join(s.main, '.adf', 'runlog', '2026-11-04-codex.tar.gz'))
    assert.equal(result.sessions, 3)
    assert.deepEqual(result.changes, ['my-change'])
    const files = list(result.archive)
    for (const f of ['sessions/rollout-a.jsonl', 'sessions/rollout-b.jsonl', 'sessions/rollout-c.jsonl', 'changes/my-change/sdd/ledger.jsonl', 'changes/my-change/openspec/proposal.md', 'registry.json', 'versions.json']) {
      assert.ok(files.includes(f), `${f} missing from ${files}`)
    }
    assert.ok(!files.some((f) => /other|old|auth\.json|\.env|\.ENV|\.pem|\.key|old-change/.test(f)), files.join('\n'))
    const versions = JSON.parse(readIn(result.archive, 'versions.json'))
    assert.equal(versions.runtime, 'codex')
    assert.equal(versions.node, process.version)
    assert.deepEqual(versions.window, { from: '2026-11-01', to: '2026-11-04' })
    assert.ok('runtimeVersion' in versions && 'plugins' in versions && Array.isArray(versions.skipped))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('claude-code transcripts are packed by project key', () => {
  const s = setup()
  try {
    const [key] = encodeKeys(s.main)
    const [wkey] = encodeKeys(s.worktree)
    put(join(s.home, 'projects', key, 'sess-1.jsonl'), '{}\n')
    put(join(s.home, 'projects', key, 'sess-1', 'subagents', 'agent-1.jsonl'), '{}\n')
    put(join(s.home, 'projects', wkey, 'sess-2.jsonl'), '{}\n')
    put(join(s.home, 'projects', '-somewhere-else', 'sess-3.jsonl'), '{}\n')
    // The files were just written, so they are dated today.
    const today = new Date().toISOString().slice(0, 10)
    const out = run(['collect', '--from', today, '--to', today, '--root', s.main], { env: { ADF_RUNTIME: 'claude-code', CLAUDE_CONFIG_DIR: s.home } })
    assert.equal(out.sessions, 2)
    const files = list(out.archive)
    assert.ok(files.includes('sessions/sess-1.jsonl') && files.includes('sessions/sess-2.jsonl'))
    assert.ok(files.includes('sessions/sess-1/subagents/agent-1.jsonl'))
    assert.ok(!files.some((f) => f.includes('sess-3')))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('broken and missing sessions are named, not fatal', () => {
  const s = setup()
  try {
    put(join(s.home, 'sessions', '2026', '11', '02', 'rollout-bad.jsonl'), 'not json\n')
    rollout(s.home, '2026-11-02', 'rollout-good.jsonl', s.main)
    put(join(s.main, '.superpowers', 'sdd', 'my-change', 'ledger.jsonl'), `${JSON.stringify({ id: 'session-1', kind: 'session', at: '2026-11-02T09:00:00Z', sessionId: 'gone-uuid' })}\n`)
    const result = collectIn(s, 'codex')
    assert.equal(result.ok, true)
    assert.equal(result.sessions, 1)
    assert.ok(result.skipped.some((x) => x.what.endsWith('rollout-bad.jsonl') && /broken/.test(x.reason)), JSON.stringify(result.skipped))
    assert.ok(result.skipped.some((x) => x.what === 'session gone-uuid'), JSON.stringify(result.skipped))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('the warning says the archive holds whole sessions', () => {
  const s = setup()
  try {
    const result = collectIn(s, 'codex')
    assert.match(result.warning, /whole session/)
    assert.ok(result.bytes > 0 && existsSync(result.archive))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('a bad date is a refusal, a bad command a usage error', () => {
  const s = setup()
  try {
    assert.equal(run(['collect', '--from', 'yesterday', '--root', s.main]).ok, false)
    assert.throws(() => run(['pack']), /usage/)
    assert.throws(() => run(['collect', '--bogus', 'x']), /unknown argument/)
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('.adf/runlog/ is ignored by the host .gitignore lines', () => {
  const s = setup()
  try {
    ignoreLocalDirs(s.main)
    const result = collectIn(s, 'codex')
    git(s.main, 'check-ignore', '-q', result.archive)
    assert.equal(git(s.main, 'status', '--porcelain', '--', '.adf'), '')
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('a large rollout still matches by its first line; a first line over the head is skipped', () => {
  const s = setup()
  try {
    const [y, m, d] = ['2026', '11', '02']
    const meta = (cwd) => JSON.stringify({ type: 'session_meta', payload: { cwd } })
    put(join(s.home, 'sessions', y, m, d, 'rollout-big.jsonl'), `${meta(s.main)}\n${'x'.repeat(2 * 1024 * 1024)}\n`)
    put(join(s.home, 'sessions', y, m, d, 'rollout-long.jsonl'), `${meta(s.main).slice(0, -2)},"pad":"${'y'.repeat(300 * 1024)}"}}\n`)
    const result = collectIn(s, 'codex')
    assert.equal(result.ok, true)
    assert.equal(result.sessions, 1)
    assert.ok(list(result.archive).includes('sessions/rollout-big.jsonl'))
    assert.ok(result.skipped.some((x) => x.what.endsWith('rollout-long.jsonl') && /broken/.test(x.reason)))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('a sibling directory that only shares the path prefix is not the project', () => {
  const s = setup()
  try {
    rollout(s.home, '2026-11-02', 'rollout-sib.jsonl', `${s.main}2`)
    const today = new Date().toISOString().slice(0, 10)
    put(join(s.home, 'projects', encodeKeys(`${s.main}2`)[0], 'sib-1.jsonl'), '{}\n')
    assert.equal(collectIn(s, 'codex').sessions, 0)
    const claude = run(['collect', '--from', today, '--to', today, '--root', s.main], { env: { ADF_RUNTIME: 'claude-code', CLAUDE_CONFIG_DIR: s.home } })
    assert.equal(claude.sessions, 0)
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})

test('a ledger that does not parse is named in skipped', () => {
  const s = setup()
  try {
    put(join(s.main, '.superpowers', 'sdd', 'bad-change', 'ledger.jsonl'), '{not json\n')
    const result = collectIn(s, 'codex')
    assert.equal(result.ok, true)
    assert.ok(result.skipped.some((x) => x.what.endsWith(join('bad-change', 'ledger.jsonl'))))
  } finally {
    rmSync(s.base, { recursive: true, force: true })
  }
})
