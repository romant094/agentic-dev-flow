// A plugin's config migrations: the steps its declaration lists, run in version order over a
// registry entry's config when /adf:update moves the plugin from one version to another.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from './update.mjs'

// Runs the steps with from < version <= to. With no known `from`, runs none: the config was
// never written by an older version. The input config is not mutated.
export async function migrateConfig(entry, declaration, pluginDir, { from, to }) {
  let config = structuredClone(entry?.config ?? {})
  const ran = []
  if (from === null || from === undefined) return { config, ran }
  const steps = (declaration.migrations ?? [])
    .filter((step) => compareVersions(step.version, from) > 0 && compareVersions(step.version, to) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
  for (const step of steps) {
    let migrate
    try {
      migrate = (await import(pathToFileURL(join(pluginDir, step.script)).href)).default
    } catch (error) {
      throw new Error(`${declaration.name}: migration ${step.version} cannot load ${step.script}: ${error.message}`)
    }
    if (typeof migrate !== 'function') {
      throw new Error(`${declaration.name}: migration ${step.version} (${step.script}) does not export a function`)
    }
    config = await migrate(config)
    const proto = config !== null && typeof config === 'object' ? Object.getPrototypeOf(config) : undefined
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${declaration.name}: migration ${step.version} (${step.script}) returned ${Array.isArray(config) ? 'an array' : config === null ? 'null' : typeof config}, not a plain config object`)
    }
    ran.push(step.version)
  }
  return { config, ran }
}
