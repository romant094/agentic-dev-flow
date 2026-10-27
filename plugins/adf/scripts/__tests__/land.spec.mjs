// land.mjs and lib/land.mjs: the hand-off after the merge, against real git repositories in temp
// directories, with fixture tracker and forge plugins enabled by path entries. No real tracker,
// no real forge and no network: each fixture answers from its registry config and records each
// call it gets. lib/tracker.mjs, the field checker and the held write, is tested here too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../land.mjs'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { landFile, mergedByAncestry, readLand } from '../lib/land.mjs'
import { initRegistry, readRegistry, setDebtRoot, writeRegistry } from '../lib/registry.mjs'
import { CORE } from '../lib/roles.mjs'
import { checkFields, FIELD_LIMITS, handoffFields } from '../lib/tracker.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The frame's `## Tools` section as sent: from its heading to the next, comment lines dropped.
const FRAME = readFileSync(join(here, '..', '..', 'schema', 'prompts', 'frame.md'), 'utf8')
const FRAME_TOOLS = FRAME.slice(FRAME.indexOf('## Tools'), FRAME.indexOf('\n## ', FRAME.indexOf('## Tools')))
  .split('\n')
  .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
  .join('\n')
  .trim()
const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const CHANGE = 'fix-pool'
const BRANCH = 'fix/PROJ-1/fix-pool'
const ARCHIVED = 'openspec/changes/archive/2026-10-19-fix-pool'
const MR = 'https://forge.example/mr/7'

// Answers each operation from config[op], else held plans and applied ones; records each call.
const TRACKER = `import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
let t = ''
process.stdin.on('data', (d) => (t += d)).on('end', () => {
  const { root, config, input } = JSON.parse(t)
  const op = process.argv[2]
  appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ plugin: 'tracker', op, input }) + '\\n')
  const out = (o) => console.log(JSON.stringify(o))
  if (config[op]) return out(config[op])
  if (op === 'check') return out({ state: 'done', tool: 'ready', account: 'dev' })
  if (!input.apply) return out({ state: 'done', held: true, plan: 'handoff-plan', preview: input.items.map((i) => i.key + ': ' + i.state) })
  return out({ state: 'done', applied: input.items.map((i) => i.key), skipped: [], failed: [] })
})
`
// Answers `state` from config.state; records each call.
const FORGE = `import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
let t = ''
process.stdin.on('data', (d) => (t += d)).on('end', () => {
  const { root, config, input } = JSON.parse(t)
  const op = process.argv[2]
  appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ plugin: 'forge', op, input }) + '\\n')
  console.log(JSON.stringify(config[op] ?? { state: 'done', tool: 'ready' }))
})
`

const CHECK = { verdict: 'current', requirements: [{ text: 'close the old socket', status: 'current', sources: [] }], bug: null, corrections: [], questions: [], checked: [{ kind: 'code', ref: 'src/pool.ts:40', finding: 'one socket per reconnect' }] }
const item = (key, over) => ({ source: 'tracker', key, title: `Issue ${key}`, kind: 'task', url: `https://tracker.example/${key}`, status: 'In Progress', open: true, parent: null, links: [], branchToken: key, branchRank: 1, excluded: null, flags: [], file: `.superpowers/sdd/${CHANGE}/tracker/${key}.json`, state: 'taken', reason: null, verdict: 'current', check: CHECK, ...over })
const SCOPE = {
  version: 1,
  change: CHANGE,
  from: { keys: ['PROJ-1', 'PROJ-2'], text: null },
  tracker: { state: 'done', plugin: 't', account: 'dev', notes: [] },
  items: [
    item('PROJ-1', { kind: 'bug', title: 'Session pool leaks on reconnect' }),
    item('PROJ-2', { state: 'partial', reason: 'the metrics only', title: 'Pool metrics' }),
    item('PROJ-3', { state: 'excluded', reason: 'Suspended', verdict: null, check: null }),
    { source: 'debt', key: 'snmp-01', title: 'Session pool leaks connections', kind: 'debt', state: 'taken', reason: null, verdict: 'current', check: CHECK, flags: [] }
  ],
  inFlight: [],
  flagsShown: [],
  base: null,
  start: { state: 'done' },
  retest: null
}

function plugin(root, name, file, declaration) {
  const dir = join(root, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify({ name, ...declaration }))
  writeFileSync(join(dir, file), name === 't' ? TRACKER : FORGE)
}

