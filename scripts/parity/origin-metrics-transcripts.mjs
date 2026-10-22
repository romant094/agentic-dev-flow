#!/usr/bin/env node
// Dev tool: the origin's metrics extractor against the port's, on the session transcripts of the
// origin's archived changes that survive on this machine (`~/.claude/projects/`, read only). The
// origin's `extractMetrics` (it writes nothing; its CLI writes) is imported from a copy of its
// scripts under the system temp directory (lib/origin-metrics.mjs), removed at the end, and run as
// its window retrospective re-measures a merged change: the merge's branch (the record's own
// branch first), the range `merge^1..merge^2`, no prices. The port's side is `readTranscripts`
// (lib/transcripts.mjs) and `computeFacts` (lib/metrics-facts.mjs) over the same repository,
// branch and ledger: the ledger.jsonl the origin reads first (its `ledgerCandidates` order).
// With no transcript of the origin at all it prints { skipped } and exits 0.
//
//   node scripts/parity/origin-metrics-transcripts.mjs <origin project root> [--all]
//
// --all also prints every change's comparison.
//
// Compared per change both sides resolve a session for: the resolved sessions; the token buckets
// (input, output, thinking, cacheRead, cacheWrite5m, cacheWrite1h, turns, placeholder turns) of
// the total, per actor and per model; per dispatch (by agent id) its classification (role, task,
// round, exact), actor, agent type, model, turns and tokens; the cache hit rate; the autonomy
// counts; the active minutes; the outliers.
//
// Deliberate differences, counted per class (anything else fails the tool):
//   phase-source    phases: the origin reads `/opsx:<x>` command tags only; the port reads the
//                   ledger's `session --phase` records first, then `/adf:<x>` tags, so the origin's
//                   tags give the port no phase; the per-phase split is not compared, its total is
//   phase-command   a `/opsx:<x>` launch typed by the developer: the origin leaves it out of the
//                   developer messages as a flow command, the port counts it (its flow command is
//                   `/adf:<x>`); the difference is exactly those launches
//   sidechain       a sidechain record of the session's own transcript: the origin sums it into
//                   the orchestrator, the port into the worker actor; the difference is exactly
//                   those responses
//   missing-agent   an agent with a `.meta.json` and no transcript: the origin drops it, the port
//                   lists the dispatch as `missing` with the reason
//   classify-*      a description the two classifiers read differently, by the rules of
//                   CLASSIFY below: `classify-investigate-topic`, `classify-v1-name`
//   classify-outlier  the outliers differ only through such a dispatch: its role in the port's
//                   reading adds a peer to, or takes one from, a role's median; the port's
//                   outliers recomputed with the origin's role for each such dispatch equal the
//                   origin's
//   rounding        active minutes: the origin sums minutes rounded per phase, the port rounds
//                   the total; within 0.05 per phase
//   progress-sessions a session only the origin's legacy `progress.md` `## Sessions` names; the
//                   port has no Markdown ledger
//   no-notification-fallback  the origin's token-economy row fell back to the harness's
//                   `<usage>` notification totals for subagents without transcripts; the port keeps
//                   no notification figure (not compared, counted)
//   price-free      no prices on either side: the origin's dollar figures are not compared, the
//                   port keeps tokens only (counted once per change)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseName } from '../../plugins/adf/scripts/lib/dispatch.mjs'
import { readLedger } from '../../plugins/adf/scripts/lib/ledger.mjs'
import { computeFacts, maxTurnsFromAgents, outliers, TOKEN_FIELDS } from '../../plugins/adf/scripts/lib/metrics-facts.mjs'
import { PLUGIN_ROOT } from '../../plugins/adf/scripts/lib/metrics.mjs'
import { defaultProjectsDir, readTranscripts } from '../../plugins/adf/scripts/lib/transcripts.mjs'
import { archivedEntries, readHistory } from '../../plugins/adf/scripts/lib/window.mjs'
import { ARCHIVE, copyOriginScripts, count, gitOn, originArg, originIo } from './lib/origin-metrics.mjs'

const origin = originArg('origin-metrics-transcripts.mjs')
const listAll = process.argv.includes('--all')
const git = gitOn(origin)
const projectsDir = defaultProjectsDir()
const REF = 'HEAD'

