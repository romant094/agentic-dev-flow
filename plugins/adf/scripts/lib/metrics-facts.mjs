// The facts the metrics record takes from a change's transcripts: tokens by actor, phase, model
// and level, the dispatches, cache-lifetime evidence, outliers, autonomy, timing and context.
// Pure: it reads the runtime-neutral sessions `lib/transcripts.mjs` hands on (its `value`) and
// the ledger records passed in, and returns tokens only — no prices (lib/prices.mjs costs them).
//
// Actors: `orchestrator` (the session's own responses), `controller` (a subagent other agents
// name as their parent) and `worker` (every other subagent, and a sidechain record of the
// session's own transcript). Levels: the flow's agent types `adf:<level>` (or the origin's
// `adf-<level>`); the session's own responses are `orchestrator`, any other agent type `other`.
// Every breakdown sums to the total.
import { parseName } from './dispatch.mjs'

export const TOKEN_FIELDS = ['input', 'output', 'thinking', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']
export const LEVELS = ['mechanical', 'integration', 'architecture']
// The 5-minute cache lifetime, in seconds: a gap longer than it is a cold resume, and a gap the
// active time counts is capped at it, so idle time is not counted as work.
export const CACHE_GAP_SEC = 300
export const ONE_HOUR_SEC = 3600
export const OTHER_PHASE = 'other'
export const COVERAGE_WARNING = `phases: all active time is in "${OTHER_PHASE}"; no ledger session record and no /adf:<phase> command marked a phase`

const zero = () => Object.fromEntries([...TOKEN_FIELDS.map((f) => [f, 0]), ['turns', 0], ['placeholderTurns', 0]])
const add = (bucket, r) => {
  for (const f of TOKEN_FIELDS) bucket[f] += r[f]
  bucket.turns += 1
  if (r.outputFinal === false) bucket.placeholderTurns += 1
}
const minutes = (ms) => Number((ms / 60000).toFixed(1))

// ---------------------------------------------------------------- classify

// The Superpowers skill's own agent nouns ("T1 implementer r1"), read as the role they name.
const NOUNS = { implementer: 'impl', reviewer: 'review', 're-reviewer': 're-review', fixer: 'fix' }

// The role, task, group and round a dispatch's description names. The fixed form
// (lib/dispatch.mjs parseName) and the Superpowers nouns in its place are exact, and so is
// `investigate <topic>` with a topic of more than one word; anything else is a keyword guess
// marked `exact: false`.
export function classify(description) {
  const text = String(description ?? '').trim()
  const blank = { role: null, task: null, group: null, round: null }
  const parsed = parseName(text) ?? parseName(text.split(/\s+/).map((w) => NOUNS[w] ?? w).join(' '))
  if (parsed) return { ...blank, ...parsed, exact: true }
  const topic = /^investigate\s+(\S.*)$/.exec(text)
  if (topic) return { ...blank, role: 'investigate', topic: topic[1], exact: true }
  if (text === '') return { ...blank, exact: false }
  const lower = text.toLowerCase()
  const role = /final/.test(lower) && /review/.test(lower)
    ? 'final-review'
    : /merge/.test(lower) && /review/.test(lower)
      ? 'merge-review'
      : /re-?review/.test(lower)
        ? 're-review'
        : /sweep/.test(lower)
          ? 'sweep'
          : /\bfix/.test(lower)
            ? 'fix'
            : /review/.test(lower)
              ? 'review'
              : /implement|^task \d/.test(lower)
                ? 'impl'
                : /verify|check/.test(lower)
                  ? 'verify'
                  : 'investigate'
  const task = /\btask\s+(\d+)|\bT(\d+)\b/i.exec(text)
  const round = /\bround\s+(\d+)|\br(\d+)\b/i.exec(text)
  return { ...blank, role, task: task ? Number(task[1] ?? task[2]) : null, round: round ? Number(round[1] ?? round[2]) : null, exact: false }
}

// ---------------------------------------------------------------- levels and ceilings

export function levelOf(agentType) {
  const m = /^adf[:-](mechanical|integration|architecture)$/.exec(String(agentType ?? ''))
  return m ? m[1] : null
}

// `{ <level>: maxTurns }` from the texts of the flow's agent definitions (`agents/*.md`), read
// from each file's front matter `name` and `maxTurns`.
export function maxTurnsFromAgents(texts) {
  const out = {}
  for (const text of texts) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))?.[1]
    if (!front) continue
    const name = /^name:\s*["']?([a-z-]+)["']?\s*$/m.exec(front)?.[1]
    const max = /^maxTurns:\s*(\d+)\s*$/m.exec(front)?.[1]
    if (name && max) out[name] = Number(max)
  }
  return out
}

// ---------------------------------------------------------------- phases