// A host whose change fix-pool was archived on its branch: the archived directory holds the
// scope; archive's state records the merge request (`forge`) or the local merge. `merged` merges
// the branch into develop; `forge` is 1.7 (state provided), 1.6 (not provided) or null.
// `tree` is the debt tree the branch carries after archive, files under debt/; with it the
// registry's debt.root is debt.
function landHost({ tracker = true, forge = null, merged = true, scope = SCOPE, forgeState = null, tree = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-land-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  initRegistry(root, CORE.coreContract)
  setBranches(root, { integration: 'develop', protected: ['main'] })
  const extensions = []
  if (tracker) {
    plugin(root, 't', 't.mjs', { contract: '1.7', provides: { tracker: { script: 't.mjs', operations: ['check', 'gather', 'start', 'handoff'] } } })
    extensions.push({ path: 'plugins/t', points: ['tracker'], config: {} })
  }
  if (forge) {
    const operations = ['check', 'open', 'push', 'finalize', ...(forge === '1.7' ? ['state'] : [])]
    plugin(root, 'f', 'f.mjs', { contract: forge, provides: { forge: { script: 'f.mjs', operations } } })
    extensions.push({ path: 'plugins/f', points: ['forge'], config: forgeState ? { state: forgeState } : {} })
  }
  writeRegistry(root, { ...readRegistry(root), extensions })
  if (tree) setDebtRoot(root, 'debt')
  ignoreLocalDirs(root)
  writeFileSync(join(root, '.gitignore'), `${readFileSync(join(root, '.gitignore'), 'utf8')}plugins/\ncalls.jsonl\n`)
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'checkout', '-q', '-b', BRANCH)
  const dir = join(root, ARCHIVED)
  mkdirSync(join(dir, 'specs', 'session-pool'), { recursive: true })
  writeFileSync(join(dir, '.adf.json'), `${JSON.stringify({ schema: 'adf', schemaVersion: 1, created: '2026-10-15', base: 'develop' })}\n`)
  writeFileSync(join(dir, 'proposal.md'), '## Why\n\nThe pool leaks.\n')
  writeFileSync(join(dir, 'tasks.md'), '- [x] 1.1 close the old socket (PROJ-1, snmp-01)\n- [x] 1.2 count the sockets (PROJ-2)\n')
  writeFileSync(join(dir, 'verify.md'), '# Verify\n\nVerdict: PASS\n')
  writeFileSync(join(dir, 'specs', 'session-pool', 'spec.md'), '## MODIFIED Requirements\n')
  if (scope) writeFileSync(join(dir, 'scope.json'), `${JSON.stringify(scope, null, 2)}\n`)
  writeFileSync(join(root, 'pool.ts'), 'close()\n')
  for (const [path, text] of Object.entries(tree ?? {})) {
    mkdirSync(dirname(join(root, 'debt', path)), { recursive: true })
    writeFileSync(join(root, 'debt', path), text)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'fix(pool): close the old socket')
  git(root, 'checkout', '-q', 'develop')
  if (scope) {
    mkdirSync(join(root, '.superpowers', 'sdd', CHANGE, 'scope'), { recursive: true })
    writeFileSync(join(root, '.superpowers', 'sdd', CHANGE, 'scope', 'scope.json'), JSON.stringify(scope))
  }
  if (merged) git(root, 'merge', '-q', '--no-ff', '--no-edit', BRANCH)
  const steps = forge
    ? { mr: { state: 'done', detail: { forge: 'f', url: MR, branch: BRANCH, base: 'develop' } }, 'merge-local': { state: 'skipped', detail: {} } }
    : { mr: { state: 'skipped', detail: { forge: 'none' } }, 'merge-local': { state: merged ? 'done' : 'skipped', detail: { branch: BRANCH, base: 'develop' } } }
  mkdirSync(join(root, '.superpowers', 'sdd', CHANGE, 'archive'), { recursive: true })
  writeFileSync(join(root, '.superpowers', 'sdd', CHANGE, 'archive', 'state.json'), JSON.stringify({ change: CHANGE, steps }))
  return root
}

const land = (root, ...args) => run([...args, '--change', CHANGE, '--root', root, ...(['check', 'wait', 'handoff'].includes(args[0]) ? ['--home', home] : [])])
const calls = (root, who) => (existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !who || c.plugin === who) : [])
const setConfig = (root, path, config) => writeRegistry(root, { ...readRegistry(root), extensions: readRegistry(root).extensions.map((e) => (e.path === path ? { ...e, config } : e)) })
const reply = (root, name, body) => {
  const file = join(root, `${name}.json`)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}
