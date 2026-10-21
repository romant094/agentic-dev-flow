// The scripts the skills run: apply-plan.mjs, discover.mjs, read-issues.mjs, read-comments.mjs,
// and the context they share (lib/context.mjs). Jira is a fake fetch; nothing reaches the network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main as applyPlan } from '../apply-plan.mjs'
import { main as discover } from '../discover.mjs'
import { main as readIssues } from '../read-issues.mjs'
import { main as readComments } from '../read-comments.mjs'
import { loadContext } from '../lib/context.mjs'
import { WORKFLOW, fakeJira, issue } from './fake-jira.mjs'

const NOW = new Date('2026-10-21T10:00:00.000Z')
const DISCOVERED_AT = '2026-10-20T10:00:00.000Z'

function host({ config = { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'] }, env = 'JIRA_PAT=token-value\nJIRA_QA=qa.login\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-jira-scripts-'))
  mkdirSync(join(root, '.claude', 'jira', 'profile'), { recursive: true })
  writeFileSync(join(root, '.claude', '.env'), env)
  writeFileSync(join(root, '.claude', 'adf-extensions.json'), JSON.stringify({ contract: '1.7', extensions: [{ plugin: 'adf-jira@agentic-dev-flow', config }] }))
  writeFileSync(
    join(root, '.claude', 'jira', 'profile', 'discovered.json'),
    JSON.stringify({ discoveredAt: DISCOVERED_AT, instance: {}, project: { key: 'PROJ' }, issueTypes: [], fieldMap: {}, workflow: WORKFLOW, unsampledStatuses: [], permissions: {} })
  )
  return root
}

function deps(root, extra = {}) {
  const lines = { out: [], err: [] }
  return {
    lines,
    deps: {
      cwd: root,
      home: mkdtempSync(join(tmpdir(), 'adf-jira-home-')),
      processEnv: {},
      now: () => NOW,
      run: () => null,
      out: (l) => lines.out.push(l),
      err: (l) => lines.err.push(l),
      warn: (l) => lines.err.push(l),
      ignored: () => true,
      ...extra
    }
  }
}

function planFile(root, rows, extra = {}) {
  const path = join(root, '.adf', 'jira', 'bulk', 'plan.json')
  mkdirSync(join(root, '.adf', 'jira', 'bulk'), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, operation: 'transition', allowlist: ['PROJ'], discoveredAt: DISCOVERED_AT, rows, ...extra }))
  return path
}

const handToQa = { key: 'PROJ-1', summary: 'S', from: 'In Progress', steps: [{ transitionId: '821', to: 'Review' }, { fields: { assignee: { name: '<JIRA_QA>' } } }], state: 'pending' }

