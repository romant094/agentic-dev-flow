// Declares ADF in the host's committed .claude/settings.json, so Claude Code offers a
// contributor who trusts the folder to install it, and with it Superpowers, which the core's
// plugin.json declares as a dependency. Adds only missing keys: an explicit `false` is the
// developer's decision and stays.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MARKETPLACE = 'agentic-dev-flow'
export const PLUGIN_KEY = `adf@${MARKETPLACE}`
export const SETTINGS_PATH = '.claude/settings.json'

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function indentOf(text) {
  const line = /\n([ \t]+)\S/.exec(text)
  return line ? line[1] : '\t'
}

// The marketplace source as this machine added it. A local directory is a path on one
// machine and is never written into a committed file.
export function marketplaceSource(home) {
  const entry = readJson(join(home, 'plugins', 'known_marketplaces.json'))?.[MARKETPLACE]
  return entry?.source && entry.source.source !== 'directory' ? entry.source : null
}

export function declareInHost(root, { source }) {
  const path = join(root, SETTINGS_PATH)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null
  const settings = text === null ? {} : JSON.parse(text)
  const added = []
  const notes = []

  settings.enabledPlugins ??= {}
  if (settings.enabledPlugins[PLUGIN_KEY] === undefined) {
    settings.enabledPlugins[PLUGIN_KEY] = true
    added.push(`enabledPlugins.${PLUGIN_KEY}`)
  } else if (settings.enabledPlugins[PLUGIN_KEY] === false) {
    notes.push(`${PLUGIN_KEY} is disabled in ${SETTINGS_PATH}; left as it is`)
  }

  settings.extraKnownMarketplaces ??= {}
  if (settings.extraKnownMarketplaces[MARKETPLACE] === undefined) {
    if (source) {
      settings.extraKnownMarketplaces[MARKETPLACE] = { source }
      added.push(`extraKnownMarketplaces.${MARKETPLACE}`)
    } else {
      notes.push(`the ${MARKETPLACE} marketplace was added from a local directory or not found; not declared`)
    }
  }

  if (added.length > 0) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(settings, null, text === null ? '\t' : indentOf(text))}\n`)
  }
  return { added, notes }
}
