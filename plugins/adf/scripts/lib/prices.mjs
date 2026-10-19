// The dated price table: one file per entry, `.adf/prices/<YYYY-MM-DD>.json` under the host root,
// each `{ from, source, models }` with rates in USD per million tokens. A record keeps tokens only;
// cost takes, for each response, the entry in force at its time. One file per entry lets two
// branches that fetched the same prices on the same day add the same bytes and merge cleanly.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PRICES_DIR = join('.adf', 'prices')

const RATE_FIELDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output']
const ENTRY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/

const dollars = (cell) => {
  const m = /\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/.exec(cell)
  return m ? Number(m[1]) : null
}

// Parse the model pricing table of the official pricing page (markdown), as the origin does. A
// row is kept only when every rate it needs parsed; a missing rate is left out, never guessed.
export function parsePriceTable(markdown) {
  const prices = {}
  let columns = null
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      columns = null
      continue
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (/^model$/i.test(cells[0] ?? '')) {
      columns = cells.map((c) => c.toLowerCase())
      continue
    }
    if (!columns || /^:?-+/.test(cells[0] ?? '')) continue
    const col = (name) => cells[columns.findIndex((c) => c.includes(name))] ?? ''
    const name = cells[0]
      .replace(/<sup>.*?<\/sup>/g, '')
      .replace(/\s*\(.*$/, '')
      .trim()
    const rates = {
      input: dollars(col('base input')),
      cacheWrite5m: dollars(col('5m cache')),
      cacheWrite1h: dollars(col('1h cache')),
      cacheRead: dollars(col('cache hits')),
      output: dollars(col('output'))
    }
    if (name && Object.values(rates).every((v) => v !== null)) prices[name] = rates
  }
  return prices
}

// A model's matching key, from a transcript id or a table name: `claude-opus-5-5[1m]`,
// `us.anthropic.claude-opus-5-5-20260101-v1:0` and `Claude Opus 5.5` all give `opus 5.5`;
// `claude-3-5-haiku-20241022` and `Claude Haiku 3.5` give `haiku 3.5`. Null when no family word.
export function modelKey(name) {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^.*\banthropic\./, '')
    .replace(/[@:].*$/, '')
    .replace(/-v\d+$/, '')
    .split(/[\s._-]+/)
    .filter((w) => w && w !== 'claude' && !/^\d{8}$/.test(w))
  const family = words.filter((w) => !/^\d+$/.test(w))
  const version = words.filter((w) => /^\d+$/.test(w))
  if (family.length === 0) return null
  return `${family.join(' ')} ${version.join('.')}`.trim()
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    )
  }
  return value
}

// The bytes of an entry: sorted keys, two-space indent, trailing newline, so the same entry is
// the same file on every branch and every platform.
export function serializeEntry(entry) {
  return `${JSON.stringify(sortKeys(entry), null, 2)}\n`
}

const sameModels = (a, b) => JSON.stringify(sortKeys(a ?? {})) === JSON.stringify(sortKeys(b ?? {}))

// The table, oldest entry first; an entry whose models equal the one before it adds nothing and
// is collapsed into it.
export function readTable(root) {
  const dir = join(root, PRICES_DIR)
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir)
    .filter((f) => ENTRY_FILE.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((e) => e && typeof e.from === 'string' && e.models && typeof e.models === 'object')
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  const table = []
  for (const e of entries) {
    if (table.length && sameModels(table[table.length - 1].models, e.models)) continue
    table.push(e)
  }
  return table
}

const dateOf = (now) => {
  const d = now instanceof Date ? now : new Date(now)
  return d.toISOString().slice(0, 10)
}

// Fetch the pricing page and build an entry dated today (UTC). A failed request, a non-2xx status
// or a page with no parsable table is `{ ok: false, reason }`; nothing is thrown.
export async function fetchEntry({ url, fetch = globalThis.fetch, now = () => new Date() } = {}) {
  if (!url) return { ok: false, reason: 'no prices url' }
  let text
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, reason: `${url} answered ${res.status}` }
    text = await res.text()
  } catch (err) {
    return { ok: false, reason: `could not fetch ${url}: ${err.message}` }
  }
  const models = parsePriceTable(text)
  if (Object.keys(models).length === 0) return { ok: false, reason: `no price table parsed from ${url}` }
  return { ok: true, entry: { from: dateOf(now()), source: url, models } }
}

// Fetch and write a new entry only when its models differ from the last entry's.
//   { state: 'written', path, from }   a new entry; `path` is relative to the root
//   { state: 'unchanged', from }       the page matches the last entry; nothing written
//   { state: 'stale', last, reason }   the fetch failed; the last entry stays in force
//   { state: 'none', reason }          the fetch failed and there is no entry; cost is unpriced
export async function updateTable(root, { url, fetch, now } = {}) {
  const table = readTable(root)
  const last = table[table.length - 1] ?? null
  const got = await fetchEntry({ url, fetch, now })
  if (!got.ok) return last ? { state: 'stale', last: last.from, reason: got.reason } : { state: 'none', reason: got.reason }
  if (last && sameModels(last.models, got.entry.models)) return { state: 'unchanged', from: last.from }
  const path = join(PRICES_DIR, `${got.entry.from}.json`)
  mkdirSync(join(root, PRICES_DIR), { recursive: true })
  writeFileSync(join(root, path), serializeEntry(got.entry))
  return { state: 'written', path, from: got.entry.from }
}

// The rates in force for a model at a response's time: the latest entry whose `from` is on or
// before the response's UTC date, and in it the model whose key matches.
//   { rates, from, name, reason: null } or { rates: null, from, name: null, reason }
export function priceAt(table, model, timestamp) {
  const t = Date.parse(timestamp)
  if (Number.isNaN(t)) return { rates: null, from: null, name: null, reason: 'no timestamp' }
  const day = dateOf(t)
  let entry = null
  for (const e of table) if (e.from <= day) entry = e
  if (!entry) return { rates: null, from: null, name: null, reason: `no price entry on or before ${day}` }
  const key = modelKey(model)
  const name = key ? Object.keys(entry.models).find((n) => modelKey(n) === key) : undefined
  if (!name) return { rates: null, from: entry.from, name: null, reason: `model ${model} not in the entry of ${entry.from}` }
  return { rates: entry.models[name], from: entry.from, name, reason: null }
}

// USD for one response's tokens at a `priceAt` result. `thinking` is part of `output` (the API's
// `output_tokens` counts it, and `output_tokens_details.thinking_tokens` breaks it out), so it is
// billed at the output rate through `output` and not added a second time.
//   { usd, reason: null } or { usd: null, reason }
export function costOf(tokens, price) {
  if (!price?.rates) return { usd: null, reason: price?.reason ?? 'no price' }
  const r = price.rates
  const missing = RATE_FIELDS.filter((f) => typeof r[f] !== 'number')
  if (missing.length) return { usd: null, reason: `rates lack ${missing.join(', ')}` }
  const n = (f) => Number(tokens?.[f]) || 0
  const usd =
    (n('input') * r.input +
      n('cacheWrite5m') * r.cacheWrite5m +
      n('cacheWrite1h') * r.cacheWrite1h +
      n('cacheRead') * r.cacheRead +
      n('output') * r.output) /
    1e6
  return { usd, reason: null }
}
