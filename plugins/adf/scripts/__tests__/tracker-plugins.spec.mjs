// The core's tracker callers, run as the CLIs an orchestrator runs (scope.mjs start and retest,
// land.mjs check, wait, comment-input, comment and handoff), against the real adf-jira of this
// repository as the tracker and the real adf-gitlab as the forge, both named by an absolute
// registry path. What the core sends is what the plugin gets: a field shape one side refuses
// fails here, where each side's own specs pass.
//
// No network and no real credential. Jira is adf-jira's fake (fake-jira.mjs), loaded into every
// process by NODE_OPTIONS=--import fake-jira-preload.mjs and kept in a JSON file between them;
// glab is a shell script first on PATH that answers the forge's `state`. Each CLI runs with
// HOME set to an empty directory and no JIRA_ variable of the caller, so the plugin reads only
// the host's .claude/.env this test writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { initRegistry, readRegistry, setDebtRoot, writeRegistry } from '../lib/registry.mjs'
import { CORE } from '../lib/roles.mjs'
import { WORKFLOW, issue } from '../../../adf-jira/scripts/__tests__/fake-jira.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGINS = resolve(here, '..', '..', '..')
const SCRIPTS = resolve(here, '..')
const PRELOAD = pathToFileURL(join(here, 'fake-jira-preload.mjs')).href
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const CHANGE = 'fix-pool'
const BRANCH = 'fix/PROJ-1/fix-pool'
const ARCHIVED = 'openspec/changes/archive/2026-10-19-fix-pool'
const MR = 'https://gitlab.example.com/group/repo/-/merge_requests/7'
const JIRA = { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], statuses: { start: 'In Progress', handoff: 'Review' } }
const CHECK = { verdict: 'current', requirements: [], bug: null, corrections: [], questions: [], checked: [] }

const trackerItem = (key, over = {}) => ({ source: 'tracker', key, title: `Issue ${key}`, kind: 'task', url: `${JIRA.baseUrl}/browse/${key}`, status: 'In Progress', open: true, parent: null, links: [], branchToken: key, branchRank: 1, excluded: null, flags: [], file: null, state: 'taken', reason: null, verdict: 'current', check: CHECK, ...over })
const debtItem = (key, tracker, state = 'taken') => ({ source: 'debt', key, title: `Entry ${key}`, kind: 'debt', class: 'debt', block: 'snmp', anchors: [`${key}.ts`], tracker, matched: 'key', files: ['debt/snmp/index.md'], state, reason: state === 'partial' ? 'one site only' : null, verdict: 'current', check: CHECK, flags: [] })
const scopeOf = (items, extra = {}) => ({ version: 1, change: CHANGE, from: { keys: [], text: null }, tracker: { state: 'done', plugin: 'adf-jira', account: 'dev.login', notes: [] }, items, inFlight: [], flagsShown: [], base: null, start: null, retest: null, ...extra })

