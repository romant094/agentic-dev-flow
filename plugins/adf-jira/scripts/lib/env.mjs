// The plugin's credentials and personal values, resolved inside the script process. The agent
// never reads the env file: diagnostics name a variable, the layer it came from and its length,
// never its value.
//
// Layers, first non-empty value wins, only JIRA_ keys:
//   1. the process environment
//   2. the project's env file: `.claude/.env`, or the registry config's `envFile`
//   3. ~/.claude/.env
// The registry config's `baseUrl` and `allowlist` (committed, not secret) win over JIRA_URL and
// JIRA_ALLOWED_PROJECTS; the env keys remain for a host with no registry entry.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const ENV_FILE = join('.claude', '.env')

export class EnvError extends Error {
  constructor(message, missing) {
    super(message)
    this.name = 'EnvError'
    this.missing = missing
  }
}

export function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function readIfPresent(path) {
  try {
    return { found: true, values: parseEnvFile(readFileSync(path, 'utf8')) }
  } catch {
    return { found: false, values: {} }
  }
}

function stringsOnly(input) {
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export function projectEnvFile(projectDir, envFile) {
  if (!envFile) return join(projectDir, ENV_FILE)
  return isAbsolute(envFile) ? envFile : join(projectDir, envFile)
}

// The JIRA_ values of the three layers, first non-empty wins, with no check of what is
// required: { resolved, sources, files }.
export function resolveLayers({ projectDir, homeDir, processEnv = process.env, envFile }) {
  const projectPath = projectEnvFile(projectDir, envFile)
  const homePath = join(homeDir, '.claude', '.env')
  const project = readIfPresent(projectPath)
  const home = readIfPresent(homePath)
  const layers = [
    { layer: 'process', values: stringsOnly(processEnv) },
    { layer: 'project', values: project.values },
    { layer: 'home', values: home.values }
  ]

  const resolved = {}
  const sources = []
  for (const { layer, values } of layers) {
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith('JIRA_')) continue
      if (value === '') continue
      if (key in resolved) continue
      resolved[key] = value
      sources.push({ key, layer, length: value.length })
    }
  }
  return { resolved, sources, files: { project: { path: projectPath, found: project.found }, home: { path: homePath, found: home.found } } }
}

export function resolveEnv({ projectDir, homeDir, processEnv = process.env, envFile, config = {} }) {
  const { resolved, sources, files } = resolveLayers({ projectDir, homeDir, processEnv, envFile })
  const projectPath = files.project.path

  let url = resolved.JIRA_URL
  let allowedProjects = resolved.JIRA_ALLOWED_PROJECTS?.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (typeof config.baseUrl === 'string' && config.baseUrl !== '') {
    url = config.baseUrl
    replaceSource(sources, 'JIRA_URL', { key: 'baseUrl', layer: 'config', length: url.length })
  }
  if (Array.isArray(config.allowlist)) {
    allowedProjects = config.allowlist
    replaceSource(sources, 'JIRA_ALLOWED_PROJECTS', { key: 'allowlist', layer: 'config', length: allowedProjects.join(',').length })
  }

  const missing = []
  if (!url) missing.push('JIRA_URL')
  if (!resolved.JIRA_PAT) missing.push('JIRA_PAT')
  if (allowedProjects === undefined) missing.push('JIRA_ALLOWED_PROJECTS')
  if (missing.length > 0) {
    throw new EnvError(
      `Missing required variable(s): ${missing.join(', ')}. Not found in the process environment, ${projectPath}, or ~/.claude/.env` +
        `${missing.some((m) => m !== 'JIRA_PAT') ? ', and the registry config sets no baseUrl or allowlist' : ''}. Copy the plugin's env.example and fill them in.`,
      missing
    )
  }
  if (allowedProjects.length === 0) {
    throw new EnvError('JIRA_ALLOWED_PROJECTS resolved to an empty list; refusing to run unscoped.', ['JIRA_ALLOWED_PROJECTS'])
  }

  const env = {
    url: url.replace(/\/+$/, ''),
    pat: resolved.JIRA_PAT,
    allowedProjects,
    defaultProject: resolved.JIRA_DEFAULT_PROJECT,
    assignee: resolved.JIRA_ASSIGNEE,
    gitAuthor: resolved.JIRA_GIT_AUTHOR,
    pm: resolved.JIRA_PM,
    qa: resolved.JIRA_QA
  }
  return { env, sources, files }
}

function replaceSource(sources, key, entry) {
  const i = sources.findIndex((s) => s.key === key)
  if (i === -1) sources.push(entry)
  else sources.splice(i, 1, entry)
}
