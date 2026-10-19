// The session transcripts the runtime writes, read for the metrics: the one runtime-specific
// module of the metrics (`RUNTIME`). Everything Claude Code's layout and record shapes decide is
// read here and handed on as plain data — sessions, deduplicated responses, timestamps, slash
// commands, autonomy counts, compactions and subagents — so `lib/metrics-facts.mjs` knows no
// runtime. Nothing is written.
//
// Layout: `<projectsDir>/<key>/<session>.jsonl`, one JSON record per line, and the session's
// dispatched agents in `<key>/<session>/subagents/agent-<id>.jsonl` beside `agent-<id>.meta.json`
// (`agentType`, `description`, `parentAgentId`, `model`). A key is the directory the session was
// started in, encoded (`projectKeys`).
//
// Sessions: the ledger's `session` records first (they carry the runtime's session id), then
// every session with records on the change's branch (`sliceByBranch`), each marked `ledger`,
// `branch` or `both`; a ledger session whose transcript is gone is named in `unresolved`. Each
// transcript file is read and parsed once. No transcripts at all is `{ value: null, reason }`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const RUNTIME = 'claude-code'
// The vendor's pricing page, served as Markdown: the default of the registry's
// `metrics.pricesUrl` (lib/prices.mjs reads it).
export const DEFAULT_PRICES_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
export const defaultProjectsDir = () => join(homedir(), '.claude', 'projects')
// Where the flow keeps its worktrees (lib/workspace.mjs WORKTREES_DIR), as a key suffix: a
// worktree's sessions sit under `<key>--claude-worktrees-<name>`, a key no path derives once the
// worktree is removed.
export const WORKTREE_KEY = '--claude-worktrees-'
// Branches every change's sessions run on: discovering by them would give one change the whole
// project's sessions.
export const INTEGRATION_BRANCHES = new Set(['', 'HEAD', 'develop', 'main', 'master'])

const present = (value) => ({ value, reason: null })
const absent = (reason) => ({ value: null, reason })
const unique = (xs) => [...new Set(xs)]

// ---------------------------------------------------------------- project keys

// The encodings of one absolute path the runtime may have used: every separator as `-` (the
// leading `-` kept, the on-disk form), the same without the leading `-`, and every character
// that is not a letter or a digit as `-` (the runtime maps `.` too, so a path inside
// `.claude/worktrees/` has only this form).
export function encodeKeys(path) {
  const slash = String(path).replace(/[\\/]/g, '-')
  return unique([slash, slash.replace(/^-/, ''), String(path).replace(/[^A-Za-z0-9]/g, '-')])
}

// Every key a change's transcripts may live under: the encodings of the repository path and of
// the main checkout (the git common dir's parent; the flow starts its sessions there), then
// every `entries` name that is one of them followed by WORKTREE_KEY.
export function projectKeys({ repoPath, commonDir = null, entries = [] }) {
  const paths = [repoPath]
  if (commonDir && basename(commonDir) === '.git') paths.push(dirname(commonDir))
  const keys = unique(paths.filter(Boolean).flatMap(encodeKeys))
  for (const key of [...keys]) {
    for (const entry of entries) if (entry.startsWith(`${key}${WORKTREE_KEY}`) && !keys.includes(entry)) keys.push(entry)
  }
  return keys
}

// ---------------------------------------------------------------- records

export function parseRecords(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') out.push(value)
    } catch {
      // A torn last line or any non-JSON line is skipped.
    }
  }
  return out
}

// A change's work runs on its branch and, in a wave-1 fan-out, on its group branches
// (lib/groups.mjs: `<branch>--group-<G>`).
export const onChangeBranch = (candidate, branch) => candidate === branch || candidate.startsWith(`${branch}--group-`)

// The records written while the session was on the change's branch. One session can move on to
// another change's branch; counting it whole charges each change for the other's work. A record
// with no `gitBranch` inherits the last one seen.
export function sliceByBranch(records, branch) {
  const kept = []
  let current = null
  for (const record of records) {
    if (typeof record.gitBranch === 'string') current = record.gitBranch
    if (current !== null && onChangeBranch(current, branch)) kept.push(record)
  }
  const times = timestamps(kept)
  return { records: kept, first: times[0] ?? null, last: times.at(-1) ?? null }
}

const timestamps = (records) => records.map((r) => r.timestamp).filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)))

