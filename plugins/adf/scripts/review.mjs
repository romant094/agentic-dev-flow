#!/usr/bin/env node
// CLI over lib/review.mjs, lib/review-state.mjs and lib/marker.mjs. Prints one JSON object on
// stdout; exit 1 on a refusal or a failing check, exit 2 on a usage error. --root is the
// repository, the change worktree with --change (default: the current directory); the
// registry's `review` settings are read from it when it has one. Without --change, `start`,
// `input`, `response` and `render` need no change directory and no Claude Code session.
// With --change the run's state lives under .superpowers/sdd/<change>/review/
// (lib/review-state.mjs); the developer's rulings are ledger records written after `start`.
//
//   review.mjs start (--change <name> [--range <A..B>] [--fresh] | --range <A..B>) [--root <dir>]
//       the range, the files the filter keeps and excludes, the diff's bytes, `empty`, and over
//       review.maxBytes the slices by directory with their coverage proof, which the developer
//       approves with a `review-slices` ruling. With --change: a warning when the range touches
//       none of the plan's **Files:** paths; the result is recorded as the run's start; a run
//       with rounds is refused unless --fresh, which discards it; --range needs the developer's
//       `review-range` ruling.
//       { ok, change, range, counts: { changed, kept, excluded }, kept, excluded, bytes,
//         maxBytes, empty, over, slices | null, proof | null, plan | null, warnings,
//         rangeRuling? }
//   review.mjs round --change <name> [--root <dir>]
//       open the next round: 1 after start; k + 1 when a fix landed after round k's review;
//       past round 3 only with the developer's `review-round-<k>` ruling, which the record
//       names (refused with `escalate: true` otherwise). An open round with no findings yet is
//       returned again.
//       { ok, round, already, since, ruling, cap }
//   review.mjs input --round <k> [--slice <n>] (--change <name> | --range <A..B> [--since <sha>])
//                    [--prompt <file>] [--out <file>] [--root <dir>]
//       write the reviewer's input: the host prompt (registry review.prompt, or --prompt), the
//       core's reply format and marker grammar, and the filtered diff. With --change the round
//       must be open; round 1 reads the start's range, round k the fix range from the commit
//       round k - 1's fixes were made on, after round k - 1's blocking findings with their
//       state and failure modes; slices need the `review-slices` ruling; --out defaults to
//       review/input-r<k>[-s<n>].md. Without --change, --out is required and round 2 and later
//       need --since. A diff over review.maxBytes needs --slice. An empty diff is refused.
//       { ok, file, round, slice: { index, of, dir } | null, range, files, bytes, payloadBytes }
//   review.mjs response --file <json> [--kind findings|fix] [--root <dir>]
//       check a reply against its schema; for findings also the verdict over review.blockOn,
//       every finding open. Exit 1 on an invalid reply and on BLOCKED.
//       { ok, kind, valid, errors, fenced, verdict?, blocking?, counts?, blockOn? }
//   review.mjs response --change <name> --round <k> [--slice <n>] --file <json> [--resume yes|no]
//                       [--root <dir>]
//       check the reviewer's reply and store it as round k's (slice n's); once every slice is
//       in, the round's findings are written, ids renumbered on from the earlier rounds. Every
//       checked reply is an event of the dispatch `ai-review r<k>[ s<n>]` in the change's shared
//       log (lib/attempts.mjs). An invalid reply is refused with `retry: true`, `next: retry` and
//       `mode: resume` (resume the same agent with the errors), or `mode: fresh` with --resume
//       no (the harness cannot resume it: dispatch it afresh with the errors as its question);
//       a second invalid reply of the name stops the stage (`stopped: true`, `next: stop`) until
//       start --fresh. `ok` is the reply stored, whatever the verdict.
//       { ok, valid, round, slice, complete, missing? | findingsFile, ids, renumbered, verdict,
//         blocking, counts }; refused: { ok: false, valid: false, name, errors, next, mode,
//         invalid, retry? | stopped?, error, fenced }
//   review.mjs fixplan --change <name> --round <k> [--also F<n> ...] [--root <dir>]
//       the round's open blocking findings (and --also, open findings chosen to be fixed, kept
//       for the round's later calls) in sequential order, same-file findings adjacent: fixers
//       share the one worktree, so one runs at a time. `next` is the one to dispatch now, each
//       with its dispatch name `ai-fix F<n> r<k>` and level (integration, architecture from
//       round 2); run it again after each stored reply. False-positive claims waiting for the
//       developer are listed apart; one they rejected (`ledger.mjs ruling --as fix`) is a fix
//       again, carrying `rejected`.
//       { ok, round, level, also, next: entry | null, fixes: [entry], awaitingDeveloper:
//         [{ finding, argument }] }, entry { finding, severity, file, line, title, name, level,
//         rejected?: { argument, decision, ruling } }
//   review.mjs fix --change <name> --round <k> --finding F<n> --file <json> [--resume yes|no]
//                  [--root <dir>]
//       check the reply of the fixer dispatched as `ai-fix F<n> r<k>` (the finding is the
//       command's: a reply naming another finding is invalid); `fixed` needs its sha in the
//       round's fix range, one commit touching the finding's file, its tests or both (a test
//       of the file: a test file named after it) and nothing else, and records the
//       disposition; `false-positive` leaves the finding open with its argument, for the
//       developer. A commit that fails the check makes the reply invalid. Invalid replies: one
//       retry, as response, keyed by the dispatch name. Every refusal carries `next`: `retry`
//       (`retry: true`) or `stop` (no fixer for this finding; `stopped: true` when the stage
//       stopped).
//       { ok, finding, outcome, sha?, files?, tests?, awaiting?, next? }; refused: as response,
//       or { ok: false, error, retry: false, next: 'stop', stopped? }
//   review.mjs disposition --change <name> --finding F<n> --as dismissed|accepted|recorded
//                          [--body-file <file>] [--root <dir>]
//       dismissed: the developer's ruling (`ledger.mjs ruling --finding F<n> --as dismissed`)
//       and a committed ADF IGNORE marker covering the finding's line at HEAD, or that line
//       gone from HEAD; accepted: the ruling `--as accepted`, an optional body; recorded: a
//       non-blocking severity and --body-file, why it was left.
//       { ok, finding, disposition, as, ... }
//   review.mjs assemble --change <name> [--not-reviewed <reason>] [--commit] [--root <dir>]
//       render openspec/changes/<change>/review.md from the state, the rulings and HEAD; the
//       verdict BLOCKED while a blocking finding is open, a fix is not re-reviewed, or the suite
//       after the fixes fails with no `review-suite` ruling. Refused: a dirty tree outside the
//       record, a non-blocking finding with no disposition, a ruling not applied, a commit no
//       round reviewed, a fix with no suite run at HEAD (suite.mjs run --section review).
//       --not-reviewed: the empty-diff record, PASS. --commit commits the record alone.
//       { ok, file, verdict, commit, counts, rounds, outstanding, report }
//   review.mjs check --file <review.md> [--root <dir>]
//       read a record as archive does; exit 1 when the verdict or the sha cannot be read.
//       { ok, verdict, commit, change, rounds, counts, dispositions, errors, warnings }
//   review.mjs render --file <json> [--out <file>] [--root <dir>]
//       the findings as markdown; with --out written to the file, otherwise in `markdown`.
//       { ok, verdict, blocking, counts, out | markdown }
//   review.mjs markers [--root <dir>]
//       every IGNORE, IGNORE-START/END and DUP marker in the tree; exit 1 when one is
//       invalid (no key, a bad key, no reason, an unpaired START or END).
//       { ok, markers: [{ file, line, kind, key?, existing?, reason? }], invalid }
//   review.mjs mark --file <path> --line <n> [--end-line <n>] --key <key> --reason <reason>
//                   [--commit] [--root <dir>]
//       write `ADF IGNORE <key> -- <reason>` above the line, or with --end-line the pair
//       `ADF IGNORE-START <key> -- <reason>` above --line and `ADF IGNORE-END` below
//       --end-line, in the file's comment syntax. --commit commits the file alone through
//       lib/commit.mjs; `commit` is null when the marker was already there.
//       { ok, file, line, endLine?, marker, already, commit? }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { commitPaths } from './lib/commit.mjs'
import { isMain } from './lib/main.mjs'
import { markIgnore, markIgnoreBlock, scanMarkers } from './lib/marker.mjs'
import { checkFindings, checkFix, collect, coverageProof, computeVerdict, planTouch, prepareInput, proposeSlices, renderFindings, resolveRange, reviewConfig } from './lib/review.mjs'
import {
  assemble,
  checkRecord,
  checkRoundInput,
  dispose,
  fixPlan,
  inputFile,
  liveState,
  openRound,
  previousFindings,
  recordFix,
  recordStart,
  Refusal,
  roundRange,
  slicesApproved,
  storeReply
} from './lib/review-state.mjs'