describe('apply-plan.mjs', () => {
  it('prints the summary with the resolved login and exits 1 without sending', async () => {
    const root = host()
    const jira = fakeJira({ issues: { 'PROJ-1': issue('PROJ-1', { status: 'In Progress' }) } })
    const path = planFile(root, [handToQa])
    const { lines, deps: d } = deps(root, { fetch: jira.fetch })
    assert.equal(await applyPlan([path], d), 1)
    assert.ok(lines.out.join('\n').includes('assignee: qa.login'))
    assert.ok(lines.out.join('\n').includes('Re-run with --confirm'))
    assert.equal(jira.calls.length, 0)
  })

  it('applies with --confirm, and the plan file keeps the placeholder and records the state', async () => {
    const root = host()
    const jira = fakeJira({ issues: { 'PROJ-1': issue('PROJ-1', { status: 'In Progress' }) } })
    const path = planFile(root, [handToQa])
    const { lines, deps: d } = deps(root, { fetch: jira.fetch })
    assert.equal(await applyPlan([path, '--confirm'], d), 0)
    assert.equal(jira.store['PROJ-1'].fields.status, 'Review')
    assert.deepEqual(jira.store['PROJ-1'].fields.assignee, { name: 'qa.login' })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(saved.rows[0].state, 'done')
    assert.equal(saved.rows[0].steps[1].fields.assignee.name, '<JIRA_QA>')
    assert.ok(lines.out.join('\n').includes('applied:       1'))
  })

  it('refuses a plan whose allowlist reaches past the configured one', async () => {
    const root = host()
    const path = planFile(root, [handToQa], { allowlist: ['PROJ', 'OTHER'] })
    const jira = fakeJira()
    await assert.rejects(applyPlan([path], deps(root, { fetch: jira.fetch }).deps), /OTHER, outside the configured allowlist/)
    assert.equal(jira.calls.length, 0)
  })

  it('refuses a plan using a login the env file does not set, naming the variable', async () => {
    const root = host()
    const path = planFile(root, [{ ...handToQa, steps: [{ fields: { assignee: { name: '<JIRA_PM>' } } }] }])
    await assert.rejects(applyPlan([path], deps(root, { fetch: fakeJira().fetch }).deps), /JIRA_PM is not set in the env file/)
  })

  it('refuses a plan git does not ignore, before sending or writing anything', async () => {
    const root = host()
    const jira = fakeJira({ issues: { 'PROJ-1': issue('PROJ-1', { status: 'In Progress' }) } })
    const path = planFile(root, [handToQa])
    const before = readFileSync(path, 'utf8')
    const seen = []
    const ignored = (dir, p) => (seen.push([dir, p]), false)
    await assert.rejects(applyPlan([path, '--confirm'], deps(root, { fetch: jira.fetch, ignored }).deps), /git does not ignore .*plan\.json.*run \/adf:init/)
    assert.deepEqual(seen, [[root, path]])
    assert.equal(jira.calls.length, 0)
    assert.equal(readFileSync(path, 'utf8'), before)
  })

  it('refuses a plan built against an older profile', async () => {
    const root = host()
    const path = planFile(root, [handToQa], { discoveredAt: '2026-10-19T10:00:00.000Z' })
    await assert.rejects(applyPlan([path], deps(root).deps), /Plan is stale/)
  })
})

function discoveryFetch() {
  const calls = []
  const json = (body) => new Response(JSON.stringify(body), { status: 200 })
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url)
    calls.push(pathname)
    if (pathname === '/rest/api/2/serverInfo') return json({ baseUrl: 'https://jira.example.com', version: '9.12.0', deploymentType: 'Server' })
    if (pathname === '/rest/api/2/project/PROJ') return json({ key: 'PROJ', name: 'Example' })
    if (pathname === '/rest/api/2/issue/createmeta') return json({ projects: [{ issuetypes: [{ id: '1', name: 'Task', subtask: false, fields: { summary: { required: true } } }] }] })
    if (pathname === '/rest/api/2/field') return json([{ id: 'customfield_1', name: 'Reproduce steps', custom: true }])
    if (pathname === '/rest/api/2/project/PROJ/statuses') return json([{ name: 'Task', statuses: [{ name: 'Opened' }] }])
    if (pathname === '/rest/api/2/search') return json({ startAt: 0, total: 1, issues: [{ key: 'PROJ-1', fields: {} }] })
    if (pathname === '/rest/api/2/issue/PROJ-1/transitions') return json({ transitions: [{ id: '4', name: 'Start', to: { name: 'In Progress' } }] })
    if (pathname === '/rest/api/2/mypermissions') return json({ permissions: { CREATE_ISSUE: { havePermission: true } } })
    throw new Error(`unexpected ${init.method ?? 'GET'} ${pathname}`)
  }
  return { fetch, calls }
}

