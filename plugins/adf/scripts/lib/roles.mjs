// Calls a role: the one enabled plugin that provides it, or nothing. The plugin's script gets
// one JSON object on stdin ({ root, config, input }) and prints one on stdout, whose `state`
// is `done`, `degraded` or `refused` (contract/README.md). The core reads fields, never prose.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { enabledPlugins } from './registry.mjs'

export const STATES = ['done', 'degraded', 'refused']

export function provider(root, point, core) {
  return enabledPlugins(root, core).find((p) => Object.hasOwn(p.declaration.provides, point)) ?? null
}

// With no provider the result is `{ state: 'none' }`: the point's documented default applies.
export function callRole(root, point, operation, input, core) {
  if (!core.points[point]?.operations.includes(operation)) {
    throw new Error(`${point} has no operation ${operation}`)
  }
  const found = provider(root, point, core)
  if (!found) return { state: 'none', point }
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

const LABEL = { check: 'Forge', open: 'Merge request', push: 'Push', finalize: 'Merge request' }

// The lines a command shows for a forge result, so no caller renders the forge's JSON itself:
// what happened to the merge request (or the push), the hint and fallback commands of a degraded
// forge, and the refusal's reason. Nothing is claimed that the result does not carry.
export function forgeReport(operation, result) {
  const label = LABEL[operation] ?? 'Forge'
  if (result.state === 'none') return `${label}: none; no forge plugin is enabled, so nothing was pushed and no merge request exists.`
  if (result.state === 'refused') return `${label}: refused; ${result.error ?? 'no reason given'}`
  if (result.state === 'degraded') {
    return [`${label}: not done yet. ${result.hint ?? ''}`.trim(), ...(result.fallback ?? []).map((c) => `  ${c}`)].join('\n')
  }
  if (operation === 'check') return `Forge: ${result.tool ?? 'ready'}`
  if (operation === 'push') return `Push: done${result.url ? `; merge request ${result.url}` : ''}`
  const what = operation === 'finalize' ? 'out of draft' : result.reused ? 'reused' : 'opened as a draft'
  return `${label}: ${result.url ?? (result.number ? `!${result.number}` : 'no link returned')} (${what})`
}
