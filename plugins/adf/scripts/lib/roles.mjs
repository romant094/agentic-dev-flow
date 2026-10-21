// Calls a role: the one enabled plugin that provides it, or nothing; and a hook: every enabled
// plugin that provides it, in registry order. The plugin's script gets one JSON object on stdin
// ({ root, config, input }) and prints one on stdout, whose `state` is `done`, `degraded` or
// `refused` (contract/README.md). The core reads fields, never prose.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry, registryPlugins } from './registry.mjs'

export const STATES = ['done', 'degraded', 'refused']

// The contract this core runs, in the shape the registry functions take ({ coreContract,
// points }); a caller adds `home`.
const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const contract = JSON.parse(readFileSync(join(CORE_ROOT, 'contract', 'contract.json'), 'utf8'))
export const CORE = { coreContract: contract.version, points: contract.points }

export function provider(root, point, core) {
  return registryPlugins(root, core).plugins.find((p) => Object.hasOwn(p.declaration.provides, point)) ?? null
}

// With no provider the result is `{ state: 'none' }`: the point's documented default applies.
// A registry entry whose plugin is not installed or is disabled is absent. When no enabled
// plugin provides the point, `absent` lists the absent entries that recorded the point
// ({ id, reason }), and the report says the step was skipped; an entry that recorded no points
// is named for none. A provider written for a contract before the operation was added, which
// does not declare it, is `{ state: 'none', point, operation, reason: 'not-provided', plugin }`:
// the operation's default applies, as with no provider.
export function callRole(root, point, operation, input, core) {
  if (!core.points[point]?.operations.includes(operation)) {
    throw new Error(`${point} has no operation ${operation}`)
  }
  const { plugins, absent } = registryPlugins(root, core)
  const found = plugins.find((p) => Object.hasOwn(p.declaration.provides, point))
  if (!found) {
    const named = absent.filter((a) => a.points.includes(point)).map(({ id, reason }) => ({ id, reason }))
    return named.length ? { state: 'none', point, absent: named } : { state: 'none', point }
  }
  if (!found.declaration.provides[point].operations?.includes(operation)) {
    return { state: 'none', point, operation, reason: 'not-provided', plugin: found.declaration.name }
  }
  return runProvider(root, found, point, operation, input)
}

// One provider's run: its script with the operation as its argument, in `root`. A script that
// prints no result is refused.
function runProvider(root, found, point, operation, input) {
  const script = join(found.dir, found.declaration.provides[point].script)
  const run = spawnSync('node', [script, operation], {
    cwd: root,
    input: JSON.stringify({ root: realpathSync(root), config: found.entry.config ?? {}, input }),
    encoding: 'utf8',
    maxBuffer: 1 << 24
  })
  let result
  try {
    result = JSON.parse(run.stdout)
  } catch {
    result = null
  }
  if (!result || !STATES.includes(result.state)) {
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(0, 500)
    return { state: 'refused', plugin: found.declaration.name, error: `${found.declaration.name} ${operation} returned no result: ${said || `exit ${run.status}`}` }
  }
  return { ...result, plugin: found.declaration.name }
}

// ---------------------------------------------------------------- hooks

// The enabled providers of a hook point, in registry order, and the absent entries that recorded
// it ({ id, reason }). A host with no registry has neither.
export function hookProviders(root, point, core) {
  if (core.points[point]?.kind !== 'hook') throw new Error(`${point} is not a hook point`)
  if (!readRegistry(root)) return { plugins: [], absent: [] }
  const { plugins, absent } = registryPlugins(root, core)
  return {
    plugins: plugins.filter((p) => Object.hasOwn(p.declaration.provides, point)),
    absent: absent.filter((a) => a.points.includes(point)).map(({ id, reason }) => ({ id, reason }))
  }
}

// Calls every enabled provider of a hook point in registry order, each with its own config. A
// hook point has one operation, named like the point. The state is `none` with no provider,
// `done` when every provider is done, `degraded` when one is degraded and none refused, and
// `refused` at the first provider that refuses: the providers after it are not called, and
// `skipped` names them. `results` holds each called provider's result with its `plugin`;
// `absent` names the absent entries that recorded the point, as callRole does.
export function callHook(root, point, input, core) {
  const { plugins, absent } = hookProviders(root, point, core)
  const named = absent.length ? { absent } : {}
  if (plugins.length === 0) return { state: 'none', point, results: [], ...named }
  const results = []
  for (const [i, found] of plugins.entries()) {
    const result = runProvider(root, found, point, point, input)
    results.push(result)
    if (result.state === 'refused') {
      return { state: 'refused', point, results, ...named, skipped: plugins.slice(i + 1).map((p) => p.declaration.name) }
    }
  }
  return { state: results.some((r) => r.state === 'degraded') ? 'degraded' : 'done', point, results, ...named }
}

