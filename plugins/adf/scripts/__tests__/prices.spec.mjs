// prices.mjs against a temporary host root and a fake fetch: no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  costOf,
  fetchEntry,
  modelKey,
  parsePriceTable,
  PRICES_DIR,
  priceAt,
  readTable,
  serializeEntry,
  updateTable
} from '../lib/prices.mjs'

const URL = 'https://example.test/pricing.md'

const page = (opusInput) => `# Pricing

| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
|---|---|---|---|---|---|
| Claude Opus 5.5 | $${opusInput} / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Haiku 4.5<sup>1</sup> | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Sonnet 3.7 ([deprecated](/x)) | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Mystery 1 | $3 / MTok | n/a | $6 / MTok | $0.30 / MTok | $15 / MTok |

Other text.
`

const fakeFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })
const failingFetch = async () => {
  throw new Error('getaddrinfo ENOTFOUND')
}
const at = (iso) => () => new Date(iso)

function host() {
  const root = mkdtempSync(join(tmpdir(), 'adf-prices-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}
const files = (root) => {
  try {
    return readdirSync(join(root, PRICES_DIR)).sort()
  } catch {
    return []
  }
}

test('parsePriceTable keeps fully priced rows and strips footnotes and notes', () => {
  const models = parsePriceTable(page(4))
  assert.deepEqual(Object.keys(models).sort(), ['Claude Haiku 4.5', 'Claude Opus 5.5', 'Claude Sonnet 3.7'])
  assert.deepEqual(models['Claude Opus 5.5'], { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 })
  assert.deepEqual(parsePriceTable('no table here'), {})
})

test('modelKey matches transcript model ids to table names', () => {
  const cases = [
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-opus-5-5[1m]', 'Claude Opus 5.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5'],
    ['claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7'],
    ['us.anthropic.claude-opus-5-5-20260101-v1:0', 'Claude Opus 5.5'],
    ['claude-opus-4-1@20250805', 'Claude Opus 4.1'],
    ['claude-sonnet-4', 'Claude Sonnet 4']
  ]
  for (const [id, name] of cases) assert.equal(modelKey(id), modelKey(name), `${id} vs ${name}`)
  assert.equal(modelKey('claude-opus-5-5'), 'opus 5.5')
  assert.notEqual(modelKey('claude-opus-4-5'), modelKey('Claude Opus 4.1'))
  assert.notEqual(modelKey('<synthetic>'), modelKey('Claude Opus 5.5'))
  assert.equal(modelKey(''), null)
  assert.equal(modelKey(null), null)
})

test('a first fetch writes an entry; an unchanged page writes nothing', async () => {
  const h = host()
  try {
    const first = await updateTable(h.root, { url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-01T09:00:00Z') })
    assert.deepEqual(first, { state: 'written', path: join(PRICES_DIR, '2026-10-01.json'), from: '2026-10-01' })
    const entry = JSON.parse(readFileSync(join(h.root, first.path), 'utf8'))
    assert.deepEqual(Object.keys(entry), ['from', 'models', 'source'])
    assert.equal(entry.source, URL)

    const again = await updateTable(h.root, { url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-05T09:00:00Z') })
    assert.deepEqual(again, { state: 'unchanged', from: '2026-10-01' })
    assert.deepEqual(files(h.root), ['2026-10-01.json'])
  } finally {
    h.done()
  }
})

test('a change of prices adds an entry, and each response takes the one in force', async () => {
  const h = host()
  try {
    await updateTable(h.root, { url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-01T09:00:00Z') })
    const changed = await updateTable(h.root, { url: URL, fetch: fakeFetch(page(6)), now: at('2026-10-10T09:00:00Z') })
    assert.equal(changed.state, 'written')
    assert.equal(changed.from, '2026-10-10')
    assert.deepEqual(files(h.root), ['2026-10-01.json', '2026-10-10.json'])

    const table = readTable(h.root)
    assert.deepEqual(
      table.map((e) => e.from),
      ['2026-10-01', '2026-10-10']
    )
    const before = priceAt(table, 'claude-opus-5-5', '2026-10-09T23:59:59Z')
    assert.equal(before.from, '2026-10-01')
    assert.equal(before.name, 'Claude Opus 5.5')
    assert.equal(before.rates.input, 4)
    const after = priceAt(table, 'claude-opus-5-5[1m]', '2026-10-10T00:00:01Z')
    assert.equal(after.from, '2026-10-10')
    assert.equal(after.rates.input, 6)

    const tokens = { input: 1e6, output: 1e6, thinking: 5e5, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }
    assert.deepEqual(costOf(tokens, before), { usd: 4 + 20 + 0.2 + 5 + 8, reason: null })
    assert.deepEqual(costOf(tokens, after), { usd: 6 + 20 + 0.2 + 5 + 8, reason: null })
  } finally {
    h.done()
  }
})

test('a failed fetch keeps the last entry and says so', async () => {
  const h = host()
  try {
    await updateTable(h.root, { url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-01T09:00:00Z') })
    const thrown = await updateTable(h.root, { url: URL, fetch: failingFetch, now: at('2026-10-05T09:00:00Z') })
    assert.equal(thrown.state, 'stale')
    assert.equal(thrown.last, '2026-10-01')
    assert.match(thrown.reason, /ENOTFOUND/)
    const status = await updateTable(h.root, { url: URL, fetch: fakeFetch('down', 503), now: at('2026-10-05T09:00:00Z') })
    assert.equal(status.state, 'stale')
    assert.match(status.reason, /503/)
    const empty = await updateTable(h.root, { url: URL, fetch: fakeFetch('<html>moved</html>'), now: at('2026-10-05T09:00:00Z') })
    assert.equal(empty.state, 'stale')
    assert.match(empty.reason, /no price table/)
    assert.deepEqual(files(h.root), ['2026-10-01.json'])
  } finally {
    h.done()
  }
})

test('a failed fetch with no entry at all leaves cost unpriced', async () => {
  const h = host()
  try {
    const result = await updateTable(h.root, { url: URL, fetch: failingFetch, now: at('2026-10-05T09:00:00Z') })
    assert.equal(result.state, 'none')
    assert.match(result.reason, /ENOTFOUND/)
    assert.deepEqual(files(h.root), [])
    const price = priceAt(readTable(h.root), 'claude-opus-5-5', '2026-10-05T10:00:00Z')
    assert.equal(price.rates, null)
    const cost = costOf({ input: 10, output: 10 }, price)
    assert.equal(cost.usd, null)
    assert.match(cost.reason, /no price entry/)
  } finally {
    h.done()
  }
})

test('two branches adding the same entry write byte-identical files', async () => {
  const a = host()
  const b = host()
  try {
    // The page lists its rows in another order on the second fetch; the bytes do not move.
    const reordered = page(4).split('\n')
    ;[reordered[4], reordered[5]] = [reordered[5], reordered[4]]
    const ra = await updateTable(a.root, { url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-01T08:00:00Z') })
    const rb = await updateTable(b.root, { url: URL, fetch: fakeFetch(reordered.join('\r\n')), now: at('2026-10-01T17:30:00Z') })
    assert.equal(ra.path, rb.path)
    const bytesA = readFileSync(join(a.root, ra.path))
    const bytesB = readFileSync(join(b.root, rb.path))
    assert.ok(bytesA.equals(bytesB))
    assert.ok(bytesA.toString('utf8').endsWith('}\n'))
    assert.ok(!bytesA.toString('utf8').includes('\r'))
  } finally {
    a.done()
    b.done()
  }
})

test('readTable sorts by from and collapses an entry equal to the one before it', () => {
  const h = host()
  try {
    const dir = join(h.root, PRICES_DIR)
    mkdirSync(dir, { recursive: true })
    const models = parsePriceTable(page(4))
    const changed = parsePriceTable(page(6))
    // Two branches each fetched the same prices on different days and both entries merged.
    writeFileSync(join(dir, '2026-10-03.json'), serializeEntry({ from: '2026-10-03', source: URL, models }))
    writeFileSync(join(dir, '2026-10-01.json'), serializeEntry({ from: '2026-10-01', source: URL, models }))
    writeFileSync(join(dir, '2026-10-07.json'), serializeEntry({ from: '2026-10-07', source: URL, models: changed }))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    assert.deepEqual(
      readTable(h.root).map((e) => e.from),
      ['2026-10-01', '2026-10-07']
    )
  } finally {
    h.done()
  }
})

test('a response before the first entry, or of an unknown model, is unpriced with a reason', () => {
  const table = [{ from: '2026-10-01', source: URL, models: parsePriceTable(page(4)) }]
  const early = priceAt(table, 'claude-opus-5-5', '2026-09-30T23:59:59Z')
  assert.equal(early.rates, null)
  assert.match(early.reason, /no price entry on or before 2026-09-30/)
  assert.deepEqual(costOf({ input: 1, output: 1 }, early), { usd: null, reason: early.reason })

  const unknown = priceAt(table, 'claude-opus-9-9', '2026-10-02T00:00:00Z')
  assert.equal(unknown.rates, null)
  assert.equal(unknown.from, '2026-10-01')
  assert.match(unknown.reason, /claude-opus-9-9 not in the entry/)

  assert.match(priceAt(table, 'claude-opus-5-5', null).reason, /no timestamp/)
  assert.deepEqual(costOf({ input: 1 }, null), { usd: null, reason: 'no price' })
})

test('fetchEntry dates the entry by UTC and refuses without a url', async () => {
  const got = await fetchEntry({ url: URL, fetch: fakeFetch(page(4)), now: at('2026-10-01T23:30:00-05:00') })
  assert.equal(got.ok, true)
  assert.equal(got.entry.from, '2026-10-02')
  assert.deepEqual(await fetchEntry({ fetch: fakeFetch(page(4)) }), { ok: false, reason: 'no prices url' })
})
