// Propose's scope: what one change takes on, gathered before its branch is made. Whatever the
// start (tracker keys, a phrase, or neither), the core gathers what fits the same change: the
// technical debt store always, the tracker when a provider is enabled (the `tracker` role,
// contract 1.7), and the in-flight changes whose scope already holds a gathered key. The
// developer selects each item (taken, partial or excluded, each non-taken with a reason); one
// read-only `scope-check <KEY>` agent checks each taken or partial item, and its JSON reply is
// checked here; the developer answers the questions in one message; a bug that does not
// reproduce is sent back for a retest; after the branch and worktree exist, the taken tracker
// issues are started. Every tracker write holds for the developer's yes.
//
// State: <main>/.superpowers/sdd/<change>/scope/scope.json (gitignored, in the main checkout,
// so it outlives the worktree), the check inputs and prompts under check/, the replies under
// replies/; the tracker's own files under <main>/.superpowers/sdd/<change>/tracker/ (its
// stateDir). Once the change exists, every write is mirrored into
// openspec/changes/<change>/scope.json of the change worktree, which the propose commit carries.
// A scope with no item and no skipped tracker is not mirrored: propose then runs as it did
// before scopes existed.
//
// The scope record:
//   { version: 1, change, from: { keys, text }, tracker, items, inFlight, flagsShown, base,
//     start, retest }
//   tracker  { state: done | none | skipped | degraded, plugin, account?, reason?, tool?,
//              hint?, notes, absent? }
//   item     { source: tracker | debt, key, title, kind, state: candidate | taken | partial |
//              excluded, reason, verdict, check, flags, ... }
//            tracker: url, status, open, parent, links, branchToken, branchRank, file
//            debt:    block, class, anchors, tracker, files, matched (key | text)
//   paths are relative to the main checkout, so the committed record names no machine path.
//
// The debt text match is deterministic: the words of the phrase (or, with no key and no phrase,
// of the change name) of at least four letters, lowercased, minus a fixed list of common words;
// an entry matches when its title holds at least two of them (one, for a phrase of one word).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBranches } from './branches.mjs'
import { listTree } from './debt.mjs'
import { SCOPE_KEY, SCOPE_ROLES, scopeCheckName, sddDir } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { readDebtRoot, readRegistry } from './registry.mjs'
import { checkouts } from './resolve.mjs'
import { callRole, knowledgeReport, TRACKER_SKIPPED, trackerReport } from './roles.mjs'
import { worktreePath } from './workspace.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SCOPE_SCHEMA = join(PLUGIN_ROOT, 'schema', SCOPE_ROLES['scope-check'].schema)
const PROMPT = join(PLUGIN_ROOT, 'schema', 'prompts', 'scope-check.md')
export const SCOPE_FILE = 'scope.json'
export const SECTION = 'Scope sources'
export const RETEST_REASON = 'does not reproduce; sent to retest'
const IN_SCOPE = ['taken', 'partial']
const SETTLED = ['current', 'corrected']

export class Refusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}
const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

export const scopeDir = (main, change) => join(sddDir(main, change), 'scope')
export const trackerDir = (main, change) => join(sddDir(main, change), 'tracker')
export const scopeFile = (main, change) => join(scopeDir(main, change), SCOPE_FILE)
export const changeScopeFile = (root, change) => join(root, 'openspec', 'changes', change, SCOPE_FILE)
const posix = (path) => path.split(sep).join('/')
const relMain = (main, path) => (isAbsolute(path) ? posix(relative(main, path)) : posix(path))
const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_')
const CHANGE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// ---------------------------------------------------------------- state

export function readScope(main, change) {
  const file = scopeFile(main, change)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// A scope worth committing: it holds an item, or records that the tracker was skipped.
export const recordable = (scope) => Boolean(scope && (scope.items.length > 0 || scope.tracker?.state === 'skipped'))

// The change's own copy, in its worktree, once `propose.mjs create` made it.
function changeCopy(main, change) {
  const dir = join(worktreePath(main, change), 'openspec', 'changes', change)
  return existsSync(dir) ? join(dir, SCOPE_FILE) : null
}

export function writeScope(main, change, scope) {
  const file = scopeFile(main, change)
  mkdirSync(dirname(file), { recursive: true })
  const text = `${JSON.stringify(scope, null, 2)}\n`
  writeFileSync(file, text)
  const copy = changeCopy(main, change)
  if (copy && recordable(scope)) writeFileSync(copy, text)
  return scope
}

function load(root, change) {
  if (!CHANGE.test(change ?? '')) refuse(`"${change ?? ''}" is not a kebab-case change name`)
  const main = mainCheckout(root)
  const scope = readScope(main, change)
  return { main, scope }
}

function requireScope(root, change) {
  const { main, scope } = load(root, change)
  if (!scope) refuse(`${change} has no scope yet; run scope.mjs gather --change ${change} first`)
  return { main, scope }
}

const itemOf = (scope, key) => {
  const item = scope.items.find((i) => i.key === key)
  if (!item) refuse(`${key} is not an item of the scope; its items: ${scope.items.map((i) => i.key).join(', ') || 'none'}`)
  return item
}

// ---------------------------------------------------------------- the tracker call

// The tracker role, or none on a host with no registry.
function tracker(root, operation, input, core) {
  if (!readRegistry(root)) return { state: 'none', point: 'tracker' }
  return callRole(root, 'tracker', operation, input, core)
}

const keyOf = (entry) => (typeof entry === 'string' ? entry : entry?.key)

// ---------------------------------------------------------------- words

const STOP = new Set(['about', 'after', 'again', 'also', 'before', 'being', 'change', 'could', 'does', 'each', 'from', 'have', 'into', 'just', 'make', 'more', 'must', 'only', 'other', 'over', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'when', 'where', 'which', 'will', 'with', 'would'])

export function phraseWords(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => [...w].length >= 4 && !STOP.has(w))
  return [...new Set(words)]
}