// ---------------------------------------------------------------- forge input from state

export const COMMIT_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'style', 'perf', 'ci', 'build', 'revert']

// A merge request title in Conventional Commits form: the type from the branch prefix
// (`feat/add-x` gives feat), and the summary `<scope>: <description>` or `<description>`.
export function titleFrom(branch, summary) {
  const type = /^([a-z]+)\//.exec(branch ?? '')?.[1]
  if (!COMMIT_TYPES.includes(type)) {
    throw new Error(`the branch "${branch}" has no Conventional Commits type prefix (${COMMIT_TYPES.map((t) => `${t}/`).join(', ')}), so --summary cannot give the title its type; pass --title "<type>(<scope>): <description>" in full instead`)
  }
  const m = /^\s*([^:\s][^:]*?)\s*:\s*(.+)$/.exec(summary)
  return m ? `${type}(${m[1]}): ${m[2].trim()}` : `${type}: ${summary.trim()}`
}

const FROM_STATE = { open: ['change', 'branch', 'base', 'protected'], push: ['change', 'branch', 'protected'], finalize: ['change', 'branch', 'base', 'protected'] }

// The input of a forge operation with every value that already lives somewhere read from there:
// the branch from git in `root`, the base from the change's .adf.json, the protected branches
// from the registry. A value the caller also passed must agree, or the call is refused: the
// orchestrator once copied these between scripts by hand. `state` is { change, branch, base,
// protected } as read; null or empty where it could not be read.
export function forgeInput(operation, state, { input = {}, title, summary, draft } = {}) {
  const keys = FROM_STATE[operation]
  if (!keys) return input
  const out = { ...input }
  for (const key of keys) {
    const value = state[key]
    if (value === null || value === undefined || value === '') {
      throw new Error({ branch: 'HEAD is detached or unreadable; run in the change worktree', base: 'the change records no base in its .adf.json', protected: 'the registry sets no branch policy; run /adf:init', change: 'no change' }[key])
    }
    if (input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify(value)) {
      throw new Error(`input.${key} is ${JSON.stringify(input[key])}, but the core reads ${JSON.stringify(value)}; leave it out`)
    }
    out[key] = value
  }
  if (operation !== 'push') {
    if (title) out.title = title
    else if (summary) out.title = titleFrom(state.branch, summary)
    if (!out.title) throw new Error(`${operation} needs a title: pass --summary "<scope>: <description>" or --title`)
  }
  if (operation === 'open') out.draft = draft ?? input.draft ?? true
  return out
}

// ---------------------------------------------------------------- the report of a forge call

// The lines a `none` report adds for registry entries that would provide the point but are absent.
const ABSENT = { 'not-installed': 'not installed', disabled: 'disabled' }
const absentLines = (result, step) =>
  (result.absent ?? []).map((a) => `\n${a.id} is in the registry but ${ABSENT[a.reason] ?? a.reason}; ${step} was skipped.`).join('')

const LABEL = { check: 'Forge', open: 'Merge request', push: 'Push', finalize: 'Merge request', state: 'Merge request' }

