import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rankBranches, runOperation } from '../lib/tracker.mjs'
import { main } from '../tracker.mjs'
import { WORKFLOW, fakeJira, issue } from './fake-jira.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOW = new Date('2026-10-21T10:00:00.000Z')
const CONFIG = { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], statuses: { handoff: 'Review', excluded: ['Suspended'] }, fields: ['Reproduce steps'] }

function project({ env = 'JIRA_PAT=token-value\nJIRA_QA=qa.login\n', discoveredAt = '2026-10-20T10:00:00.000Z', profile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-jira-'))
  const home = mkdtempSync(join(tmpdir(), 'adf-jira-home-'))
  if (env !== null) {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', '.env'), env)
  }
  if (profile) {
    const dir = join(root, '.claude', 'jira', 'profile')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'discovered.json'),
      JSON.stringify({ discoveredAt, instance: {}, project: { key: 'PROJ' }, issueTypes: [], fieldMap: { 'Reproduce steps': 'customfield_1' }, workflow: WORKFLOW, unsampledStatuses: [], permissions: {} })
    )
  }
  return { root, home, stateDir: join(root, '.superpowers', 'sdd', 'my-change', 'tracker') }
}

// A Jira whose next comment POSTs fail with a 500: `before` sends nothing, `after` posts the
// comment and loses the response.
function failingComments(jira, { times = 1, mode = 'before' } = {}) {
  let left = times
  const fetch = async (url, init = {}) => {
    const comment = (init.method ?? 'GET') === 'POST' && new URL(url).pathname.endsWith('/comment')
    if (comment && left > 0) {
      left -= 1
      if (mode === 'after') await jira.fetch(url, init)
      return new Response(JSON.stringify({ errorMessages: ['Internal error'] }), { status: 500 })
    }
    return jira.fetch(url, init)
  }
  return { ...jira, fetch }
}

const commentPosts = (jira) => jira.writes().filter((c) => c.path.endsWith('/comment'))

const rowOf = (plan, key, step) => plan.rows.find((r) => r.key === key && r.step === step)

function call(jira, where, operation, input = {}, config = CONFIG) {
  return runOperation(operation, { root: where.root, config, input }, { fetch: jira.fetch, home: where.home, processEnv: {}, now: () => NOW, git: () => null, pluginRoot: PLUGIN_ROOT })
}

describe('tracker check', () => {
  it('is ready with the account, and describes the env without a value', async () => {
    const where = project()
    const jira = fakeJira()
    const { code, result } = await call(jira, where, 'check')
    assert.equal(code, 0)
    assert.equal(result.state, 'done')
    assert.equal(result.tool, 'ready')
    assert.equal(result.account, 'dev.login')
    assert.equal(result.sources.find((s) => s.key === 'JIRA_PAT').length, 'token-value'.length)
    assert.ok(!JSON.stringify(result).includes('token-value'))
    assert.deepEqual(
      jira.calls.map((c) => c.path),
      ['/rest/api/2/myself']
    )
  })

  it('is degraded missing, with the template to copy, when there is no env file', async () => {
    const where = project({ env: null })
    const jira = fakeJira()
    const { code, result } = await call(jira, where, 'check')
    assert.equal(code, 0)
    assert.equal(result.state, 'degraded')
    assert.equal(result.tool, 'missing')
    assert.match(result.hint, /env\.example/)
    assert.match(result.hint, /JIRA_PAT/)
    assert.equal(jira.calls.length, 0)
  })

  it('is degraded unauthenticated when Jira refuses the token', async () => {
    const where = project({ env: 'JIRA_PAT=expired\n' })
    const { result } = await call(fakeJira(), where, 'check')
    assert.equal(result.state, 'degraded')
    assert.equal(result.tool, 'unauthenticated')
    assert.match(result.hint, /personal access token/)
    assert.ok(!JSON.stringify(result).includes('expired'))
  })

  it('is degraded unconfigured when neither the config nor the env names the instance', async () => {
    const where = project()
    const jira = fakeJira()
    const { result } = await call(jira, where, 'check', {}, {})
    assert.equal(result.tool, 'unconfigured')
    assert.match(result.hint, /baseUrl and allowlist/)
    assert.equal(jira.calls.length, 0)
  })

  it('is degraded unconfigured with the setup hint when there is no profile', async () => {
    const { result } = await call(fakeJira(), project({ profile: false }), 'check')
    assert.equal(result.tool, 'unconfigured')
    assert.match(result.hint, /\/adf-jira:setup/)
  })

  it('is degraded unconfigured when the profile is past its age', async () => {
    const { result } = await call(fakeJira(), project({ discoveredAt: '2026-10-01T10:00:00.000Z' }), 'check')
    assert.equal(result.tool, 'unconfigured')
    assert.match(result.hint, /more than 7 days/)
  })

  it('refuses an invalid config before any call', async () => {
    const jira = fakeJira()
    const { code, result } = await call(jira, project(), 'check', {}, { ...CONFIG, allowList: ['PROJ'] })
    assert.equal(code, 1)
    assert.equal(result.state, 'refused')
    assert.match(result.error, /allowList is not a key/)
    assert.equal(jira.calls.length, 0)
  })
})

