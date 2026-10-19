// The retrospective's agent: what it reads, how its reply is checked and what is computed from
// it. One agent at level `architecture` (`retro <id>`, lib/dispatch.mjs) reasons over a window
// of archived changes and replies in JSON under schema/retro.schema.json; it assesses how the flow
// worked and writes no debt. Its findings stay in the sidecar; the `upstream` role files them.
//
//   input    the agent's input.json, from the sidecar (lib/window.mjs buildSidecar) and the
//            window's records and attempts logs read from the ref's tree: per change a summary
//            of its record, the ledger's deviations and rulings, the review stage's dispositions
//            and verify's checks and warnings where the record has them, and the signals below;
//            the delta, the removal candidates and what else may be named, the waiting items,
//            the plugins in force, and `values`, every key the reply may cite with its value
//   check    the rules of a reply the schema cannot state (see `check`)
//   compute  the reply with every key resolved to its value, each finding's plugin version from
//            its manifest, the decisions in the waiting list's order and the improvements
//            ordered by the value of their saving, highest first
//
// The keys of `values` are dot paths named after the sidecar's fields. A metric key holds dots of
// its own (`quality.findings.re-review`), so a key is looked up whole, never split:
//
//   aggregates.<metric>.<stat>        stat n, mean, median, perTask, perKloc, iqr, cv
//   delta.<metric>.<stat>             the current value less the previous window's
//   coverage.records, coverage.changes, candidates.records
//   changes.<name>.values.<metric>    one change's value of a metric
//   changes.<name>.tasks, changes.<name>.git.<diffLines | fixesAfter | exposureDays>
//   changes.<name>.signals.<lateCaught | prematureDone>
//   changes.<name>.review.rounds, changes.<name>.review.dispositions.<as>
//   changes.<name>.verify.checks.<id> (a verdict), changes.<name>.verify.warnings
//   changes.<name>.ledger.deviations, changes.<name>.ledger.rulings
//
// A value that was not measured has no key: no data is never cited as a figure.
//
// The signals, computed per change from its record and its archived attempts.jsonl:
//   lateCaught     the review stage's findings and the failed (or ruled) verify checks, when
//                  every task's last accepted review or re-review was clean; 0 when one was not
//   prematureDone  each impl or fix reply computed DONE that its task's next accepted review or
//                  re-review sent back to fixing, or, for an impl, that a re-review round followed
//   reDerivation   not counted: a record carries no file reads per dispatch
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEvents, readLog, recordDispatchAt, recordReplyAt, standing } from './attempts.mjs'
import { dispatchName, parseName, retroDir } from './dispatch.mjs'
import { installedPath } from './installed.mjs'
import { generatorOf, RECORD_FILE } from './metrics.mjs'
import { LAYERS } from './metrics-records.mjs'
import { checkReply, replyContext } from './reply.mjs'
import { claudeHome, readJson } from './superpowers.mjs'
import { readBlobs, recordOf } from './window.mjs'

export const INPUT_VERSION = 1
export const ATTEMPTS_FILE = 'attempts.jsonl'
export const NONE = 'none'
export const STATS = ['n', 'mean', 'median', 'perTask', 'perKloc', 'iqr', 'cv']
export const RE_DERIVATION_REASON = 'not counted: a metrics record carries no file reads per dispatch'
export const retroAttemptsFile = (root, id) => join(retroDir(root, id), ATTEMPTS_FILE)

const num = (v) => typeof v === 'number' && Number.isFinite(v)
const round4 = (v) => Number(v.toFixed(4))
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- signals

const TASK_REVIEWS = ['review', 're-review']
const DONE_ROLES = ['impl', 'fix']
const taskOf = (e) => parseName(e.name)

// Review-stage findings and failed verify checks once every task review passed.
export function lateCaught(record, events) {
  if (events === null) return { value: null, reason: `no ${ATTEMPTS_FILE} in the archive directory` }
  const last = new Map()
  for (const e of events) {
    const p = taskOf(e)
    if (e.event === 'valid' && p?.task !== undefined && TASK_REVIEWS.includes(p.role) && typeof e.result?.result === 'string') last.set(p.task, e.result.result)
  }
  if (last.size === 0) return { value: null, reason: `no accepted task review with a result in ${ATTEMPTS_FILE}` }
  const open = [...last].filter(([, result]) => result !== 'clean').map(([task]) => task)
  if (open.length > 0) return { value: 0, taskReviewsPassed: false, notClean: open.sort((a, b) => a - b), caught: [] }
  const caught = []
  const review = record?.findings?.['ai-review']?.findings
  if (num(review) && review > 0) caught.push({ stage: 'review', findings: review })
  for (const [check, verdict] of Object.entries(record?.verify?.checks ?? {})) if (verdict === 'fail' || verdict === 'ruled') caught.push({ stage: 'verify', check, verdict })
  return { value: caught.reduce((n, c) => n + (c.findings ?? 1), 0), taskReviewsPassed: true, caught }
}