// The lines a command shows for a forge result, so no caller renders the forge's JSON itself:
// what happened to the merge request (or the push), the hint and fallback commands of a degraded
// forge, and the refusal's reason. Nothing is claimed that the result does not carry. `draft` is
// what the caller asked `open` for: false opens it ready to merge (the retrospective's). A forge
// written before the operation existed (`reason: 'not-provided'`) is named, and the operation's
// default applies, as with no forge.
export function forgeReport(operation, result, { draft = true } = {}) {
  const label = LABEL[operation] ?? 'Forge'
  if (result.state === 'none' && result.reason === 'not-provided') return `${label}: none; ${result.plugin ?? 'the forge plugin'} does not provide ${operation}, so the step's default applies.`
  if (result.state === 'none') return `${label}: none; no forge plugin is enabled, so nothing was pushed and no merge request exists.${absentLines(result, `the forge ${operation}`)}`
  if (result.state === 'refused') return `${label}: refused; ${result.error ?? 'no reason given'}`
  if (result.state === 'degraded') {
    return [`${label}: not done yet. ${result.hint ?? ''}`.trim(), ...(result.fallback ?? []).map((c) => `  ${c}`)].join('\n')
  }
  if (operation === 'check') return `Forge: ${result.tool ?? 'ready'}`
  if (operation === 'push') return `Push: done${result.url ? `; merge request ${result.url}` : ''}`
  if (operation === 'state') {
    const where = result.url ?? (result.number ? `!${result.number}` : 'no link returned')
    const merged = result.status === 'merged' ? `merged${result.mergedAt ? ` at ${result.mergedAt}` : ''}${result.mergeCommit ? `, commit ${String(result.mergeCommit).slice(0, 7)}` : ''}` : result.status ?? 'no status returned'
    return `${label}: ${where} (${merged})`
  }
  const what = operation === 'finalize' ? 'out of draft, ready to merge' : result.reused ? 'reused' : draft ? 'opened as a draft' : 'opened, ready to merge'
  return `${label}: ${result.url ?? (result.number ? `!${result.number}` : 'no link returned')} (${what})`
}

// ---------------------------------------------------------------- the knowledge role

// The globs an ingest may write, from the knowledge provider's `context`, for verify's
// out-of-plan check. With no provider, or a provider that fails, there are none, and `state`
// and `error` say why. A glob that is not relative to the host root is dropped and named.
export function knowledgePaths(root, core) {
  let result
  try {
    result = callRole(root, 'knowledge', 'context', {}, core)
  } catch (error) {
    return { state: 'refused', paths: [], error: error.message }
  }
  if (result.state !== 'done') return { state: result.state, paths: [], ...(result.error ? { error: result.error } : {}), ...(result.absent ? { absent: result.absent } : {}) }
  const given = Array.isArray(result.paths) ? result.paths : []
  const valid = (g) => typeof g === 'string' && g !== '' && g.trim() === g && !isAbsolute(g) && !normalize(g).startsWith('..')
  const dropped = given.filter((g) => !valid(g))
  return { state: 'done', plugin: result.plugin, paths: given.filter(valid), ...(dropped.length ? { error: `not relative to the host root: ${dropped.map(String).join(', ')}` } : {}) }
}

// The line a command shows for a knowledge result; the defaults with no provider are stated
// here once, so no command words them itself.
export function knowledgeReport(operation, result) {
  if (result.state === 'none') {
    return `${{
      context: 'Knowledge: none; no knowledge plugin is enabled, so brainstorm reads no index and archive skips the ingest.',
      log: 'Knowledge log: none; no knowledge plugin is enabled, so no log entry was written and archive skipped the ingest.',
      check: 'Knowledge check: none; no knowledge plugin is enabled.'
    }[operation]}${absentLines(result, `the knowledge ${operation}`)}`
  }
  if (result.state === 'refused') return `Knowledge ${operation}: refused; ${result.error ?? 'no reason given'}`
  if (result.state === 'degraded') return `Knowledge ${operation}: not done. ${result.hint ?? ''}`.trim()
  if (operation === 'context') return `Knowledge: index ${result.index ?? 'not named'}${result.exists === false ? ' (missing)' : ''}`
  if (operation === 'log') {
    const header = String(result.entry ?? '').split('\n')[0]
    const rotated = result.rotated?.length ? `; rotated ${result.rotated.join(', ')}` : ''
    return `Knowledge log: ${result.amended ? 'amended' : 'written'} ${header}${rotated}`
  }
  const findings = result.findings ?? []
  return findings.length ? `Knowledge check: ${findings.length} finding(s)` : 'Knowledge check: no findings'
}

// ---------------------------------------------------------------- the upstream role

// The `owner/name` path of a git remote URL, https, ssh or scp-like (`git@host:owner/name.git`),
// without `.git`; null for anything else, a local path among them.
export function slugOf(url) {
  if (typeof url !== 'string') return null
  const text = url.trim()
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(.+)$/.exec(text) ?? /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/.exec(text)
  if (!m) return null
  const path = m[1].replace(/\/+$/, '').replace(/\.git$/, '')
  return /^[^/\s]+(\/[^/\s]+)+$/.test(path) ? path : null
}