// Whether a title matches the phrase's words: two of them, or one for a phrase of one word.
export function matchesPhrase(title, words) {
  if (words.length === 0) return false
  const own = new Set(phraseWords(title))
  return words.filter((w) => own.has(w)).length >= Math.min(2, words.length)
}

// ---------------------------------------------------------------- gather

const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

function trackerItem(main, change, raw) {
  const key = text(raw?.key)
  if (!SCOPE_KEY.test(key)) refuse(`the tracker returned an item with the key "${key}", which is not a scope key`)
  const file = raw.file ? relMain(main, isAbsolute(raw.file) ? raw.file : join(trackerDir(main, change), raw.file)) : null
  return {
    source: 'tracker',
    key,
    title: text(raw.title),
    kind: text(raw.kind || 'task').toLowerCase(),
    url: raw.url ?? null,
    status: raw.status ?? null,
    open: raw.open !== false,
    parent: raw.parent ?? null,
    links: Array.isArray(raw.links) ? raw.links.filter((l) => l && typeof l.key === 'string').map((l) => ({ key: l.key, relation: text(l.relation) })) : [],
    branchToken: text(raw.branchToken || key),
    branchRank: Number.isFinite(raw.branchRank) ? raw.branchRank : null,
    excluded: raw.excluded ? text(raw.excluded) : null,
    flags: [...new Set((Array.isArray(raw.flags) ? raw.flags : []).map(text).filter(Boolean))],
    file
  }
}

function debtItems(main, { keys, words }) {
  const root = readDebtRoot(main)
  if (!root) return { store: null, items: [] }
  const tree = join(main, root)
  const { blocks, entries } = listTree(tree, { kind: 'debt' })
  const items = []
  for (const e of entries) {
    const matched = e.tracker && keys.has(e.tracker) ? 'key' : keys.has(e.id) ? 'key' : matchesPhrase(e.title, words) ? 'text' : null
    if (!matched) continue
    const block = blocks.find((b) => b.id === e.block)
    items.push({
      source: 'debt',
      key: e.id,
      title: e.title,
      kind: 'debt',
      class: e.class,
      block: e.block,
      anchors: e.anchors,
      tracker: e.tracker,
      matched,
      files: [posix(join(root, block.index)), ...block.bodyFiles.map((f) => posix(join(root, f)))],
      flags: []
    })
  }
  return { store: root, items }
}

// The other changes in flight, in any checkout, whose committed scope takes a key gathered here.
function inFlight(main, change, keys) {
  let roots
  try {
    roots = checkouts(main).map((c) => c.root)
  } catch {
    roots = [main]
  }
  const found = new Map()
  for (const root of roots) {
    const dir = join(root, 'openspec', 'changes')
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name === 'archive' || name === change || found.has(name)) continue
      const file = join(dir, name, SCOPE_FILE)
      if (!existsSync(file) || !statSync(file).isFile()) continue
      let other
      try {
        other = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const held = (other.items ?? []).filter((i) => IN_SCOPE.includes(i.state) && keys.has(i.key)).map((i) => i.key)
      if (held.length) found.set(name, { change: name, checkout: root === main ? '.' : relMain(main, root), keys: held })
    }
  }
  return [...found.values()]
}

const KEPT = ['state', 'reason', 'verdict', 'check']

function trackerLine(t) {
  if (t.state === 'skipped') return `Tracker: skipped for this change (${t.reason}).`
  if (t.state === 'none') return trackerReport('gather', t)
  if (t.state === 'degraded') return `${t.report} Fix it and gather again, or gather again with --skip-tracker "<reason>".`
  return t.report
}

function debtLine(store, items) {
  if (!store) return 'Debt: none; the registry sets no debt.root.'
  if (items.length === 0) return 'Debt: no entry matches.'
  return `Debt: ${items.map((i) => `${i.key} (${i.matched === 'key' ? `tracker key ${i.tracker ?? i.key}` : 'phrase'})`).join(', ')}.`
}

