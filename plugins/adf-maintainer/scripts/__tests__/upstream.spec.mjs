import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createArgs, debtMarker, findingMarker, installHint, listArgs, renderDebt, renderFinding, runOperation, slug } from '../lib/upstream.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', '..')
const cli = join(pluginDir, 'scripts', 'upstream.mjs')
const ROOT = '/work/host'
const REPO = 'acme/agentic-dev-flow'

// Records every call as "cmd arg1 arg2 ..." and answers with the first handler whose prefix
// matches, so a test can assert on the order as well as on which calls happened. A handler's
// answer may be a function of the call, for answers that change from call to call.
const record = (handlers) => {
  const calls = []
  const run = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    const hit = handlers.find(([prefix]) => key === prefix || key.startsWith(`${prefix} `))
    if (!hit) return { status: 1, stdout: '', stderr: 'no handler' }
    return typeof hit[1] === 'function' ? hit[1](args) : hit[1]
  }
  return { run, calls }
}
const yes = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const no = (stderr = 'failed') => ({ status: 1, stdout: '', stderr })

const tool = [
  ['gh --version', yes('gh version 2.62.0')],
  ['gh auth status', yes('Logged in')]
]
const pushable = [...tool, [`gh api repos/${REPO}`, yes(JSON.stringify({ full_name: REPO, permissions: { push: true } }))]]
const labelsOk = [`gh api repos/${REPO}/labels`, yes('{}')]
const listed = (label, issues) => [`gh api --paginate repos/${REPO}/issues?state=all&labels=${label}&per_page=100`, yes(issues.map((i) => JSON.stringify(i)).join('\n'))]
const none = [listed('adf-retro', []), listed('adf-debt', [])]

const op = (operation, input, handlers, { platform = 'darwin' } = {}) => {
  const { run, calls } = record(handlers)
  const { code, result } = runOperation(operation, { root: ROOT, config: {}, input }, { run, platform })
  return { code, result, calls }
}

const finding = {
  id: 'R1',
  title: 'Apply re-reads the plan per task',
  class: 'token waste',
  changes: ['add-login', 'fix-cache'],
  evidence: [
    { key: 'reads', value: 14 },
    { key: 'session', value: 'abc123' }
  ],
  cost: { key: 'tokens', value: '120k' },
  caughtWhere: 'retrospective',
  plugin: 'gitlab',
  version: '0.3.0',
  body: 'The orchestrator opened plan.md once per task.'
}
const debt = {
  id: 'D-2026-10-01-1',
  title: 'Finalize wording drifts from the template',
  plugin: 'adf',
  pluginVersion: '0.11.0',
  change: 'add-login',
  class: 'deferred wording',
  source: 'review.md',
  body: 'The finalize hint names a section the template no longer has.'
}
const fileInput = (over = {}) => ({ repository: REPO, host: 'xnms', retro: '2026-10-20-window', findings: [finding], debt: [debt], ...over })
const creates = (calls) => calls.filter((c) => c.startsWith(`gh api repos/${REPO}/issues`))

// ---------------------------------------------------------------- check

test('check reports missing gh with an install hint, and says nothing was sent', () => {
  const { code, result } = op('check', { repository: REPO }, [])
  assert.equal(code, 0)
  assert.equal(result.state, 'degraded')
  assert.equal(result.tool, 'missing')
  assert.equal(result.hint, 'brew install gh')
  assert.ok(Array.isArray(result.fallback))
  assert.match(result.message, /nothing was sent/)
  assert.match(installHint('win32'), /winget/)
})

test('check reports unauthenticated with gh auth login, naming GH_TOKEN', () => {
  const { code, result } = op('check', { repository: REPO }, [['gh --version', yes()]])
  assert.equal(code, 0)
  assert.equal(result.tool, 'unauthenticated')
  assert.equal(result.hint, 'gh auth login')
  assert.match(result.message, /GH_TOKEN/)
  assert.match(result.message, /nothing was sent/)
})

