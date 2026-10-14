#!/usr/bin/env node
// CLI over lib/reply.mjs: validates a subagent's reply file against the shape of the role it
// was dispatched in. The shapes are stated in full in lib/reply.mjs's header. Prints one JSON
// object on stdout.
//
//   reply.mjs --role <role> <file> [--root <dir>]
//
// A relative <file> is read from --root <dir> (default: the current directory).
// Exit 0: the reply is valid ({ ok: true, role, file }). Exit 1: it is refused
// ({ ok: false, role, file, error, reasons }). Exit 2: the call itself is wrong — no role or
// file, an unknown role, an unreadable file ({ ok: false, error, usage }).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { checkReplyText, ROLES } from './lib/reply.mjs'

export const USAGE = `Usage:
  reply.mjs --role <role> <file> [--root <dir>]
Roles: ${Object.keys(ROLES).join(', ')}`

// A wrong call, as opposed to a refused reply: exit 2.
export class UsageError extends Error {}

export function run(argv, { cwd = process.cwd() } = {}) {
  const args = [...argv]
  const at = args.indexOf('--root')
  const root = at === -1 ? cwd : args.splice(at, 2)[1]
  const flag = args.indexOf('--role')
  const role = flag === -1 ? undefined : args[flag + 1]
  const file = args.filter((_, i) => i !== flag && i !== flag + 1)[0]
  if (!root || !role || !file) throw new UsageError('usage: reply.mjs --role <role> <file> [--root <dir>]')
  if (!Object.hasOwn(ROLES, role)) throw new UsageError(`unknown role ${role}; known: ${Object.keys(ROLES).join(', ')}`)
  let text
  try {
    text = readFileSync(resolve(root, file), 'utf8')
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${e.message}`)
  }
  const reasons = checkReplyText(role, text)
  if (reasons.length === 0) return { ok: true, role, file }
  return { ok: false, role, file, error: `${file} is not a valid ${role} reply`, reasons }
}

if (isMain(import.meta.url)) {
  try {
    const out = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, usage: USAGE })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