// One session's phase marks, `{ source, marks: [{ at, phase }] }`. The ledger's `session`
// records of that session come first: they are written by the phase itself, a few turns after it
// starts, so the first one covers the session from its start. A session the ledger does not
// mark takes its `/adf:<phase>` command launches, and what comes before the first is `other`.
export function phaseMarks(session, ledger = []) {
  const recorded = ledger
    .filter((r) => r?.kind === 'session' && r.sessionId === session.id && typeof r.phase === 'string' && typeof r.at === 'string')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  if (recorded.length > 0) return { source: 'ledger', marks: recorded.map((r, i) => ({ at: i === 0 ? '' : r.at, phase: r.phase })) }
  const marks = (session.commands ?? []).flatMap((c) => {
    const m = /^adf:([a-z-]+)$/.exec(c.name)
    return m ? [{ at: c.at, phase: m[1] }] : []
  })
  return { source: marks.length > 0 ? 'commands' : 'none', marks }
}

export function phaseAt(marks, at) {
  let phase = OTHER_PHASE
  if (!at) return phase
  for (const m of marks) {
    if (m.at <= at) phase = m.phase
    else break
  }
  return phase
}

// Each gap between consecutive timestamps, capped at CACHE_GAP_SEC, added to `into` under the
// key `keyOf` gives the earlier timestamp. Returns the summed milliseconds.
function activeMs(times, keyOf, into) {
  let total = 0
  let previous = null
  for (const at of times) {
    const t = Date.parse(at)
    if (Number.isNaN(t)) continue
    if (previous !== null && t >= previous.t) {
      const gap = Math.min(t - previous.t, CACHE_GAP_SEC * 1000)
      total += gap
      if (into) {
        const key = keyOf(previous.at)
        into.set(key, (into.get(key) ?? 0) + gap)
      }
    }
    previous = { t, at }
  }
  return total
}

// ---------------------------------------------------------------- cache lifetime

// The gaps inside one agent's responses longer than the cache lifetime, each with the cache
// figures of the response after it: a resumed agent past five minutes writes its prefix again.
export function coldResumes(list, thresholdSec = CACHE_GAP_SEC) {
  const out = []
  let previous = null
  for (const r of list) {
    const t = r.at ? Date.parse(r.at) : Number.NaN
    if (Number.isNaN(t)) continue
    if (previous !== null) {
      const gapSec = Math.round((t - previous) / 1000)
      if (gapSec > thresholdSec) out.push({ gapSec, model: r.model, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h, cacheRead: r.cacheRead })
    }
    previous = t
  }
  return out
}

// What the subagent cache-lifetime decision needs, in tokens per model: the 5-minute writes
// after a cold resume a 1-hour lifetime would have bridged (`rewrittenTokens`), against every
// 5-minute write a 1-hour lifetime would charge its premium on (`write5m`). A gap over an hour is
// counted apart: no lifetime on offer saves it. The cost step prices both sides.
export function cacheTtlEvidence(dispatches) {
  const evidence = { coldResumes: 0, beyondOneHour: 0, rewrittenTokens: 0, write5m: 0, byModel: {} }
  const model = (m) => (evidence.byModel[m] ??= { rewrittenTokens: 0, write5m: 0 })
  for (const d of dispatches) {
    for (const r of d.responses) {
      evidence.write5m += r.cacheWrite5m
      model(r.model).write5m += r.cacheWrite5m
    }
    for (const g of d.coldResumes) {
      if (g.gapSec > ONE_HOUR_SEC) {
        evidence.beyondOneHour += 1
        continue
      }
      evidence.coldResumes += 1
      evidence.rewrittenTokens += g.cacheWrite5m
      model(g.model).rewrittenTokens += g.cacheWrite5m
    }
  }
  return evidence
}

// ---------------------------------------------------------------- outliers