test('check refuses a repository that is not owner/name, before any call', () => {
  for (const repository of ['acme', 'acme/x/y', '', 'https://github.com/acme/x', 1]) {
    const { code, result, calls } = op('check', { repository }, pushable)
    assert.equal(code, 1)
    assert.match(result.error, /input\.repository must be "owner\/name"; nothing was sent\./)
    assert.deepEqual(calls, [])
  }
  assert.match(op('check', { repository: REPO, extra: 1 }, pushable).result.error, /unknown field extra/)
  assert.match(op('check', {}, pushable).result.error, /missing field repository/)
})

test('check refuses without push permission on the repository', () => {
  const handlers = [...tool, [`gh api repos/${REPO}`, yes(JSON.stringify({ permissions: { push: false, pull: true } }))]]
  const { code, result } = op('check', { repository: REPO }, handlers)
  assert.equal(code, 1)
  assert.deepEqual(result, { state: 'refused', error: `no push permission on ${REPO}; nothing was sent.` })
})

test('check refuses when the repository cannot be read', () => {
  const { code, result } = op('check', { repository: REPO }, [...tool, [`gh api repos/${REPO}`, no('gh: Not Found (HTTP 404)')]])
  assert.equal(code, 1)
  assert.match(result.error, /could not read the repository .*HTTP 404\); nothing was sent\./)
})

test('check is done when gh is ready and may push', () => {
  const { code, result, calls } = op('check', { repository: REPO }, pushable)
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', tool: 'ready', repository: REPO })
  assert.deepEqual(calls, ['gh --version', 'gh auth status', `gh api repos/${REPO}`])
})

// ---------------------------------------------------------------- input

test('file refuses unknown and missing fields before any call', () => {
  const cases = [
    [fileInput({ extra: true }), /input: unknown field extra/],
    [{ repository: REPO, host: 'xnms', retro: 'r', findings: [] }, /input: missing field debt/],
    [fileInput({ findings: [{ ...finding, note: 'x' }] }), /input\.findings\[0\]: unknown field note/],
    [fileInput({ findings: [{ ...finding, caughtWhere: undefined }] }), /input\.findings\[0\]\.caughtWhere is required/],
    [fileInput({ debt: [{ ...debt, pluginVersion: '' }] }), /input\.debt\[0\]\.pluginVersion is required/],
    [fileInput({ debt: [{ ...debt, source: 3 }] }), /input\.debt\[0\]\.source must be text, empty or null/],
    [fileInput({ debt: [{ ...debt, note: 1 }] }), /input\.debt\[0\]: unknown field note/],
    [fileInput({ findings: [{ ...finding, cost: { key: 'tokens' } }] }), /cost must be/],
    [fileInput({ findings: [{ ...finding, evidence: [{ key: 'a', value: null }] }] }), /evidence must be/],
    [fileInput({ findings: [finding, finding] }), /the id R1 appears twice/],
    [fileInput({ host: 'a --> b' }), /input\.host must be one line/],
    [fileInput({ repository: 'nope' }), /input\.repository/]
  ]
  for (const [input, error] of cases) {
    const { code, result, calls } = op('file', input, pushable)
    assert.equal(code, 1)
    assert.match(result.error, error)
    assert.match(result.error, /nothing was sent\.$/)
    assert.deepEqual(calls, [])
  }
})

test('file with no findings and no debt is done with no issues and no call', () => {
  const { code, result, calls } = op('file', fileInput({ findings: [], debt: [] }), [])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', issues: [] })
  assert.deepEqual(calls, [])
})

test('file degrades like check, and refuses without push permission, before any write', () => {
  const missing = op('file', fileInput(), [])
  assert.equal(missing.code, 0)
  assert.equal(missing.result.state, 'degraded')
  assert.match(missing.result.message, /nothing was sent/)
  const denied = op('file', fileInput(), [...tool, [`gh api repos/${REPO}`, yes('{"permissions":{"push":false}}')]])
  assert.equal(denied.code, 1)
  assert.match(denied.result.error, /no push permission/)
  assert.equal(denied.calls.some((c) => c.includes('/labels') || c.includes('/issues')), false)
})

// ---------------------------------------------------------------- labels

