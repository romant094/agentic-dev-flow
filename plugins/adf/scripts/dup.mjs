#!/usr/bin/env node
// CLI over lib/dup.mjs: the developer dismissed a reuse-sweep finding; place the DUP marker and
// record the accepted debt in one call. Prints one JSON object on stdout; exit 1 on a refusal,
// exit 2 on a usage error.
//
//   dup.mjs mark --change <name> --file <path> [--line <n>] --existing <existing> --why <why>
//                --reason <developer's reason> [--task <n>] [--root <change worktree>]
//
// --file is the finding's introduced file, relative to --root; --line its introduced line (none:
// the whole file is the duplicate, and the marker goes on the first line). --existing is the
// finding's `existing`, verbatim; --why the finding's `why`; --reason the developer's reason, one
// line. The marker is written in the file's comment syntax, chosen by its extension; a format
// with no comment syntax is refused before anything is written, and the developer's acceptance
// then goes on record with `ledger.mjs debt ... --accepted` alone. Then the debt record:
// `debt --what "duplicate: <file>[:<line>] repeats <existing>" --reason <why> --accepted <reason>`,
// which archive resolves as accepted. --commit then commits the marked file alone through
// lib/commit.mjs with the message markMessage(<file>) from lib/dup.mjs; `commit` is its sha, or
// null when the file holds no uncommitted change.
//
//   { ok, file, line, marker, already, debt: { id } | { skipped: "<why>" }, commit? }
import { commitPaths } from './lib/commit.mjs'
import { isMain } from './lib/main.mjs'
import { markFile, markMessage } from './lib/dup.mjs'
import { gitIn } from './lib/workspace.mjs'
import { appendRecord, buildRecord, readRecords } from './lib/ledger.mjs'

export const USAGE =
  'usage: dup.mjs mark --change <name> --file <path> [--line <n>] --existing <existing> --why <why> --reason <reason> [--task <n>] [--root <dir>] [--commit]'

export class UsageError extends Error {}

const FLAGS = ['--change', '--file', '--line', '--existing', '--why', '--reason', '--task', '--root']

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--commit') {
      values.commit = true
      continue
    }
    if (!FLAGS.includes(arg)) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { ...values, rest }
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { change, file, line, existing, why, reason, task, root = cwd, commit, rest } = parse(argv)
  if (rest.length !== 1 || rest[0] !== 'mark' || !change || !file || !existing || !why || !reason) throw new UsageError(USAGE)
  const what = `duplicate: ${file}${line ? `:${line}` : ''} repeats ${existing}`
  const fields = { what, reason: why, accepted: reason, ...(task ? { task } : {}) }
  const records = readRecords(root, change)
  // The record is checked before the file is touched, so a refused record leaves no marker.
  buildRecord('debt', fields, { existing: records })
  const marked = markFile(root, { file, line, existing, reason })
  // The marker shifts the introduced line by one, so a repeated call names another line: the
  // acceptance is the same when the file and the existing location are.
  const same = records.find(
    (r) => r.kind === 'debt' && r.accepted && (r.what === what || (marked.already && r.what.startsWith(`duplicate: ${marked.file}`) && r.what.endsWith(` repeats ${existing}`)))
  )
  const debt = same ? { skipped: `${same.id} already records this acceptance` } : { id: appendRecord(root, change, 'debt', fields, { env }).record.id }
  if (!commit) return { ok: true, ...marked, debt }
  const dirty = gitIn(root)('status', '--porcelain', '--', marked.file) !== ''
  return { ok: true, ...marked, debt, commit: dirty ? commitPaths(root, { only: [marked.file], message: markMessage(marked.file) }).commit : null }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
