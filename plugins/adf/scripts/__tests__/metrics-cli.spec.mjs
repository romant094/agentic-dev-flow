// scripts/metrics.mjs: each command through the CLI (one JSON object, exit 0 / 1 refused / 2
// usage) or through run() with a fake fetch, in temporary hosts; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromV1, validateRecord } from '../lib/metrics.mjs'
import { readRegistry, writeRegistry } from '../lib/registry.mjs'
import { DEFAULT_PRICES_URL } from '../lib/transcripts.mjs'
import { run } from '../metrics.mjs'
import { host } from './git-host.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'metrics.mjs')
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const call = (cwd, ...args) => {
  const out = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  return { code: out.status, json: JSON.parse(out.stdout) }
}

const page = (input) => `| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---|---|---|---|---|
| Claude Opus 5.5 | $${input} / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
`
const fakeFetch = (body, seen = []) => async (url) => {
  seen.push(url)
  return { ok: true, status: 200, text: async () => body }
}

test('extract writes a valid record into the change directory', () => {
  const h = host()
  const projects = tmp('adf-metrics-cli-projects-')
  const { code, json } = call(h.change, 'extract', '--change', 'add-x', '--projects', projects)
  assert.equal(code, 0, JSON.stringify(json))
  assert.equal(json.file, 'openspec/changes/add-x/metrics.json')
  assert.match(json.coverage.tokens, /^transcripts: /)
  assert.equal(json.coverage.timing, 'record')
  const record = JSON.parse(readFileSync(join(h.dir, 'metrics.json'), 'utf8'))
  assert.deepEqual(validateRecord(record), [])

  const out = join(h.change, 'elsewhere', 'm.json')
  assert.equal(call(h.change, 'extract', '--change', 'add-x', '--projects', projects, '--out', out).code, 0)
  assert.ok(existsSync(out))
})

test('extract refuses a change with no directory, and a record that fails its schema', () => {
  const h = host()
  const missing = call(h.change, 'extract', '--change', 'no-such')
  assert.equal(missing.code, 1)
  assert.match(missing.json.error, /no change "no-such"/)
  const invalid = call(h.change, 'extract', '--change', 'Bad_Name', '--out', join(h.change, 'x.json'), '--projects', tmp('adf-metrics-cli-projects-'))
  assert.equal(invalid.code, 1)
  assert.ok(invalid.json.errors.some((e) => e.startsWith('$.change')))
  assert.ok(!existsSync(join(h.change, 'x.json')), 'nothing is written')
})

test('usage errors exit 2', () => {
  const cwd = tmp('adf-metrics-cli-')
  for (const args of [[], ['nonsense'], ['extract'], ['render'], ['cost'], ['prices'], ['prices', 'fetch', '--file', 'x'], ['candidates', '--change', 'x'], ['render', '--file']]) {
    const { code, json } = call(cwd, ...args)
    assert.equal(code, 2, args.join(' '))
    assert.equal(json.ok, false)
  }
})

const v1 = (findings) => ({
  schemaVersion: 1,
  change: 'old',
  branch: 'feat/old',
  generatedAt: '2026-10-01T10:00:00.000Z',
  sessions: [],
  cost: { total: {} },
  facts: { rows: [], dispatches: [] },
  ledger: { dispatches: {}, deviations: {} },
  compliance: [],
  maintainability: {},
  findings
})