describe('tracker gather', () => {
  const linked = [
    { type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'PROJ-5' } },
    { type: { name: 'Relates', outward: 'relates to', inward: 'relates to' }, inwardIssue: { key: 'OTHER-1' } }
  ]
  const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 1), author: { name: 'someone' }, created: '2026-09-02T10:00:00.000+0300', body: `comment ${i + 1}` }))

  it('reads the named issue, its parent, sub-tasks and links, and writes one file per issue with every comment', async () => {
    const where = project()
    const jira = fakeJira({
      issues: {
        'PROJ-1': issue('PROJ-1', { parent: 'PROJ-9', subtasks: ['PROJ-2'], links: linked, fields: { customfield_1: 'Open the page' } }),
        'PROJ-2': issue('PROJ-2', { type: 'Sub-task', subtask: true, parent: 'PROJ-1' }),
        'PROJ-5': issue('PROJ-5', { type: 'Bug' }),
        'PROJ-9': issue('PROJ-9', { type: 'Epic' })
      },
      comments: { 'PROJ-1': many }
    })
    const { code, result } = await call(jira, where, 'gather', { keys: ['PROJ-1'], change: 'my-change', stateDir: where.stateDir })
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(
      result.items.map((i) => i.key),
      ['PROJ-1', 'PROJ-9', 'PROJ-2', 'PROJ-5']
    )
    const one = result.items[0]
    assert.equal(one.url, 'https://jira.example.com/browse/PROJ-1')
    assert.equal(one.named, true)
    assert.deepEqual(one.links, [
      { key: 'PROJ-5', relation: 'blocks' },
      { key: 'OTHER-1', relation: 'relates to' }
    ])
    assert.deepEqual(result.items[3].via, { key: 'PROJ-1', relation: 'is blocked by' })
    assert.ok(result.notes.some((n) => n.startsWith('OTHER-1') && /outside the allowlist/.test(n)))
    assert.ok(!jira.calls.some((c) => c.path.includes('OTHER-1')))
    const file = JSON.parse(readFileSync(one.file, 'utf8'))
    assert.equal(file.description, 'Description of PROJ-1')
    assert.equal(file.comments.length, 150)
    assert.deepEqual(file.fields, { 'Reproduce steps': 'Open the page' })
    assert.equal(jira.writes().length, 0)
  })

  it('ranks the branch key: the lowest sub-task before a bug, the epic unranked', async () => {
    const where = project()
    const jira = fakeJira({
      issues: {
        'PROJ-1': issue('PROJ-1', { parent: 'PROJ-9', subtasks: ['PROJ-3', 'PROJ-2'], links: [linked[0]] }),
        'PROJ-2': issue('PROJ-2', { type: 'Sub-task', subtask: true }),
        'PROJ-3': issue('PROJ-3', { type: 'Sub-task', subtask: true }),
        'PROJ-5': issue('PROJ-5', { type: 'Bug' }),
        'PROJ-9': issue('PROJ-9', { type: 'Epic' })
      }
    })
    const { result } = await call(jira, where, 'gather', { keys: ['PROJ-1'], change: 'c', stateDir: where.stateDir })
    const rank = Object.fromEntries(result.items.map((i) => [i.key, i.branchRank]))
    assert.deepEqual(rank, { 'PROJ-1': 4, 'PROJ-9': null, 'PROJ-3': 2, 'PROJ-2': 1, 'PROJ-5': 3 })
    assert.equal(result.items.find((i) => i.key === 'PROJ-1').branchToken, 'PROJ-1')
  })

  it('excludes a closed and a suspended issue, and flags a stale status once', async () => {
    const where = project()
    const jira = fakeJira({
      issues: {
        'PROJ-1': issue('PROJ-1', { status: 'Closed' }),
        'PROJ-2': issue('PROJ-2', {
          status: 'Suspended',
          changelog: { histories: [{ created: '2026-09-10T10:00:00.000+0300', items: [{ field: 'status', toString: 'Suspended' }] }] }
        })
      },
      comments: { 'PROJ-2': [{ id: '1', created: '2026-09-20T10:00:00.000+0300', body: 'Reopened: the vendor fixed it' }] }
    })
    const { result } = await call(jira, where, 'gather', { keys: ['PROJ-1', 'PROJ-2'], change: 'c', stateDir: where.stateDir })
    const [closed, suspended] = result.items
    assert.equal(closed.open, false)
    assert.match(closed.excluded, /closed/)
    assert.deepEqual(closed.flags, [])
    assert.equal(suspended.excluded, 'excluded status Suspended')
    assert.equal(suspended.flags.length, 1)
    assert.match(suspended.flags[0], /may be stale/)
    assert.equal(closed.branchRank, null)
    assert.equal(suspended.branchRank, null)
  })

  it('searches open issues by text in the allowlisted projects only', async () => {
    const where = project()
    const jira = fakeJira({ issues: { 'PROJ-7': issue('PROJ-7', { summary: 'Login "page" fails' }), 'PROJ-8': issue('PROJ-8', { summary: 'Unrelated' }) } })
    const { result } = await call(jira, where, 'gather', { text: 'login "page"', change: 'c', stateDir: where.stateDir })
    const search = jira.calls.find((c) => c.path === '/rest/api/2/search')
    assert.match(search.body.jql, /^project in \("PROJ"\) AND text ~ "login \\"page\\"" AND statusCategory != Done/)
    assert.deepEqual(
      result.items.map((i) => [i.key, i.named]),
      [['PROJ-7', true]]
    )
  })

  it('names an unknown key in the notes and reads the rest', async () => {
    const where = project()
    const jira = fakeJira({ issues: { 'PROJ-1': issue('PROJ-1') } })
    const { result } = await call(jira, where, 'gather', { keys: ['PROJ-1', 'PROJ-404'], change: 'c', stateDir: where.stateDir })
    assert.deepEqual(
      result.items.map((i) => i.key),
      ['PROJ-1']
    )
    assert.ok(result.notes.some((n) => n.startsWith('PROJ-404')))
  })

  it('refuses keys and text together, and a relative stateDir, before any call', async () => {
    const where = project()
    const jira = fakeJira()
    assert.equal((await call(jira, where, 'gather', { keys: ['PROJ-1'], text: 'x', change: 'c', stateDir: where.stateDir })).result.state, 'refused')
    assert.equal((await call(jira, where, 'gather', { keys: ['PROJ-1'], change: 'c', stateDir: 'rel' })).result.state, 'refused')
    assert.equal(jira.calls.length, 0)
  })
})

