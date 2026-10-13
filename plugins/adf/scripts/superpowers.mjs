#!/usr/bin/env node
// The Superpowers gate. Prints one JSON object and exits 1 when Superpowers is unavailable:
//
//   {"ok":true,"reason":null}
//   {"ok":false,"reason":"...","install":"claude plugin install ..."}
//
// --root <dir> names the host project (default: the current directory); --home <dir> the
// Claude Code home (default: $CLAUDE_CONFIG_DIR, else ~/.claude).
import { fileURLToPath } from 'node:url'
import { checkSuperpowers } from './lib/superpowers.mjs'

function option(args, name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const home = option(args, '--home')
  const result = checkSuperpowers(option(args, '--root') ?? process.cwd(), home ? { home } : {})
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