test('render gives Markdown for either schema version; an unreadable file is refused', () => {
  const cwd = tmp('adf-metrics-cli-')
  writeFileSync(join(cwd, 'old.json'), JSON.stringify(v1({ sweep: { dispatches: 1, findings: 0 } })))
  const { code, json } = call(cwd, 'render', '--file', 'old.json')
  assert.equal(code, 0)
  assert.match(json.markdown, /^# Metrics: old\n/)
  assert.match(json.markdown, /\| sweep \| 1 \| 0 \|/)
  assert.match(json.markdown, /Not measured: v1: no session of the record resolved/)
  assert.equal(call(cwd, 'render', '--file', 'missing.json').code, 1)
})

test('candidates reads every archived record, converting v1 and skipping a broken one', () => {
  const cwd = tmp('adf-metrics-cli-')
  const archive = join(cwd, 'openspec', 'changes', 'archive')
  const put = (name, record) => {
    mkdirSync(join(archive, name), { recursive: true })
    writeFileSync(join(archive, name, 'metrics.json'), typeof record === 'string' ? record : JSON.stringify(record))
  }
  for (const [i, day] of ['01', '02', '03'].entries()) put(`2026-10-${day}-c${i}`, { ...v1({ sweep: { dispatches: 1, findings: 0 }, review: { dispatches: 1, findings: i } }), change: `c${i}`, generatedAt: `2026-10-${day}T10:00:00.000Z` })
  put('2026-10-04-broken', '{ not json')
  put('2026-10-05-wrong', JSON.stringify({ schemaVersion: 2, change: 'wrong' }))
  const { code, json } = call(cwd, 'candidates')
  assert.equal(code, 0)
  assert.equal(json.records, 3)
  assert.deepEqual(json.layers, ['sweep'])
  assert.deepEqual(
    json.skipped.map((s) => s.file),
    ['openspec/changes/archive/2026-10-04-broken/metrics.json', 'openspec/changes/archive/2026-10-05-wrong/metrics.json']
  )
})

test('cost prices a record with the host price table, unpriced without one', () => {
  const cwd = tmp('adf-metrics-cli-')
  const million = { input: 0, output: 1e6, thinking: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  writeFileSync(join(cwd, 'r.json'), JSON.stringify({ schemaVersion: 2, tokens: { byModelDay: { 'claude-opus-5-5': { '2026-10-02': million } } } }))
  const none = call(cwd, 'cost', '--file', 'r.json')
  assert.equal(none.code, 0)
  assert.equal(none.json.usd, null)
  assert.equal(none.json.unpriced.length, 1)
  mkdirSync(join(cwd, '.adf', 'prices'), { recursive: true })
  writeFileSync(join(cwd, '.adf', 'prices', '2026-10-01.json'), JSON.stringify({ from: '2026-10-01', source: 'x', models: { 'Claude Opus 5.5': { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 } } }))
  const priced = call(cwd, 'cost', '--file', 'r.json')
  assert.equal(priced.json.usd, 25)
  assert.deepEqual(priced.json.entries, ['2026-10-01'])
  // A v1 record is priced too, on its own day.
  writeFileSync(join(cwd, 'old.json'), JSON.stringify({ ...v1({}), sessions: [{ id: 's', resolved: true, source: 'both', scope: 'branch', window: null }], cost: { total: { output: 1e6, turns: 1 }, byModel: { 'claude-opus-5-5': { output: 1e6, turns: 1 } } } }))
  assert.deepEqual(validateRecord(fromV1(JSON.parse(readFileSync(join(cwd, 'old.json'), 'utf8')))), [])
  assert.equal(call(cwd, 'cost', '--file', 'old.json').json.usd, 25)
})

test('prices fetch writes an entry when the prices changed, from the registry url or the default', async () => {
  const h = host()
  const seen = []
  const first = await run(['prices', 'fetch'], { cwd: h.change, fetch: fakeFetch(page(5), seen), now: () => new Date('2026-10-01T09:00:00Z') })
  assert.equal(first.ok, true)
  assert.equal(first.state, 'written')
  assert.equal(first.path, '.adf/prices/2026-10-01.json')
  assert.deepEqual(seen, [DEFAULT_PRICES_URL])
  const same = await run(['prices', 'fetch'], { cwd: h.change, fetch: fakeFetch(page(5)), now: () => new Date('2026-10-02T09:00:00Z') })
  assert.equal(same.state, 'unchanged')

  writeRegistry(h.change, { ...readRegistry(h.change), metrics: { pricesUrl: 'https://prices.example/p.md' } })
  const moved = await run(['prices', 'fetch'], { cwd: h.change, fetch: fakeFetch(page(6), seen), now: () => new Date('2026-10-03T09:00:00Z') })
  assert.equal(moved.state, 'written')
  assert.equal(seen.at(-1), 'https://prices.example/p.md')
  const flag = await run(['prices', 'fetch', '--url', 'https://flag.example/p.md'], { cwd: h.change, fetch: fakeFetch(page(6), seen) })
  assert.equal(flag.state, 'unchanged')
  assert.equal(seen.at(-1), 'https://flag.example/p.md')
})

test('prices fetch that fails with no entry is refused; with an entry it keeps the last', () => {
  const cwd = tmp('adf-metrics-cli-')
  const failed = call(cwd, 'prices', 'fetch', '--url', 'http://127.0.0.1:9/pricing.md')
  assert.equal(failed.code, 1)
  assert.equal(failed.json.state, 'none')
  mkdirSync(join(cwd, '.adf', 'prices'), { recursive: true })
  writeFileSync(join(cwd, '.adf', 'prices', '2026-10-01.json'), JSON.stringify({ from: '2026-10-01', source: 'x', models: { 'Claude Opus 5.5': {} } }))
  const stale = call(cwd, 'prices', 'fetch', '--url', 'http://127.0.0.1:9/pricing.md')
  assert.equal(stale.code, 0)
  assert.equal(stale.json.state, 'stale')
  assert.equal(stale.json.last, '2026-10-01')
})
