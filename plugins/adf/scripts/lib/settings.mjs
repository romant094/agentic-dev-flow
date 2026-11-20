// The project's flow settings: `<root>/<SETTINGS_FILE>`, one key per value the flow's scripts
// read, checked against schema/settings.schema.json. The instructions for each key live in the
// schema's `description`, in the plugin; the project's file holds only the values, so a release
// changes the instructions without touching the project.
//
//   readSettings  the file's values over DEFAULTS; a missing file reads as DEFAULTS; a file that
//                 is not JSON or fails the schema throws, naming the file and each error
//   getSetting    one key's value
//   setSetting    writes one key, checked first; the other keys stay as they are
//   renderSettings  the text the plan and verify agents read: each key, its value and the first
//                 sentence of its description
//
// A key that is absent takes its default. `testFirstShares` keeps absent and empty apart: null
// (the default) leaves the test-first proof to the task's reviewer, a list (even an empty one)
// has the flow prove each test-first task itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSchema, validateJson } from './json-schema.mjs'
import { SETTINGS_FILE } from './layout.mjs'

export { SETTINGS_FILE }
export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'settings.schema.json')

export const DEFAULTS = Object.freeze({
  packages: [],
  checks: [],
  wholeSuiteCommand: null,
  affectedTestsCommand: null,
  failedTestsCommand: null,
  freshRunProof: null,
  testFirstShares: null,
  worktreeCopies: [],
  worktreePreparation: [],
  formatCommand: null
})
export const KEYS = Object.keys(DEFAULTS)
// What /adf:init writes into a new project: every key, the test-first proof on with no share.
export const INITIAL = Object.freeze({ ...DEFAULTS, testFirstShares: [] })

// The keys that hold one command line, and the keys that hold paths inside the project.
const ONE_LINE = ['wholeSuiteCommand', 'affectedTestsCommand', 'failedTestsCommand', 'freshRunProof', 'formatCommand']
const PATHS = ['packages', 'testFirstShares', 'worktreeCopies']
const inside = (path) => !isAbsolute(path) && !normalize(path).startsWith('..') && !path.includes('`')

let schema = null
export const settingsSchema = () => (schema ??= readSchema(SCHEMA_PATH))

// The errors of a settings object: the schema's, then one line per command and paths inside the
// project, which the schema cannot say.
export function settingsErrors(value) {
  const errors = validateJson(settingsSchema(), value)
  if (errors.length > 0) return errors
  for (const key of ONE_LINE) if (typeof value[key] === 'string' && /[\r\n]/.test(value[key])) errors.push(`$.${key}: must be one line`)
  for (const key of PATHS) for (const path of value[key] ?? []) if (!inside(path)) errors.push(`$.${key}: "${path}" is not a path inside the project`)
  for (const [i, step] of (value.worktreePreparation ?? []).entries()) {
    if (/[\r\n]/.test(step.command)) errors.push(`$.worktreePreparation[${i}].command: must be one line`)
    for (const path of step.inputs) if (!inside(path)) errors.push(`$.worktreePreparation[${i}].inputs: "${path}" is not a path inside the project`)
  }
  return errors
}

const fileOf = (root) => join(resolve(root), SETTINGS_FILE)

// The file's own object, or null when there is none; throws when it cannot be used.
function readRaw(root) {
  const file = fileOf(root)
  if (!existsSync(file)) return null
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${SETTINGS_FILE} is not valid JSON: ${error.message}`)
  }
  const errors = settingsErrors(value)
  if (errors.length > 0) throw new Error(`${SETTINGS_FILE} fails its schema: ${errors.join('; ')}`)
  return value
}

export function readSettings(root) {
  return { ...DEFAULTS, ...(readRaw(root) ?? {}) }
}

export function getSetting(root, key) {
  if (!KEYS.includes(key)) throw new Error(`unknown settings key "${key}"; known: ${KEYS.join(', ')}`)
  return readSettings(root)[key]
}

// Writes the file in the order of KEYS, two-space JSON with a final newline.
export function writeSettings(root, value) {
  const errors = settingsErrors(value)
  if (errors.length > 0) throw new Error(`the settings fail their schema: ${errors.join('; ')}`)
  const file = fileOf(root)
  mkdirSync(dirname(file), { recursive: true })
  const ordered = Object.fromEntries(KEYS.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`)
  return { file, settings: { ...DEFAULTS, ...ordered } }
}

// Sets one key; the value is checked with the rest of the file before anything is written. A
// string value is trimmed; an empty one is null.
export function setSetting(root, key, value) {
  if (!KEYS.includes(key)) throw new Error(`unknown settings key "${key}"; known: ${KEYS.join(', ')}`)
  const own = readRaw(root) ?? {}
  const clean = typeof value === 'string' ? value.trim() || null : value
  const result = writeSettings(root, { ...own, [key]: clean })
  return { ...result, key, value: result.settings[key] }
}

const firstSentence = (text) => /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text

// The settings as the plan and verify agents read them, with the file they come from.
export function renderSettings(settings) {
  const properties = settingsSchema().properties
  const lines = [`# Project settings (${SETTINGS_FILE})`, '']
  for (const key of KEYS) {
    const value = settings[key]
    const shown = value === null || (Array.isArray(value) && value.length === 0) ? (value === null ? 'not set' : 'none') : JSON.stringify(value)
    lines.push(`- \`${key}\`: ${shown}. ${firstSentence(properties[key].description)}`)
  }
  return `${lines.join('\n')}\n`
}
