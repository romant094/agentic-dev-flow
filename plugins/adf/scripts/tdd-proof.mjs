#!/usr/bin/env node
// CLI over lib/tdd-proof.mjs: proves a test-first task's new test can fail. Prints one JSON
// object on stdout; exit 0 when the proof holds, 1 when it does not or on a refusal, 2 on a
// usage error.
//
//   tdd-proof.mjs --worktree <w> --commit <sha> --test "<cmd>" --change <name>
//                 [--test-file <path> ...] [--share <path> ...] [--root <change worktree>]
//                 [--timeout <minutes>]
//
// In a throwaway detached worktree of the commit's first parent (never <w> itself) the commit's
// test files are written and <cmd> runs: it must fail. The worktree then moves to the commit and
// <cmd> must pass. The worktree is removed, never forced. <w> is the worktree that holds the
// commit; --test-file names the test files when the name heuristic misses them; --share links an
// untracked path of <w> (node_modules, a virtualenv) into the throwaway tree for both runs;
// --root is where the output files go (default <w>).
//
//   { ok, proof, commit, parent, testFiles, parentFails, parentExit, commitPasses, commitExit,
//     outputFiles: { parent, commit }, worktree, shared, removed, removeError?, error? }
//
// `proof` false with `commitPasses` false says nothing about the test: the commit itself does
// not pass in a clean tree (a missing dependency, a missing --share), and the outputs say why.
import { isMain } from './lib/main.mjs'
import { tddProof } from './lib/tdd-proof.mjs'

export const USAGE =
  'usage: tdd-proof.mjs --worktree <w> --commit <sha> --test "<cmd>" --change <name> [--test-file <path> ...] [--share <path> ...] [--root <dir>] [--timeout <minutes>]'

export class UsageError extends Error {}

const SINGLE = ['--worktree', '--commit', '--test', '--change', '--root', '--timeout']
const REPEATED = ['--test-file', '--share']

function parse(argv) {
  const values = { 'test-file': [], share: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (![...SINGLE, ...REPEATED].includes(arg)) throw new UsageError(`unexpected argument "${arg}"`)
    const value = argv[i + 1]
    if (value === undefined) throw new UsageError(`${arg} needs a value`)
    const key = arg.slice(2)
    if (REPEATED.includes(arg)) values[key].push(value)
    else if (values[key] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[key] = value
    i++
  }
  return values
}

export function run(argv) {
  const v = parse(argv)
  if (!v.worktree || !v.commit || !v.test || !v.change) throw new UsageError(USAGE)
  const timeout = v.timeout === undefined ? undefined : Number(v.timeout)
  if (timeout !== undefined && !(timeout > 0)) throw new UsageError('--timeout must be a positive number of minutes')
  return tddProof(v.worktree, {
    change: v.change,
    commit: v.commit,
    test: v.test,
    testFiles: v['test-file'].length ? v['test-file'] : null,
    share: v.share,
    root: v.root ?? v.worktree,
    ...(timeout ? { timeoutMinutes: timeout } : {})
  })
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
