// Where the adf scripts run from: the plugin root, its version, and whether it is an installed
// release (under <home>/plugins/cache/) or some other directory, such as a local clone.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// scriptUrl is the import.meta.url of a file in <root>/scripts/lib/.
export function pluginRoot({ home, scriptUrl }) {
  const root = resolve(dirname(fileURLToPath(scriptUrl)), '..', '..')
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const cached = root.startsWith(join(resolve(home), 'plugins', 'cache') + sep)
  return { root, version, cached, warning: cached ? null : `the adf scripts run from ${root}, not from an installed release` }
}
