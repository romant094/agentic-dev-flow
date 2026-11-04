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
import { fileURLToPath } from 'node:url'
import { selectInstall } from './installed.mjs'
import { detectRuntime, installCommand, runtimeHome } from './runtime.mjs'

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
// `roots` is one directory or a list of them (the main directory and the worktree).
export function countsHere(record, roots) {
  if (record.scope === 'user' || record.scope === undefined) return true
  if (typeof record.projectPath !== 'string') return false
  return [roots].flat().some((root) => resolve(record.projectPath) === resolve(root))
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

// In Codex the gate is the install lookup: enabled in config.toml and present in the cache.
export function checkSuperpowers(root, { runtime = detectRuntime({ scriptPath: fileURLToPath(import.meta.url) }), home = runtimeHome(runtime) } = {}) {
  if (runtime === 'codex') {
    try {
      selectInstall(PLUGIN_ID, root, { runtime, home })
      return { ok: true, reason: null }
    } catch (error) {
      if (!error.absent) throw error
      const reason = error.absent.reason === 'disabled' ? `${PLUGIN_ID} is installed but disabled` : `${PLUGIN_ID} is not installed for this project`
      return { ok: false, reason, install: installCommand(runtime, PLUGIN_ID, 'user') }
    }
  }
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