if (!existsSync(projectsDir) || !readdirSync(projectsDir).some((d) => d.includes(origin.replace(/[^A-Za-z0-9]/g, '-')))) {
  console.log(JSON.stringify({ skipped: `no session transcript of the origin under ${projectsDir}` }))
  process.exit(0)
}

// Descriptions the two classifiers read differently, each rule with its class and reason.
const CLASSIFY = [
  {
    class: 'classify-investigate-topic',
    why: 'the port reads `investigate <topic>` as exact with any topic (metrics-facts.mjs classify); the origin only with a topic of letters and digits, else a keyword guess',
    match: (text, o, p) => /^investigate\s+\S/.test(text) && !o.exact && p.exact && p.role === 'investigate'
  },
  {
    class: 'classify-v1-name',
    why: "a name in the origin's own grammar (`<role> [<word>] [r<n>]` over its roles: `spec-merge`, `verify <x>`, `review r<n>`, `final-review <G>`, `fix sweep`) that the port's fixed form (dispatch.mjs parseName) does not carry: the port reads it by keyword, `exact: false`",
    match: (text, o, p) => o.exact && !p.exact && parseName(text) === null
  }
]

const out = { changes: 0, measured: 0, skipped: {}, compared: {}, classes: {}, rows: [], unexplained: [] }
const fail = (change, what, detail) => out.unexplained.push({ change, what, ...detail })
const near = (a, b, tol = 0) => (a ?? null) === (b ?? null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol + 1e-9)

// The origin's bucket in the port's field names.
const bucketOf = (t) => (t ? { ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, t[f] ?? 0])), turns: t.turns ?? 0, placeholderTurns: t.outputPlaceholderTurns ?? 0 } : null)
const sameBucket = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const zero = () => ({ ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])), turns: 0, placeholderTurns: 0 })

// The responses of a session's sidechain records on the branch, as the port read them.
const sidechainBucket = (sessions) => {
  const b = zero()
  for (const s of sessions) for (const r of s.sidechain) {
    for (const f of TOKEN_FIELDS) b[f] += r[f]
    b.turns++
    if (r.outputFinal === false) b.placeholderTurns++
  }
  return b
}
const minus = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - (b?.[k] ?? 0)]))

// The `/opsx:<x>` launches of the developer among a session's records on the branch, the start
// record excepted: the port counts each as a developer message.
const OPSX = /<command-name>\/opsx:[a-z-]+<\/command-name>/
function opsxLaunches(tx) {
  let n = 0
  for (const s of tx.sessions) {
    const text = readFileSync(join(projectsDir, s.key, `${s.id}.jsonl`), 'utf8')
    const records = text.split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
    const start = records.find((r) => r.type === 'user')
    let current = null
    for (const r of records) {
      if (typeof r.gitBranch === 'string') current = r.gitBranch
      if (s.scope === 'branch' && !(current === tx.branch || current?.startsWith(`${tx.branch}--group-`))) continue
      if (r === start || r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) continue
      const c = r.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : null
      if (text === null) continue
      const bare = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (OPSX.test(bare) && !/<command-name>\/clear<\/command-name>/.test(bare)) n++
    }
  }
  return n
}

// Every place the origin reads a change's ledger.jsonl, most current first (its ledgerCandidates).
function ledgerOf(dir, change) {
  for (const file of [join(origin, '.superpowers', 'sdd', change, 'ledger.jsonl'), join(origin, 'openspec', 'changes', change, 'ledger.jsonl'), join(origin, ARCHIVE, dir, 'ledger.jsonl')]) {
    if (existsSync(file)) return { records: readLedger(readFileSync(file, 'utf8')), found: true }
  }
  return { records: [], found: false }
}