test('file ensures every label once, and an existing label (HTTP 422) is fine', () => {
  const exists = { status: 1, stdout: '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}', stderr: 'gh: Validation Failed (HTTP 422)' }
  const handlers = [...pushable, [`gh api repos/${REPO}/labels`, exists], ...none, [`gh api repos/${REPO}/issues`, yes('{"number":1,"html_url":"u"}')]]
  const { code, calls } = op('file', fileInput(), handlers)
  assert.equal(code, 0)
  assert.deepEqual(
    calls.filter((c) => c.includes('/labels')),
    [
      `gh api repos/${REPO}/labels -f name=adf-retro -f color=5319e7`,
      `gh api repos/${REPO}/labels -f name=token-waste -f color=c5def5`,
      `gh api repos/${REPO}/labels -f name=plugin:gitlab -f color=0e8a16`,
      `gh api repos/${REPO}/labels -f name=adf-debt -f color=b60205`,
      `gh api repos/${REPO}/labels -f name=deferred-wording -f color=c5def5`,
      `gh api repos/${REPO}/labels -f name=plugin:adf -f color=0e8a16`
    ]
  )
})

test('a label that cannot be created for another reason is refused with no issue created', () => {
  const handlers = [...pushable, [`gh api repos/${REPO}/labels`, no('gh: Forbidden (HTTP 403)')]]
  const { code, result, calls } = op('file', fileInput(), handlers)
  assert.equal(code, 1)
  assert.match(result.error, /could not create the label adf-retro .*HTTP 403\); no issue was created\./)
  assert.deepEqual(creates(calls), [])
})

test('slug lowers and dashes a class', () => {
  assert.equal(slug('deferred wording'), 'deferred-wording')
  assert.equal(slug('  Token  Waste! '), 'token-waste')
})

// ---------------------------------------------------------------- idempotency

test('the markers key a finding by host, retro and id, and debt by host and id only', () => {
  assert.equal(findingMarker('xnms', '2026-10-20-window', 'R1'), '<!-- adf: xnms/2026-10-20-window/R1 -->')
  assert.equal(debtMarker('xnms', 'D1'), '<!-- adf: xnms/debt/D1 -->')
})

test('the list is read once per kind label, paginated, issues only', () => {
  assert.deepEqual(listArgs(REPO, 'adf-debt'), [
    'api',
    '--paginate',
    `repos/${REPO}/issues?state=all&labels=adf-debt&per_page=100`,
    '--jq',
    '.[] | select(.pull_request == null) | {number, url: .html_url, body}'
  ])
})

test('an item whose marker is already on an issue is returned with existed true, not created', () => {
  const old = { number: 41, url: 'https://github.com/acme/agentic-dev-flow/issues/41', body: `old text\n\n${debtMarker('xnms', debt.id)}\n` }
  const other = { number: 40, url: 'x', body: `${findingMarker('xnms', '2026-09-01-window', 'R1')}` }
  const handlers = [
    ...pushable,
    labelsOk,
    listed('adf-retro', [other]),
    listed('adf-debt', [old]),
    [`gh api repos/${REPO}/issues`, yes('{"number":42,"html_url":"https://github.com/acme/agentic-dev-flow/issues/42"}')]
  ]
  const { code, result, calls } = op('file', fileInput(), handlers)
  assert.equal(code, 0)
  assert.deepEqual(result, {
    state: 'done',
    issues: [
      { item: 'R1', kind: 'finding', number: 42, url: 'https://github.com/acme/agentic-dev-flow/issues/42', existed: false },
      { item: debt.id, kind: 'debt', number: 41, url: old.url, existed: true }
    ]
  })
  assert.equal(creates(calls).length, 1)
  assert.equal(calls.filter((c) => c.startsWith('gh api --paginate')).length, 2)
})

test('a list that cannot be read is refused with no issue created', () => {
  const handlers = [...pushable, labelsOk, [`gh api --paginate`, no('HTTP 500')]]
  const { code, result, calls } = op('file', fileInput(), handlers)
  assert.equal(code, 1)
  assert.match(result.error, /could not list the adf-retro issues .*; no issue was created\./)
  assert.deepEqual(creates(calls), [])
})

// ---------------------------------------------------------------- create