// A host on develop with adf-jira (and, with `forge`, adf-gitlab) in its registry by absolute
// path, Jira's env file and project profile in place, and a fake Jira holding `issues`.
function host({ issues, forge = false }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-tracker-plugins-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'adf-tracker-plugins-env-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  initRegistry(root, CORE.coreContract)
  setBranches(root, { integration: 'develop', protected: ['main'] })
  const extensions = [{ path: join(PLUGINS, 'adf-jira'), points: ['tracker'], config: JIRA }]
  if (forge) extensions.push({ path: join(PLUGINS, 'adf-gitlab'), points: ['forge'], config: {} })
  writeRegistry(root, { ...readRegistry(root), extensions })
  ignoreLocalDirs(root)
  mkdirSync(join(root, '.claude', 'jira', 'profile'), { recursive: true })
  writeFileSync(join(root, '.claude', '.env'), 'JIRA_PAT=token-value\nJIRA_QA=qa.login\n')
  writeFileSync(join(root, '.gitignore'), `${readFileSync(join(root, '.gitignore'), 'utf8')}.claude/.env\n`)
  const discovered = { discoveredAt: new Date().toISOString(), instance: {}, project: { key: 'PROJ' }, issueTypes: [], fieldMap: {}, workflow: WORKFLOW, unsampledStatuses: [], permissions: {} }
  writeFileSync(join(root, '.claude', 'jira', 'profile', 'discovered.json'), JSON.stringify(discovered))
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')

  const jira = join(outside, 'jira.json')
  writeFileSync(jira, JSON.stringify({ issues, comments: {}, calls: [] }))
  const bin = join(outside, 'bin')
  mkdirSync(bin)
  const home = join(outside, 'home')
  mkdirSync(home)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^JIRA_/.test(k) && k !== 'NODE_OPTIONS'))
  Object.assign(env, { HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, NODE_OPTIONS: `--import=${PRELOAD}`, ADF_FAKE_JIRA: jira })
  return { root, bin, home, env, jira: () => JSON.parse(readFileSync(jira, 'utf8')) }
}

// A core CLI as the orchestrator runs it; its one JSON object with the exit code.
function cli(h, script, ...args) {
  const takesHome = ['check', 'wait', 'handoff', 'start', 'retest'].includes(args[0])
  const run = spawnSync('node', [join(SCRIPTS, script), ...args, '--change', CHANGE, '--root', h.root, ...(takesHome ? ['--home', h.home] : [])], { encoding: 'utf8', env: h.env })
  try {
    return { code: run.status, ...JSON.parse(run.stdout) }
  } catch {
    throw new Error(`${script} ${args.join(' ')} printed no JSON (exit ${run.status}): ${run.stdout}${run.stderr}`)
  }
}

const writes = (h) => h.jira().calls.filter((c) => c.method !== 'GET' && c.path !== '/rest/api/2/search')

// ---------------------------------------------------------------- propose: start and retest