describe('rankBranches', () => {
  it('ranks a named sub-task first and ties two named tasks', () => {
    const items = rankBranches([
      { key: 'P-9', kind: 'task', named: true, subtask: false, excluded: null },
      { key: 'P-8', kind: 'task', named: true, subtask: false, excluded: null },
      { key: 'P-4', kind: 'sub-task', named: true, subtask: true, excluded: null },
      { key: 'P-2', kind: 'bug', named: false, subtask: false, excluded: null },
      { key: 'P-1', kind: 'task', named: false, subtask: false, excluded: null }
    ])
    assert.deepEqual(
      items.map((i) => i.branchRank),
      [3, 3, 1, 2, null]
    )
  })
})

describe('tracker start', () => {
  const issues = () => ({
    'PROJ-1': issue('PROJ-1', { status: 'Opened' }),
    'PROJ-2': issue('PROJ-2', { status: 'In Progress', assignee: 'dev.login' }),
    'PROJ-3': issue('PROJ-3', { status: 'Closed' })
  })

  it('holds a plan without sending anything, and previews each issue with its path and assignee', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { code, result } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }, { key: 'PROJ-2' }, { key: 'PROJ-3' }], stateDir: where.stateDir })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.held, true)
    assert.match(result.plan, /^start-20261021T100000Z$/)
    assert.equal(jira.writes().length, 0)
    assert.ok(result.preview.includes('PROJ-1 Summary of PROJ-1: Opened → In Progress; assignee dev.login'))
    assert.ok(result.preview.includes('PROJ-2 skipped: already In Progress and assigned to the developer'))
    assert.ok(result.preview.some((l) => l.startsWith('PROJ-3 skipped: no route')))
    const plan = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.equal(rowOf(plan, 'PROJ-1', 'assignee').steps[0].fields.assignee.name, '<JIRA_ASSIGNEE>')
  })

  it('applies the held plan, and a rerun with the same id sends nothing again', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }, { key: 'PROJ-3' }], stateDir: where.stateDir })
    const { result } = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-1'])
    assert.deepEqual(
      result.skipped.map((s) => s.key),
      ['PROJ-3']
    )
    assert.deepEqual(result.failed, [])
    assert.equal(jira.store['PROJ-1'].fields.status, 'In Progress')
    assert.deepEqual(jira.store['PROJ-1'].fields.assignee, { name: 'dev.login' })
    const writes = jira.writes().length
    const again = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(again.result.applied, ['PROJ-1'])
    assert.equal(jira.writes().length, writes)
  })

  it('skips an issue moved by hand between the plan and the apply', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }], stateDir: where.stateDir })
    jira.store['PROJ-1'].fields.status = 'Suspended'
    const { result } = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, [])
    assert.match(result.skipped[0].reason, /Expected status "Opened" but found "Suspended"/)
    assert.equal(jira.writes().length, 0)
  })

  it('refuses a plan built against an older profile, sending nothing', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }], stateDir: where.stateDir })
    const file = join(where.root, '.claude', 'jira', 'profile', 'discovered.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), discoveredAt: '2026-10-21T09:00:00.000Z' }))
    const { code, result } = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.equal(code, 1)
    assert.match(result.error, /stale/)
    assert.equal(jira.writes().length, 0)
  })

  it('refuses a plan edited to reach outside the allowlist', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }], stateDir: where.stateDir })
    const plan = JSON.parse(readFileSync(held.file, 'utf8'))
    plan.rows[0].key = 'OTHER-1'
    writeFileSync(held.file, JSON.stringify(plan))
    const { result } = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.equal(result.state, 'refused')
    assert.match(result.error, /OTHER-1/)
    assert.equal(jira.writes().length, 0)
  })

  it('refuses a key outside the allowlist whole, before any call', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result } = await call(jira, where, 'start', { items: [{ key: 'PROJ-1' }, { key: 'OTHER-2' }], stateDir: where.stateDir })
    assert.equal(result.state, 'refused')
    assert.match(result.error, /OTHER-2/)
    assert.equal(jira.calls.length, 0)
  })

  it('accepts the fields the core sends and the plugin does not use', async () => {
    const where = project()
    const items = [{ key: 'PROJ-1', state: 'taken', corrections: [], answers: [] }]
    const { result } = await call(fakeJira({ issues: issues() }), where, 'start', { items, change: 'my-change', stateDir: where.stateDir })
    assert.equal(result.held, true)
  })

  const corrected = {
    key: 'PROJ-1',
    state: 'taken',
    corrections: [{ what: 'The port range', was: '1-65535', now: '1-65534' }, { what: 'The default\nport', was: null, now: '8080' }],
    answers: [{ question: 'Does the bulk edit count?', answer: 'No, a later change.' }]
  }

  it('adds the correction comment of a corrected item to the plan and the preview, and none for another item', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const plain = { key: 'PROJ-2', state: 'taken', corrections: [], answers: [{ question: 'Q?', answer: 'A.' }] }
    const { result } = await call(jira, where, 'start', { items: [corrected, plain], change: 'my-change', stateDir: where.stateDir })
    assert.equal(jira.writes().length, 0)
    const plan = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.deepEqual(
      plan.rows.map((r) => `${r.key} ${r.step} ${r.from}`),
      ['PROJ-1 transition Opened', 'PROJ-1 assignee In Progress', 'PROJ-1 comment In Progress']
    )
    const body = 'h3. Corrected before the work started\n# The port range: 1-65534 (was 1-65535)\n# The default port: 8080\n\nh3. Answered by the developer\n# Does the bulk edit count? — No, a later change.'
    assert.equal(rowOf(plan, 'PROJ-1', 'comment').steps[0].comment.body, body)
    assert.ok(result.preview.includes('PROJ-1 Summary of PROJ-1: Opened → In Progress; assignee dev.login; comment:'))
    assert.ok(result.preview.includes('    # The port range: 1-65534 (was 1-65535)'))
    assert.ok(result.preview.includes('PROJ-2 skipped: already In Progress and assigned to the developer'))
  })

  it('adds the comment of an item corrected only by the answers', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const answered = { key: 'PROJ-1', state: 'taken', verdict: 'corrected', corrections: [], answers: [{ question: 'Q?', answer: 'A.' }] }
    const { result } = await call(jira, where, 'start', { items: [answered], change: 'my-change', stateDir: where.stateDir })
    const plan = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.equal(rowOf(plan, 'PROJ-1', 'comment').steps[0].comment.body, 'h3. Answered by the developer\n# Q? — A.')
  })

  it('posts the correction comment on an issue already started and assigned', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'start', { items: [{ ...corrected, key: 'PROJ-2' }], change: 'my-change', stateDir: where.stateDir })
    const { result } = await call(jira, where, 'start', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-2'])
    assert.deepEqual(
      jira.writes().map((c) => `${c.method} ${c.path}`),
      ['POST /rest/api/2/issue/PROJ-2/comment']
    )
    assert.match(jira.comments['PROJ-2'][0].body, /^h3\. Corrected before the work started/)
  })

  it('renders the host template named by config.correctionTemplate', async () => {
    const where = project()
    writeFileSync(join(where.root, 'corrections.md'), '<!-- corrected -->\nFixed:\n* {{corrections}}\n')
    const { result } = await call(fakeJira({ issues: issues() }), where, 'start', { items: [corrected], change: 'my-change', stateDir: where.stateDir }, { ...CONFIG, correctionTemplate: 'corrections.md' })
    const body = rowOf(JSON.parse(readFileSync(result.file, 'utf8')), 'PROJ-1', 'comment').steps[0].comment.body
    assert.equal(body, 'Fixed:\n* The port range: 1-65534 (was 1-65535)\n* The default port: 8080')
  })

  it('refuses a correction template without its section, sending nothing', async () => {
    const where = project()
    writeFileSync(join(where.root, 'corrections.md'), 'no section\n')
    const jira = fakeJira({ issues: issues() })
    const { code, result } = await call(jira, where, 'start', { items: [corrected], change: 'my-change', stateDir: where.stateDir }, { ...CONFIG, correctionTemplate: 'corrections.md' })
    assert.equal(code, 1)
    assert.match(result.error, /no section "corrected"/)
    assert.equal(jira.writes().length, 0)
  })

  it('refuses an apply of an unknown plan id', async () => {
    const where = project()
    const { result } = await call(fakeJira(), where, 'start', { stateDir: where.stateDir, apply: 'start-20261021T100000Z' })
    assert.equal(result.state, 'refused')
    assert.match(result.error, /no plan/)
  })
})

