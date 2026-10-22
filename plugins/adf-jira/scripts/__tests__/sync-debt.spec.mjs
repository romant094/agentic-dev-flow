// sync-debt.mjs and lib/sync-debt.mjs: the debt tree's groups, the grouping check, the plans and
// the key write-back, against a real debt tree through the core's debt CLI (the core beside this
// plugin). Jira is a fake fetch; nothing reaches the network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { main } from '../sync-debt.mjs'
import { applyPlan, bodyLines } from '../lib/apply.mjs'
import { JiraClient } from '../lib/client.mjs'
import { parseDebtTemplate } from '../lib/debt-description.mjs'
import { loadPlan } from '../lib/plan.mjs'
import { fakeJira, issue } from './fake-jira.mjs'

const NOW = new Date('2026-10-22T10:00:00.000Z')
const HEADER = '| ID | Title | Anchors | Class | Source | Tracker |\n|---|---|---|---|---|---|\n'
const ROOT = '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`snmp`](snmp/index.md) | SNMP |\n| [`ui`](ui/index.md) | UI |\n'
const SNMP = `# SNMP\n\nLast id: \`snmp-04\`\n\n${HEADER}| \`snmp-01\` | Trailing index extracted in three places | \`a.ts:12\`, \`b.ts:40\` | debt | c1 | PROJ-7 |\n| \`snmp-02\` | Walk ignores the timeout | \`walk.ts:5\` | defect | c1 | PROJ-7 |\n| \`snmp-03\` | Index parse duplicated again | \`a.ts:80\` | debt | c2 | |\n| \`snmp-04\` | Session pool leaks | \`pool.ts:3\` | defect | c2 | |\n`
const UI = `# UI\n\nLast id: \`ui-02\`\n\n${HEADER}| \`ui-01\` | Form labels drift | \`form.tsx:1\` | decision | c3 | PROJ-9 |\n| \`ui-02\` | Table sort is unstable | \`table.tsx:9\` | defect | c3 | |\n`
const CONFIG = { baseUrl: 'https://jira.example.com', allowlist: ['PROJ'], debtEpic: 'PROJ-1', statuses: { initial: 'Opened' } }
const FACTS = {
  discoveredAt: '2026-10-21T10:00:00.000Z',
  issueTypes: [
    { name: 'Sub-task', subtask: true, requiredFields: ['project', 'issuetype', 'summary', 'parent', 'reporter'] },
    { name: 'Task', subtask: false, requiredFields: ['project', 'issuetype', 'summary'] },
    { name: 'Story', subtask: false, requiredFields: ['project', 'issuetype', 'summary', 'customfield_1'] }
  ],
  fieldMap: { 'Epic Link': 'customfield_10100' },
  workflow: {}
}

