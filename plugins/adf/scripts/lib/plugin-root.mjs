// Where the adf scripts run from: the plugin root, its version, and whether it is an installed
// release (under <home>/plugins/cache/) or some other directory, such as a local clone.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// scriptUrl is the import.meta.url of a file in <root>/scripts/lib/.
export function pluginRoot({ home, scriptUrl }) {
  const root = resolve(dirname(fileURLToPath(scriptUrl)), '..', '..')
  const version = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
  // A home that is a symlink (~/.claude to another directory) is compared resolved, as node
  // resolves the script's own path.
  const real = (path) => (existsSync(path) ? realpathSync(path) : resolve(path))
  const cached = real(root).startsWith(join(real(home), 'plugins', 'cache') + sep)
  return { root, version, cached, warning: cached ? null : `the adf scripts run from ${root}, not from an installed release` }
}