test('create sends the title, the rendered body and each label as labels[]', () => {
  const sent = []
  const handlers = [
    ...pushable,
    labelsOk,
    ...none,
    [
      `gh api repos/${REPO}/issues`,
      (args) => {
        sent.push(args)
        return yes(JSON.stringify({ number: 50 + sent.length, html_url: `https://github.com/${REPO}/issues/${50 + sent.length}` }))
      }
    ]
  ]
  const { code, result } = op('file', fileInput(), handlers)
  assert.equal(code, 0)
  assert.deepEqual(
    result.issues.map((i) => [i.item, i.kind, i.number, i.existed]),
    [
      ['R1', 'finding', 51, false],
      [debt.id, 'debt', 52, false]
    ]
  )
  const f = renderFinding(finding, { host: 'xnms', retro: '2026-10-20-window' })
  assert.deepEqual(sent[0], [
    'api',
    `repos/${REPO}/issues`,
    '-f',
    'title=[gitlab] Apply re-reads the plan per task',
    '-f',
    `body=${f.body}`,
    '-f',
    'labels[]=adf-retro',
    '-f',
    'labels[]=token-waste',
    '-f',
    'labels[]=plugin:gitlab'
  ])
  assert.deepEqual(sent[1], createArgs(REPO, renderDebt(debt, { host: 'xnms' })))
  assert.ok(sent[1].includes('title=[adf] Finalize wording drifts from the template'))
  assert.ok(sent[1].includes('labels[]=deferred-wording'))
})

test('a finding with no plugin is titled [adf] and gets no plugin label', () => {
  const rendered = renderFinding({ ...finding, plugin: null, version: null }, { host: 'xnms', retro: 'r' })
  assert.equal(rendered.title, '[adf] Apply re-reads the plan per task')
  assert.deepEqual(rendered.labels, ['adf-retro', 'token-waste'])
  assert.match(rendered.body, /^- Plugin: none$/m)
})

test('a create failing midway is refused naming what was created and what was not', () => {
  const second = { ...finding, id: 'R2', title: 'Second' }
  let n = 0
  const handlers = [
    ...pushable,
    labelsOk,
    ...none,
    [`gh api repos/${REPO}/issues`, () => (++n === 1 ? yes(JSON.stringify({ number: 7, html_url: `https://github.com/${REPO}/issues/7` })) : no('gh: HTTP 502'))]
  ]
  const { code, result } = op('file', fileInput({ findings: [finding, second] }), handlers)
  assert.equal(code, 1)
  assert.equal(result.state, 'refused')
  assert.equal(
    result.error,
    `could not create the issue for finding R2 on ${REPO}: gh: HTTP 502; created: finding R1 (#7 https://github.com/${REPO}/issues/7); not created: finding R2, debt ${debt.id}. Rerun file: an issue already filed carries its marker and is not filed again.`
  )
  assert.deepEqual(result.issues, [{ item: 'R1', kind: 'finding', number: 7, url: `https://github.com/${REPO}/issues/7`, existed: false }])
})

test('a create whose answer is unreadable is refused, warning that the issue may exist', () => {
  const handlers = [...pushable, labelsOk, ...none, [`gh api repos/${REPO}/issues`, yes('not json')]]
  const { code, result } = op('file', fileInput({ debt: [] }), handlers)
  assert.equal(code, 1)
  assert.match(result.error, /the issue may exist: the rerun finds it by its marker; no issue was created; not created: finding R1\./)
})

// ---------------------------------------------------------------- rendered bodies

test('the rendered body of a finding', () => {
  const { body } = renderFinding(finding, { host: 'xnms', retro: '2026-10-20-window' })
  assert.equal(
    body,
    [
      'The orchestrator opened plan.md once per task.',
      '',
      '- Class: token waste',
      '- Changes: add-login, fix-cache',
      '- Evidence:',
      '  - reads: 14',
      '  - session: abc123',
      '- Cost: tokens: 120k',
      '- Caught where: retrospective',
      '- Plugin: gitlab 0.3.0',
      '- Host: xnms',
      '- Retrospective: 2026-10-20-window',
      '',
      '<!-- adf: xnms/2026-10-20-window/R1 -->',
      ''
    ].join('\n')
  )
})