// keys: tracker keys or debt ids the developer named; text: a phrase; skipTracker: the reason
// the developer gave for working without the tracker this time, after a degraded check.
export function gather(root, change, { keys = [], text: phrase = null, skipTracker = null, core }) {
  const { main, scope: previous } = load(root, change)
  for (const k of keys) if (!SCOPE_KEY.test(k)) refuse(`"${k}" is not a key: a key holds no space, colon, pipe or backtick`)
  const stateDir = trackerDir(main, change)
  let t
  let raw = []
  if (skipTracker !== null) {
    if (skipTracker.trim() === '') refuse('--skip-tracker needs the reason the tracker is skipped')
    t = { state: 'skipped', plugin: null, reason: skipTracker.trim(), notes: [] }
  } else {
    const check = tracker(main, 'check', {}, core)
    const plugin = check.plugin ?? null
    if (check.state === 'refused') refuse(trackerReport('check', check), { tracker: check })
    if (check.state === 'none') t = { state: 'none', plugin: null, notes: [], ...(check.absent ? { absent: check.absent } : {}), report: trackerReport('gather', check) }
    else if (check.state === 'degraded') t = { state: 'degraded', plugin, tool: check.tool ?? null, hint: check.hint ?? null, notes: [], report: trackerReport('check', check) }
    else if (keys.length === 0 && !phrase) t = { state: 'done', plugin, account: check.account ?? null, notes: ['no key and no phrase; the tracker was not searched'], report: trackerReport('check', check) }
    else {
      mkdirSync(stateDir, { recursive: true })
      const got = tracker(main, 'gather', { ...(keys.length ? { keys } : {}), ...(phrase ? { text: phrase } : {}), change, stateDir }, core)
      if (got.state === 'refused') refuse(trackerReport('gather', got), { tracker: got })
      if (got.state === 'degraded') t = { state: 'degraded', plugin, tool: got.tool ?? null, hint: got.hint ?? null, notes: [], report: trackerReport('gather', got) }
      else if (got.state === 'none') t = { state: 'none', plugin, notes: [], report: trackerReport('gather', got) }
      else {
        raw = Array.isArray(got.items) ? got.items : []
        t = { state: 'done', plugin, account: check.account ?? null, notes: (got.notes ?? []).map(text), report: trackerReport('gather', got) }
      }
    }
  }
  const trackerItems = raw.map((r) => trackerItem(main, change, r))
  const keySet = new Set([...keys, ...trackerItems.map((i) => i.key)])
  const words = phraseWords(phrase ?? (keys.length ? '' : change.replace(/-/g, ' ')))
  const debt = debtItems(main, { keys: keySet, words })
  const items = [...trackerItems, ...debt.items]
  const seen = new Set()
  for (const i of items) {
    if (seen.has(i.key)) refuse(`two gathered items share the key ${i.key}; name the one meant with --keys`)
    seen.add(i.key)
  }
  const flying = inFlight(main, change, new Set(items.map((i) => i.key)))
  for (const f of flying) for (const k of f.keys) items.find((i) => i.key === k).flags.push(`in flight in change ${f.change}`)
  for (const item of items) {
    const before = previous?.items.find((p) => p.key === item.key && p.source === item.source)
    if (before) for (const k of KEPT) item[k] = before[k]
    else {
      item.state = item.excluded ? 'excluded' : 'candidate'
      item.reason = item.excluded ?? null
      item.verdict = null
      item.check = null
    }
  }
  // A flag is shown once: a gather again names only the flags no earlier gather showed.
  const shown = new Set(previous?.flagsShown ?? [])
  const flags = []
  for (const item of items) {
    for (const flag of item.flags) {
      const id = `${item.key}: ${flag}`
      if (!shown.has(id)) {
        shown.add(id)
        flags.push({ key: item.key, flag })
      }
    }
  }
  const scope = {
    version: 1,
    change,
    from: { keys, text: phrase },
    tracker: t,
    items,
    inFlight: flying,
    flagsShown: [...shown],
    base: previous?.base ?? null,
    start: previous?.start ?? null,
    retest: previous?.retest ?? null
  }
  writeScope(main, change, scope)
  const empty = items.length === 0 && flying.length === 0 && t.state !== 'degraded'
  const report = [
    trackerLine(t),
    ...t.notes.map((n) => `  note: ${n}`),
    debtLine(debt.store, debt.items),
    ...flying.map((f) => `In flight: change ${f.change} already takes ${f.keys.join(', ')}.`),
    ...flags.map((f) => `Flag: ${f.key}: ${f.flag}`)
  ].join('\n')
  return {
    ok: true,
    change,
    step: 'gather',
    tracker: { state: t.state, plugin: t.plugin, ...(t.hint ? { hint: t.hint, tool: t.tool } : {}), ...(t.reason ? { reason: t.reason } : {}) },
    items: items.map(summary),
    inFlight: flying,
    flags,
    empty,
    report,
    next: t.state === 'degraded'
      ? `the tracker is degraded: fix it and run gather again, or run scope.mjs gather --change ${change} --skip-tracker "<reason>"`
      : empty
        ? 'nothing to select: go on to the branch'
        : `select: scope.mjs select --change ${change} --take <keys> [--partial "<KEY>: <reason>"] [--exclude "<KEY>: <reason>"] [--rest "<reason>"]`
  }
}