test('scope.mjs start holds the moves for the yes and applies them; retest sends a not-reproduced bug back with what was tried', () => {
  const corrected = trackerItem('PROJ-2', {
    state: 'partial',
    reason: 'the metrics only',
    verdict: 'corrected',
    check: { ...CHECK, verdict: 'corrected', corrections: [{ what: 'The socket limit', was: '10', now: '8', sources: ['pool.ts:4'] }], questions: [{ n: 1, question: 'Keep the gauge?', about: 'scope', checked: ['pool.ts'], needs: 'a yes', answer: 'Yes.' }] }
  })
  const tried = ['Reconnect three times on the base commit.', 'Reconnect under load\n  with two clients at once.']
  const bug = trackerItem('PROJ-3', { kind: 'bug', verdict: 'not-reproduced', check: { ...CHECK, verdict: 'not-reproduced', bug: { reproduction: ['reconnect'], expected: 'one socket', tried } } })
  const h = host({
    issues: {
      'PROJ-1': issue('PROJ-1'),
      'PROJ-2': issue('PROJ-2'),
      'PROJ-3': issue('PROJ-3', { status: 'In Progress', type: 'Bug', assignee: 'dev.login' })
    }
  })
  const base = git(h.root, 'rev-parse', 'HEAD')
  const scopeFile = join(h.root, '.superpowers', 'sdd', CHANGE, 'scope', 'scope.json')
  mkdirSync(dirname(scopeFile), { recursive: true })
  writeFileSync(scopeFile, JSON.stringify(scopeOf([trackerItem('PROJ-1'), corrected, bug], { base: { commit: base } })))
  // propose.mjs create has made the change's worktree.
  mkdirSync(join(h.root, '.claude', 'worktrees', CHANGE, 'openspec', 'changes', CHANGE), { recursive: true })

  const held = cli(h, 'scope.mjs', 'start')
  assert.deepEqual([held.code, held.ok, held.state, held.held], [0, true, 'pending', true], JSON.stringify(held))
  assert.match(held.plan, /^start-\d{8}T\d{6}Z/)
  assert.ok(held.preview.includes('PROJ-1 Summary of PROJ-1: Opened → In Progress; assignee dev.login'), held.preview.join('\n'))
  assert.ok(held.preview.includes('    h3. Answered by the developer'), 'the corrected issue carries its correction comment')
  assert.deepEqual(writes(h), [], 'nothing is sent before the yes')

  const started = cli(h, 'scope.mjs', 'start', '--yes')
  assert.deepEqual([started.code, started.state, started.applied, started.failed], [0, 'done', ['PROJ-1', 'PROJ-2'], []], JSON.stringify(started))
  const afterStart = h.jira()
  for (const key of ['PROJ-1', 'PROJ-2']) {
    assert.equal(afterStart.issues[key].fields.status, 'In Progress', key)
    assert.deepEqual(afterStart.issues[key].fields.assignee, { name: 'dev.login' }, key)
  }
  assert.match(afterStart.comments['PROJ-2'][0].body, /The socket limit: 8 \(was 10\)/)
  assert.equal(afterStart.issues['PROJ-3'].fields.status, 'In Progress', 'a bug that did not reproduce is not started')

  const pending = cli(h, 'scope.mjs', 'retest')
  assert.deepEqual([pending.code, pending.state, pending.held], [0, 'pending', true], JSON.stringify(pending))
  assert.ok(pending.preview.includes('PROJ-3 Summary of PROJ-3: In Progress → Review; assignee qa.login; comment:'), pending.preview.join('\n'))
  const retested = cli(h, 'scope.mjs', 'retest', '--yes')
  assert.deepEqual([retested.code, retested.state, retested.applied], [0, 'done', ['PROJ-3']], JSON.stringify(retested))
  const afterRetest = h.jira()
  assert.equal(afterRetest.issues['PROJ-3'].fields.status, 'Review')
  assert.deepEqual(afterRetest.issues['PROJ-3'].fields.assignee, { name: 'qa.login' })
  assert.equal(
    afterRetest.comments['PROJ-3'][0].body,
    `h3. Does not reproduce\nThe issue does not reproduce on commit ${base}.\n\nh3. Tried\n# Reconnect three times on the base commit.\n# Reconnect under load\n# with two clients at once.`
  )
  const item = JSON.parse(readFileSync(scopeFile, 'utf8')).items.find((i) => i.key === 'PROJ-3')
  assert.deepEqual([item.state, item.reason], ['excluded', 'does not reproduce; sent to retest'])
})

// ---------------------------------------------------------------- land: the hand-off after the merge

const DEBT_ROOT = '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`snmp`](snmp/index.md) | SNMP |\n'
const DEBT_LEFT = '# SNMP\n\nLast id: `snmp-05`\n\n| ID | Title | Anchors | Class | Source | Tracker |\n|---|---|---|---|---|---|\n| `snmp-04` | Entry snmp-04 | `snmp-04.ts` | debt | s | PROJ-8 |\n| `snmp-05` | Entry snmp-05 | `snmp-05.ts` | debt | s | PROJ-8 |\n'