export const USAGE = `usage:
  review.mjs start (--change <name> [--range <A..B>] [--fresh] | --range <A..B>) [--root <dir>]
  review.mjs round --change <name> [--root <dir>]
  review.mjs input --round <k> [--slice <n>] (--change <name> | --range <A..B> [--since <sha>]) [--prompt <file>] [--out <file>] [--root <dir>]
  review.mjs response --file <json> [--kind findings|fix] [--root <dir>]
  review.mjs response --change <name> --round <k> [--slice <n>] --file <json> [--resume yes|no] [--root <dir>]
  review.mjs fixplan --change <name> --round <k> [--also F<n> ...] [--root <dir>]
  review.mjs fix --change <name> --round <k> --finding F<n> --file <json> [--resume yes|no] [--root <dir>]
  review.mjs disposition --change <name> --finding F<n> --as dismissed|accepted|recorded [--body-file <file>] [--root <dir>]
  review.mjs assemble --change <name> [--not-reviewed <reason>] [--commit] [--root <dir>]
  review.mjs check --file <review.md> [--root <dir>]
  review.mjs render --file <json> [--out <file>] [--root <dir>]
  review.mjs markers [--root <dir>]
  review.mjs mark --file <path> --line <n> [--end-line <n>] --key <key> --reason <reason> [--commit] [--root <dir>]`

