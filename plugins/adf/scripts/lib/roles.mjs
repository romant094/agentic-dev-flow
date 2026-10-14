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
