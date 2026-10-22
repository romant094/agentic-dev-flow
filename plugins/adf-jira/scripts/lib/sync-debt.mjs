// /adf-jira:sync-debt over the core's debt tree: one tracker issue mirrors a group of related
// debt entries, and the entries of a group hold its key in their Tracker cells. Everything here
// is deterministic; the agent decides only the grouping, which `checkGrouping` checks.
//
//   debtState      the tree's groups (key -> entries) and its keyless entries, each with the
//                  groups and keyless entries it relates to by block, sub-block or anchor file
//   checkGrouping  the agent's grouping decision against the tree
//   buildPlans     the create plan (one row per new group, a child of config.debtEpic) and the
//                  edit plan (one row per group, its description rendered again from the
//                  template, expecting config.statuses.initial and the template's shape, sent
//                  only when it differs), each row naming the entry ids it carries
//   trackResults   what the applied plans mean for the tree: the keys to write into entries, the
//                  entries that wait because their group's issue moved on, the rows not applied
//
// The grouping, one JSON object:
//   { version: 1,
//     join:   [{ key, entries: [id] }]        keyless entries joining the existing group key
//     create: [{ summary, entries: [id] }]    a new group, filed as one new issue
//     wait:   [{ entry, reason }] }           a keyless entry left keyless this run
// Every keyless entry is decided exactly once.
import { debtShape, renderDebtDescription } from './debt-description.mjs'
import { projectOf } from './plan.mjs'

export const GROUPING_KEYS = ['version', 'join', 'create', 'wait']
export const ATTACH = ['parent', 'epic-link']
export const SUMMARY_LIMIT = 255
const EPIC_LINK = 'Epic Link'

const posix = (...parts) => parts.filter(Boolean).join('/')
// The file of an anchor: the text before a `:<line>`; an anchor without one is its own file.
const anchorFile = (anchor) => /^(.*?):\d/.exec(anchor)?.[1] ?? anchor
const oneLine = (text) => typeof text === 'string' && text.trim() !== '' && !text.includes('\n')

function view(entry, blocks, root) {
  const block = blocks.find((b) => b.id === entry.block)
  return {
    id: entry.id,
    block: entry.block,
    subBlock: entry.subBlock,
    title: entry.title,
    anchors: entry.anchors,
    class: entry.class,
    files: block ? [posix(root, block.index), ...block.bodyFiles.map((f) => posix(root, f))] : []
  }
}

// How two entries relate, as the script can tell: the same block, the same sub-block of it, a
// shared anchor file. The subject is the agent's to judge.
function relation(a, b) {
  const by = []
  if (a.block === b.block) by.push('block')
  if (a.block === b.block && a.subBlock !== null && a.subBlock === b.subBlock) by.push('sub-block')
  const files = new Set(a.anchors.map(anchorFile))
  if (b.anchors.some((x) => files.has(anchorFile(x)))) by.push('anchor-file')
  return by
}