export class UsageError extends Error {}

const VALUED = ['--change', '--range', '--root', '--round', '--slice', '--since', '--prompt', '--out', '--file', '--kind', '--line', '--end-line', '--key', '--reason', '--finding', '--as', '--body-file', '--not-reviewed', '--also', '--resume']
const BOOLEAN = ['--fresh', '--commit']
// The options each subcommand takes, besides --root.
const TAKES = {
  start: ['change', 'range', 'fresh'],
  round: ['change'],
  input: ['change', 'range', 'round', 'slice', 'since', 'prompt', 'out'],
  response: ['file', 'kind', 'change', 'round', 'slice', 'resume'],
  fixplan: ['change', 'round', 'also'],
  fix: ['change', 'round', 'finding', 'file', 'resume'],
  disposition: ['change', 'finding', 'as', 'body-file'],
  assemble: ['change', 'not-reviewed', 'commit'],
  check: ['file'],
  render: ['file', 'out'],
  markers: [],
  mark: ['file', 'line', 'end-line', 'key', 'reason', 'commit']
}
// The subcommands that read or write a change's review state.
const NEEDS_CHANGE = ['round', 'fixplan', 'fix', 'disposition', 'assemble']

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (BOOLEAN.includes(arg)) {
      values[arg.slice(2)] = true
      continue
    }
    if (!VALUED.includes(arg)) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (arg === '--also') values.also = [...(values.also ?? []), value]
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