function host({ config = CONFIG, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-jira-sync-debt-'))
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.7', debt: { root: 'debt' }, extensions: [{ plugin: 'adf-jira@agentic-dev-flow', config }] }))
  write('.claude/jira/profile/discovered.json', JSON.stringify(FACTS))
  write('debt/index.md', ROOT)
  write('debt/snmp/index.md', SNMP)
  write('debt/ui/index.md', UI)
  for (const [path, text] of Object.entries(files)) write(path, text)
  return root
}

const deps = (root) => ({ cwd: root, run: () => null, now: () => NOW, ignored: () => true })
const call = (root, ...argv) => main(argv, deps(root))
const grouping = (root, value) => {
  const file = join(root, 'grouping.json')
  writeFileSync(file, JSON.stringify(value))
  return file
}
const GROUPING = {
  version: 1,
  join: [{ key: 'PROJ-7', entries: ['snmp-03'] }],
  create: [{ summary: 'Session pool leaks connections', entries: ['snmp-04'] }],
  wait: [{ entry: 'ui-02', reason: 'the sort may be the grid library; ask its owner first' }]
}

describe('sync-debt.mjs state', () => {
  it('returns the groups by key and the keyless entries with what they relate to', () => {
    const root = host()
    const state = call(root, 'state')
    assert.deepEqual([state.ok, state.root, state.epic, state.initial], [true, 'debt', 'PROJ-1', 'Opened'])
    assert.deepEqual(state.groups.map((g) => [g.key, g.entries.map((e) => e.id)]), [['PROJ-7', ['snmp-01', 'snmp-02']], ['PROJ-9', ['ui-01']]])
    assert.deepEqual(state.groups[0].entries[0], { id: 'snmp-01', block: 'snmp', subBlock: null, title: 'Trailing index extracted in three places', anchors: ['a.ts:12', 'b.ts:40'], class: 'debt', files: ['debt/snmp/index.md'] })
    assert.deepEqual(state.keyless.map((e) => e.id), ['snmp-03', 'snmp-04', 'ui-02'])
    assert.deepEqual(state.keyless[0].related, { groups: [{ key: 'PROJ-7', by: ['block', 'anchor-file'] }], entries: [{ id: 'snmp-04', by: ['block'] }] })
    assert.deepEqual(state.keyless[2].related, { groups: [{ key: 'PROJ-9', by: ['block'] }], entries: [] })
  })
})

describe('sync-debt.mjs check-groups', () => {
  it('passes a grouping that decides every keyless entry once', () => {
    const root = host()
    assert.deepEqual(call(root, 'check-groups', '--file', grouping(root, GROUPING)), { ok: true, errors: [], join: 1, create: 1, wait: 1 })
  })

  it('refuses an unknown or tracked id, an entry decided twice or not at all, a join to no group, and a malformed item', () => {
    const root = host()
    const out = call(
      root,
      'check-groups',
      '--file',
      grouping(root, {
        version: 2,
        join: [{ key: 'PROJ-99', entries: ['snmp-03'] }, { key: 'PROJ-7', entries: ['snmp-01'] }],
        create: [{ summary: 'Use `walk` once', entries: ['snmp-03', 'nope-01'] }, { summary: 'x', entries: [] }],
        wait: [{ entry: 'snmp-04', reason: '' }],
        extra: true
      })
    )
    assert.equal(out.ok, false)
    assert.deepEqual(out.errors, [
      'the grouping: unknown field extra; its fields are version, join, create, wait',
      'version is 2, not 1',
      'join[0]: "PROJ-99" is not the key of a group in the tree; a join names an existing group',
      'join[1]: snmp-01 is already tracked as PROJ-7; only a keyless entry is decided',
      'create[0]: summary holds a backtick; the summary is a plain paraphrase',
      'create[0]: snmp-03 is already decided in join[0]; decide each entry once',
      'create[0]: no entry nope-01 in the tree',
      'create[1]: entries is not a non-empty list of entry ids',
      'wait[0]: reason is not one line of text',
      'undecided: ui-02; every keyless entry joins a group, forms a new one, or waits with a reason'
    ])
  })
})

describe('sync-debt.mjs plan', () => {
  it('builds a create row per new group and an edit row per group, expecting the initial status and the template shape', () => {
    const root = host()
    const out = call(root, 'plan', '--file', grouping(root, GROUPING), '--type', 'Sub-task', '--attach', 'parent')
    assert.deepEqual([out.ok, out.rows, out.waiting], [true, { create: 1, edit: 2 }, [{ entry: 'ui-02', reason: GROUPING.wait[0].reason }]])
    assert.ok(out.plans.create.startsWith(join(root, '.adf', 'jira', 'sync-debt', 'plan-create-')))
    assert.ok(out.plans.edit.startsWith(join(root, '.adf', 'jira', 'sync-debt', 'plan-edit-')))
    assert.deepEqual(out.preview, [
      'create Sub-task under PROJ-1: "Session pool leaks connections" — snmp-04',
      'PROJ-7: snmp-03 join; its description is rendered again from 3 entries, sent only while it is Opened and its description has the template\'s shape, else the joining entries wait',
      'PROJ-9: its description is rendered again from 1 entries, sent only if it differs, while it is Opened and has the template\'s shape',
      'ui-02 waits: the sort may be the grid library; ask its owner first'
    ])

    const create = loadPlan(out.plans.create)
    assert.deepEqual([create.operation, create.purpose, create.allowlist, create.discoveredAt], ['create', 'sync-debt', ['PROJ'], FACTS.discoveredAt])
    const [row] = create.rows
    assert.deepEqual([row.key, row.project, row.summary, row.entries, row.state], ['(new)', 'PROJ', 'Session pool leaks connections', ['snmp-04'], 'pending'])
    const fields = row.steps[0].create.fields
    assert.deepEqual([fields.project, fields.issuetype, fields.parent, fields.reporter], [{ key: 'PROJ' }, { name: 'Sub-task' }, { key: 'PROJ-1' }, { name: '<JIRA_ASSIGNEE>' }])
    assert.equal(
      fields.description,
      'h3. Technical debt\n* snmp-04: Session pool leaks\n** Anchors: pool.ts:3\n** Class: defect\n\nMirrored from the technical debt tree debt: each entry above is a row there that carries this issue\'s key.'
    )
    assert.equal(Object.hasOwn(fields, 'assignee'), false)

    const edit = loadPlan(out.plans.edit)
    assert.deepEqual([edit.operation, edit.allowlist], ['edit', ['PROJ']])
    const [joined, refreshed] = edit.rows
    assert.deepEqual([joined.key, joined.from, joined.entries, joined.joins], ['PROJ-7', 'Opened', ['snmp-01', 'snmp-02', 'snmp-03'], ['snmp-03']])
    assert.deepEqual([refreshed.key, refreshed.from, refreshed.entries, refreshed.joins], ['PROJ-9', 'Opened', ['ui-01'], []])
    const shape = new RegExp(joined.body.shape)
    const description = joined.steps[0].fields.description
    assert.match(description, /\* snmp-01: Trailing index extracted in three places\n\*\* Anchors: a\.ts:12, b\.ts:40\n/)
    assert.match(description, /\* snmp-03: Index parse duplicated again\n/)
    assert.ok(shape.test(bodyLines(description)), 'a rendered description has the shape')
    assert.ok(shape.test(bodyLines(refreshed.steps[0].fields.description)), 'for any number of entries')
    assert.ok(shape.test(bodyLines(description.replace(/\n/g, '\r\n\n'))), 'blank lines and line endings do not count')
    assert.equal(shape.test(bodyLines('Written by hand.\n\nh3. Acceptance\n* it works')), false)
    assert.equal(shape.test(bodyLines(`${description}\n\nh3. Test stand\n* the lab switch`)), false, 'a description a person extended is not the shape')
  })

  it('attaches by Epic Link, and refuses a missing type, model, epic, initial status or a field a mirror does not fill', () => {
    const root = host()
    const file = grouping(root, GROUPING)
    const linked = loadPlan(call(root, 'plan', '--file', file, '--type', 'Task', '--attach', 'epic-link').plans.create).rows[0].steps[0].create.fields
    assert.deepEqual([linked.customfield_10100, linked.parent, linked.reporter], ['PROJ-1', undefined, undefined])
    assert.throws(() => call(root, 'plan', '--file', file), /a new group needs --type/)
    assert.throws(() => call(root, 'plan', '--file', file, '--type', 'Task'), /a new group needs --attach parent or epic-link/)
    assert.throws(() => call(root, 'plan', '--file', file, '--type', 'Bug', '--attach', 'parent'), /the issue type "Bug" is not in discovered\.json/)
    assert.throws(() => call(root, 'plan', '--file', file, '--type', 'Story', '--attach', 'parent'), /requires customfield_1, which a debt mirror does not fill/)
    assert.throws(() => call(root, 'plan', '--file', file, '--type', 'Task', '--attach', 'parent', '--type', 'Task'), /--type is given twice/)
    const noEpic = host({ config: { ...CONFIG, debtEpic: undefined } })
    assert.throws(() => call(noEpic, 'plan', '--file', grouping(noEpic, GROUPING), '--type', 'Task', '--attach', 'parent'), /config\.debtEpic names no epic/)
    const noInitial = host({ config: { ...CONFIG, statuses: {} } })
    assert.throws(() => call(noInitial, 'plan', '--file', grouping(noInitial, GROUPING), '--type', 'Task', '--attach', 'parent'), /config\.statuses\.initial names no initial status/)
    assert.throws(() => call(root, 'plan', '--file', grouping(root, { version: 1 })), /the grouping is refused: undecided: snmp-03, snmp-04, ui-02/)
  })

  it('renders the host template config.debtTemplate names instead of the plugin\'s', () => {
    const template = 'Preface.\n<!-- description -->\nDebt of {{root}}:\n{{#entries}}\n# {{title}} ({{class}}, {{block}})\n{{/entries}}\n'
    const root = host({ config: { ...CONFIG, debtTemplate: 'jira/debt.md' }, files: { 'jira/debt.md': template } })
    const edit = loadPlan(call(root, 'plan', '--file', grouping(root, GROUPING), '--type', 'Task', '--attach', 'parent').plans.edit)
    assert.equal(edit.rows[0].steps[0].fields.description, 'Debt of debt:\n# Trailing index extracted in three places (debt, snmp)\n# Walk ignores the timeout (defect, snmp)\n# Index parse duplicated again (debt, snmp)')
    writeFileSync(join(root, 'jira/debt.md'), '<!-- description -->\n{{title}}\n')
    assert.throws(() => call(root, 'plan', '--file', grouping(root, GROUPING), '--type', 'Task', '--attach', 'parent'), /no \{\{#entries\}\} block/)
  })
})

describe('sync-debt.mjs track', () => {
  it('writes the key of each applied row into its entries; a drifted group leaves its joining entries waiting', async () => {
    const root = host()
    const out = call(root, 'plan', '--file', grouping(root, GROUPING), '--type', 'Task', '--attach', 'parent')
    // The create applied: Jira returned PROJ-12. The edit plan runs against a fake Jira: PROJ-7
    // moved on, PROJ-9 already carries its description.
    const create = loadPlan(out.plans.create)
    Object.assign(create.rows[0], { state: 'done', createdKey: 'PROJ-12' })
    writeFileSync(out.plans.create, JSON.stringify(create))
    const edit = loadPlan(out.plans.edit)
    const jira = fakeJira({
      issues: {
        'PROJ-7': issue('PROJ-7', { status: 'In Progress' }),
        'PROJ-9': issue('PROJ-9', { fields: { description: edit.rows[1].steps[0].fields.description.replace(/\n/g, '\r\n') } })
      }
    })
    const client = new JiraClient({ url: 'https://jira.example.com', pat: 'token-value' }, jira.fetch)
    const outcome = await applyPlan({ plan: edit, client, persist: (p) => writeFileSync(out.plans.edit, JSON.stringify(p)) })
    assert.deepEqual([outcome.applied, outcome.skippedDrift, outcome.unchanged], [0, 1, 1])
    assert.deepEqual(jira.writes(), [], 'nothing was written to Jira')

    const tracked = call(root, 'track', '--plan', out.plans.create, '--plan', out.plans.edit)
    assert.equal(tracked.ok, true)
    assert.deepEqual(tracked.tracked, [{ id: 'snmp-04', key: 'PROJ-12', changed: true }])
    assert.deepEqual(tracked.waiting, [{ id: 'snmp-03', key: 'PROJ-7', reason: 'Expected status "Opened" but found "In Progress"; left untouched.' }])
    assert.deepEqual([tracked.created, tracked.updated, tracked.unchanged, tracked.notApplied, tracked.errors], [['PROJ-12'], [], ['PROJ-9'], [], []])
    assert.deepEqual(tracked.check, { ok: true, errors: [] })
    const snmp = readFileSync(join(root, 'debt/snmp/index.md'), 'utf8')
    assert.match(snmp, /\| `snmp-04` \| Session pool leaks \| `pool\.ts:3` \| defect \| c2 \| PROJ-12 \|/)
    assert.match(snmp, /\| `snmp-03` \| Index parse duplicated again \| `a\.ts:80` \| debt \| c2 \| \|/)
    assert.deepEqual(call(root, 'track', '--plan', out.plans.create).tracked, [{ id: 'snmp-04', key: 'PROJ-12', changed: false }], 'a rerun changes nothing')
  })

  it('writes nothing for a row not applied, and refuses a plan of another skill', () => {
    const root = host()
    const out = call(root, 'plan', '--file', grouping(root, GROUPING), '--type', 'Task', '--attach', 'parent')
    const create = loadPlan(out.plans.create)
    Object.assign(create.rows[0], { state: 'failed', error: 'Jira refused the create' })
    writeFileSync(out.plans.create, JSON.stringify(create))
    const tracked = call(root, 'track', '--plan', out.plans.create, '--plan', out.plans.edit)
    assert.deepEqual(tracked.tracked, [])
    assert.deepEqual(tracked.notApplied, [
      { key: '(new)', entries: ['snmp-04'], reason: 'Jira refused the create' },
      { key: 'PROJ-7', entries: ['snmp-03'], reason: 'not applied' },
      { key: 'PROJ-9', entries: [], reason: 'not applied' }
    ])
    assert.equal(readFileSync(join(root, 'debt/snmp/index.md'), 'utf8'), SNMP)
    writeFileSync(out.plans.create, JSON.stringify({ ...create, purpose: 'bulk' }))
    assert.throws(() => call(root, 'track', '--plan', out.plans.create), /a plan of bulk, not of sync-debt/)
  })
})

describe('lib/debt-description.mjs parseDebtTemplate', () => {
  it('refuses a template without one entries block, a per-entry value outside it, and a block inside it', () => {
    const t = (body) => () => parseDebtTemplate(`<!-- description -->\n${body}\n`, 'host.md')
    assert.throws(t('{{root}}'), /host\.md: no \{\{#entries\}\} block/)
    assert.throws(t('{{#entries}}\n{{id}}\n{{/entries}}\n{{#entries}}\n{{id}}\n{{/entries}}'), /a second \{\{#entries\}\} block/)
    assert.throws(t('{{title}}\n{{#entries}}\n{{id}}\n{{/entries}}'), /\{\{title\}\} stands outside the entries block; only \{\{root\}\} may/)
    assert.throws(t('{{#entries}}\n{{#title}}\n{{id}}\n{{/title}}\n{{/entries}}'), /a block inside the entries block/)
    assert.throws(t('{{#entries}}\n\n{{/entries}}'), /the entries block is empty/)
    assert.throws(t('{{#entries}}\n{{owner}}\n{{/entries}}'), /unknown placeholder \{\{owner\}\}/)
    assert.deepEqual(parseDebtTemplate('<!-- description -->\nIn {{root}}:\n{{#entries}}\n- {{id}}\n{{/entries}}\n', 'host.md'), { head: ['In {{root}}:'], entry: ['- {{id}}'], tail: [''] })
  })
})
