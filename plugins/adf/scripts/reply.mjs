#!/usr/bin/env node
// CLI over lib/reply.mjs: checks a subagent's reply file as the role its dispatch name gives, and
// computes the role's result, without recording anything (`dispatch.mjs reply` records). The
// schemas are under schema/, the checks and the computed results stated in lib/reply.mjs's
// header. Prints one JSON object on stdout.
//
//   reply.mjs check --change <name> --name "<dispatch name>" --file <reply file> [--root <dir>]
//
// --root is the change worktree (default: the current directory); a relative <reply file> is
// read from it. Exit 0: the reply is valid ({ ok: true, valid: true, errors: [], result, name,
// role, file, fenced }). Exit 1: it is refused ({ ok: false, valid: false, errors, result: null,
// ... }), or its context cannot be read ({ ok: false, error }). Exit 2: the call itself is wrong
// — a missing flag, a name of no reply role, an unreadable file ({ ok: false, error, usage }).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseName } from './lib/dispatch.mjs'
import { mainCheckout } from './lib/installed.mjs'
import { isMain } from './lib/main.mjs'
import { checkReply, replyContext, ROLES } from './lib/reply.mjs'

export const USAGE = `Usage:
  reply.mjs check --change <name> --name "<dispatch name>" --file <reply file> [--root <dir>]
Roles: ${Object.keys(ROLES).join(', ')}`

// A wrong call, as opposed to a refused reply: exit 2.
export class UsageError extends Error {}

const FLAGS = ['--change', '--name', '--file', '--root']

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    if (!FLAGS.includes(arg)) throw new UsageError(`unknown flag ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

export function run(argv, { cwd = process.cwd(), main } = {}) {
  const { values, rest } = parse(argv)
  if (rest.length !== 1 || rest[0] !== 'check' || !values.change || !values.name || !values.file) throw new UsageError(USAGE)
  const root = resolve(cwd, values.root ?? '.')
  const role = parseName(values.name)?.role
  if (!Object.hasOwn(ROLES, role ?? '')) throw new UsageError(`"${values.name}" is not the dispatch name of a reply role; known roles: ${Object.keys(ROLES).join(', ')}`)
  const file = resolve(root, values.file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new UsageError(`cannot read ${values.file}: ${e.message}`)
  }
  const checked = checkReply(role, text, () => replyContext(root, values.change, values.name, { main: main ?? mainCheckout(root) }))
  return { ok: checked.valid, valid: checked.valid, errors: checked.errors, result: checked.result ?? null, name: values.name, role, file, fenced: checked.fenced }
}

if (isMain(import.meta.url)) {
  try {
    const out = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(usage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