test('the rendered body of a debt record', () => {
  const { body } = renderDebt(debt, { host: 'xnms' })
  assert.equal(
    body,
    [
      'The finalize hint names a section the template no longer has.',
      '',
      '- Class: deferred wording',
      '- Plugin: adf 0.11.0',
      '- Change: add-login',
      '- Source: review.md',
      '- Host: xnms',
      '',
      `<!-- adf: xnms/debt/${debt.id} -->`,
      ''
    ].join('\n')
  )
})

// ---------------------------------------------------------------- runOperation and the CLI

test('runOperation refuses an unknown operation and a bad payload', () => {
  const { run } = record([])
  assert.match(runOperation('merge', { root: ROOT, input: {} }, { run }).result.error, /unknown operation "merge"/)
  assert.match(runOperation('check', [], { run }).result.error, /must be a JSON object/)
  assert.match(runOperation('check', { input: {} }, { run }).result.error, /root is required/)
})

test('runOperation turns a throw after a create into a refusal that says an issue was created', () => {
  let n = 0
  const run = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (key.startsWith(`gh api repos/${REPO}/issues`)) {
      if (++n === 2) throw new Error('boom')
      return yes('{"number":1,"html_url":"u"}')
    }
    const hit = [...pushable, labelsOk, ...none].find(([p]) => key === p || key.startsWith(`${p} `))
    return hit ? hit[1] : no()
  }
  const { code, result } = runOperation('file', { root: ROOT, input: fileInput() }, { run, platform: 'darwin' })
  assert.equal(code, 1)
  assert.equal(result.error, 'boom; 1 issue(s) were created before the error; rerun file to complete it.')
})

// A fake gh on PATH: answers --version, auth status and the repository read, nothing else.
const fakeGh = (push) => {
  const dir = mkdtempSync(join(tmpdir(), 'adf-maintainer-gh-'))
  const script = [
    '#!/usr/bin/env node',
    'const a = process.argv.slice(2).join(" ")',
    'if (a === "--version") { console.log("gh version 2.62.0"); process.exit(0) }',
    'if (a === "auth status") process.exit(0)',
    `if (a === "api repos/${REPO}") { console.log(JSON.stringify({ permissions: { push: ${push} } })); process.exit(0) }`,
    'console.error("unexpected: " + a); process.exit(1)'
  ].join('\n')
  writeFileSync(join(dir, 'gh'), `${script}\n`)
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

const cliRun = (args, input, env = process.env) => {
  const proc = spawnSync('node', [cli, ...args], { input, encoding: 'utf8', env })
  return { code: proc.status, out: JSON.parse(proc.stdout) }
}

test('the CLI runs check end to end against gh on PATH', { skip: process.platform === 'win32' }, () => {
  // The root must exist: the CLI runs gh in it.
  const payload = JSON.stringify({ root: tmpdir(), config: {}, input: { repository: REPO } })
  const ready = cliRun(['check'], payload, { ...process.env, PATH: `${fakeGh(true)}${delimiter}${process.env.PATH}` })
  assert.equal(ready.code, 0)
  assert.deepEqual(ready.out, { state: 'done', tool: 'ready', repository: REPO })
  const denied = cliRun(['check'], payload, { ...process.env, PATH: `${fakeGh(false)}${delimiter}${process.env.PATH}` })
  assert.equal(denied.code, 1)
  assert.equal(denied.out.error, `no push permission on ${REPO}; nothing was sent.`)
})

test('the CLI refuses invalid JSON and stray arguments', () => {
  assert.equal(cliRun(['check'], 'not json').code, 1)
  assert.match(cliRun(['check', '--force'], '{}').out.error, /usage: upstream\.mjs/)
})

test('the declaration names contract 1.5 and the upstream operations', () => {
  const declared = JSON.parse(readFileSync(join(pluginDir, 'adf-extension.json'), 'utf8'))
  assert.equal(declared.contract, '1.5')
  assert.deepEqual(declared.provides, { upstream: { script: 'scripts/upstream.mjs', operations: ['check', 'file'] } })
})

test('a debt record with no change and no source is accepted, and its body omits those lines', () => {
  const { change, source, ...bare } = debt
  for (const record of [bare, { ...bare, change: null, source: null }, { ...bare, change: '', source: '' }]) {
    const handlers = [...pushable, labelsOk, ...none, [`gh api repos/${REPO}/issues`, yes('{"number":9,"html_url":"u"}')]]
    const { code, result } = op('file', fileInput({ findings: [], debt: [record] }), handlers)
    assert.equal(code, 0)
    assert.equal(result.issues[0].number, 9)
    assert.equal(
      renderDebt(record, { host: 'xnms' }).body,
      [debt.body, '', '- Class: deferred wording', '- Plugin: adf 0.11.0', '- Host: xnms', '', `<!-- adf: xnms/debt/${debt.id} -->`, ''].join('\n')
    )
  }
})

// ---------------------------------------------------------------- with the core

// A fake gh on PATH that can file: the probe, the labels, an empty issue list, and each created
// issue numbered from 1 in the order it is created.
const filingGh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adf-maintainer-gh-'))
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    'const argv = process.argv.slice(2)',
    'const a = argv.join(" ")',
    'if (a === "--version") { console.log("gh version 2.62.0"); process.exit(0) }',
    'if (a === "auth status") process.exit(0)',
    `if (a === "api repos/${REPO}") { console.log(JSON.stringify({ permissions: { push: true } })); process.exit(0) }`,
    `if (argv[1] === "repos/${REPO}/labels") { console.log("{}"); process.exit(0) }`,
    'if (argv[1] === "--paginate") process.exit(0)',
    `if (argv[1] === "repos/${REPO}/issues") {`,
    '  const counter = path.join(__dirname, "count")',
    '  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1',
    '  fs.writeFileSync(counter, String(n))',
    `  console.log(JSON.stringify({ number: n, html_url: "https://github.com/${REPO}/issues/" + n }))`,
    '  process.exit(0)',
    '}',
    'console.error("unexpected: " + a); process.exit(1)'
  ].join('\n')
  writeFileSync(join(dir, 'gh'), `${script}\n`)
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n')
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