// Each DONE impl or fix reply of a task that the task's next events show was not done: up to the
// task's next accepted impl or fix, an accepted review or re-review with result `fix`, or, after
// an impl, a re-review dispatched at all.
export function prematureDone(events) {
  if (events === null) return { value: null, reason: `no ${ATTEMPTS_FILE} in the archive directory` }
  const cases = []
  events.forEach((e, i) => {
    const p = taskOf(e)
    if (e.event !== 'valid' || p?.task === undefined || !DONE_ROLES.includes(p.role) || e.result?.status !== 'DONE') return
    const later = events.slice(i + 1).filter((x) => taskOf(x)?.task === p.task)
    const next = later.findIndex((x) => x.event === 'valid' && DONE_ROLES.includes(taskOf(x).role))
    const span = next === -1 ? later : later.slice(0, next)
    const failing = span.find((x) => x.event === 'valid' && TASK_REVIEWS.includes(taskOf(x).role) && x.result?.result === 'fix')
    const round = p.role === 'impl' ? span.find((x) => taskOf(x).role === 're-review') : undefined
    const by = failing ?? round
    if (by) cases.push({ task: p.task, done: e.name, at: e.at ?? null, by: by.name, how: failing ? 'failing review' : 're-review round' })
  })
  return { value: cases.length, cases }
}

// ---------------------------------------------------------------- input

// The plugins a finding may name: the core, each enabled plugin and each plugin installed for
// this project, with the version its manifest gives. An enabled plugin's manifest wins.
export function pluginsInForce(root, { home = claudeHome() } = {}) {
  const out = new Map()
  const generator = generatorOf(root, { home }).value
  if (generator) {
    out.set(generator.plugin, { name: generator.plugin, version: generator.version, source: 'core' })
    for (const [name, version] of Object.entries(generator.plugins)) out.set(name, { name, version, source: 'enabled' })
  }
  for (const id of Object.keys(readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins ?? {})) {
    let dir
    try {
      dir = installedPath(id, root, { home })
    } catch {
      continue
    }
    const manifest = readJson(join(dir, '.claude-plugin', 'plugin.json'))
    if (typeof manifest?.name !== 'string' || typeof manifest.version !== 'string') continue
    const known = out.get(manifest.name)
    out.set(manifest.name, known ? { ...known, id } : { name: manifest.name, version: manifest.version, source: 'installed', id })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]))

// One change of the input, and the keys it adds to `values`.
function changeInput(c, record, events, put) {
  const at = `changes.${c.change}`
  for (const [metric, value] of Object.entries(c.values ?? {})) put(`${at}.values.${metric}`, value)
  put(`${at}.tasks`, c.tasks)
  for (const field of ['diffLines', 'fixesAfter', 'exposureDays']) put(`${at}.git.${field}`, c.git?.[field])
  const signals = { lateCaught: lateCaught(record, events), prematureDone: prematureDone(events), reDerivation: { value: null, reason: RE_DERIVATION_REASON } }
  put(`${at}.signals.lateCaught`, signals.lateCaught.value)
  put(`${at}.signals.prematureDone`, signals.prematureDone.value)
  const out = {
    change: c.change,
    archiveDir: c.archiveDir,
    branch: c.branch,
    mergedAt: c.mergedAt,
    tasks: c.tasks,
    record: c.record,
    generator: c.generator ?? null,
    gaps: Object.fromEntries(Object.entries(c.coverage ?? {}).filter(([, v]) => v?.none).map(([group, v]) => [group, v.none])),
    summary: record ? pick(record, ['impl', 'replies', 'tests', 'outliers']) : null,
    signals
  }
  if (record?.ledger) {
    const { deviations, rulings } = record.ledger
    out.ledger = { deviations, rulings }
    put(`${at}.ledger.deviations`, deviations.length)
    put(`${at}.ledger.rulings`, rulings)
  }
  if (record?.review) {
    const { verdict, rounds, dispositions, stopped } = record.review
    out.review = { verdict, rounds, dispositions, recorded: dispositions.recorded ?? 0, accepted: dispositions.accepted ?? 0, stopped }
    put(`${at}.review.rounds`, rounds)
    for (const [as, n] of Object.entries(dispositions)) put(`${at}.review.dispositions.${as}`, n)
  }
  if (record?.verify) {
    const { verdict, checks, warnings } = record.verify
    out.verify = { verdict, checks, warnings }
    for (const [id, v] of Object.entries(checks)) put(`${at}.verify.checks.${id}`, v)
    put(`${at}.verify.warnings`, warnings.length)
  }
  if (record?.sources?.disagreements?.length) out.disagreements = record.sources.disagreements
  return out
}

