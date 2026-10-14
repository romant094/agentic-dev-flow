// Whether the Superpowers plugin is available to Claude Code in a host project. The flow's
// brainstorm, plan and apply stages are Superpowers skills, and a missing skill raises no
// error: the agent does the skill's work by hand. This check turns that into a stop.
//
// It reads Claude Code's own state (installed_plugins.json, version 2, and the settings
// files). That shape is private and can change; a change makes the check fail loudly, with
// the install command, never pass silently.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PLUGIN_ID = 'superpowers@claude-plugins-official'
export const INSTALL_COMMAND = `claude plugin install ${PLUGIN_ID}`

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// Claude Code's precedence: user, then project, then local; the later layer wins.
export function mergeSettings(...layers) {
  return { enabledPlugins: Object.assign({}, ...layers.map((s) => s?.enabledPlugins)) }
}

// A user-scope record counts everywhere. A project- or local-scope record counts only in the
// project it was installed for: Claude Code records one per checkout, worktrees included.
export function countsHere(record, root) {
  if (record.scope === 'user' || record.scope === undefined) return true
  return typeof record.projectPath === 'string' && resolve(record.projectPath) === resolve(root)
}

export function isAvailable({ installedPlugins, settings, exists, root }) {
  const records = installedPlugins?.plugins?.[PLUGIN_ID]
  const here = Array.isArray(records) ? records.filter((r) => countsHere(r, root)) : []
  if (here.length === 0) {
    return { ok: false, reason: `${PLUGIN_ID} is not installed for this project` }
  }
  if (!here.some((r) => r.installPath && exists(r.installPath))) {
    return { ok: false, reason: `${PLUGIN_ID} is recorded but no install path exists on disk` }
  }
  if (settings?.enabledPlugins?.[PLUGIN_ID] === false) {
    return { ok: false, reason: `${PLUGIN_ID} is installed but disabled` }
  }
  return { ok: true, reason: null }
}

export function checkSuperpowers(root, { home = claudeHome() } = {}) {
  const settings = mergeSettings(
    readJson(join(home, 'settings.json')),
    readJson(join(root, '.claude', 'settings.json')),
    readJson(join(root, '.claude', 'settings.local.json'))
  )
  const result = isAvailable({
    installedPlugins: readJson(join(home, 'plugins', 'installed_plugins.json')),
    settings,
    exists: existsSync,
    root
  })
  return result.ok ? result : { ...result, install: INSTALL_COMMAND }
}