export const summary = (i) => ({
  key: i.key,
  source: i.source,
  title: i.title,
  kind: i.kind,
  state: i.state,
  ...(i.reason ? { reason: i.reason } : {}),
  ...(i.status ? { status: i.status } : {}),
  ...(i.verdict ? { verdict: i.verdict } : {}),
  ...(i.flags?.length ? { flags: i.flags } : {})
})

// ---------------------------------------------------------------- select

// The key whose branch token names the branch: the taken or partial tracker item with the lowest
// rank. A tie is { tie: [keys] }, for the developer to choose; no ranked item is null.
export function branchKey(scope) {
  const ranked = (scope?.items ?? []).filter((i) => i.source === 'tracker' && IN_SCOPE.includes(i.state) && i.branchRank !== null && i.branchRank !== undefined)
  if (ranked.length === 0) return null
  const low = Math.min(...ranked.map((i) => i.branchRank))
  const best = ranked.filter((i) => i.branchRank === low)
  return best.length === 1 ? { key: best[0].key, token: best[0].branchToken } : { tie: best.map((i) => i.key) }
}

// take: keys; partial and exclude: [{ key, reason }]; rest: the reason every undecided item is
// excluded with.
export function select(root, change, { take = [], partial = [], exclude = [], rest = null }) {
  const { main, scope } = requireScope(root, change)
  if (scope.tracker.state === 'degraded') refuse(`the tracker is degraded; fix it and gather again, or gather again with --skip-tracker "<reason>"`)
  const choices = [...take.map((key) => ({ key, state: 'taken', reason: null })), ...partial.map((p) => ({ ...p, state: 'partial' })), ...exclude.map((e) => ({ ...e, state: 'excluded' }))]
  if (choices.length === 0 && rest === null) refuse('select needs --take, --partial, --exclude or --rest')
  const named = new Set()
  for (const c of choices) {
    if (named.has(c.key)) refuse(`${c.key} is named twice`)
    named.add(c.key)
    itemOf(scope, c.key)
    if (c.state !== 'taken' && !(c.reason ?? '').trim()) refuse(`${c.key}: a ${c.state} item needs a reason, as "<KEY>: <reason>"`)
  }
  for (const c of choices) {
    const item = itemOf(scope, c.key)
    item.state = c.state
    item.reason = c.reason?.trim() || null
  }
  if (rest !== null) {
    if (rest.trim() === '') refuse('--rest needs the reason the undecided items are excluded')
    for (const item of scope.items.filter((i) => i.state === 'candidate')) {
      item.state = 'excluded'
      item.reason = rest.trim()
    }
  }
  writeScope(main, change, scope)
  const undecided = scope.items.filter((i) => i.state === 'candidate').map((i) => i.key)
  return {
    ok: true,
    change,
    step: 'select',
    items: scope.items.map(summary),
    undecided,
    branch: branchKey(scope),
    next: undecided.length ? `decide ${undecided.join(', ')}: select again, or --rest "<reason>"` : `check-input: scope.mjs check-input --change ${change}`
  }
}

// ---------------------------------------------------------------- check-input