describe('tracker handoff', () => {
  const issues = () => ({
    'PROJ-1': issue('PROJ-1', { status: 'In Progress', assignee: 'dev.login' }),
    'PROJ-2': issue('PROJ-2', { status: 'In Progress', assignee: 'dev.login' }),
    'PROJ-3': issue('PROJ-3', { status: 'In Progress', type: 'Bug' })
  })
  const taken = { key: 'PROJ-1', state: 'taken', fields: { done: ['The form validates the port.'], test: ['Open the port page.', 'Enter 70000 and save.'] } }
  const partial = { key: 'PROJ-2', state: 'partial', fields: { done: ['The single edit validates the port.'], test: ['Edit one port and save 70000.'], remains: ['The bulk edit is not covered.'] } }
  const retest = { key: 'PROJ-3', state: 'not-reproduced', fields: { tried: ['Followed the reproduction steps.'], commit: 'abc1234' } }
  const mr = { url: 'https://git.example.com/group/repo/-/merge_requests/7' }

  it('holds a row per step: taken and not-reproduced move to the tester with the comment, partial gets the comment only', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { code, result } = await call(jira, where, 'handoff', { items: [taken, partial, retest], mr, stateDir: where.stateDir })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(jira.writes().length, 0)
    assert.ok(result.preview.includes('PROJ-1 Summary of PROJ-1: In Progress → Review; assignee qa.login; comment:'))
    assert.ok(result.preview.includes('PROJ-2 Summary of PROJ-2: comment:'))
    assert.ok(result.preview.includes('    Merge request: https://git.example.com/group/repo/-/merge_requests/7'))
    const plan = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.deepEqual(
      plan.rows.map((r) => `${r.key} ${r.step} ${r.from ?? '-'}`),
      ['PROJ-1 transition In Progress', 'PROJ-1 assignee Review', 'PROJ-1 comment Review', 'PROJ-2 comment -', 'PROJ-3 transition In Progress', 'PROJ-3 assignee Review', 'PROJ-3 comment Review']
    )
    assert.equal(rowOf(plan, 'PROJ-1', 'assignee').steps[0].fields.assignee.name, '<JIRA_QA>')
    assert.match(rowOf(plan, 'PROJ-3', 'comment').steps[0].comment.body, /does not reproduce on commit abc1234/)
  })

  it('applies: the hand-off status, the tester, the comment; partial keeps its status', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'handoff', { items: [taken, partial], mr, stateDir: where.stateDir })
    const { result } = await call(jira, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-1', 'PROJ-2'])
    assert.equal(jira.store['PROJ-1'].fields.status, 'Review')
    assert.deepEqual(jira.store['PROJ-1'].fields.assignee, { name: 'qa.login' })
    assert.equal(jira.store['PROJ-2'].fields.status, 'In Progress')
    assert.equal(
      jira.comments['PROJ-1'][0].body,
      'h3. Done\n# The form validates the port.\n\nh3. How to test\n# Open the port page.\n# Enter 70000 and save.\n\nMerge request: https://git.example.com/group/repo/-/merge_requests/7'
    )
    assert.match(jira.comments['PROJ-2'][0].body, /h3\. How to test\n# Edit one port and save 70000\.\n\nh3\. Remains\n# The bulk edit is not covered\./)
  })

  it('resumes a hand-off that failed after the transition: the rerun posts only the comment', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'handoff', { items: [taken], mr, stateDir: where.stateDir })
    const flaky = failingComments(jira)
    const { result: first } = await call(flaky, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(first.applied, [])
    assert.equal(first.failed[0].key, 'PROJ-1')
    assert.match(first.failed[0].reason, /^comment: Jira responded 500/)
    assert.equal(jira.store['PROJ-1'].fields.status, 'Review')
    assert.equal(jira.comments['PROJ-1'], undefined)
    const before = jira.writes().length
    const { result } = await call(jira, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-1'])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(
      jira.writes().slice(before).map((c) => `${c.method} ${c.path}`),
      ['POST /rest/api/2/issue/PROJ-1/comment']
    )
    assert.equal(jira.comments['PROJ-1'].length, 1)
  })

  it('posts no second comment when the first was posted and its response lost', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'handoff', { items: [taken], mr, stateDir: where.stateDir })
    await call(failingComments(jira, { mode: 'after' }), where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.equal(jira.comments['PROJ-1'].length, 1)
    const { result } = await call(jira, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-1'])
    assert.equal(commentPosts(jira).length, 1)
    assert.equal(jira.comments['PROJ-1'].length, 1)
    const plan = JSON.parse(readFileSync(held.file, 'utf8'))
    assert.match(rowOf(plan, 'PROJ-1', 'comment').note, /already posted/)
  })

  it('changes nothing on a full rerun after a successful hand-off', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result: held } = await call(jira, where, 'handoff', { items: [taken, partial], mr, stateDir: where.stateDir })
    await call(jira, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    const writes = jira.writes().length
    const { result } = await call(jira, where, 'handoff', { stateDir: where.stateDir, apply: held.plan })
    assert.deepEqual(result.applied, ['PROJ-1', 'PROJ-2'])
    assert.equal(jira.writes().length, writes)
    assert.equal(jira.comments['PROJ-1'].length, 1)
    assert.equal(jira.comments['PROJ-2'].length, 1)
  })

  it('renders no merge request line with no forge', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result } = await call(jira, where, 'handoff', { items: [taken], mr: null, stateDir: where.stateDir })
    const body = rowOf(JSON.parse(readFileSync(result.file, 'utf8')), 'PROJ-1', 'comment').steps[0].comment.body
    assert.equal(body, 'h3. Done\n# The form validates the port.\n\nh3. How to test\n# Open the port page.\n# Enter 70000 and save.')
  })

  it('refuses a link in agent text before any call', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const bad = { ...taken, fields: { ...taken.fields, done: ['See https://example.com/x for the fix.'] } }
    const { code, result } = await call(jira, where, 'handoff', { items: [bad], mr, stateDir: where.stateDir })
    assert.equal(code, 1)
    assert.match(result.error, /PROJ-1: done holds a link/)
    assert.equal(jira.calls.length, 0)
  })

  it('refuses a taken item without test steps, and a missing mr', async () => {
    const where = project()
    const jira = fakeJira({ issues: issues() })
    const { result } = await call(jira, where, 'handoff', { items: [{ key: 'PROJ-1', state: 'taken', fields: { done: ['x'] } }], stateDir: where.stateDir })
    assert.match(result.error, /mr is missing/)
    assert.match(result.error, /taken needs test/)
    assert.equal(jira.calls.length, 0)
  })

  it('refuses a hand-off when JIRA_QA is not set, naming the variable only', async () => {
    const where = project({ env: 'JIRA_PAT=token-value\n' })
    const jira = fakeJira({ issues: issues() })
    const { result } = await call(jira, where, 'handoff', { items: [taken], mr, stateDir: where.stateDir })
    assert.equal(result.state, 'refused')
    assert.match(result.error, /JIRA_QA/)
    assert.equal(jira.calls.length, 0)
  })

  it('refuses a hand-off when the config names no hand-off status', async () => {
    const where = project()
    const { result } = await call(fakeJira({ issues: issues() }), where, 'handoff', { items: [taken], mr, stateDir: where.stateDir }, { ...CONFIG, statuses: {} })
    assert.match(result.error, /statuses\.handoff/)
  })

  it('renders the host template named by config.commentTemplate instead of the default', async () => {
    const where = project()
    writeFileSync(join(where.root, 'handoff.md'), '<!-- taken -->\nShipped:\n* {{done}}\n<!-- partial -->\nLeft: {{remains}}\n<!-- not-reproduced -->\nNo repro on {{commit}}\n')
    const jira = fakeJira({ issues: issues() })
    const { result } = await call(jira, where, 'handoff', { items: [taken], mr: null, stateDir: where.stateDir }, { ...CONFIG, commentTemplate: 'handoff.md' })
    const body = rowOf(JSON.parse(readFileSync(result.file, 'utf8')), 'PROJ-1', 'comment').steps[0].comment.body
    assert.equal(body, 'Shipped:\n* The form validates the port.')
  })
})

describe('tracker.mjs main', () => {
  it('refuses input that is not JSON, and an unknown operation', async () => {
    assert.equal((await main(['check'], () => 'not json')).result.state, 'refused')
    const unknown = await main(['close'], () => JSON.stringify({ root: tmpdir(), config: {}, input: {} }))
    assert.equal(unknown.code, 1)
    assert.match(unknown.result.error, /unknown operation/)
  })
})