// One entry per API response. The runtime writes one record per content block, each repeating
// the response's `message.id` and a `usage` block; the input-side figures are the same in every
// record of an id, `output_tokens` is not. It is final only in a record that carries
// `usage.output_tokens_details`; a record without it holds the streaming placeholder written as
// the response began. So an id's final record stands for it when it has one (else its largest
// output), keeping the first record's time, and `outputFinal: false` marks a response whose
// output is only that placeholder — a lower bound. `output` includes the thinking tokens, as
// `output_tokens` does; `thinking` breaks them out. `<synthetic>` is a message the runtime wrote
// itself, which no model produced.
export function responses(records) {
  const byId = new Map()
  const order = []
  const final = (r) => Boolean(r.message.usage?.output_tokens_details)
  const out = (r) => r.message.usage?.output_tokens || 0
  for (const record of records) {
    if (record.type !== 'assistant') continue
    const message = record.message
    if (!message || typeof message !== 'object' || message.model === '<synthetic>') continue
    const key = message.id ?? Symbol('no-id')
    const seen = byId.get(key)
    if (!seen) {
      byId.set(key, record)
      order.push(key)
    } else if ((!final(seen) && final(record)) || (final(seen) === final(record) && out(record) > out(seen))) {
      byId.set(key, { ...record, timestamp: seen.timestamp })
    }
  }
  return order.map((key) => {
    const record = byId.get(key)
    const u = record.message.usage || {}
    const cacheWrite = u.cache_creation_input_tokens || 0
    const cacheWrite1h = u.cache_creation?.ephemeral_1h_input_tokens || 0
    // A record without the 5m/1h split is taken as 5-minute writes, the cheaper of the two.
    const cacheWrite5m = u.cache_creation?.ephemeral_5m_input_tokens ?? cacheWrite - cacheWrite1h
    return {
      id: typeof key === 'string' ? key : null,
      at: record.timestamp ?? null,
      model: record.message.model || '(unknown)',
      effort: typeof record.effort === 'string' ? record.effort : null,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      thinking: u.output_tokens_details?.thinking_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite5m,
      cacheWrite1h,
      outputFinal: Boolean(u.output_tokens_details)
    }
  })
}

// The text of a user record, joined from its text blocks; null when it carries a tool result,
// which the runtime writes, not a person.
function userText(record) {
  const content = record.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}

const COMMAND = /<command-name>\/([^<\s]+)<\/command-name>/g

// The slash commands the user records carry, `{ at, name }` with the name without its `/`
// (`adf:apply`, `clear`).
export function commandsOf(records) {
  const out = []
  for (const record of records) {
    if (record.type !== 'user' || typeof record.timestamp !== 'string') continue
    const text = userText(record)
    if (text === null) continue
    for (const m of text.matchAll(COMMAND)) out.push({ at: record.timestamp, name: m[1] })
  }
  return out
}

// What the runtime writes into a user turn itself: command output, task notifications and the
// marker an interrupt leaves. A slash command typed mid-phase is an intervention and counts; a
// flow command launch (`/adf:<x>`) and `/clear`, counted on its own, do not.
const INJECTED = /^\s*(?:<local-command-|<task-notification>|\[Request interrupted by user)/
const UNCOUNTED_COMMAND = /<command-name>\/(?:adf:[a-z-]+|clear)<\/command-name>/

// How often the developer stepped in: messages typed, questions put to them (AskUserQuestion),
// `/clear` commands. A typed message is a user record of human text — not a tool result, a flow
// command launch or `/clear`, an injected notification, text that is only a system reminder, a
// meta record, a compaction summary or a sidechain record — and not the record that started the
// session. `whole` is the session the records were sliced from, so a slice that starts
// mid-session does not drop a real message as the start.
export function autonomyOf(records, whole = records) {
  const start = whole.find((r) => r.type === 'user') ?? null
  const facts = { developerMessages: 0, askUserQuestion: 0, clears: 0 }
  for (const record of records) {
    if (record.isSidechain) continue
    if (record.type === 'assistant') {
      const content = record.message?.content
      if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use' && b.name === 'AskUserQuestion') facts.askUserQuestion += 1
      continue
    }
    if (record.type !== 'user') continue
    const text = userText(record)
    if (text === null) continue
    if (text.includes('<command-name>/clear</command-name>')) facts.clears += 1
    if (record === start || record.isMeta || record.isCompactSummary) continue
    const bare = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (bare === '' || INJECTED.test(bare) || UNCOUNTED_COMMAND.test(bare)) continue
    facts.developerMessages += 1
  }
  return facts
}

// The compactions of a session: `{ at, trigger, preTokens }` per compaction boundary.
export function compactionsOf(records) {
  return records
    .filter((r) => r.type === 'system' && r.subtype === 'compact_boundary')
    .map((r) => ({ at: r.timestamp ?? null, trigger: r.compactMetadata?.trigger ?? null, preTokens: r.compactMetadata?.preTokens ?? null }))
}

// Records on another branch, written between the session's first and last record on the
// change's branch: work interleaved with the change's, not the rest of a long session.
function foreignRecords(records, branch, first, last) {
  if (!first || !last) return 0
  return records.filter((r) => typeof r.timestamp === 'string' && r.timestamp >= first && r.timestamp <= last && typeof r.gitBranch === 'string' && !onChangeBranch(r.gitBranch, branch)).length
}

// ---------------------------------------------------------------- reading

const readParsed = (file) => parseRecords(readFileSync(file, 'utf8'))

function readMeta(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    // An unreadable meta file leaves the agent's type and description unknown, not guessed.
    return {}
  }
}