// The change fix-pool archived on its branch and merged into develop: its scope takes PROJ-1,
// PROJ-2 (partial), snmp-01 (mirrored by PROJ-7, removed at archive) and snmp-03 and snmp-04
// (mirrored by PROJ-8; snmp-04 partial, kept). Archive's state records the merge request.
function landHost() {
  const h = host({
    forge: true,
    issues: {
      'PROJ-1': issue('PROJ-1', { status: 'In Progress', assignee: 'dev.login' }),
      'PROJ-2': issue('PROJ-2', { status: 'In Progress', assignee: 'dev.login' }),
      'PROJ-7': issue('PROJ-7'),
      'PROJ-8': issue('PROJ-8')
    }
  })
  const { root } = h
  const scope = scopeOf([trackerItem('PROJ-1'), trackerItem('PROJ-2', { state: 'partial', reason: 'the metrics only' }), debtItem('snmp-01', 'PROJ-7'), debtItem('snmp-03', 'PROJ-8'), debtItem('snmp-04', 'PROJ-8', 'partial')], { start: { state: 'done' } })
  setDebtRoot(root, 'debt')
  git(root, 'commit', '-q', '-am', 'debt root')
  git(root, 'checkout', '-q', '-b', BRANCH)
  const dir = join(root, ARCHIVED)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.adf.json'), `${JSON.stringify({ schema: 'adf', schemaVersion: 1, created: '2026-10-15', base: 'develop' })}\n`)
  writeFileSync(join(dir, 'proposal.md'), '## Why\n\nThe pool leaks.\n')
  writeFileSync(join(dir, 'scope.json'), `${JSON.stringify(scope, null, 2)}\n`)
  mkdirSync(join(root, 'debt', 'snmp'), { recursive: true })
  writeFileSync(join(root, 'debt', 'index.md'), DEBT_ROOT)
  writeFileSync(join(root, 'debt', 'snmp', 'index.md'), DEBT_LEFT)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'fix(pool): close the old socket')
  git(root, 'checkout', '-q', 'develop')
  git(root, 'merge', '-q', '--no-ff', '--no-edit', BRANCH)
  const merge = git(root, 'rev-parse', 'HEAD')
  const sdd = join(root, '.superpowers', 'sdd', CHANGE)
  mkdirSync(join(sdd, 'scope'), { recursive: true })
  writeFileSync(join(sdd, 'scope', 'scope.json'), JSON.stringify(scope))
  mkdirSync(join(sdd, 'archive'), { recursive: true })
  writeFileSync(join(sdd, 'archive', 'state.json'), JSON.stringify({ change: CHANGE, steps: { mr: { state: 'done', detail: { forge: 'adf-gitlab', url: MR, branch: BRANCH, base: 'develop' } } } }))

  // glab, as adf-gitlab's `state` calls it: the merge request merged at `merge`.
  const view = { iid: 7, web_url: MR, state: 'merged', merged_at: '2026-10-21T09:00:00.000Z', merge_commit_sha: merge }
  writeFileSync(join(h.bin, 'mr.json'), JSON.stringify(view))
  writeFileSync(
    join(h.bin, 'glab'),
    `#!/bin/sh\necho "$*" >> "$(dirname "$0")/glab.log"\ncase "$*" in\n  --version) echo "glab 1.50.0" ;;\n  "auth status") echo "Logged in" ;;\n  "mr view 7 --output json") cat "$(dirname "$0")/mr.json" ;;\n  *) echo "fake glab: unexpected $*" >&2; exit 1 ;;\nesac\n`
  )
  chmodSync(join(h.bin, 'glab'), 0o755)
  return { ...h, merge }
}

const reply = (h, key, state, fields) => {
  const file = join(h.root, '.superpowers', 'sdd', CHANGE, 'land', 'replies', `${key}.json`)
  writeFileSync(file, JSON.stringify({ role: 'land-comment', key, state, fields }))
  return file
}