const TAKEN = { done: 'The pool closes the old socket before it opens a new one.', test: 'Reconnect three times, then count the open sockets: one is open.' }
const PARTIAL = { done: 'The pool counts its open sockets.', test: 'Open the metrics page and read the socket count.', remains: 'The gauge for idle sockets.' }
// The fields as the tracker gets them: every text field a list of one-line texts.
const lists = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]]))
const valid = (key, state, fields) => ({ role: 'land-comment', key, state, fields })
const comment = (root, key, body) => land(root, 'comment', '--key', key, '--file', reply(root, `${key}-${Math.random()}`, body))

// ---------------------------------------------------------------- the field checker

test('checkFields: the required fields per state, the word limits, and no link or URL', () => {
  assert.deepEqual(FIELD_LIMITS, { done: 80, test: 120, remains: 80, tried: 80 })
  assert.deepEqual(checkFields('taken', TAKEN), [])
  assert.deepEqual(checkFields('partial', PARTIAL), [])
  assert.deepEqual(checkFields('not-reproduced', { tried: ['reconnect 3 times', 'reconnect under load'] }), [])
  assert.deepEqual(checkFields('taken', { ...TAKEN, remains: 'x' }), ['fields.remains is only for a partial item; a taken item has nothing left'])
  assert.deepEqual(checkFields('partial', TAKEN), ['fields.remains is required for a partial item'])
  assert.deepEqual(checkFields('taken', { done: '  ', test: 3 }), ['fields.done is empty', 'fields.test must be text or a list of texts'])
  assert.deepEqual(checkFields('taken', { done: [], test: ['', ' \n '] }), ['fields.done is empty', 'fields.test is empty'])
  assert.deepEqual(checkFields('taken', { done: ['a', 2], test: 'b' }), ['fields.done must be text or a list of texts'])
  assert.deepEqual(checkFields('partial', { done: ['The pool counts.'], test: 'Open the page.\nRead the count.', remains: ['The gauge.'] }), [])
  assert.deepEqual(checkFields('taken', { done: 'x' }), ['fields.test is required for a taken item'])
  assert.deepEqual(checkFields('taken', { ...TAKEN, extra: 'x' }), ['fields.extra is not a field of a taken item; its fields: done, test'])
  const words = (n) => Array.from({ length: n }, () => 'word').join(' ')
  assert.deepEqual(checkFields('taken', { done: words(80), test: words(120) }), [])
  assert.deepEqual(checkFields('taken', { done: words(81), test: words(121) }), ['fields.done has 81 words; the limit is 80', 'fields.test has 121 words; the limit is 120'])
  assert.deepEqual(checkFields('not-reproduced', { tried: [words(40), words(41)] }, { prefix: 'bug' }), ['bug.tried has 81 words; the limit is 80'])
  assert.deepEqual(checkFields('taken', { done: [words(40), words(40)], test: `${words(60)}\n${words(61)}` }), ['fields.test has 121 words; the limit is 120'], 'a limit counts every line')
  assert.deepEqual(checkFields('taken', { ...TAKEN, test: ['Open the page.', 'see www.example.com'] }), ['fields.test holds a link or URL ("www.example.com"); write plain text: the provider adds the merge request link itself'])
  for (const [text, link] of [['see https://x.example/a', 'https://x.example/a'], ['at http://x', 'http://x'], ['on www.example.com', 'www.example.com'], ['the [merge request](mr)', '[merge request](mr)'], ['ssh://host/repo', 'ssh://host/repo']]) {
    assert.deepEqual(checkFields('taken', { ...TAKEN, done: text }), [`fields.done holds a link or URL ("${link}"); write plain text: the provider adds the merge request link itself`], text)
  }
  assert.deepEqual(checkFields('closed', {}), ['closed is not a hand-off state; one of taken, partial, not-reproduced'])
})

test('handoffFields: every text field a list of one-line texts, trimmed, with no empty line; the commit as it is', () => {
  assert.deepEqual(handoffFields({ done: 'One line.', test: '  Open the page.\r\n\n  Read the count.  \n' }), { done: ['One line.'], test: ['Open the page.', 'Read the count.'] })
  assert.deepEqual(handoffFields({ done: ['First.', 'Second\nThird.', '  '], test: ['Step.'], remains: 'Left.' }), { done: ['First.', 'Second', 'Third.'], test: ['Step.'], remains: ['Left.'] })
  assert.deepEqual(handoffFields({ tried: ['reconnect 3 times'], commit: 'abc1234' }), { tried: ['reconnect 3 times'], commit: 'abc1234' })
  assert.deepEqual(handoffFields({ test: '1. Open the page.\n2) Read the count.\n- Close it.\n* Done.\n3.5 is a value.' }), { test: ['Open the page.', 'Read the count.', 'Close it.', 'Done.', '3.5 is a value.'] })
})