describe('discover.mjs', () => {
  it('refuses to write the profile while git does not ignore the personal files, before any call', async () => {
    const root = host()
    const jira = discoveryFetch()
    await assert.rejects(discover([], deps(root, { fetch: jira.fetch, ignored: (_d, p) => p.endsWith('discovered.json') }).deps), /does not ignore .*local\.md/)
    assert.equal(jira.calls.length, 0)
  })

  it('writes discovered.json to the configured profile directory', async () => {
    const root = host({ config: { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], profileDir: 'tools/jira' } })
    const jira = discoveryFetch()
    const { lines, deps: d } = deps(root, { fetch: jira.fetch, ignored: () => true })
    assert.equal(await discover(['PROJ'], d), 0)
    const facts = JSON.parse(readFileSync(join(root, 'tools', 'jira', 'discovered.json'), 'utf8'))
    assert.equal(facts.discoveredAt, NOW.toISOString())
    assert.deepEqual(facts.fieldMap, { 'Reproduce steps': 'customfield_1' })
    assert.ok(lines.out.some((l) => /JIRA_PAT\s+project\s+11 chars/.test(l)))
    assert.ok(!lines.out.join('\n').includes('token-value'))
  })

  it('refuses a project outside the allowlist', async () => {
    await assert.rejects(discover(['OTHER'], deps(host(), { fetch: discoveryFetch().fetch, ignored: () => true }).deps), /not in the allowlist/)
  })
})

describe('read-issues.mjs and read-comments.mjs', () => {
  const searchFetch = (keys) => async () =>
    new Response(JSON.stringify({ startAt: 0, total: keys.length, issues: keys.map((key) => ({ key, fields: { summary: key, status: { name: 'Opened' } } })) }), { status: 200 })

  it('prints the rows as JSON on stdout', async () => {
    const { lines, deps: d } = deps(host(), { fetch: searchFetch(['PROJ-1', 'PROJ-2']) })
    assert.equal(await readIssues(['project = PROJ'], d), 0)
    const printed = JSON.parse(lines.out[0])
    assert.equal(printed.count, 2)
    assert.equal(printed.issues[0].status, 'Opened')
  })

  it('fails a read that returns an issue outside the allowlist', async () => {
    await assert.rejects(readIssues(['text ~ x'], deps(host(), { fetch: searchFetch(['PROJ-1', 'OTHER-3']) }).deps), /outside the allowlist: OTHER-3/)
  })

  it('writes the comments to a file and counts them on stderr', async () => {
    const root = host()
    const jira = fakeJira({ issues: { 'PROJ-1': issue('PROJ-1') }, comments: { 'PROJ-1': [{ id: '7', author: { name: 'dev' }, body: 'b' }] } })
    const file = join(root, 'comments.json')
    const { lines, deps: d } = deps(root, { fetch: jira.fetch })
    assert.equal(await readComments(['PROJ-1', file], d), 0)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).comments[0].id, '7')
    assert.deepEqual(lines.err, [`1 comment(s) written to ${file}`])
  })

  it('refuses a key outside the allowlist before the request', async () => {
    const jira = fakeJira()
    await assert.rejects(readComments(['OTHER-1'], deps(host(), { fetch: jira.fetch }).deps), /outside the allowlist/)
    assert.equal(jira.calls.length, 0)
  })

  it('prints the usage and exits 1 with no argument', async () => {
    const { lines, deps: d } = deps(host())
    assert.equal(await readIssues([], d), 1)
    assert.equal(await readComments([], d), 1)
    assert.match(lines.err[0], /usage: read-issues\.mjs/)
  })
})

describe('lib/context.mjs', () => {
  it('refuses an invalid registry entry, naming the key', () => {
    const root = host({ config: { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], profiledir: 'x' } })
    assert.throws(() => loadContext({ cwd: root, home: tmpdir(), processEnv: {}, run: () => null }), /config\.profiledir is not a key/)
  })

  it('resolves the env file the config names', () => {
    const root = host({ config: { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], envFile: 'local/jira.env' } })
    mkdirSync(join(root, 'local'))
    writeFileSync(join(root, 'local', 'jira.env'), 'JIRA_PAT=other\n')
    const { env, files } = loadContext({ cwd: root, home: tmpdir(), processEnv: {}, run: () => null })
    assert.equal(env.pat, 'other')
    assert.ok(existsSync(files.project.path))
  })
})