// `listed` is the core's `debt.mjs list --kind debt` result.
export function debtState(listed) {
  const { root, blocks, entries } = listed
  const debt = entries.filter((e) => e.kind === 'debt')
  const views = new Map(debt.map((e) => [e.id, view(e, blocks, root)]))
  const groups = new Map()
  for (const e of debt) if (e.tracker) groups.set(e.tracker, [...(groups.get(e.tracker) ?? []), views.get(e.id)])
  const keyless = debt.filter((e) => !e.tracker)
  return {
    root,
    // Every entry id in tree order, the order a description lists a group's entries in.
    order: debt.map((e) => e.id),
    groups: [...groups].map(([key, members]) => ({ key, entries: members })),
    keyless: keyless.map((e) => ({
      ...views.get(e.id),
      related: {
        groups: [...groups]
          .map(([key]) => ({ key, by: [...new Set(debt.filter((o) => o.tracker === key).flatMap((o) => relation(e, o)))] }))
          .filter((g) => g.by.length > 0),
        entries: keyless.filter((o) => o.id !== e.id).map((o) => ({ id: o.id, by: relation(e, o) })).filter((o) => o.by.length > 0)
      }
    }))
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function strayKeys(where, value, known, errors) {
  for (const k of Object.keys(value)) if (!known.includes(k)) errors.push(`${where}: unknown field ${k}; its fields are ${known.join(', ')}`)
}

// The errors of a grouping against the tree's state; [] when it passes.
export function checkGrouping(state, grouping) {
  const errors = []
  if (!isObject(grouping)) return ['the grouping is not a JSON object']
  strayKeys('the grouping', grouping, GROUPING_KEYS, errors)
  if (grouping.version !== 1) errors.push(`version is ${JSON.stringify(grouping.version)}, not 1`)
  const keyless = new Set(state.keyless.map((e) => e.id))
  const keyOf = new Map(state.groups.flatMap((g) => g.entries.map((e) => [e.id, g.key])))
  const groupKeys = new Set(state.groups.map((g) => g.key))
  const decided = new Map()
  const decide = (id, where) => {
    if (typeof id !== 'string' || id === '') return errors.push(`${where}: an entry id is not text`)
    if (keyOf.has(id)) return errors.push(`${where}: ${id} is already tracked as ${keyOf.get(id)}; only a keyless entry is decided`)
    if (!keyless.has(id)) return errors.push(`${where}: no entry ${id} in the tree`)
    if (decided.has(id)) return errors.push(`${where}: ${id} is already decided in ${decided.get(id)}; decide each entry once`)
    decided.set(id, where)
  }
  const list = (name) => {
    const value = grouping[name] ?? []
    if (!Array.isArray(value)) {
      errors.push(`${name} is not a list`)
      return []
    }
    return value
  }
  const entriesOf = (item, where) => {
    if (!Array.isArray(item.entries) || item.entries.length === 0) return errors.push(`${where}: entries is not a non-empty list of entry ids`)
    for (const id of item.entries) decide(id, where)
  }
  const joined = new Set()
  list('join').forEach((item, i) => {
    const where = `join[${i}]`
    if (!isObject(item)) return errors.push(`${where} is not an object`)
    strayKeys(where, item, ['key', 'entries'], errors)
    if (!groupKeys.has(item.key)) errors.push(`${where}: ${JSON.stringify(item.key ?? null)} is not the key of a group in the tree; a join names an existing group`)
    else if (joined.has(item.key)) errors.push(`${where}: ${item.key} is joined twice; list its entries once`)
    joined.add(item.key)
    entriesOf(item, where)
  })
  list('create').forEach((item, i) => {
    const where = `create[${i}]`
    if (!isObject(item)) return errors.push(`${where} is not an object`)
    strayKeys(where, item, ['summary', 'entries'], errors)
    if (!oneLine(item.summary)) errors.push(`${where}: summary is not one line of text`)
    else if (item.summary.includes('`')) errors.push(`${where}: summary holds a backtick; the summary is a plain paraphrase`)
    else if (item.summary.trim().length > SUMMARY_LIMIT) errors.push(`${where}: summary is longer than ${SUMMARY_LIMIT} characters`)
    entriesOf(item, where)
  })
  list('wait').forEach((item, i) => {
    const where = `wait[${i}]`
    if (!isObject(item)) return errors.push(`${where} is not an object`)
    strayKeys(where, item, ['entry', 'reason'], errors)
    if (!oneLine(item.reason)) errors.push(`${where}: reason is not one line of text`)
    decide(item.entry, where)
  })
  const undecided = state.keyless.map((e) => e.id).filter((id) => !decided.has(id))
  if (undecided.length) errors.push(`undecided: ${undecided.join(', ')}; every keyless entry joins a group, forms a new one, or waits with a reason`)
  return errors
}

export class PlanRefusal extends Error {}
const refuse = (message) => {
  throw new PlanRefusal(message)
}

// The create fields of a new group's issue, by the epic model conventions.md records: a child
// carrying `parent`, or a standard issue carrying the Epic Link field. No assignee, priority or
// estimate: those are the tracker's planning, set by a person.
function createFields({ facts, epic, type, attach, summary, description }) {
  const project = projectOf(epic)
  const issueType = (facts.issueTypes ?? []).find((t) => t.name === type)
  if (!issueType) refuse(`the issue type "${type}" is not in discovered.json (${(facts.issueTypes ?? []).map((t) => t.name).join(', ') || 'none'})`)
  const fields = { project: { key: project }, issuetype: { name: type }, summary, description }
  if (attach === 'parent') fields.parent = { key: epic }
  else {
    const id = facts.fieldMap?.[EPIC_LINK]
    if (!id) refuse(`the field "${EPIC_LINK}" is not in the profile's field map; the epic-link model needs it`)
    fields[id] = epic
  }
  if ((issueType.requiredFields ?? []).includes('reporter')) fields.reporter = { name: '<JIRA_ASSIGNEE>' }
  const missing = (issueType.requiredFields ?? []).filter((f) => !Object.hasOwn(fields, f))
  if (missing.length) refuse(`the issue type "${type}" requires ${missing.join(', ')}, which a debt mirror does not fill; choose another type in conventions.md`)
  return fields
}

// { create, edit, waiting, preview }: create and edit are plan objects, or null when they have
// no row. input: { state, grouping, config, facts, template, type, attach }. Throws a refusal
// naming what to fix; nothing is written here.
export function buildPlans({ state, grouping, config, facts, template, type, attach }) {
  const errors = checkGrouping(state, grouping)
  if (errors.length) refuse(`the grouping is refused: ${errors.join('; ')}`)
  const order = new Map(state.order.map((id, i) => [id, i]))
  const byTree = (a, b) => order.get(a.id) - order.get(b.id)
  const keyless = new Map(state.keyless.map((e) => [e.id, e]))
  const allowed = (key) => !config.allowlist || config.allowlist.includes(projectOf(key))
  const description = (entries) => renderDebtDescription(template, { root: state.root, entries })
  const preview = []

  const creates = grouping.create ?? []
  let create = null
  if (creates.length) {
    const epic = config.debtEpic
    if (!epic) refuse('config.debtEpic names no epic; ask the developer for the epic key and set it in the adf-jira config')
    if (!allowed(epic)) refuse(`the epic ${epic} is outside the allowlist (${config.allowlist.join(', ')})`)
    if (!type) refuse('a new group needs --type, the issue type conventions.md records for a child of the debt epic')
    if (!ATTACH.includes(attach)) refuse(`a new group needs --attach ${ATTACH.join(' or ')}, the epic model conventions.md records`)
    const rows = creates.map((g) => {
      const ids = g.entries.map((id) => keyless.get(id)).sort(byTree).map((e) => e.id)
      const summary = g.summary.trim()
      preview.push(`create ${type} under ${epic}: "${summary}" — ${ids.join(', ')}`)
      return {
        key: '(new)',
        project: projectOf(epic),
        summary,
        entries: ids,
        steps: [{ create: { fields: createFields({ facts, epic, type, attach, summary, description: description(ids.map((id) => keyless.get(id))) }) } }],
        state: 'pending'
      }
    })
    create = { version: 1, operation: 'create', purpose: 'sync-debt', allowlist: [projectOf(epic)], discoveredAt: facts.discoveredAt, rows }
  }

  const joins = new Map((grouping.join ?? []).map((j) => [j.key, j.entries]))
  const rows = []
  for (const group of state.groups) {
    const added = (joins.get(group.key) ?? []).map((id) => keyless.get(id)).sort(byTree).map((e) => e.id)
    if (!allowed(group.key)) {
      if (added.length) refuse(`${added.join(', ')} join ${group.key}, which is outside the allowlist (${config.allowlist.join(', ')})`)
      preview.push(`${group.key}: outside the allowlist; not read and not edited`)
      continue
    }
    const initial = config.statuses?.initial
    if (!initial) refuse('config.statuses.initial names no initial status; set it to the status a new issue starts in (conventions.md records it), so a group whose issue moved on is never edited')
    const entries = [...group.entries, ...added.map((id) => keyless.get(id))].sort(byTree)
    preview.push(
      added.length
        ? `${group.key}: ${added.join(', ')} join; its description is rendered again from ${entries.length} entries, sent only while it is ${initial} and its description has the template's shape, else the joining entries wait`
        : `${group.key}: its description is rendered again from ${entries.length} entries, sent only if it differs, while it is ${initial} and has the template's shape`
    )
    rows.push({
      key: group.key,
      summary: `entries ${entries.map((e) => e.id).join(', ')}`,
      from: initial,
      body: { shape: debtShape(template, { root: state.root }) },
      entries: entries.map((e) => e.id),
      joins: added,
      steps: [{ fields: { description: description(entries) } }],
      state: 'pending'
    })
  }
  const edit = rows.length ? { version: 1, operation: 'edit', purpose: 'sync-debt', allowlist: [...new Set(rows.map((r) => projectOf(r.key)))], discoveredAt: facts.discoveredAt, rows } : null
  const waiting = (grouping.wait ?? []).map(({ entry, reason }) => ({ entry, reason }))
  for (const w of waiting) preview.push(`${w.entry} waits: ${w.reason}`)
  return { create, edit, waiting, preview }
}

// What the applied plans mean for the tree. `plans` are plan objects as the apply run left them.
// { track: [{ id, key }], waiting: [{ id, key, reason }], untouched: [{ key, reason }],
//   notApplied: [{ key, entries, reason }], created, updated, unchanged }
export function trackResults(plans) {
  const out = { track: [], waiting: [], untouched: [], notApplied: [], created: [], updated: [], unchanged: [] }
  for (const plan of plans) {
    if (plan.purpose !== 'sync-debt') throw new PlanRefusal(`a plan of ${plan.purpose ?? 'another skill'}, not of sync-debt`)
    for (const row of plan.rows) {
      const entries = row.entries ?? []
      const joins = row.joins ?? []
      if (row.state === 'done') {
        if (plan.operation === 'create') {
          if (!row.createdKey) throw new PlanRefusal(`a done create row of ${entries.join(', ')} carries no createdKey`)
          out.created.push(row.createdKey)
          for (const id of entries) out.track.push({ id, key: row.createdKey })
        } else {
          ;(row.note ? out.unchanged : out.updated).push(row.key)
          for (const id of joins) out.track.push({ id, key: row.key })
        }
      } else if (row.state === 'skipped-drift') {
        for (const id of joins) out.waiting.push({ id, key: row.key, reason: row.error ?? 'skipped' })
        out.untouched.push({ key: row.key, reason: row.error ?? 'skipped' })
      } else {
        out.notApplied.push({ key: row.createdKey ?? row.key, entries: plan.operation === 'create' ? entries : joins, reason: row.state === 'pending' ? 'not applied' : (row.error ?? row.state) })
      }
    }
  }
  return out
}