test('the reply schema uses only the keywords the validator implements', async () => {
  const { readSchema, unknownKeywords } = await import('../lib/json-schema.mjs')
  assert.deepEqual(unknownKeywords(readSchema(join(here, '..', '..', 'schema', 'land-comment.schema.json'))), [])
})

// ---------------------------------------------------------------- skipped

test('land is skipped with no tracker plugin, a skipped tracker, no tracker issue or no scope, and every later step says so', () => {
  const root = landHost({ tracker: false })
  const check = land(root, 'check')
  assert.deepEqual([check.ok, check.state, check.report], [true, 'skipped', 'Tracker check: none; no tracker plugin is enabled; the tracker step was skipped.'])
  for (const step of ['wait', 'comment-input', 'handoff']) {
    const out = land(root, step)
    assert.deepEqual([out.ok, out.state, out.detail.report], [true, 'skipped', check.report], step)
  }
  assert.equal(land(root, 'comment', '--key', 'PROJ-1', '--file', join(root, 'none.json')).state, 'skipped')
  const report = land(root, 'report')
  assert.deepEqual([report.complete, report.skipped, report.next], [true, true, null])
  assert.match(report.report, /^## Land skipped: fix-pool/)
  assert.equal(calls(root).length, 0, 'no plugin was called')

  const skippedTracker = landHost({ scope: { ...SCOPE, tracker: { state: 'skipped', reason: 'Jira is down', notes: [] }, items: SCOPE.items.filter((i) => i.source === 'debt') } })
  assert.equal(land(skippedTracker, 'check').report, 'Land: the tracker was skipped for this change (Jira is down); nothing is handed off.')
  const debtOnly = landHost({ scope: { ...SCOPE, items: SCOPE.items.filter((i) => i.source === 'debt' || i.state === 'excluded') } })
  assert.equal(land(debtOnly, 'check').report, 'Land: no tracker issue is taken or partial, and no debt the change took is tracked; nothing is handed off.')
  const noScope = landHost({ scope: null })
  assert.equal(land(noScope, 'check').report, 'Land: fix-pool has no scope; there is no tracker issue to hand off.')
  assert.equal(calls(debtOnly).length + calls(noScope).length + calls(skippedTracker).length, 0)
})

// ---------------------------------------------------------------- no forge: the whole land

test('with no forge, git ancestry decides merged; each step resumes; a partial issue keeps its state; the hand-off has no merge request link', () => {
  const root = landHost({ merged: false })
  assert.throws(() => land(root, 'wait'), /wait waits for check/)
  const check = land(root, 'check')
  assert.equal(check.state, 'done')
  assert.equal(check.detail.scopeFile, '.superpowers/sdd/fix-pool/scope/scope.json', 'before the merge the main checkout holds only the scope state')
  assert.deepEqual(check.detail.items.map((i) => `${i.key}:${i.state}`), ['PROJ-1:taken', 'PROJ-2:partial'])
  assert.equal(land(root, 'check').already, true)

  const waiting = land(root, 'wait')
  assert.deepEqual([waiting.ok, waiting.state, waiting.next], [true, 'waiting', 'wait'])
  assert.match(waiting.report, /^Merge request: none; no forge plugin is enabled, so nothing was pushed and no merge request exists\.\nNot merged: fix\/PROJ-1\/fix-pool is in none of develop, decided from git ancestry\.$/)
  assert.throws(() => land(root, 'comment-input'), /comment-input waits for wait/)
  assert.match(land(root, 'report').report, /Next: land\.mjs wait --change fix-pool, once the merge request is merged\./)

  git(root, 'merge', '-q', '--no-ff', '--no-edit', BRANCH)
  const merge = git(root, 'rev-parse', 'HEAD')
  const merged = land(root, 'wait')
  assert.deepEqual([merged.state, merged.detail.via, merged.detail.ref, merged.detail.mergeCommit, merged.detail.url], ['done', 'ancestry', 'develop', merge, null])
  assert.match(merged.detail.mergedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(land(root, 'wait').already, true)
  assert.equal(calls(root, 'forge').length, 0)

  const input = land(root, 'comment-input')
  assert.deepEqual(input.dispatches.map((d) => [d.name, d.state, d.agent]), [['land-comment PROJ-1', 'taken', 'adf:integration'], ['land-comment PROJ-2', 'partial', 'adf:integration']])
  const one = JSON.parse(readFileSync(input.dispatches[1].inputFile, 'utf8'))
  assert.deepEqual([one.key, one.state, one.fields, one.limits, one.merge.mergeCommit], ['PROJ-2', 'partial', ['done', 'test', 'remains'], { done: 80, test: 120, remains: 80 }, merge])
  assert.equal(one.artifacts.proposal, join(root, ARCHIVED, 'proposal.md'), 'after the merge the archived change is read')
  assert.deepEqual(one.artifacts.specs, [join(root, ARCHIVED, 'specs', 'session-pool', 'spec.md')])
  assert.deepEqual(one.check, CHECK)
  const prompt = readFileSync(input.dispatches[0].promptFile, 'utf8')
  assert.ok(prompt.startsWith('You are dispatched as `land-comment PROJ-1`, at the integration capability level'), prompt)
  assert.ok(!prompt.includes('{{') && !prompt.includes('<!--'))
  assert.ok(prompt.includes(FRAME_TOOLS), 'the frame\'s Tools rule, verbatim')
  assert.equal(land(root, 'comment-input').already, true)

  const first = comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  assert.deepEqual([first.ok, first.state, first.missing], [true, 'pending', ['PROJ-2']])
  assert.throws(() => land(root, 'handoff'), /none recorded for PROJ-2/)
  assert.match(land(root, 'report').report, /- comment: pending — fields recorded for PROJ-1; missing PROJ-2/)
  const second = comment(root, 'PROJ-2', valid('PROJ-2', 'partial', PARTIAL))
  assert.deepEqual([second.state, second.missing, second.next], ['done', [], 'handoff'])
  assert.equal(comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN)).already, true)

  assert.throws(() => land(root, 'handoff', '--yes'), /no held handoff plan to apply; run land\.mjs handoff --change fix-pool without --yes first/)
  const held = land(root, 'handoff')
  assert.deepEqual([held.ok, held.state, held.plan, held.preview, held.mr], [true, 'pending', 'handoff-plan', ['PROJ-1: taken', 'PROJ-2: partial'], null])
  assert.equal(held.waiting, "the developer's yes: land.mjs handoff --change fix-pool --yes")
  const sent = calls(root, 'tracker').at(-1)
  assert.deepEqual([sent.op, sent.input.items, sent.input.mr, sent.input.change, sent.input.apply], ['handoff', [{ key: 'PROJ-1', state: 'taken', fields: lists(TAKEN) }, { key: 'PROJ-2', state: 'partial', fields: lists(PARTIAL) }], null, CHANGE, undefined])
  assert.equal(sent.input.stateDir, join(root, '.superpowers', 'sdd', CHANGE, 'tracker'))
  assert.match(land(root, 'report').report, /Next: the developer's yes: land\.mjs handoff --change fix-pool --yes\./)
  const applied = land(root, 'handoff', '--yes')
  assert.deepEqual([applied.ok, applied.state, applied.applied], [true, 'done', ['PROJ-1', 'PROJ-2']])
  assert.equal(calls(root, 'tracker').at(-1).input.apply, 'handoff-plan')
  assert.equal(land(root, 'handoff').already, true)
  assert.throws(() => comment(root, 'PROJ-1', valid('PROJ-1', 'taken', { ...TAKEN, done: 'Other words.' })), /hand-off of fix-pool is applied/)

  const report = land(root, 'report')
  assert.deepEqual([report.complete, report.next, report.done], [true, null, ['check', 'wait', 'comment-input', 'comment', 'handoff']])
  assert.match(report.report, /^## Land complete: fix-pool/)
  const saved = readLand(root, CHANGE)
  assert.equal(landFile(root, CHANGE), join(root, '.superpowers', 'sdd', CHANGE, 'land', 'land.json'))
  assert.deepEqual(Object.keys(saved.steps), ['check', 'wait', 'comment-input', 'comment', 'handoff'])
  assert.deepEqual(saved.steps.comment.detail.keys['PROJ-2'].fields, PARTIAL)
})

test('mergedByAncestry: a fast-forward is merged at the tip, origin/<base> counts, and a missing branch refuses', () => {
  const root = landHost({ merged: false })
  git(root, 'update-ref', 'refs/remotes/origin/develop', BRANCH)
  const by = mergedByAncestry(root, { branch: BRANCH, base: 'develop' })
  assert.deepEqual([by.merged, by.ref, by.mergeCommit], [true, 'origin/develop', git(root, 'rev-parse', BRANCH)])
  assert.throws(() => mergedByAncestry(root, { branch: 'feat/gone', base: 'develop' }), /the branch feat\/gone is not in/)
})

// ---------------------------------------------------------------- with a forge

test('with a forge: open and draft wait, closed stops land, merged passes the merge request link to the hand-off', () => {
  const root = landHost({ forge: '1.7', forgeState: { state: 'done', number: 7, url: MR, status: 'open' } })
  land(root, 'check')
  const open = land(root, 'wait')
  assert.deepEqual([open.ok, open.state, open.report], [true, 'waiting', `Merge request: ${MR} (open)`])
  assert.match(open.waiting, /the merge request is open: once it is merged, run land\.mjs wait --change fix-pool again/)
  assert.deepEqual(calls(root, 'forge').at(-1).input, { change: CHANGE, branch: BRANCH, base: 'develop', url: MR })
  setConfig(root, 'plugins/f', { state: { state: 'done', number: 7, url: MR, status: 'closed' } })
  const closed = land(root, 'wait')
  assert.deepEqual([closed.ok, closed.state], [false, 'closed'])
  assert.equal(closed.refusal, `the merge request ${MR} was closed without a merge; land stops and hands nothing off`)
  assert.throws(() => land(root, 'comment-input'), /comment-input waits for wait/)
  const stopped = land(root, 'report')
  assert.deepEqual([stopped.complete, stopped.stopped], [false, true])
  assert.match(stopped.report, /Stopped: the merge request was closed without a merge; nothing was handed off\./)
  setConfig(root, 'plugins/f', { state: { state: 'done', number: 7, url: MR, status: 'merged', mergedAt: '2026-10-20T10:00:00Z', mergeCommit: 'abcdef1234567' } })
  const merged = land(root, 'wait')
  assert.deepEqual([merged.state, merged.detail.via, merged.detail.mergeCommit, merged.report], ['done', 'forge', 'abcdef1234567', `Merge request: ${MR} (merged at 2026-10-20T10:00:00Z, commit abcdef1)`])
  land(root, 'comment-input')
  comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  comment(root, 'PROJ-2', valid('PROJ-2', 'partial', PARTIAL))
  assert.deepEqual(land(root, 'handoff').mr, { url: MR })
  assert.deepEqual(calls(root, 'tracker').at(-1).input.mr, { url: MR })
})

test('a forge that does not provide state falls back to git ancestry and keeps the link archive recorded; a degraded forge waits', () => {
  const root = landHost({ forge: '1.6' })
  land(root, 'check')
  const merged = land(root, 'wait')
  assert.deepEqual([merged.state, merged.detail.via, merged.detail.forge, merged.detail.url], ['done', 'ancestry', 'f', MR])
  assert.match(merged.report, /^Merge request: none; f does not provide state, so the step's default applies\.\nMerged: /)
  const degraded = landHost({ forge: '1.7', forgeState: { state: 'degraded', tool: 'unauthenticated', hint: 'run glab auth login' } })
  land(degraded, 'check')
  const out = land(degraded, 'wait')
  assert.deepEqual([out.ok, out.state, out.hint, out.next], [true, 'degraded', 'run glab auth login', 'wait'])
})

// ---------------------------------------------------------------- the comment's checks

test('comment refuses a reply out of its rules, records nothing, and a changed field drops a held plan', () => {
  const root = landHost()
  for (const step of ['check', 'wait', 'comment-input']) land(root, step)
  const refused = (key, body) => {
    const out = comment(root, key, body)
    assert.deepEqual([out.ok, out.valid], [false, false])
    assert.match(out.next, /^retry/)
    return out.errors
  }
  assert.match(refused('PROJ-1', 'not json').join('\n'), /^not JSON: /)
  assert.deepEqual(refused('PROJ-1', valid('PROJ-9', 'taken', TAKEN)), ['key is PROJ-9, but this dispatch writes PROJ-1'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', 'taken', TAKEN)), ['state is taken, but PROJ-2 is partial in the scope', 'fields.remains is required for a partial item'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', 'taken', { ...TAKEN, remains: 'more' })), ['fields.remains is only for a partial item; a taken item has nothing left'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', 'taken', { ...TAKEN, test: `See ${MR}.` })), [`fields.test holds a link or URL ("${MR}."); write plain text: the provider adds the merge request link itself`])
  assert.ok(refused('PROJ-1', valid('PROJ-1', 'taken', { done: '' })).includes('$.fields: test is required'))
  assert.throws(() => comment(root, 'PROJ-3', valid('PROJ-3', 'taken', TAKEN)), /PROJ-3 is not a taken or partial tracker issue/)
  assert.throws(() => comment(root, 'snmp-01', valid('snmp-01', 'taken', TAKEN)), /snmp-01 is not a taken or partial tracker issue/)
  assert.equal(readLand(root, CHANGE).steps.comment.state, 'pending', 'nothing recorded')

  comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  comment(root, 'PROJ-2', valid('PROJ-2', 'partial', PARTIAL))
  assert.equal(land(root, 'handoff').state, 'pending')
  const changed = comment(root, 'PROJ-1', `\`\`\`json\n${JSON.stringify(valid('PROJ-1', 'taken', { ...TAKEN, done: 'The pool closes every stale socket.' }))}\n\`\`\``)
  assert.deepEqual([changed.ok, changed.state], [true, 'done'])
  assert.match(changed.report, /the held plan handoff-plan carried other fields of PROJ-1 and was dropped/)
  assert.equal(readLand(root, CHANGE).steps.handoff.state, 'pending')
  assert.throws(() => land(root, 'handoff', '--yes'), /no held handoff plan to apply/)
  assert.equal(readLand(root, CHANGE).steps.comment.detail.keys['PROJ-1'].fenced, true)
})

test('a tracker that refuses the hand-off records it, and a rerun without --yes builds a new plan', () => {
  const root = landHost()
  for (const step of ['check', 'wait', 'comment-input']) land(root, step)
  comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  comment(root, 'PROJ-2', valid('PROJ-2', 'partial', PARTIAL))
  setConfig(root, 'plugins/t', { handoff: { state: 'refused', error: 'PROJ-2 is outside the allowlist' } })
  const out = land(root, 'handoff')
  assert.deepEqual([out.ok, out.state, out.error, out.next], [false, 'refused', 'PROJ-2 is outside the allowlist', 'run land.mjs handoff --change fix-pool without --yes to build a new plan'])
  setConfig(root, 'plugins/t', {})
  assert.equal(land(root, 'handoff').state, 'pending')
})

// ---------------------------------------------------------------- debt groups

const debtItem = (key, tracker, state = 'taken') => ({ source: 'debt', key, title: `Entry ${key}`, kind: 'debt', class: 'debt', block: 'snmp', anchors: [`${key}.ts`], tracker, matched: 'key', files: ['debt/snmp/index.md'], state, reason: state === 'partial' ? 'one site only' : null, verdict: 'current', check: CHECK, flags: [] })
const DEBT_ROOT = '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`snmp`](snmp/index.md) | SNMP |\n'
const debtResolved = (rows) => `# Resolved debt of \`snmp\`\n\n| ID | Title | Anchors | Class | Tracker | Resolved by | Date |\n|---|---|---|---|---|---|---|\n${rows.map(([id, key]) => `| \`${id}\` | Entry ${id} | \`${id}.ts\` | debt | ${key} | \`${ARCHIVED}\` | 2026-10-19 |`).join('\n')}\n`
const debtIndex = (rows) => `# SNMP\n\nLast id: \`snmp-06\`\n\n| ID | Title | Anchors | Class | Source | Tracker |\n|---|---|---|---|---|---|\n${rows.map(([id, key]) => `| \`${id}\` | Entry ${id} | \`${id}.ts\` | debt | s | ${key ?? ''} |`).join('\n')}\n`

test('a tracked debt group takes part in land: taken when archive resolved every entry holding its key, partial while some remain', () => {
  // PROJ-7 mirrors snmp-01 and snmp-02, both taken and moved to resolved.md at archive; PROJ-8
  // mirrors snmp-03 (taken, resolved), snmp-04 (partial, kept) and snmp-05 (outside the scope).
  // The resolved rows still hold their keys, and are never remaining entries.
  const scope = { ...SCOPE, items: [SCOPE.items[0], debtItem('snmp-01', 'PROJ-7'), debtItem('snmp-02', 'PROJ-7'), debtItem('snmp-03', 'PROJ-8'), debtItem('snmp-04', 'PROJ-8', 'partial'), debtItem('snmp-06', null)] }
  const tree = { 'index.md': DEBT_ROOT, 'snmp/index.md': debtIndex([['snmp-04', 'PROJ-8'], ['snmp-05', 'PROJ-8'], ['snmp-06', null]]), 'snmp/resolved.md': debtResolved([['snmp-01', 'PROJ-7'], ['snmp-02', 'PROJ-7'], ['snmp-03', 'PROJ-8']]) }
  const root = landHost({ scope, tree })
  const check = land(root, 'check')
  assert.equal(check.state, 'done')
  assert.deepEqual(check.detail.items.map((i) => [i.key, i.state, i.entries ?? null]), [['PROJ-1', 'taken', null], ['PROJ-7', null, ['snmp-01', 'snmp-02']], ['PROJ-8', null, ['snmp-03', 'snmp-04']]])
  assert.match(land(root, 'report').report, /PROJ-7 \(debt snmp-01, snmp-02\), PROJ-8 \(debt snmp-03, snmp-04\)/)
  land(root, 'wait')
  const input = land(root, 'comment-input')
  assert.deepEqual(input.dispatches.map((d) => [d.name, d.state]), [['land-comment PROJ-1', 'taken'], ['land-comment PROJ-7', 'taken'], ['land-comment PROJ-8', 'partial']])
  const taken = JSON.parse(readFileSync(input.dispatches[1].inputFile, 'utf8'))
  assert.deepEqual([taken.kind, taken.issueFile, taken.check, taken.fields], ['debt', null, null, ['done', 'test']])
  assert.deepEqual(taken.debt, {
    resolved: [{ id: 'snmp-01', title: 'Entry snmp-01', class: 'debt', anchors: ['snmp-01.ts'] }, { id: 'snmp-02', title: 'Entry snmp-02', class: 'debt', anchors: ['snmp-02.ts'] }],
    remaining: []
  })
  const partial = JSON.parse(readFileSync(input.dispatches[2].inputFile, 'utf8'))
  assert.deepEqual(partial.fields, ['done', 'test', 'remains'])
  assert.deepEqual(partial.debt.resolved.map((e) => e.id), ['snmp-03'])
  assert.deepEqual(partial.debt.remaining.map((e) => [e.id, e.scope]), [['snmp-04', 'partial'], ['snmp-05', null]])
  assert.match(land(root, 'report').report, /3 land-comment input\(s\); debt groups PROJ-7 \(taken\), PROJ-8 \(partial\)/)

  assert.deepEqual(comment(root, 'PROJ-8', valid('PROJ-8', 'taken', TAKEN)).errors, ['state is taken, but PROJ-8 is partial in the scope', 'fields.remains is required for a partial item'])
  comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  comment(root, 'PROJ-7', valid('PROJ-7', 'taken', TAKEN))
  assert.deepEqual(comment(root, 'PROJ-8', valid('PROJ-8', 'partial', PARTIAL)).missing, [])
  const held = land(root, 'handoff')
  assert.deepEqual(held.preview, ['PROJ-1: taken', 'PROJ-7: taken', 'PROJ-8: partial'])
  assert.deepEqual(calls(root, 'tracker').at(-1).input.items, [{ key: 'PROJ-1', state: 'taken', fields: lists(TAKEN) }, { key: 'PROJ-7', state: 'taken', fields: lists(TAKEN) }, { key: 'PROJ-8', state: 'partial', fields: lists(PARTIAL) }])
  assert.deepEqual(land(root, 'handoff', '--yes').applied, ['PROJ-1', 'PROJ-7', 'PROJ-8'])

  const debtOnly = landHost({ scope: { ...SCOPE, items: [debtItem('snmp-01', 'PROJ-7')] }, tree: { 'index.md': DEBT_ROOT, 'snmp/index.md': debtIndex([['snmp-06', null]]) } })
  assert.equal(land(debtOnly, 'check').state, 'done', 'a tracked debt group alone is handed off')
})

test('a debt key that is also a tracker item of the scope is handed off once, by the tracker item', () => {
  const scope = { ...SCOPE, items: [SCOPE.items[0], SCOPE.items[2], debtItem('snmp-01', 'PROJ-1'), debtItem('snmp-02', 'PROJ-3')] }
  const root = landHost({ scope, tree: { 'index.md': DEBT_ROOT, 'snmp/index.md': debtIndex([['snmp-06', null]]) } })
  assert.deepEqual(land(root, 'check').detail.items.map((i) => i.key), ['PROJ-1'], 'PROJ-3 is an excluded tracker item, and so not a debt group either')
  land(root, 'wait')
  assert.deepEqual(land(root, 'comment-input').dispatches.map((d) => d.key), ['PROJ-1'])
  comment(root, 'PROJ-1', valid('PROJ-1', 'taken', TAKEN))
  land(root, 'handoff')
  assert.deepEqual(calls(root, 'tracker').at(-1).input.items.map((i) => i.key), ['PROJ-1'])
})

// ---------------------------------------------------------------- the CLI

test('the CLI prints one JSON result: exit 1 on a refusal, exit 2 on a usage error', () => {
  const root = landHost({ tracker: false })
  const cli = (...args) => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [join(here, '..', 'land.mjs'), ...args, '--root', root], { encoding: 'utf8' })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }
  assert.equal(cli('frobnicate', '--change', CHANGE).code, 2)
  assert.equal(cli('report', '--change', CHANGE, '--yes').code, 2)
  assert.equal(cli('report').code, 2)
  assert.equal(cli('comment', '--change', CHANGE, '--key', 'PROJ-1').code, 2)
  const early = cli('wait', '--change', CHANGE, '--home', home)
  assert.deepEqual([early.code, early.out.ok], [1, false])
  assert.match(early.out.error, /wait waits for check/)
  const ok = cli('check', '--change', CHANGE, '--home', home)
  assert.deepEqual([ok.code, ok.out.state], [0, 'skipped'])
})
