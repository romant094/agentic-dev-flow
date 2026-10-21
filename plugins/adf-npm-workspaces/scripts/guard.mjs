#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher Bash): reads the hook input JSON on stdin and blocks an
// npm install, ci, add, update or uninstall that would run in a linked git worktree
// (lib/guard.mjs).
//
// Exit codes: 0 the call runs; 2 the call is blocked and stderr, the reason, goes to the agent;
// 1 the guard itself failed, a non-blocking error: the call runs and stderr says it was not
// checked.
import { readFileSync } from 'node:fs'
import { guardHookInput } from './lib/guard.mjs'
import { PLUGIN_NAME } from './lib/provision.mjs'
import { isMain } from './lib/main.mjs'

export function run(stdin) {
  try {
    return guardHookInput(JSON.parse(stdin))
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0]
    return { code: 1, stderr: `${PLUGIN_NAME}: the install guard could not run (${reason}); this command was not checked.\n` }
  }
}

if (isMain(import.meta.url)) {
  let stdin = ''
  try {
    stdin = readFileSync(0, 'utf8')
  } catch {
    // no input: run() reports it as a failed check
  }
  const { code, stderr } = run(stdin)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = code
}