export function median(xs) {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Dispatches whose turn count stands out, each with why: at half its level's turn ceiling or
// more (`near-ceiling`), or, among three or more dispatches of its role, 20 turns or more and
// over three times the role's median (`above-role-median`). Reasons to read the dispatch, not
// verdicts on it.
export function outliers(dispatches, maxTurns = {}) {
  const byRole = new Map()
  for (const d of dispatches) if (!d.missing) byRole.set(d.role, [...(byRole.get(d.role) ?? []), d.turns])
  const out = []
  for (const d of dispatches) {
    if (d.missing) continue
    const reasons = []
    const ceiling = maxTurns[d.level] ?? null
    if (ceiling && d.turns >= ceiling / 2) reasons.push('near-ceiling')
    const peers = byRole.get(d.role)
    const roleMedian = peers.length >= 3 ? median(peers) : null
    if (roleMedian !== null && d.turns >= 20 && d.turns > 3 * roleMedian) reasons.push('above-role-median')
    if (reasons.length > 0) out.push({ agentId: d.agentId, name: d.name, role: d.role, level: d.level, turns: d.turns, maxTurns: ceiling, roleMedian, reasons })
  }
  return out
}

// ---------------------------------------------------------------- the facts

function dispatchOf(session, agent, marks) {
  const c = classify(agent.description)
  const base = {
    sessionId: session.id,
    agentId: agent.agentId,
    parentAgentId: agent.parentAgentId,
    name: agent.description,
    role: c.role,
    task: c.task,
    group: c.group,
    round: c.round,
    exact: c.exact,
    actor: agent.controller ? 'controller' : 'worker',
    agentType: agent.agentType,
    level: levelOf(agent.agentType),
    missing: agent.missing
  }
  if (agent.missing) return { ...base, reason: agent.reason, model: agent.model, effort: null, phase: null, turns: null, tokens: null, startedAt: null, endedAt: null, activeMs: null, coldResumes: [], responses: [] }
  const tokens = zero()
  for (const r of agent.responses) add(tokens, r)
  const first = agent.responses[0]
  return {
    ...base,
    reason: null,
    model: first?.model ?? agent.model,
    effort: first?.effort ?? null,
    phase: phaseAt(marks, first?.at ?? agent.first),
    turns: agent.responses.length,
    tokens,
    startedAt: agent.first,
    endedAt: agent.last,
    activeMs: activeMs(agent.times),
    coldResumes: coldResumes(agent.responses),
    responses: agent.responses
  }
}

// The facts of one change from its transcripts (`readTranscripts(...).value`); null without
// them. `ledger` is the change's ledger records (the phase marks), `maxTurns` the turn ceiling
// per level (`maxTurnsFromAgents`), `rulings` the ledger's ruling count, or null when unknown.
export function computeFacts(transcripts, { ledger = [], maxTurns = {}, rulings = null } = {}) {
  if (!transcripts) return null
  const sessions = transcripts.sessions.filter((s) => s.resolved)
  const total = zero()
  const byActor = {}
  const byPhase = {}
  const byModel = {}
  const byLevel = {}
  const count = (r, { actor, phase, level }) => {
    add(total, r)
    add((byActor[actor] ??= zero()), r)
    add((byPhase[phase] ??= zero()), r)
    add((byModel[r.model] ??= zero()), r)
    add((byLevel[level] ??= zero()), r)
  }
  const dispatches = []
  const phaseMs = new Map()
  const taskMs = {}
  const peakBySession = {}
  const phaseSources = {}
  const autonomy = { developerMessages: 0, askUserQuestion: 0, clears: 0, sessions: sessions.length, rulings }
  let compactions = 0
  let activeTotal = 0
  let first = null
  let last = null
  const span = (a, b) => {
    if (a && (first === null || a < first)) first = a
    if (b && (last === null || b > last)) last = b
  }

  for (const s of sessions) {
    const { source, marks } = phaseMarks(s, ledger)
    phaseSources[s.id] = source
    const phaseOf = (at) => phaseAt(marks, at)
    for (const r of s.responses) count(r, { actor: 'orchestrator', phase: phaseOf(r.at), level: 'orchestrator' })
    for (const r of s.sidechain) count(r, { actor: 'worker', phase: phaseOf(r.at), level: 'other' })
    activeTotal += activeMs(s.times, phaseOf, phaseMs)
    span(s.first, s.last)
    peakBySession[s.id] = s.responses.length === 0 ? null : Math.max(...s.responses.map((r) => r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h))
    compactions += s.compactions.length
    for (const f of ['developerMessages', 'askUserQuestion', 'clears']) autonomy[f] += s.autonomy[f]
    for (const agent of s.subagents) {
      const d = dispatchOf(s, agent, marks)
      dispatches.push(d)
      if (d.missing) continue
      for (const r of d.responses) count(r, { actor: d.actor, phase: phaseOf(r.at), level: d.level ?? 'other' })
      if (d.task !== null) taskMs[d.task] = (taskMs[d.task] ?? 0) + d.activeMs
      span(d.startedAt, d.endedAt)
    }
  }

  const activeByPhase = Object.fromEntries([...phaseMs].map(([k, v]) => [k, minutes(v)]))
  const warnings = []
  if (activeTotal > 0 && [...phaseMs.keys()].every((k) => k === OTHER_PHASE)) warnings.push(COVERAGE_WARNING)
  const strip = ({ responses: _r, coldResumes: cr, activeMs: ms, ...d }) => ({ ...d, coldResumes: cr.length, activeMinutes: ms === null ? null : minutes(ms) })
  return {
    dispatches: dispatches.map(strip),
    tokens: { total, byActor, byPhase, byModel, byLevel },
    phases: phaseSources,
    context: { peakBySession, compactions },
    cacheTtl: cacheTtlEvidence(dispatches.filter((d) => !d.missing)),
    outliers: outliers(dispatches, maxTurns),
    autonomy,
    timing: {
      first,
      last,
      elapsedMinutes: first && last ? minutes(Date.parse(last) - Date.parse(first)) : null,
      activeMinutes: { total: minutes(activeTotal), byPhase: activeByPhase },
      minutesPerTask: Object.fromEntries(Object.entries(taskMs).map(([k, v]) => [k, minutes(v)]))
    },
    warnings
  }
}
