#!/usr/bin/env node
// CLI over lib/settings.mjs: the project's settings, `<root>/adf/settings.json`, checked
// against schema/settings.schema.json. Every value a skill records goes through `set`; no skill
// edits the file by hand. Prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage
// error.
//
//   settings.mjs show [--root <dir>]
//       every key with its value (a key the file lacks at its default): { file, settings, text },
//       `text` the rendering the plan and verify agents read
//   settings.mjs get --key <key> [--root <dir>]
//       one key: { file, key, value, description }, `description` the schema's instructions for
//       the key, to show the developer when asking for a value
//   settings.mjs set --key <key> --value <json> [--root <dir>] [--commit]
//       record one value, given as JSON (a string in quotes, null, a list), checked with the rest
//       of the file before anything is written; the file is created when absent:
//       { file, key, value }. --commit then commits the file alone through lib/commit.mjs with
//       the message setMessage(<key>): { ..., commit }
import { join, resolve } from 'node:path'
import { commitPaths } from './lib/commit.mjs'
import { isMain } from './lib/main.mjs'
import { getSetting, KEYS, readSettings, renderSettings, setMessage, setSetting, SETTINGS_FILE, settingsSchema } from './lib/settings.mjs'

export const USAGE = 'usage: settings.mjs show [--root <dir>] | settings.mjs get --key <key> [--root <dir>] | settings.mjs set --key <key> --value <json> [--root <dir>] [--commit]'
export { setMessage }

export class UsageError extends Error {}

const VALUED = ['--root', '--key', '--value']
const FLAGS = ['--commit']
const ALLOWED = { show: [], get: ['key'], set: ['key', 'value', 'commit'] }

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (FLAGS.includes(arg)) {
      values[arg.slice(2)] = true
      continue
    }
    if (!VALUED.includes(arg)) {
      if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

const keyOf = (values) => {
  if (!values.key) throw new UsageError('--key is required')
  if (!KEYS.includes(values.key)) throw new UsageError(`unknown key "${values.key}"; known: ${KEYS.join(', ')}`)
  return values.key
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(ALLOWED, sub)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && !ALLOWED[sub].includes(k))
  if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  const root = resolve(cwd, values.root ?? '.')
  const file = join(root, SETTINGS_FILE)
  switch (sub) {
    case 'show': {
      const settings = readSettings(root)
      return { file, settings, text: renderSettings(settings) }
    }
    case 'get': {
      const key = keyOf(values)
      return { file, key, value: getSetting(root, key), description: settingsSchema().properties[key].description }
    }
    case 'set': {
      const key = keyOf(values)
      if (values.value === undefined) throw new UsageError('set needs --value')
      let value
      try {
        value = JSON.parse(values.value)
      } catch {
        throw new UsageError(`--value must be JSON, such as "\\"npm test\\"", null or "[\\".env\\"]"; got ${values.value}`)
      }
      const written = setSetting(root, key, value)
      const out = { file: written.file, key, value: written.value }
      if (!values.commit) return out
      return { ...out, commit: commitPaths(root, { only: [SETTINGS_FILE], message: setMessage(key) }).commit }
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