function positive(name, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`)
  return n
}

// --resume yes|no: whether the harness can resume the agent whose reply is refused.
function resumable(values) {
  if (values.resume === undefined) return true
  if (!['yes', 'no'].includes(values.resume)) throw new UsageError('--resume is yes or no')
  return values.resume === 'yes'
}

function readText(cwd, file) {
  try {
    return readFileSync(resolve(cwd, file), 'utf8')
  } catch {
    throw new Error(`cannot read ${file}`)
  }
}

function start(root, values) {
  if (!values.change && !values.range) throw new UsageError('name the range with --change, --range, or both')
  if (values.fresh && !values.change) throw new UsageError("--fresh discards a change's review run: it needs --change")
  const config = reviewConfig(root)
  const range = resolveRange(root, { change: values.change ?? null, range: values.range ?? null })
  const { changed, files, excluded, bytes } = collect(root, range, config)
  const slices = proposeSlices(files, config.maxBytes)
  const warnings = []
  let plan = null
  if (values.change) {
    const { warning, ...touch } = planTouch(root, values.change, changed)
    plan = touch
    if (warning) warnings.push(warning)
  }
  for (const s of slices ?? []) if (s.oversize) warnings.push(`slice ${s.index} (${s.files[0]}) is one file of ${s.bytes} bytes, over review.maxBytes ${config.maxBytes}`)
  const out = {
    ok: true,
    change: values.change ?? null,
    range,
    counts: { changed: changed.length, kept: files.length, excluded: excluded.length },
    kept: files,
    excluded,
    bytes,
    maxBytes: config.maxBytes,
    empty: files.length === 0,
    over: slices !== null,
    slices,
    proof: slices ? coverageProof(files, slices) : null,
    plan,
    warnings
  }
  if (!values.change) return out
  const { rangeRuling } = recordStart(root, values.change, out, { fresh: Boolean(values.fresh) })
  return { ...out, rangeRuling }
}

function readPrompt(root, cwd, config, values) {
  const path = values.prompt ? resolve(cwd, values.prompt) : config.prompt ? join(root, config.prompt) : null
  if (!path) throw new Error('no review prompt: set review.prompt in the registry, or pass --prompt <file>')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read the review prompt ${path}`)
  }
}

function input(root, cwd, values) {
  if (!values.round) throw new UsageError('input needs --round')
  if (Boolean(values.change) === Boolean(values.range)) throw new UsageError('name the range with exactly one of --change and --range')
  const round = positive('round', values.round)
  const slice = values.slice === undefined ? null : positive('slice', values.slice)
  let range
  let previous = []
  let approved = true
  let state = null
  if (values.change) {
    if (values.since) throw new UsageError("with --change the round's base is recorded: --since belongs to --range")
    state = liveState(root, values.change)
    if (!state.rounds[round - 1]) throw new Refusal(`round ${round} is not open: run review.mjs round --change ${values.change}`)
    range = roundRange(root, values.change, state, round)
    previous = previousFindings(root, values.change, state, round)
    approved = Boolean(slicesApproved(root, values.change, state))
  } else {
    if (!values.out) throw new UsageError('input without --change needs --out')
    if (round === 1 && values.since) throw new UsageError('round 1 reviews the whole range: --since belongs to round 2 and later')
    if (round > 1 && !values.since) throw new UsageError(`round ${round} reviews the fix range: pass --since <sha>, the HEAD recorded before the round's fixes`)
    range = resolveRange(root, { range: values.range, since: values.since ?? null })
  }
  const config = reviewConfig(root)
  const prompt = readPrompt(root, cwd, config, values)
  const prepared = prepareInput(root, { range, config, prompt, round, slice, previous, slicesApproved: approved })
  if (!prepared.ok) {
    if (prepared.needsRuling) prepared.rulingCommand = `ledger.mjs ruling --change ${values.change} --check review-slices --reason "<the developer's reason, in their words>"`
    return prepared
  }
  if (state) checkRoundInput(root, values.change, state, round, range, prepared.slices)
  const file = values.out ? resolve(cwd, values.out) : inputFile(root, values.change, round, prepared.slice ? prepared.slice.index : null)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, prepared.payload, 'utf8')
  return { ok: true, file, round, slice: prepared.slice, range, files: prepared.files, bytes: prepared.bytes, payloadBytes: Buffer.byteLength(prepared.payload, 'utf8') }
}

function response(root, cwd, values) {
  if (!values.file) throw new UsageError('response needs --file')
  const kind = values.kind ?? 'findings'
  if (kind !== 'findings' && kind !== 'fix') throw new UsageError('--kind is findings or fix')
  const text = readText(cwd, values.file)
  if (values.change) {
    if (kind !== 'findings') throw new UsageError("a fixer's reply for a change goes to review.mjs fix")
    if (!values.round) throw new UsageError('response --change needs --round')
    const slice = values.slice === undefined ? null : positive('slice', values.slice)
    return storeReply(root, values.change, { round: positive('round', values.round), slice, text, file: resolve(cwd, values.file), resume: resumable(values) })
  }
  if (values.round || values.slice || values.resume) throw new UsageError('--round, --slice and --resume store a reply: they need --change')
  if (kind === 'fix') {
    const { valid, errors, fenced } = checkFix(text)
    return { ok: valid, kind, valid, errors, fenced }
  }
  const { valid, errors, fenced, reply } = checkFindings(text)
  if (!valid) return { ok: false, kind, valid, errors, fenced }
  const verdict = computeVerdict(reply.findings, { blockOn: reviewConfig(root).blockOn })
  return { ok: verdict.verdict === 'PASS', kind, valid, errors, fenced, ...verdict }
}

