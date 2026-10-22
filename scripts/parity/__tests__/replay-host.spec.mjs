// lib/replay-host.mjs on a fixture origin shaped like the real one: a debt tree with the `Jira`
// column and a root index whose format description names an example id, memory pages, a
// .gitignore. The setup runs the port's init path in a sandbox candidate, records each refusal
// with the minimal edit it made, commits on develop and pushes to the sandbox remote; the host
// checks pass after it and the origin is unchanged. The values the records hold for iteration 15
// are read from this repository's docs. The opt-in live check is in replay-replies.spec.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSandbox } from '../lib/sandbox.mjs'
import { editReport, hostEdits, ORDER, PLUGINS, recordedRegistry, RECORDED_GUIDE, setupHost } from '../lib/replay-host.mjs'

const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const ROOT_INDEX = [
  '# Technical Debt',
  '',
  '## How an entry is written',
  '',
  '| ID | Title | Anchors | Class | Source | Jira |',
  '|---|---|---|---|---|---|',
  '| `snmp-00` | An example row | `a.ts:1` | debt | `some-change` | |',
  '',
  '## Blocks',
  '',
  '| Block | Covers |',
  '|---|---|',
  '| [`snmp`](snmp/index.md) | SNMP |',
  ''
].join('\n')

const BLOCK = (header) => [header, '|---|---|---|---|---|---|', '| `snmp-01` | Pool leaks | `pool.ts:10` | defect | `x` | K-9 |', ''].join('\n')

// An origin whose develop holds the host files the switch meets; `block` is the snmp block's
// table header.
function fixtureOrigin({ block = '| ID | Title | Anchors | Class | Source | Jira |' } = {}) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-host-origin-'))), 'origin')
  execFileSync('git', ['init', '-q', '-b', 'develop', dir])
  const files = {
    '.gitignore': '.claude/worktrees/\nnode_modules\n.env\n',
    '.claude/memory/index.md': '# Memory Index\n',
    '.claude/memory/tech-debt/index.md': ROOT_INDEX,
    '.claude/memory/tech-debt/snmp/index.md': BLOCK(block),
    'openspec/specs/x/spec.md': '# x Specification\n\n## Purpose\n\nThe x capability is a fixture capability of the host setup test only.\n\n## Requirements\n\n### Requirement: X\n\nThe system SHALL x.\n\n#### Scenario: x\n\n- **WHEN** x\n- **THEN** x\n',
    'package.json': '{ "name": "host", "private": true }\n'
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=O', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', 'host')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

// The registry of the test: the real plugins by path, with fixture values in place of the
// recorded ones.
const REGISTRY = ORDER.map((name) => ({
  name,
  path: join(PLUGINS, name),
  config: {
    'adf-postgres': { prefix: 't', url: { file: '.env', key: 'DATABASE_URL' }, exec: 'local' },
    'adf-jira': { baseUrl: 'https://jira.example.invalid', allowlist: ['K'] }
  }[name] ?? null,
  notes: []
}))

const snapshot = (dir) => ({ refs: git(dir, 'for-each-ref'), status: git(dir, 'status', '--porcelain'), head: git(dir, 'rev-parse', 'HEAD') })

function withHost(origin, fn) {
  const sandbox = createSandbox({ origin: origin.dir })
  try {
    const candidate = sandbox.addCandidate('c1', { base: origin.base })
    fn(sandbox, candidate)
  } finally {
    sandbox.destroy()
  }
}

