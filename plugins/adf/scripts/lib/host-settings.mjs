// Declares ADF in the host's committed .claude/settings.json, so Claude Code offers a
// contributor who trusts the folder to install it, and with it Superpowers, which the core's
// plugin.json declares as a dependency. Adds only missing keys: an explicit `false` is the
// developer's decision and stays. Also allows the writes an agent makes to the knowledge base,
// in the main checkout and in every change worktree (knowledgeWriteRules).
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

// Claude Code guards a project's `.claude/` directory: `acceptEdits` does not cover a write
// there without an allow rule. A change worktree is its own project inside the main checkout,
// so archive's ingest, which writes the knowledge base in the change worktree, needs a rule for
// that path too. A rule starting with one `/` is anchored at the root of the settings file's
// project, whatever the session's working directory; `*` is one path segment, one worktree.
// Edit and Write each get a rule. `paths` are the knowledge role's globs, relative to the host
// root; `worktreesDir` is where the flow makes worktrees.
export function knowledgeWriteRules(paths, worktreesDir) {
  return paths.flatMap((glob) => [glob, `${worktreesDir}/*/${glob}`]).flatMap((path) => [`Edit(/${path})`, `Write(/${path})`])
}

// Reads the settings, lets `change` push to `added` and `notes`, and writes the file back,
// in its own indent, only when something was added.
function updateSettings(root, change) {
  const path = join(root, SETTINGS_PATH)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null
  const settings = text === null ? {} : JSON.parse(text)
  const added = []
  const notes = []
  change(settings, added, notes)
  if (added.length > 0) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(settings, null, text === null ? '\t' : indentOf(text))}\n`)
  }
  return { added, notes }
}

function addAllowRules(settings, added, rules) {
  for (const rule of rules) {
    settings.permissions ??= {}
    settings.permissions.allow ??= []
    if (settings.permissions.allow.includes(rule)) continue
    settings.permissions.allow.push(rule)
    added.push(`permissions.allow ${rule}`)
  }
}

// Adds the allow rules the host's settings miss, each once, after the rules already there.
export function allowInHost(root, rules) {
  return updateSettings(root, (settings, added) => addAllowRules(settings, added, rules))
}

export function declareInHost(root, { source, allow = [] }) {
  return updateSettings(root, (settings, added, notes) => {
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

    addAllowRules(settings, added, allow)
  })
}