function render(root, cwd, values) {
  if (!values.file) throw new UsageError('render needs --file')
  const { valid, errors, reply } = checkFindings(readText(cwd, values.file))
  if (!valid) return { ok: false, error: `${values.file} is not a valid findings reply`, errors }
  const { blockOn } = reviewConfig(root)
  const markdown = renderFindings(reply, { blockOn })
  const { verdict, blocking, counts } = computeVerdict(reply.findings, { blockOn })
  if (!values.out) return { ok: true, verdict, blocking, counts, markdown }
  const out = resolve(cwd, values.out)
  writeFileSync(out, markdown, 'utf8')
  return { ok: true, verdict, blocking, counts, out }
}

export const markMessage = (file) => `chore: mark the dismissed review finding in ${file}`

function mark(root, values) {
  if (!values.file || !values.line || !values.key || !values.reason) throw new UsageError('mark needs --file, --line, --key and --reason')
  const line = positive('line', values.line)
  const marked =
    values['end-line'] === undefined
      ? markIgnore(root, { file: values.file, line, key: values.key, reason: values.reason })
      : markIgnoreBlock(root, { file: values.file, line, endLine: positive('end-line', values['end-line']), key: values.key, reason: values.reason })
  if (!values.commit) return { ok: true, ...marked }
  const commit = marked.already ? null : commitPaths(root, { only: [marked.file], message: markMessage(marked.file) }).commit
  return { ok: true, ...marked, commit }
}

function round(values, command) {
  if (!values.round) throw new UsageError(`${command} needs --round`)
  return positive('round', values.round)
}

function dispatch(command, root, cwd, values) {
  const change = values.change
  switch (command) {
    case 'start':
      return start(root, values)
    case 'round':
      return openRound(root, change)
    case 'input':
      return input(root, cwd, values)
    case 'response':
      return response(root, cwd, values)
    case 'fixplan':
      for (const id of values.also ?? []) if (!/^F[1-9]\d*$/.test(id)) throw new UsageError(`--also takes a finding id F<n>, not "${id}"`)
      return fixPlan(root, change, { round: round(values, command), also: values.also ?? [] })
    case 'fix':
      if (!values.file || !values.finding) throw new UsageError('fix needs --finding and --file')
      if (!/^F[1-9]\d*$/.test(values.finding)) throw new UsageError(`--finding takes a finding id F<n>, not "${values.finding}"`)
      return recordFix(root, change, { round: round(values, command), finding: values.finding, text: readText(cwd, values.file), file: resolve(cwd, values.file), resume: resumable(values) })
    case 'disposition':
      if (!values.finding || !values.as) throw new UsageError('disposition needs --finding and --as')
      return dispose(root, change, { finding: values.finding, as: values.as, body: values['body-file'] === undefined ? null : readText(cwd, values['body-file']) })
    case 'assemble':
      return assemble(root, { change, notReviewed: values['not-reviewed'] ?? null, commit: Boolean(values.commit) })
    case 'check':
      if (!values.file) throw new UsageError('check needs --file')
      return checkRecord(readText(cwd, values.file))
    case 'render':
      return render(root, cwd, values)
    case 'markers': {
      const { markers, invalid } = scanMarkers(root)
      return { ok: invalid.length === 0, markers, invalid }
    }
    case 'mark':
      return mark(root, values)
  }
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [command, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(TAKES, command)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && !TAKES[command].includes(k))
  if (stray.length > 0) throw new UsageError(`--${stray.join(', --')} does not belong to ${command}`)
  if (NEEDS_CHANGE.includes(command) && !values.change) throw new UsageError(`${command} needs --change`)
  const root = resolve(cwd, values.root ?? '.')
  try {
    return dispatch(command, root, cwd, values)
  } catch (error) {
    // A refusal of the review state is an answer: it carries what resolves it.
    if (error instanceof Refusal) return { ok: false, error: error.message, ...error.extra }
    throw error
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