test('the setup records each debt refusal with its minimal edit, commits on develop, pushes, and the host checks pass after it', () => {
  const origin = fixtureOrigin()
  const before = snapshot(origin.dir)
  withHost(origin, (sandbox, c) => {
    const r = setupHost(sandbox, c, { registry: REGISTRY, change: 'add-x' })
    assert.equal(r.ok, true, editReport(r))
    assert.deepEqual(r.unclaimed, [])

    // The refusals of the origin tree, each with the edit that cleared it.
    const columns = r.refusals.filter((x) => /the columns must be/.test(x.message))
    assert.deepEqual(columns.map((x) => [x.file, x.line]), [['.claude/memory/tech-debt/snmp/index.md', 1]])
    assert.match(columns[0].edit, /renamed Jira to Tracker/)
    const example = r.refusals.find((x) => x.message === 'snmp-00 is named but no row carries it')
    assert.equal(example.file, '.claude/memory/tech-debt/index.md')
    assert.match(example.edit, /example row naming snmp-00 removed/)
    assert.equal(r.before.debt.ok, false)
    assert.ok(r.refusals.every((x) => x.edit !== null), JSON.stringify(r.refusals))

    // The edits, by path.
    const edits = Object.fromEntries(hostEdits(r).map((e) => [e.path, e.kinds]))
    assert.deepEqual(edits['.claude/adf-extensions.json'], ['init', 'branches', 'debt-root', 'add'])
    assert.deepEqual(edits['.claude/memory/tech-debt/snmp/index.md'], ['refusal'])
    assert.deepEqual(edits['.claude/memory/tech-debt/index.md'], ['refusal'])
    assert.deepEqual(edits['openspec/planning.md'], ['init', 'recorded'])
    for (const path of ['.claude/settings.json', '.gitignore', 'openspec/review-prompt.md', '.gitlab/merge_request_templates/adf.md', '.claude/memory/log.md', '.claude/memory/system.md']) assert.ok(edits[path], path)
    assert.equal(edits['.claude/memory/index.md'], undefined, 'a host file already present is kept')
    assert.ok(Object.keys(edits).some((p) => /^\.adf\/prices\/\d{4}-\d{2}-\d{2}\.json$/.test(p)))

    // The host as the switch leaves it, committed and pushed.
    const main = c.main
    assert.equal(git(main, 'status', '--porcelain'), '')
    assert.equal(git(main, 'rev-parse', 'HEAD'), r.commit)
    assert.equal(git(c.remote, 'rev-parse', 'refs/heads/develop'), r.commit)
    assert.equal(git(main, 'rev-parse', 'HEAD^'), origin.base)
    assert.equal(git(main, 'log', '-1', '--format=%s'), 'chore(adf): set up ADF in the replay host')
    const registry = JSON.parse(readFileSync(join(main, '.claude', 'adf-extensions.json'), 'utf8'))
    assert.deepEqual(registry.extensions.map((e) => e.path), ORDER.map((n) => join(PLUGINS, n)))
    assert.deepEqual(registry.branches, { integration: 'develop', protected: [] })
    assert.deepEqual(registry.debt, { root: '.claude/memory/tech-debt' })
    assert.match(readFileSync(join(main, '.claude/memory/tech-debt/snmp/index.md'), 'utf8'), /^\| ID \| Title \| Anchors \| Class \| Source \| Tracker \|$/m)
    const guide = readFileSync(join(main, 'openspec', 'planning.md'), 'utf8')
    for (const line of ['npm test -- --force', '`Cached:    0 cached`', '- `packages/shared`', '- `.env`']) assert.ok(guide.includes(line), line)

    // The checks after the commit.
    assert.deepEqual(r.checks.registry.plugins, ORDER)
    assert.equal(r.checks.superpowers.ok, true)
    assert.equal(r.checks.debt.ok, true)
    assert.equal(r.checks.forge.state, 'done')
    assert.equal(r.checks.preflight.ok, true, JSON.stringify(r.checks.preflight))
    assert.equal(r.checks.tracker.state, 'degraded', 'no env file and no profile in the sandbox')
    assert.ok(sandbox.calls('glab').length > 0 && sandbox.calls('glab').every((x) => ['--version', 'auth'].includes(x.argv[0])), 'the forge check only asks glab its version and login')
    assert.ok(r.environment.some((e) => e.path.endsWith(join('plugins', 'installed_plugins.json'))))
    const installed = JSON.parse(readFileSync(join(sandbox.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), 'utf8'))
    assert.equal(installed.plugins['adf@agentic-dev-flow'][0].installPath, join(PLUGINS, 'adf'))
    assert.ok(existsSync(installed.plugins['superpowers@claude-plugins-official'][0].installPath))
    assert.ok(installed.plugins['superpowers@claude-plugins-official'][0].installPath.startsWith(sandbox.root))
  })
  assert.deepEqual(snapshot(origin.dir), before)
})

test('a refusal no rule fixes is recorded with no edit, and the setup is not ok', () => {
  const origin = fixtureOrigin({ block: '| ID | Title | Jira |' })
  withHost(origin, (sandbox, c) => {
    const r = setupHost(sandbox, c, { registry: REGISTRY.filter((e) => e.name === 'adf-gitlab'), guide: null })
    assert.equal(r.ok, false)
    const left = r.refusals.find((x) => x.file === '.claude/memory/tech-debt/snmp/index.md')
    assert.equal(left.edit, null)
    assert.equal(r.checks.debt.ok, false)
    assert.match(editReport(r), /refusal debt\.mjs check \.claude\/memory\/tech-debt\/snmp\/index\.md:1: .* -> no edit: left as it is/)
    assert.equal(git(c.remote, 'rev-parse', 'refs/heads/develop'), r.commit, 'what was set up is still committed and pushed')
  })
})

test('a candidate off develop or with uncommitted work is refused before anything runs', () => {
  const origin = fixtureOrigin()
  withHost(origin, (sandbox, c) => {
    writeFileSync(join(c.main, 'package.json'), '{}\n')
    assert.throws(() => setupHost(sandbox, c, { registry: [] }), /has uncommitted changes/)
    git(c.main, 'checkout', '-q', '--', 'package.json')
    git(c.main, 'checkout', '-q', '-b', 'other')
    assert.throws(() => setupHost(sandbox, c, { registry: [] }), /is not on develop/)
  })
})

test('the recorded registry: every plugin of the switch in order, adf-jira and adf-postgres with the recorded config, adf-maintainer left out', () => {
  const registry = recordedRegistry()
  assert.deepEqual(registry.map((e) => e.name), ORDER)
  assert.ok(!registry.some((e) => e.name === 'adf-maintainer'))
  for (const e of registry) assert.equal(e.path, join(PLUGINS, e.name))
  const jira = registry.find((e) => e.name === 'adf-jira')
  assert.deepEqual(Object.keys(jira.config).sort(), ['allowlist', 'baseUrl', 'debtEpic', 'fields', 'profileDir', 'statuses'])
  assert.match(jira.notes[0], /only its config is taken, since the replay registers the plugin by path/)
  assert.deepEqual(Object.keys(registry.find((e) => e.name === 'adf-postgres').config).sort(), ['exec', 'prefix', 'url'])
  assert.deepEqual(registry.filter((e) => e.config === null).map((e) => e.name), ['adf-gitlab', 'adf-memory', 'adf-english-check', 'adf-npm-workspaces', 'adf-prisma'])
  for (const key of ['packages', 'wholeSuite', 'proof', 'copies']) assert.match(RECORDED_GUIDE[key].source, /docs\/lessons|README/)
})