// The dispatched agents of one session. An agent other agents name as their parent is a
// controller. With a branch, only an agent's records on it count, and an agent with none is not
// the change's. An agent whose `.meta.json` has no transcript beside it is kept, `missing`, with
// the reason, so it is named rather than dropped.
export function readSubagents(dir, branch = null) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
  const ids = unique(names.map((n) => /^agent-(.+?)(?:\.meta\.json|\.jsonl)$/.exec(n)?.[1]).filter(Boolean)).sort()
  const metas = Object.fromEntries(ids.map((id) => [id, names.includes(`agent-${id}.meta.json`) ? readMeta(join(dir, `agent-${id}.meta.json`)) : {}]))
  const parents = new Set(Object.values(metas).map((m) => m.parentAgentId).filter(Boolean))
  const out = []
  for (const agentId of ids) {
    const meta = metas[agentId]
    const base = {
      agentId,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      parentAgentId: meta.parentAgentId ?? null,
      model: meta.model ?? null,
      controller: parents.has(agentId)
    }
    if (!names.includes(`agent-${agentId}.jsonl`)) {
      out.push({ ...base, missing: true, reason: `no agent-${agentId}.jsonl beside its .meta.json`, responses: [], times: [], first: null, last: null })
      continue
    }
    let records = readParsed(join(dir, `agent-${agentId}.jsonl`))
    if (branch) records = sliceByBranch(records, branch).records
    if (records.length === 0) continue
    const times = timestamps(records)
    out.push({ ...base, missing: false, reason: null, responses: responses(records), times, first: times[0] ?? null, last: times.at(-1) ?? null })
  }
  return out
}

function buildSession({ id, key, source, records, branch, projectsDir }) {
  const sliced = branch ? sliceByBranch(records, branch) : null
  const scope = sliced && sliced.records.length > 0 ? 'branch' : 'session'
  const own = scope === 'branch' ? sliced.records : records
  const times = timestamps(own)
  const first = times[0] ?? null
  const last = times.at(-1) ?? null
  return {
    id,
    key,
    source,
    resolved: true,
    scope,
    first,
    last,
    times,
    responses: responses(own.filter((r) => !r.isSidechain)),
    sidechain: responses(own.filter((r) => r.isSidechain)),
    // From the whole transcript: a session often launches a phase before it changes into the
    // change's worktree, so the launch may sit on another branch than the work it starts.
    commands: commandsOf(records),
    autonomy: autonomyOf(own, records),
    compactions: compactionsOf(own),
    foreignRecords: scope === 'branch' ? foreignRecords(records, branch, first, last) : 0,
    subagents: readSubagents(join(projectsDir, key, id, 'subagents'), scope === 'branch' ? branch : null)
  }
}

// The transcripts of one change. `repoPath` is the change's checkout, `commonDir` its git common
// dir (absolute), `branch` the change's branch, `ledger` the change's ledger records. Returns
// `{ value: { runtime, projectsDir, keys, sessions, unresolved }, reason: null }`, or
// `{ value: null, reason }` when no session resolves.
export function readTranscripts({ repoPath, commonDir = null, branch = null, ledger = [], projectsDir = defaultProjectsDir() }) {
  if (!existsSync(projectsDir)) return absent(`no transcript directory ${projectsDir}`)
  const entries = readdirSync(projectsDir)
  const keys = projectKeys({ repoPath, commonDir, entries }).filter((k) => entries.includes(k))
  const discoverable = typeof branch === 'string' && !INTEGRATION_BRANCHES.has(branch)
  const onBranch = discoverable ? branch : null
  const ledgerIds = unique(ledger.filter((r) => r?.kind === 'session' && typeof r.sessionId === 'string' && r.sessionId).map((r) => r.sessionId))

  const found = new Map() // id -> { key, source, records }
  const unresolved = []
  for (const id of ledgerIds) {
    const key = keys.find((k) => existsSync(join(projectsDir, k, `${id}.jsonl`)))
    if (key === undefined) unresolved.push(id)
    else found.set(id, { key, source: 'ledger', records: readParsed(join(projectsDir, key, `${id}.jsonl`)) })
  }
  if (discoverable) {
    // A cheap substring test before the parse; the slice decides (the test also matches a
    // branch this one is a prefix of).
    const marker = `"gitBranch":${JSON.stringify(branch).slice(0, -1)}`
    for (const key of keys) {
      for (const name of readdirSync(join(projectsDir, key))) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -'.jsonl'.length)
        const known = found.get(id)
        if (known) {
          if (known.source === 'ledger' && sliceByBranch(known.records, branch).records.length > 0) known.source = 'both'
          continue
        }
        const text = readFileSync(join(projectsDir, key, name), 'utf8')
        if (!text.includes(marker)) continue
        const records = parseRecords(text)
        if (sliceByBranch(records, branch).records.length > 0) found.set(id, { key, source: 'branch', records })
      }
    }
  }

  if (found.size === 0) {
    const where = keys.length === 0 ? `no project key of ${repoPath} under ${projectsDir}` : `no session ${discoverable ? `on branch ${branch} ` : ''}under ${keys.join(', ')}`
    return absent(unresolved.length > 0 ? `${where}; the ledger's sessions ${unresolved.join(', ')} have no transcript` : where)
  }
  const sessions = [...found].map(([id, s]) => buildSession({ id, ...s, branch: onBranch, projectsDir }))
  return present({ runtime: RUNTIME, projectsDir, keys, sessions, unresolved })
}