// The retro agent's input.json from a sidecar. `root` is a checkout holding the sidecar's ref,
// whose tree gives each change's record and attempts log; `home` the Claude Code home.
export function input(sidecar, { root, home = claudeHome() } = {}) {
  const values = {}
  const put = (key, value) => {
    if (value !== null && value !== undefined && (typeof value === 'string' || num(value))) values[key] = value
  }
  for (const [metric, agg] of Object.entries(sidecar.aggregates ?? {})) for (const stat of STATS) put(`aggregates.${metric}.${stat}`, agg[stat])
  for (const kind of ['improved', 'worsened', 'unchanged']) for (const row of sidecar.delta?.[kind] ?? []) put(`delta.${row.metric}.${row.stat}`, round4(row.current - row.previous))
  put('coverage.records', sidecar.coverage?.records)
  put('coverage.changes', sidecar.coverage?.changes)
  put('candidates.records', sidecar.candidates?.records)

  const file = (c, name) => `${c.archiveDir}/${name}`
  const blobs = readBlobs(root, sidecar.ref, sidecar.changes.flatMap((c) => [file(c, RECORD_FILE), file(c, ATTEMPTS_FILE)]))
  const records = []
  const changes = sidecar.changes.map((c) => {
    const { record } = recordOf(blobs.get(file(c, RECORD_FILE)), `${sidecar.ref}:${file(c, RECORD_FILE)}`)
    if (record) records.push(record)
    const text = blobs.get(file(c, ATTEMPTS_FILE))
    return changeInput(c, record, text == null ? null : parseEvents(text), put)
  })

  const waiting = (sidecar.waiting ?? []).map((item) => {
    const metrics = item.metrics.map((m) => m.key ?? m)
    return { id: item.id, question: item.question, lessons: item.lessons, metrics, keys: Object.keys(values).filter((k) => metrics.some((m) => k.startsWith(`aggregates.${m}.`))) }
  })
  const checks = [...new Set(records.flatMap((r) => Object.keys(r.verify?.checks ?? {})))].sort()
  return {
    schemaVersion: INPUT_VERSION,
    date: sidecar.date,
    mode: sidecar.mode,
    ref: sidecar.ref,
    scope: sidecar.scope ?? null,
    cutoff: sidecar.cutoff ?? null,
    previous: sidecar.previous ?? null,
    flowVersions: sidecar.flowVersions ?? [],
    changes,
    delta: sidecar.delta ?? null,
    candidates: sidecar.candidates ?? null,
    removable: {
      candidates: [...(sidecar.candidates?.layers ?? []), ...(sidecar.candidates?.checks ?? [])],
      layers: LAYERS,
      checks,
      rules: waiting.map((w) => w.id)
    },
    waiting,
    plugins: pluginsInForce(root, { home }),
    keys: Object.keys(values),
    values
  }
}

// ---------------------------------------------------------------- check and compute

// What a removal candidate's name is: computed, or a layer, check or rule the input lists.
function kindOf(name, removable) {
  if (removable.candidates.includes(name)) return 'candidate'
  if (removable.layers.includes(name)) return 'layer'
  if (removable.checks.includes(name)) return 'check'
  if (removable.rules.includes(name)) return 'rule'
  return null
}