test('land hands off taken, partial and debt-group issues through adf-jira, the merge read from adf-gitlab, with fields as texts or lists', () => {
  const h = landHost()

  const check = cli(h, 'land.mjs', 'check')
  assert.deepEqual([check.code, check.state, check.detail.tracker], [0, 'done', { plugin: 'adf-jira', account: 'dev.login' }], JSON.stringify(check))

  const wait = cli(h, 'land.mjs', 'wait')
  assert.deepEqual([wait.code, wait.state, wait.detail.via, wait.detail.forge, wait.detail.url, wait.detail.mergeCommit], [0, 'done', 'forge', 'adf-gitlab', MR, h.merge], JSON.stringify(wait))
  assert.ok(readFileSync(join(h.bin, 'glab.log'), 'utf8').includes('mr view 7 --output json'))

  const input = cli(h, 'land.mjs', 'comment-input')
  assert.deepEqual(input.dispatches.map((d) => [d.key, d.state]), [['PROJ-1', 'taken'], ['PROJ-2', 'partial'], ['PROJ-7', 'taken'], ['PROJ-8', 'partial']])

  // As texts: one line, and steps on lines of one text. As lists: one text per line.
  const fields = {
    'PROJ-1': ['taken', { done: 'The pool closes the old socket before it opens a new one.', test: 'Reconnect three times.\nCount the open sockets: one is open.\n' }],
    'PROJ-2': ['partial', { done: ['The pool counts its open sockets.'], test: ['Open the metrics page.', 'Read the socket count.'], remains: ['The gauge for idle sockets.'] }],
    'PROJ-7': ['taken', { done: 'The trailing index is parsed in one place.', test: ['Walk a table with a trailing index.'] }],
    'PROJ-8': ['partial', { done: 'The index parse is shared.', test: 'Walk the interface table.', remains: 'The second parse site in snmp-04.' }]
  }
  for (const [key, [state, f]] of Object.entries(fields)) {
    const out = cli(h, 'land.mjs', 'comment', '--key', key, '--file', reply(h, key, state, f))
    assert.deepEqual([out.code, out.valid], [0, true], `${key}: ${JSON.stringify(out.errors)}`)
  }

  const held = cli(h, 'land.mjs', 'handoff')
  assert.deepEqual([held.code, held.ok, held.state, held.mr], [0, true, 'pending', { url: MR }], JSON.stringify(held))
  assert.ok(held.preview.includes('PROJ-1 Summary of PROJ-1: In Progress → Review; assignee qa.login; comment:'), held.preview.join('\n'))
  assert.ok(held.preview.includes('PROJ-2 Summary of PROJ-2: comment:'), held.preview.join('\n'))
  assert.ok(held.preview.includes('PROJ-7 Summary of PROJ-7: Opened → In Progress → Review; assignee qa.login; comment:'), held.preview.join('\n'))
  assert.deepEqual(writes(h), [], 'nothing is sent before the yes')

  const applied = cli(h, 'land.mjs', 'handoff', '--yes')
  assert.deepEqual([applied.code, applied.state, applied.applied, applied.failed], [0, 'done', ['PROJ-1', 'PROJ-2', 'PROJ-7', 'PROJ-8'], []], JSON.stringify(applied))
  const jira = h.jira()
  assert.deepEqual(['PROJ-1', 'PROJ-2', 'PROJ-7', 'PROJ-8'].map((k) => [k, jira.issues[k].fields.status, jira.issues[k].fields.assignee?.name ?? null]), [
    ['PROJ-1', 'Review', 'qa.login'],
    ['PROJ-2', 'In Progress', 'dev.login'],
    ['PROJ-7', 'Review', 'qa.login'],
    ['PROJ-8', 'Opened', null]
  ])
  assert.equal(
    jira.comments['PROJ-1'][0].body,
    `h3. Done\n# The pool closes the old socket before it opens a new one.\n\nh3. How to test\n# Reconnect three times.\n# Count the open sockets: one is open.\n\nMerge request: ${MR}`
  )
  assert.equal(
    jira.comments['PROJ-2'][0].body,
    `h3. Done\n# The pool counts its open sockets.\n\nh3. How to test\n# Open the metrics page.\n# Read the socket count.\n\nh3. Remains\n# The gauge for idle sockets.\n\nMerge request: ${MR}`
  )
  assert.match(jira.comments['PROJ-8'][0].body, /^h3\. Done\n# The index parse is shared\.\n\nh3\. How to test\n# Walk the interface table\.\n\nh3\. Remains\n# The second parse site in snmp-04\./)
  assert.equal(cli(h, 'land.mjs', 'report').complete, true)
})