test("the core's file input is accepted by the CLI, and its result reads in the core's report", { skip: process.platform === 'win32' }, async () => {
  const core = join(pluginDir, '..', 'adf', 'scripts', 'lib')
  const { upstreamFileInput } = await import(join(core, 'retro-run.mjs'))
  const { upstreamReport } = await import(join(core, 'roles.mjs'))
  // A finding as the core resolves a reply's (no version), and an ADF debt record with no
  // change and no source, as an older record in the debt tree has.
  const resolved = {
    id: 'R1',
    title: 'An implementation reported done before its review passed',
    class: 'premature-done',
    changes: ['one'],
    evidence: [{ key: 'changes.one.signals.prematureDone', value: 1 }],
    cost: { key: 'changes.one.values.cost.tokens', value: 300 },
    caughtWhere: 'the task test run',
    plugin: 'adf',
    body: 'T1 was reported done and its review sent it back.'
  }
  const record = { id: 'adf-02', title: 'The hook misses a staged rename', plugin: 'adf', pluginVersion: '0.11.0', class: 'defect', body: 'A rename staged before the hook ran is not checked.' }
  const input = upstreamFileInput({ repository: REPO, host: 'acme/host', retro: '2026-10-20-window', findings: [resolved], debt: [record] })
  const payload = JSON.stringify({ root: tmpdir(), config: {}, input })
  const { code, out } = cliRun(['file'], payload, { ...process.env, PATH: `${filingGh()}${delimiter}${process.env.PATH}` })
  assert.equal(code, 0, JSON.stringify(out))
  const url = (n) => `https://github.com/${REPO}/issues/${n}`
  assert.deepEqual(out, {
    state: 'done',
    issues: [
      { item: 'R1', kind: 'finding', number: 1, url: url(1), existed: false },
      { item: 'adf-02', kind: 'debt', number: 2, url: url(2), existed: false }
    ]
  })
  assert.equal(upstreamReport('file', { ...out, plugin: 'adf-maintainer' }), `Upstream: 2 filed, 0 already filed; finding R1 as ${url(1)}, ADF debt adf-02 as ${url(2)}`)
})