function gitText(root, ...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The commit the checks read: the integration branch as fetched, else as local, else HEAD.
function baseCommit(main) {
  const integration = readBranches(main)?.integration
  const refs = [...(integration ? [`origin/${integration}`, integration] : []), 'HEAD']
  for (const ref of refs) {
    const commit = gitText(main, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
    if (commit) return { ref, commit }
  }
  return { ref: null, commit: null }
}

function capabilities(main) {
  const dir = join(main, 'openspec', 'specs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'spec.md'))).sort()
}

const readText = (main, rel) => {
  try {
    return readFileSync(join(main, rel), 'utf8')
  } catch {
    return ''
  }
}

// The capabilities whose every name word the item's title or file holds.
function matchedSpecs(main, item, names) {
  const own = new Set(String(`${item.title} ${item.file ? readText(main, item.file) : ''}`).toLowerCase().split(/[^\p{L}\p{N}]+/u))
  return names.filter((name) => name.split('-').every((w) => own.has(w)))
}

function renderPrompt(fields) {
  return readFileSync(PROMPT, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
    .join('\n')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => fields[k] ?? '')
}

export function checkInput(root, change, { key = null, core }) {
  const { main, scope } = requireScope(root, change)
  const undecided = scope.items.filter((i) => i.state === 'candidate').map((i) => i.key)
  if (undecided.length) refuse(`decide ${undecided.join(', ')} first: scope.mjs select`)
  const targets = scope.items.filter((i) => IN_SCOPE.includes(i.state) && (key === null || i.key === key))
  if (key !== null && targets.length === 0) refuse(`${key} is not taken or partial; check-input writes the input of a taken or partial item`)
  scope.base = baseCommit(main)
  let knowledge = { state: 'none', point: 'knowledge' }
  if (readRegistry(main)) {
    try {
      knowledge = callRole(main, 'knowledge', 'context', {}, core)
    } catch (error) {
      knowledge = { state: 'refused', error: error.message }
    }
  }
  const index = knowledge.state === 'done' && typeof knowledge.index === 'string' && knowledge.index !== '' ? join(main, knowledge.index) : null
  const names = capabilities(main)
  const dir = scopeDir(main, change)
  mkdirSync(join(dir, 'check'), { recursive: true })
  mkdirSync(join(dir, 'replies'), { recursive: true })
  const abs = (rel) => join(main, rel)
  const dispatches = []
  for (const item of targets) {
    const linked = new Set([...(item.links ?? []).map((l) => l.key), ...(item.parent ? [item.parent] : []), ...(item.tracker ? [item.tracker] : [])])
    const related = scope.items.filter((i) => i.key !== item.key && (linked.has(i.key) || (i.links ?? []).some((l) => l.key === item.key) || i.parent === item.key))
    const debt = scope.items.filter((i) => i.source === 'debt' && (i.key === item.key || i.tracker === item.key))
    const inputFile = join(dir, 'check', `${fileKey(item.key)}.json`)
    const promptFile = join(dir, 'check', `${fileKey(item.key)}.prompt.md`)
    const replyFile = join(dir, 'replies', `${fileKey(item.key)}.json`)
    const name = scopeCheckName(item.key)
    const input = {
      name,
      change,
      key: item.key,
      source: item.source,
      kind: item.kind,
      title: item.title,
      state: item.state,
      reason: item.reason,
      ...(item.url ? { url: item.url } : {}),
      ...(item.status ? { status: item.status } : {}),
      issueFile: item.file ? abs(item.file) : null,
      related: related.map((r) => ({ key: r.key, source: r.source, title: r.title, file: r.file ? abs(r.file) : null, files: (r.files ?? []).map(abs) })),
      debt: debt.map((d) => ({ key: d.key, title: d.title, class: d.class, anchors: d.anchors, files: d.files.map(abs) })),
      knowledgeIndex: index,
      knowledge: knowledgeReport('context', knowledge),
      specs: { dir: join(main, 'openspec', 'specs'), matched: matchedSpecs(main, item, names) },
      base: scope.base,
      bug: item.kind === 'bug',
      replyFile,
      schema: SCOPE_SCHEMA
    }
    writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`)
    const level = SCOPE_ROLES['scope-check'].level
    writeFileSync(promptFile, renderPrompt({ name, level, key: item.key, change, inputFile, replyFile, schema: SCOPE_SCHEMA }))
    dispatches.push({ name, key: item.key, agent: `adf:${level}`, worktree: main, inputFile, promptFile, replyFile })
  }
  writeScope(main, change, scope)
  return {
    ok: true,
    change,
    step: 'check-input',
    base: scope.base,
    dispatches,
    next: dispatches.length
      ? `dispatch each, read-only and in parallel, with its promptFile; then scope.mjs check --change ${change} --key <KEY> --file <replyFile>`
      : 'nothing is taken or partial: go on to the branch'
  }
}

// ---------------------------------------------------------------- check

const hasSources = (x) => Array.isArray(x?.sources) && x.sources.length > 0

// The rules the schema cannot state, for a reply that passed the schema.
export function checkScopeReply(reply, item) {
  const errors = []
  if (reply.key !== item.key) errors.push(`key is ${reply.key}, but this dispatch checks ${item.key}`)
  const questions = reply.questions ?? []
  if (reply.verdict === 'corrected' && (reply.corrections ?? []).length === 0) errors.push('a corrected verdict lists no correction')
  reply.corrections.forEach((c, i) => {
    if (!hasSources(c)) errors.push(`corrections[${i}] names no source`)
  })
  reply.requirements.forEach((r, i) => {
    if (r.status !== 'current' && !hasSources(r)) errors.push(`requirements[${i}] is ${r.status} and names no source`)
  })
  questions.forEach((q, i) => {
    if (q.checked.length === 0) errors.push(`questions[${i}] does not say what was checked`)
    if (q.needs.trim() === '') errors.push(`questions[${i}] does not say what it needs`)
  })
  if (reply.verdict === 'needs-developer' && questions.length === 0) errors.push('a needs-developer verdict asks no question')
  if (reply.verdict !== 'needs-developer' && questions.length > 0) errors.push(`a question leaves the verdict needs-developer, not ${reply.verdict}`)
  const isBug = item.kind === 'bug'
  if (isBug) {
    const bug = reply.bug ?? null
    const asked = (about) => questions.some((q) => q.about === about)
    if (!(bug?.reproduction?.length > 0) && !asked('reproduction')) errors.push('a bug with no reproduction asks no question about it')
    if (!(bug?.expected ?? '').trim() && !asked('expected')) errors.push('a bug with no expected behaviour asks no question about it')
  }
  if (reply.verdict === 'not-reproduced') {
    if (!isBug) errors.push(`not-reproduced is a bug's verdict; ${item.key} is a ${item.kind}`)
    else {
      if (!(reply.bug?.reproduction?.length > 0)) errors.push('a not-reproduced verdict names no reproduction it tried')
      if (!(reply.bug?.tried?.length > 0)) errors.push('a not-reproduced verdict lists nothing tried (bug.tried)')
    }
  }
  return errors
}

export function check(root, change, { key, file }) {
  const { main, scope } = requireScope(root, change)
  const item = itemOf(scope, key)
  if (!IN_SCOPE.includes(item.state)) refuse(`${key} is ${item.state}; only a taken or partial item is checked`)
  if (!existsSync(file)) return { ok: false, valid: false, change, key, errors: [`no reply file at ${file}`], next: 'retry' }
  const parsed = parseReply(readFileSync(file, 'utf8'))
  const errors = [...parsed.errors]
  if (parsed.reply !== null) {
    const schemaErrors = validateJson(readSchema(SCOPE_SCHEMA), parsed.reply)
    errors.push(...schemaErrors)
    if (schemaErrors.length === 0) errors.push(...checkScopeReply(parsed.reply, item))
  }
  if (errors.length) {
    return { ok: false, valid: false, change, key, errors, next: `retry: send the errors to the same agent once; a second refusal stops, and the item goes to the developer` }
  }
  const reply = parsed.reply
  item.check = {
    verdict: reply.verdict,
    requirements: reply.requirements,
    bug: reply.bug ?? null,
    corrections: reply.corrections,
    questions: reply.questions.map((q, i) => ({ n: i + 1, ...q, answer: null })),
    checked: reply.checked,
    reply: relMain(main, file),
    ...(parsed.fenced ? { fenced: true } : {})
  }
  item.verdict = reply.verdict
  writeScope(main, change, scope)
  return {
    ok: true,
    valid: true,
    change,
    key,
    verdict: reply.verdict,
    questions: item.check.questions.map(({ n, question, about, checked, needs }) => ({ n, question, about, checked, needs })),
    next: reply.verdict === 'needs-developer'
      ? 'put every question of every item to the developer in one message, then scope.mjs answer'
      : reply.verdict === 'not-reproduced'
        ? `retest: scope.mjs retest --change ${change}`
        : 'checked'
  }
}

// ---------------------------------------------------------------- answer

// One answer to question n of a needs-developer item; or, once every question is answered, the
// verdict the answers give: current, corrected, or obsolete (the item leaves the scope, with
// the reason).
export function answer(root, change, { key, question = null, text: given = null, verdict = null, reason = null }) {
  const { main, scope } = requireScope(root, change)
  const item = itemOf(scope, key)
  if (!item.check) refuse(`${key} has no checked reply; run scope.mjs check first`)
  const questions = item.check.questions
  if (question !== null) {
    if (verdict !== null) refuse('answer one question, or give the verdict, not both')
    const q = questions.find((x) => x.n === question)
    if (!q) refuse(`${key} has no question ${question}; its questions: ${questions.map((x) => x.n).join(', ') || 'none'}`)
    if (!(given ?? '').trim()) refuse('--answer needs the developer\'s answer')
    q.answer = given.trim()
  } else {
    if (!['current', 'corrected', 'obsolete'].includes(verdict)) refuse('--verdict is current, corrected or obsolete')
    const open = questions.filter((q) => q.answer === null).map((q) => q.n)
    if (open.length) refuse(`question(s) ${open.join(', ')} of ${key} are not answered yet`)
    if (verdict === 'obsolete') {
      if (!(reason ?? '').trim()) refuse('an obsolete item leaves the scope with a reason: --reason "<text>"')
      item.state = 'excluded'
      item.reason = reason.trim()
    }
    item.verdict = verdict
  }
  writeScope(main, change, scope)
  const open = questions.filter((q) => q.answer === null).map((q) => q.n)
  return { ok: true, change, key, step: 'answer', verdict: item.verdict, state: item.state, open, next: open.length ? `answer question(s) ${open.join(', ')}` : item.verdict === 'needs-developer' ? `give the verdict: scope.mjs answer --change ${change} --key ${key} --verdict current|corrected|obsolete` : 'answered' }
}

// ---------------------------------------------------------------- render and the gate

const cell = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')

function noteOf(item) {
  const parts = []
  for (const c of item.check?.corrections ?? []) parts.push(`corrected: ${c.what}${c.was ? ` (was ${c.was})` : ''}, now ${c.now}`)
  for (const q of item.check?.questions ?? []) parts.push(`asked: ${q.question}${q.answer ? ` answered: ${q.answer}` : ''}`)
  return parts.join('; ')
}

function trackerStatement(t) {
  if (t.state === 'skipped') return `Tracker: skipped for this change (${t.reason}).`
  if (t.state === 'none') return `Tracker: none; ${TRACKER_SKIPPED}.`
  if (t.state === 'degraded') return `Tracker: degraded (${t.tool ?? 'unknown'}).`
  return `Tracker: ${t.plugin ?? 'enabled'}.`
}

// The proposal's `## Scope sources` section, rendered from the scope record.
export function renderSection(scope) {
  const rows = scope.items.map((i) => `| ${[i.key, i.source, i.title, i.state, i.reason ?? '', i.verdict ?? '', noteOf(i)].map(cell).join(' | ')} |`)
  return [
    `## ${SECTION}`,
    '',
    trackerStatement(scope.tracker),
    '',
    '| Key | Source | Title | State | Reason | Verdict | Corrected or asked |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    ...(scope.inFlight?.length ? ['', ...scope.inFlight.map((f) => `In flight: change ${f.change} also takes ${f.keys.join(', ')}.`)] : [])
  ].join('\n')
}

// The section of a Markdown text under `## <title>`, up to the next level-two heading.
export function sectionOf(markdown, title) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${title}`)
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  return lines.slice(start, end).join('\n').trim()
}

const proposalOf = (root, change) => join(root, 'openspec', 'changes', change, 'proposal.md')

// Writes the section into the change's proposal, replacing the one there or appending it.
export function render(root, change) {
  if (!CHANGE.test(change ?? '')) refuse(`"${change ?? ''}" is not a kebab-case change name`)
  const file = changeScopeFile(root, change)
  if (!existsSync(file)) return { ok: true, change, step: 'render', written: false, report: 'The change holds no scope.json; the proposal has no Scope sources section.' }
  const proposal = proposalOf(root, change)
  if (!existsSync(proposal)) refuse(`openspec/changes/${change}/proposal.md does not exist yet; write it, then render`)
  const scope = JSON.parse(readFileSync(file, 'utf8'))
  const section = renderSection(scope)
  const textNow = readFileSync(proposal, 'utf8')
  const current = sectionOf(textNow, SECTION)
  let next
  if (current === null) next = `${textNow.trimEnd()}\n\n${section}\n`
  else {
    const lines = textNow.split('\n')
    const start = lines.findIndex((l) => l.trim() === `## ${SECTION}`)
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
    if (end === -1) end = lines.length
    next = [...lines.slice(0, start), ...section.split('\n'), ...(end < lines.length ? ['', ...lines.slice(end)] : [''])].join('\n')
  }
  writeFileSync(proposal, next)
  return { ok: true, change, step: 'render', written: true, section }
}

// The proposal gate: with a scope.json in the change, `## Scope sources` is its rendering.
export function scopeSourcesGate(root, change) {
  const file = changeScopeFile(root, change)
  if (!existsSync(file)) return { ok: true }
  const proposal = proposalOf(root, change)
  const current = existsSync(proposal) ? sectionOf(readFileSync(proposal, 'utf8'), SECTION) : null
  const expected = renderSection(JSON.parse(readFileSync(file, 'utf8')))
  const norm = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n').trim()
  if (current !== null && norm(current) === norm(expected)) return { ok: true }
  return { ok: false, error: `the proposal's ## ${SECTION} section ${current === null ? 'is missing' : 'is not the rendering of scope.json'}; run scope.mjs render --change ${change} --root ${root} and never edit the section by hand` }
}

// ---------------------------------------------------------------- the held tracker writes

const held = (change, step) => `the developer's yes: scope.mjs ${step} --change ${change} --yes`

// Runs a held tracker write: without yes the plan and its preview, with it the plan applied.
function heldWrite(main, change, scope, { step, operation, input, yes, core, after }) {
  const record = scope[step]
  const stateDir = trackerDir(main, change)
  mkdirSync(stateDir, { recursive: true })
  if (yes && !(record?.plan && ['held', 'failed'].includes(record.state))) refuse(`there is no held ${step} plan to apply; run scope.mjs ${step} --change ${change} without --yes first`)
  const result = tracker(main, operation, { ...input, change, stateDir, ...(yes ? { apply: record.plan } : {}) }, core)
  const report = trackerReport(operation, result)
  if (result.state === 'none') {
    scope[step] = { state: 'skipped', report }
    writeScope(main, change, scope)
    return { ok: true, change, step, state: 'skipped', report }
  }
  if (result.state === 'refused') {
    scope[step] = { state: 'refused', report }
    writeScope(main, change, scope)
    return { ok: false, change, step, state: 'refused', report, error: result.error ?? report, next: `run scope.mjs ${step} --change ${change} without --yes to build a new plan` }
  }
  if (result.state === 'degraded') return { ok: true, change, step, state: 'degraded', report, hint: result.hint ?? null }
  if (result.held) {
    scope[step] = { state: 'held', plan: result.plan ?? null, preview: result.preview ?? [], report }
    writeScope(main, change, scope)
    return { ok: true, change, step, state: 'pending', held: true, plan: result.plan ?? null, preview: result.preview ?? [], report, waiting: held(change, step) }
  }
  const applied = (result.applied ?? []).map(keyOf)
  const failed = result.failed ?? []
  scope[step] = { state: failed.length ? 'failed' : 'done', plan: record?.plan ?? result.plan ?? null, applied: result.applied ?? [], skipped: result.skipped ?? [], failed, report }
  after?.(applied)
  writeScope(main, change, scope)
  return { ok: failed.length === 0, change, step, state: scope[step].state, applied: result.applied ?? [], skipped: result.skipped ?? [], failed, report, ...(failed.length ? { next: `rerun scope.mjs ${step} --change ${change} --yes: the plan resumes where it stopped` } : {}) }
}

function trackerOff(scope) {
  if (scope.tracker.state === 'skipped') return `Tracker: skipped for this change (${scope.tracker.reason}); nothing was sent.`
  if (scope.tracker.state === 'none') return `Tracker: none; ${TRACKER_SKIPPED}.`
  return null
}

// The taken and partial tracker issues move to the tracker's start (in progress, assigned), after
// the branch and worktree exist. Each carries its corrections and answers, which the plan may
// also write to the issue as a comment.
export function start(root, change, { yes = false, core }) {
  const { main, scope } = requireScope(root, change)
  const off = trackerOff(scope)
  if (off) {
    scope.start = { state: 'skipped', report: off }
    writeScope(main, change, scope)
    return { ok: true, change, step: 'start', state: 'skipped', report: off }
  }
  const targets = scope.items.filter((i) => i.source === 'tracker' && IN_SCOPE.includes(i.state) && i.verdict !== 'not-reproduced')
  if (targets.length === 0) return { ok: true, change, step: 'start', state: 'skipped', report: 'Tracker start: no tracker item is taken or partial; nothing to start.' }
  const unsettled = targets.filter((i) => !SETTLED.includes(i.verdict)).map((i) => `${i.key} (${i.verdict ?? 'not checked'})`)
  if (unsettled.length) refuse(`check and settle every taken or partial issue before start: ${unsettled.join(', ')}`)
  if (!changeCopy(main, change)) refuse(`start runs after the branch and the worktree exist: run propose.mjs create --change ${change} first`)
  const items = targets.map((i) => ({
    key: i.key,
    state: i.state,
    corrections: (i.check?.corrections ?? []).map(({ what, was, now }) => ({ what, was, now })),
    answers: (i.check?.questions ?? []).filter((q) => q.answer).map(({ question, answer: a }) => ({ question, answer: a }))
  }))
  return heldWrite(main, change, scope, { step: 'start', operation: 'start', input: { items }, yes, core })
}

// A bug that does not reproduce leaves the scope and goes back to its tester: the tracker's
// handoff with state not-reproduced, what was tried and the commit it was tried on.
export function retest(root, change, { yes = false, core }) {
  const { main, scope } = requireScope(root, change)
  const targets = scope.items.filter((i) => IN_SCOPE.includes(i.state) && i.verdict === 'not-reproduced')
  if (targets.length === 0) return { ok: true, change, step: 'retest', state: 'skipped', report: 'Retest: no item is not-reproduced.' }
  const off = trackerOff(scope)
  if (off) return { ok: true, change, step: 'retest', state: 'skipped', report: off }
  if (!scope.base?.commit) refuse('the scope records no base commit; run scope.mjs check-input first')
  const items = targets.map((i) => ({ key: i.key, state: 'not-reproduced', fields: { tried: i.check.bug.tried, commit: scope.base.commit } }))
  return heldWrite(main, change, scope, {
    step: 'retest',
    operation: 'handoff',
    input: { items, mr: null },
    yes,
    core,
    after: (applied) => {
      for (const item of targets.filter((i) => applied.includes(i.key))) {
        item.state = 'excluded'
        item.reason = RETEST_REASON
      }
    }
  })
}

// ---------------------------------------------------------------- read-only

export function state(root, change) {
  const { main, scope } = requireScope(root, change)
  return { ok: true, change, file: scopeFile(main, change), scope, branch: branchKey(scope), recordable: recordable(scope) }
}
