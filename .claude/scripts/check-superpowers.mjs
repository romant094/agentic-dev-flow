#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLUGIN_ID = 'superpowers@claude-plugins-official'
export const INSTALL_COMMAND = `claude plugin install ${PLUGIN_ID}`

export function isAvailable({ installedPlugins, settings, exists }) {
  const records = installedPlugins?.plugins?.[PLUGIN_ID]
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: `${PLUGIN_ID} is not installed` }
  }
  if (!records.some((r) => r.installPath && exists(r.installPath))) {
    return { ok: false, reason: `${PLUGIN_ID} is recorded but no install path exists on disk` }
  }
  if (settings?.enabledPlugins?.[PLUGIN_ID] === false) {
    return { ok: false, reason: `${PLUGIN_ID} is installed but disabled` }
  }
  return { ok: true, reason: null }
}

export function mergeSettings(userSettings, projectSettings) {
  return {
    enabledPlugins: { ...userSettings?.enabledPlugins, ...projectSettings?.enabledPlugins }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const claudeHome = join(homedir(), '.claude')
  const userSettings = readJson(join(claudeHome, 'settings.json'))
  const projectSettings = readJson('.claude/settings.json')
  const settings = mergeSettings(userSettings, projectSettings)
  const result = isAvailable({
    installedPlugins: readJson(join(claudeHome, 'plugins', 'installed_plugins.json')),
    settings,
    exists: existsSync
  })

  if (result.ok) {
    process.exit(0)
  }

  console.error(`STOP: ${result.reason}.`)
  console.error('')
  console.error('This workflow requires the Superpowers plugin. Install it with:')
  console.error(`  ${INSTALL_COMMAND}`)
  console.error('')
  console.error('Do not continue without it and do not perform its work manually.')
  process.exit(1)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main()
}