// The repository the core's findings and ADF debt are filed in: the `repository` of its own
// plugin.json, as `owner/name`. A manifest that names none, or no remote URL, is refused.
export function coreRepository(manifest = JSON.parse(readFileSync(join(CORE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))) {
  const slug = slugOf(manifest?.repository)
  if (!slug) throw new Error(`the core's plugin.json names no repository URL (repository: ${JSON.stringify(manifest?.repository ?? null)}); nothing can be filed upstream`)
  return slug
}

// The host a retrospective files from, for the issue markers: the `origin` remote's `owner/name`,
// else the base name of the host root.
export function hostSlug(root) {
  let url = null
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    url = null
  }
  return slugOf(url) ?? basename(root)
}

// The line a command shows for an upstream result; the default with no provider is stated here
// once: nothing is filed, the findings stay in the retrospective's sidecar and the ADF debt in the
// debt tree, unfiled.
export function upstreamReport(operation, result) {
  if (result.state === 'none') {
    return `${{
      check: 'Upstream: none; no upstream plugin is enabled, so the findings stay in the retrospective sidecar and the ADF debt stays unfiled.',
      file: 'Upstream: none; no upstream plugin is enabled, so nothing was filed and the findings stay in the retrospective sidecar, the ADF debt unfiled in the debt tree.'
    }[operation]}${absentLines(result, `the upstream ${operation}`)}`
  }
  if (result.state === 'refused') return `Upstream ${operation}: refused; ${result.error ?? 'no reason given'}`
  if (result.state === 'degraded') return `Upstream ${operation}: not done. ${result.hint ?? ''}`.trim()
  if (operation === 'check') return `Upstream: ${result.tool ?? 'ready'}`
  const issues = result.issues ?? []
  if (issues.length === 0) return 'Upstream: nothing filed'
  const existed = issues.filter((i) => i.existed).length
  const what = (i) => `${i.kind === 'debt' ? 'ADF debt' : 'finding'} ${i.item} as ${i.url ?? `#${i.number}`}${i.existed ? ' (already filed)' : ''}`
  return `Upstream: ${issues.length - existed} filed, ${existed} already filed; ${issues.map(what).join(', ')}`
}

// ---------------------------------------------------------------- the tracker role

// The issue tracker of the host project (contract 1.7): `check`, `gather`, `start` and
// `handoff`. The core never names a tracker. `start` and `handoff` write to the tracker, so each
// holds for the developer's yes: called without `apply` the provider writes a plan under the
// core's `stateDir` and returns `held`, `plan` (its id) and `preview` (lines); called with
// `apply: <plan id>` it returns `applied`, `skipped` and `failed`, each a list of keys or of
// `{ key, reason }`.

export const TRACKER_SKIPPED = 'no tracker plugin is enabled; the tracker step was skipped'

const keyLine = (entry) => (typeof entry === 'string' ? entry : `${entry?.key ?? '?'}${entry?.reason ? ` (${entry.reason})` : ''}`)
const keyList = (list) => (Array.isArray(list) && list.length ? list.map(keyLine).join(', ') : 'none')

// The lines a command shows for a tracker result; the default with no provider is stated here
// once, so no command words it itself.
export function trackerReport(operation, result) {
  const label = `Tracker ${operation}`
  if (result.state === 'none') {
    if (result.reason === 'not-provided') return `${label}: none; ${result.plugin ?? 'the tracker plugin'} does not provide ${operation}; the tracker step was skipped.`
    return `${label}: none; ${TRACKER_SKIPPED}.${absentLines(result, `the tracker ${operation}`)}`
  }
  if (result.state === 'refused') return `${label}: refused; ${result.error ?? 'no reason given'}`
  if (result.state === 'degraded') return `${label}: not done (${result.tool ?? 'degraded'}). ${result.hint ?? ''}`.trim()
  if (operation === 'check') return `Tracker: ${result.tool ?? 'ready'}${result.account ? ` as ${result.account}` : ''}`
  if (operation === 'gather') {
    const items = Array.isArray(result.items) ? result.items : []
    return [`${label}: ${items.length} item(s)${items.length ? `: ${items.map((i) => i?.key).join(', ')}` : ''}`, ...(result.notes ?? []).map((n) => `  note: ${n}`)].join('\n')
  }
  if (result.held) {
    return [`${label}: held for the developer's yes; plan ${result.plan ?? '(no id)'}`, ...(result.preview ?? []).map((line) => `  ${line}`)].join('\n')
  }
  return `${label}: applied ${keyList(result.applied)}; skipped ${keyList(result.skipped)}; failed ${keyList(result.failed)}`
}