const maxTurns = maxTurnsFromAgents(readdirSync(join(PLUGIN_ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(PLUGIN_ROOT, 'agents', f), 'utf8')))
const scripts = copyOriginScripts(origin)
try {
  const { extractMetrics } = await scripts.load('adf-metrics.mjs')
  const io = originIo(origin)
  for (const entry of archivedEntries(readHistory(origin, REF))) {
    out.changes++
    const dir = entry.archiveDir.split('/').at(-1)
    const recordText = git.orNull('show', `${REF}:${entry.archiveDir}/metrics.json`)
    const branch = (recordText && JSON.parse(recordText).branch) || entry.branch
    if (entry.direct || !branch) {
      count(out.skipped, entry.direct ? 'direct commit' : 'no branch')
      continue
    }
    const theirs = await extractMetrics({ ...io, changeName: entry.change, branch, prices: null, range: `${entry.mergeSha}^1..${entry.mergeSha}^2` })
    const ledger = ledgerOf(dir, entry.change)
    const tx = readTranscripts({ repoPath: origin, commonDir: join(origin, '.git'), branch, ledger: ledger.records, projectsDir })
    const resolvedTheirs = theirs.sessions.filter((s) => s.resolved)
    if (resolvedTheirs.length === 0 && tx.value === null) {
      count(out.skipped, 'no surviving session')
      continue
    }
    out.measured++
    const row = { change: entry.change, classes: {}, sessions: { origin: resolvedTheirs.length, port: tx.value?.sessions.length ?? 0 } }
    out.rows.push(row)
    const cls = (what, c) => {
      count(out.classes, c)
      row.classes[what] = c
    }
    const compared = (what) => count(out.compared, what)
    cls('cost', 'price-free')
    if (theirs.tokenEconomy?.[1]?.source === 'notifications' && theirs.subagentDispatches?.dispatches > 0) cls('tokenEconomy', 'no-notification-fallback')

    // Sessions.
    compared('sessions')
    const ourIds = new Set((tx.value?.sessions ?? []).map((s) => s.id))
    const progressOnly = resolvedTheirs.filter((s) => !ourIds.has(s.id) && s.source === 'ledger' && !ledger.records.some((r) => r.kind === 'session' && r.sessionId === s.id))
    if (progressOnly.length > 0) cls('sessions', 'progress-sessions')
    const theirIds = new Set(resolvedTheirs.filter((s) => !progressOnly.includes(s)).map((s) => s.id))
    if ([...theirIds].sort().join() !== [...ourIds].sort().join()) {
      fail(entry.change, 'sessions', { origin: [...theirIds], port: [...ourIds] })
      continue
    }
    if (progressOnly.length > 0) continue
    const tv = { ...tx.value, branch }
    const facts = computeFacts(tx.value, { ledger: ledger.records, maxTurns, rulings: ledger.found ? ledger.records.filter((r) => r.kind === 'ruling').length : null })

    // Tokens: total, per actor, per model. A sidechain record moves from orchestrator to worker.
    const side = sidechainBucket(tx.value.sessions)
    const hasSide = side.turns > 0
    if (hasSide) cls('tokens.byActor', 'sidechain')
    compared('tokens.total')
    if (!sameBucket(bucketOf(theirs.cost.total), facts.tokens.total)) fail(entry.change, 'tokens.total', { origin: bucketOf(theirs.cost.total), port: facts.tokens.total })
    for (const actor of new Set([...Object.keys(theirs.cost.byActor), ...Object.keys(facts.tokens.byActor)])) {
      compared('tokens.byActor')
      let o = bucketOf(theirs.cost.byActor[actor]) ?? zero()
      let p = facts.tokens.byActor[actor] ?? zero()
      if (hasSide && actor === 'orchestrator') o = minus(o, side)
      if (hasSide && actor === 'worker') p = minus(p, side)
      if (!sameBucket(o, p)) fail(entry.change, `tokens.byActor.${actor}`, { origin: o, port: p })
    }
    for (const model of new Set([...Object.keys(theirs.cost.byModel), ...Object.keys(facts.tokens.byModel)])) {
      compared('tokens.byModel')
      const o = bucketOf(theirs.cost.byModel[model]) ?? zero()
      const p = facts.tokens.byModel[model] ?? zero()
      if (!sameBucket(o, p)) fail(entry.change, `tokens.byModel.${model}`, { origin: o, port: p })
    }
    compared('tokens.byPhase')
    if (JSON.stringify(Object.keys(theirs.cost.byPhase).sort()) !== JSON.stringify(Object.keys(facts.tokens.byPhase).sort())) cls('tokens.byPhase', 'phase-source')

    // Dispatches.
    const ours = new Map(facts.dispatches.map((d) => [d.agentId, d]))
    const reread = new Map()
    const missing = facts.dispatches.filter((d) => d.missing)
    if (missing.length > 0) cls('dispatches', 'missing-agent')
    compared('dispatches')
    if (theirs.facts.dispatches.length !== facts.dispatches.length - missing.length) fail(entry.change, 'dispatches', { origin: theirs.facts.dispatches.length, port: facts.dispatches.length - missing.length })
    for (const d of theirs.facts.dispatches) {
      const p = ours.get(d.agentId)
      compared('dispatch')
      if (!p) {
        fail(entry.change, 'dispatch', { agentId: d.agentId, port: 'absent' })
        continue
      }
      const theirClass = { role: d.role, task: d.task, round: d.round, exact: d.exact }
      const ourClass = { role: p.role, task: p.task, round: p.round, exact: p.exact }
      if (JSON.stringify(theirClass) !== JSON.stringify(ourClass)) {
        const rule = CLASSIFY.find((r) => r.match(d.description ?? '', theirClass, ourClass))
        if (rule) {
          cls(`dispatch ${d.agentId}`, rule.class)
          reread.set(d.agentId, d.role)
        } else fail(entry.change, 'classify', { description: d.description, origin: theirClass, port: ourClass })
      }
      const facts1 = { actor: d.actor, agentType: d.agentType === '(unknown)' ? null : d.agentType, model: d.model, turns: d.turns, tokens: { ...bucketOf(d), turns: d.turns, placeholderTurns: d.outputPlaceholderTurns } }
      const facts2 = { actor: p.actor, agentType: p.agentType, model: p.model, turns: p.turns, tokens: p.tokens }
      if (JSON.stringify(facts1) !== JSON.stringify(facts2)) fail(entry.change, 'dispatch', { agentId: d.agentId, origin: facts1, port: facts2 })
    }

    // Cache hit.
    compared('cacheHit')
    const t = facts.tokens.total
    const cacheable = t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input
    const hit = cacheable > 0 ? Number((t.cacheRead / cacheable).toFixed(4)) : null
    if (!near(theirs.cost.total.cacheHitRate, hit)) fail(entry.change, 'cacheHit', { origin: theirs.cost.total.cacheHitRate, port: hit })

    // Autonomy.
    for (const f of ['developerMessages', 'askUserQuestion', 'clears', 'sessions', 'rulings']) {
      compared(`autonomy.${f}`)
      const o = theirs.autonomy?.[f] ?? null
      const p = facts.autonomy[f] ?? null
      if (near(o, p)) continue
      if (f === 'developerMessages' && p - o === opsxLaunches(tv)) cls('autonomy.developerMessages', 'phase-command')
      else fail(entry.change, `autonomy.${f}`, { origin: o, port: p })
    }

    // Active minutes: the total; the per-phase split differs by phase source.
    compared('activeMinutes')
    const phases = Object.values(theirs.timing.byPhase ?? {})
    const o = phases.length === 0 ? null : Number(phases.reduce((a, b) => a + b, 0).toFixed(1))
    const p = facts.timing.activeMinutes.total
    if (!near(o, p)) {
      if (near(o, p, 0.05 * phases.length)) cls('activeMinutes', 'rounding')
      else fail(entry.change, 'activeMinutes', { origin: o, port: p })
    }
    if (JSON.stringify(Object.keys(theirs.timing.byPhase ?? {}).sort()) !== JSON.stringify(Object.keys(facts.timing.activeMinutes.byPhase).sort())) cls('activeMinutes.byPhase', 'phase-source')

    // Outliers.
    compared('outliers')
    const outlierKey = (x) => `${x.agentId}:${x.reasons.join('+')}`
    const [ox, px] = [theirs.facts.outliers.map(outlierKey).sort(), facts.outliers.map(outlierKey).sort()]
    if (ox.join() !== px.join()) {
      const theirRoles = outliers(facts.dispatches.map((d) => (reread.has(d.agentId) ? { ...d, role: reread.get(d.agentId) } : d)), maxTurns)
      if (reread.size > 0 && theirRoles.map(outlierKey).sort().join() === ox.join()) cls('outliers', 'classify-outlier')
      else fail(entry.change, 'outliers', { origin: ox, port: px, detail: facts.outliers })
    }
  }
} finally {
  scripts.remove()
}

if (!listAll) out.rows = out.rows.filter((r) => out.unexplained.some((u) => u.change === r.change))
console.log(JSON.stringify(out, null, 2))
process.exitCode = out.unexplained.length === 0 ? 0 : 1
