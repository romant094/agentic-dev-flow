#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher Bash): reads the hook input JSON on stdin and, when the
// command commits, checks the files the commit takes (lib/english.mjs).
//
// Exit codes: 0 the call runs (not a commit, or nothing found); 2 the call is blocked and
// stderr, one `path:line: text` per finding, goes to the agent; 1 the check itself failed,
// a non-blocking error: the call runs and stderr says the commit was not checked.
import { readFileSync } from 'node:fs'
import { checkHookInput, PLUGIN_NAME } from './lib/english.mjs'
import { isMain } from './lib/main.mjs'

export function run(stdin) {
  try {
    return checkHookInput(JSON.parse(stdin))
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0]
    return { code: 1, stderr: `${PLUGIN_NAME}: the check could not run (${reason}); this commit was not checked.\n` }
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