// The rules of a reply the schema cannot state: every evidence, cost, basis and saving key is a
// key of the input's values, and a saving's value is a number; every waiting item is answered
// exactly once and no other; the removal candidate is computed or listed, with a basis, or
// `none`; a finding's plugin is enabled or installed, its changes are the retrospective's, its
// id is unique; nothingFound is true exactly when there is no finding.
export function check(reply, input) {
  const errors = []
  const known = new Set(input.keys)
  const keys = (list, path) => {
    list.forEach((k, i) => {
      if (!known.has(k)) errors.push(`${path}[${i}]: ${k} is not a key of the input's values`)
    })
  }

  if (reply.nothingFound && reply.findings.length > 0) errors.push(`$.nothingFound: true, yet the reply has ${reply.findings.length} finding${reply.findings.length === 1 ? '' : 's'}`)
  if (!reply.nothingFound && reply.findings.length === 0) errors.push('$.nothingFound: false, yet the reply has no finding; nothing found is said with true')

  const changes = new Set(input.changes.map((c) => c.change))
  const plugins = input.plugins.map((p) => p.name)
  const ids = new Set()
  reply.findings.forEach((f, i) => {
    const at = `$.findings[${i}]`
    if (ids.has(f.id)) errors.push(`${at}.id: ${f.id} is used twice`)
    ids.add(f.id)
    f.changes.forEach((name, j) => {
      if (!changes.has(name)) errors.push(`${at}.changes[${j}]: ${name} is not a change of this retrospective`)
    })
    keys(f.evidence, `${at}.evidence`)
    if (f.cost !== null && !known.has(f.cost)) errors.push(`${at}.cost: ${f.cost} is not a key of the input's values`)
    if (f.plugin !== null && !plugins.includes(f.plugin)) errors.push(`${at}.plugin: ${f.plugin} is neither enabled nor installed; known: ${plugins.join(', ') || 'none'}`)
  })

  const items = input.waiting.map((w) => w.id)
  const answered = new Set()
  reply.decisions.forEach((d, i) => {
    if (!items.includes(d.item)) errors.push(`$.decisions[${i}].item: ${d.item} is not an item waiting for data`)
    else if (answered.has(d.item)) errors.push(`$.decisions[${i}].item: ${d.item} is answered twice`)
    answered.add(d.item)
    keys(d.basis, `$.decisions[${i}].basis`)
  })
  for (const id of items) if (!answered.has(id)) errors.push(`$.decisions: the waiting item ${id} is not answered`)

  const candidate = reply.removalCandidate
  if (candidate.name !== NONE) {
    if (!kindOf(candidate.name, input.removable)) errors.push(`$.removalCandidate.name: ${candidate.name} is no computed candidate and no layer, check or rule the input lists; name one of them, or ${NONE} with the reason`)
    else if (candidate.basis.length === 0) errors.push('$.removalCandidate.basis: a named candidate cites at least one key')
  }
  keys(candidate.basis, '$.removalCandidate.basis')

  reply.improvements.forEach((m, i) => {
    if (!known.has(m.saving)) errors.push(`$.improvements[${i}].saving: ${m.saving} is not a key of the input's values`)
    else if (!num(input.values[m.saving])) errors.push(`$.improvements[${i}].saving: ${m.saving} holds no number to order by`)
  })
  return errors
}

// The accepted reply, every key resolved to `{ key, value }`.
export function compute(reply, input) {
  const resolved = (key) => ({ key, value: input.values[key] })
  const version = (name) => input.plugins.find((p) => p.name === name)?.version ?? null
  const order = input.waiting.map((w) => w.id)
  const candidate = reply.removalCandidate
  return {
    nothingFound: reply.nothingFound,
    findings: reply.findings.map((f) => ({ ...f, evidence: f.evidence.map(resolved), cost: f.cost === null ? null : resolved(f.cost), version: f.plugin === null ? null : version(f.plugin) })),
    decisions: [...reply.decisions].sort((a, b) => order.indexOf(a.item) - order.indexOf(b.item)).map((d) => ({ ...d, basis: d.basis.map(resolved) })),
    removalCandidate: { ...candidate, kind: candidate.name === NONE ? NONE : kindOf(candidate.name, input.removable), basis: candidate.basis.map(resolved) },
    improvements: reply.improvements
      .map((m, i) => ({ m: { ...m, saving: resolved(m.saving) }, i }))
      .sort((a, b) => b.m.saving.value - a.m.saving.value || a.i - b.i)
      .map(({ m }) => m)
  }
}

// ---------------------------------------------------------------- attempts

// One dispatch of the retro `id`, in the retrospective's own log: { name, attempt, next }.
export function recordRetroDispatch(root, id, options) {
  return recordDispatchAt(retroAttemptsFile(root, id), dispatchName({ role: 'retro', id }), options)
}

// The retro's reply file checked (lib/reply.mjs, the input read from the retrospective's
// input.json) and recorded: { name, ok, valid, errors, next, mode, invalid, replyFile, log,
// result? }. A refused reply gives `retry` once, then `stop`; a stopped retro's reply is not
// checked, and recording it is refused. A missing reply file is a refused reply.
export function recordRetroReply(root, id, { file, resume = true, now } = {}) {
  const name = dispatchName({ role: 'retro', id })
  const log = retroAttemptsFile(root, id)
  const path = resolve(root, file)
  let errors = []
  let result
  if (standing(readLog(log), name).next !== 'stop') {
    const text = readOr(path)
    if (text === null) errors = [`no reply file ${path}: a reply that is prose and no file is a refusal`]
    else {
      const checked = checkReply('retro', text, () => replyContext(root, undefined, name))
      errors = checked.errors
      if (checked.valid) result = checked.result
    }
  }
  const recorded = recordReplyAt(log, { name, file: path, errors, result, resume, ...(now ? { now } : {}) })
  return { name, ...recorded, ...(result === undefined ? {} : { result }) }
}
