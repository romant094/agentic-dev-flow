// The plugin's configuration: the `config` object of its entry in the host registry
// (`.claude/adf-extensions.json`), committed and not secret. The core passes it to every role
// operation; the scripts a skill runs read the same entry themselves. Secrets and personal
// logins never go here: they stay in the env file (env.mjs).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { DEFAULT_PROFILE_DIR } from './profile.mjs'

export const PLUGIN_NAME = 'adf-jira'
export const REGISTRY_PATH = join('.claude', 'adf-extensions.json')
export const DEFAULT_START_STATUS = 'In Progress'

const PROJECT_KEY = /^[A-Z][A-Z0-9]*$/
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/
const KEYS = ['baseUrl', 'allowlist', 'profileDir', 'debtEpic', 'fields', 'commentTemplate', 'correctionTemplate', 'debtTemplate', 'envFile', 'statuses']
const STATUS_KEYS = ['initial', 'start', 'handoff', 'excluded']

const inside = (path) => typeof path === 'string' && path !== '' && !isAbsolute(path) && !normalize(path).startsWith('..')
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== ''

// Returns { config, errors }: the config with its defaults, and every error found. An unknown
// key is an error, so a typo is not silently ignored.
export function normalizeConfig(raw = {}) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, errors: ['config is not an object'] }
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) errors.push(`config.${key} is not a key of ${PLUGIN_NAME}`)

  if (raw.baseUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(String(raw.baseUrl))) errors.push('config.baseUrl is not an http or https URL')
  if (raw.allowlist !== undefined && !(Array.isArray(raw.allowlist) && raw.allowlist.every((p) => PROJECT_KEY.test(p)))) {
    errors.push('config.allowlist is not a list of project keys')
  }
  if (raw.profileDir !== undefined && !inside(raw.profileDir)) errors.push('config.profileDir is not a path inside the project')
  if (raw.debtEpic !== undefined && !ISSUE_KEY.test(String(raw.debtEpic))) errors.push('config.debtEpic is not an issue key')
  if (raw.fields !== undefined && !(Array.isArray(raw.fields) && raw.fields.every(nonEmpty))) errors.push('config.fields is not a list of field names')
  if (raw.commentTemplate !== undefined && !inside(raw.commentTemplate)) errors.push('config.commentTemplate is not a path inside the project')
  if (raw.correctionTemplate !== undefined && !inside(raw.correctionTemplate)) errors.push('config.correctionTemplate is not a path inside the project')
  if (raw.debtTemplate !== undefined && !inside(raw.debtTemplate)) errors.push('config.debtTemplate is not a path inside the project')
  if (raw.envFile !== undefined && !nonEmpty(raw.envFile)) errors.push('config.envFile is not a path')

  const statuses = raw.statuses ?? {}
  if (statuses === null || typeof statuses !== 'object' || Array.isArray(statuses)) {
    errors.push('config.statuses is not an object')
  } else {
    for (const key of Object.keys(statuses)) if (!STATUS_KEYS.includes(key)) errors.push(`config.statuses.${key} is not a key of ${PLUGIN_NAME}`)
    if (statuses.initial !== undefined && !nonEmpty(statuses.initial)) errors.push('config.statuses.initial is not a status name')
    if (statuses.start !== undefined && !nonEmpty(statuses.start)) errors.push('config.statuses.start is not a status name')
    if (statuses.handoff !== undefined && !nonEmpty(statuses.handoff)) errors.push('config.statuses.handoff is not a status name')
    if (statuses.excluded !== undefined && !(Array.isArray(statuses.excluded) && statuses.excluded.every(nonEmpty))) {
      errors.push('config.statuses.excluded is not a list of status names')
    }
  }

  const config = {
    ...raw,
    profileDir: raw.profileDir ?? DEFAULT_PROFILE_DIR,
    fields: raw.fields ?? [],
    // `initial` has no default: the status a new issue starts in is the workflow's own, and a
    // wrong guess would skip every debt group edit as drifted.
    statuses: {
      initial: statuses?.initial ?? null,
      start: statuses?.start ?? DEFAULT_START_STATUS,
      handoff: statuses?.handoff ?? null,
      excluded: statuses?.excluded ?? []
    }
  }
  return { config, errors }
}

// The main checkout of a worktree: the profile and the env file are local and ignored, so they
// live there and nowhere else. Outside a repository the directory itself.
export function mainCheckout(root, run = gitCommonDir) {
  const common = run(root)
  return common ? dirname(common) : resolve(root)
}

function gitCommonDir(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

// The config of this plugin's registry entry: an installed id `adf-jira@<marketplace>`, or a
// path whose declaration names the plugin. {} when the host has no registry or no entry.
export function readRegistryConfig(projectDir) {
  let registry
  try {
    registry = JSON.parse(readFileSync(join(projectDir, REGISTRY_PATH), 'utf8'))
  } catch {
    return {}
  }
  for (const entry of registry?.extensions ?? []) {
    if (typeof entry.plugin === 'string' && entry.plugin.split('@')[0] === PLUGIN_NAME) return entry.config ?? {}
    if (typeof entry.path === 'string') {
      const file = join(isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path), 'adf-extension.json')
      try {
        if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === PLUGIN_NAME) return entry.config ?? {}
      } catch {
        // not this plugin
      }
    }
  }
  return {}
}
