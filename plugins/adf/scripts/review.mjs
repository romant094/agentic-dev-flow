#!/usr/bin/env node
// CLI over lib/review.mjs and lib/marker.mjs. Prints one JSON object on stdout; exit 1 on a
// refusal or a failing check, exit 2 on a usage error. --root is the repository (default: the
// current directory); the registry's `review` settings are read from it when it has one.
// `input`, `response` and `render` need no change directory and no Claude Code session.
//
//   review.mjs start (--change <name> | --range <A..B>) [--root <dir>]
//       the range, the files the filter keeps and excludes, the diff's bytes, `empty`, and over
//       review.maxBytes the slices by directory with their coverage proof. With --change, a
//       warning when the range touches none of the plan's **Files:** paths.
//       { ok, change, range: { base, head, spec, from, baseRef? }, counts: { changed, kept,
//         excluded }, kept: [{ file, bytes }], excluded: [{ file, pattern }], bytes, maxBytes,
//         empty, over, slices: [{ index, dir, files, bytes, oversize }] | null, proof | null,
//         plan: { paths, touched, untouched } | null, warnings }
//   review.mjs input --round <k> [--slice <n>] (--change <name> | --range <A..B>)
//                    [--since <sha>] [--prompt <file>] --out <file> [--root <dir>]
//       write the reviewer's input: the host prompt (registry review.prompt, or --prompt), the
//       core's reply format and marker grammar, and the filtered diff. Round 1 reads the whole
//       range; round 2 and later read the fix range --since <sha>..head and need --since. A
//       diff over review.maxBytes needs --slice. An empty diff is refused.
//       { ok, file, round, slice: { index, of, dir } | null, range, files, bytes, payloadBytes }
//   review.mjs response --file <json> [--kind findings|fix] [--root <dir>]
//       check a reply against its schema; for findings also the verdict over review.blockOn,
//       every finding open. Exit 1 on an invalid reply and on BLOCKED.
//       { ok, kind, valid, errors, fenced, verdict?, blocking?, counts?, blockOn? }
//   review.mjs render --file <json> [--out <file>] [--root <dir>]
//       the findings as markdown; with --out written to the file, otherwise in `markdown`.
//       { ok, verdict, blocking, counts, out | markdown }
//   review.mjs markers [--root <dir>]
//       every IGNORE, IGNORE-START/END and DUP marker in the tree; exit 1 when one is
//       invalid (no key, a bad key, no reason, an unpaired START or END).
//       { ok, markers: [{ file, line, kind, key?, existing?, reason? }], invalid: [{ file, line,
//         text?, error }] }
//   review.mjs mark --file <path> --line <n> --key <key> --reason <reason> [--root <dir>]
//       write `ADF IGNORE <key> -- <reason>` above the line, in the file's comment syntax.
//       { ok, file, line, marker, already }
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { markIgnore, scanMarkers } from './lib/marker.mjs'
import { buildPayload, checkFindings, checkFix, collect, coverageProof, computeVerdict, planTouch, proposeSlices, renderFindings, resolveRange, reviewConfig } from './lib/review.mjs'

export const USAGE = `usage:
  review.mjs start (--change <name> | --range <A..B>) [--root <dir>]
  review.mjs input --round <k> [--slice <n>] (--change <name> | --range <A..B>) [--since <sha>] [--prompt <file>] --out <file> [--root <dir>]
  review.mjs response --file <json> [--kind findings|fix] [--root <dir>]
  review.mjs render --file <json> [--out <file>] [--root <dir>]
  review.mjs markers [--root <dir>]
  review.mjs mark --file <path> --line <n> --key <key> --reason <reason> [--root <dir>]`

export class UsageError extends Error {}

const VALUED = ['--change', '--range', '--root', '--round', '--slice', '--since', '--prompt', '--out', '--file', '--kind', '--line', '--key', '--reason']
// The options each subcommand takes, besides --root.
const TAKES = {
  start: ['change', 'range'],
  input: ['change', 'range', 'round', 'slice', 'since', 'prompt', 'out'],
  response: ['file', 'kind'],
  render: ['file', 'out'],
  markers: [],
  mark: ['file', 'line', 'key', 'reason']
}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!VALUED.includes(arg)) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

function positive(name, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`)
  return n
}

function rangeOf(root, values) {
  if (Boolean(values.change) === Boolean(values.range)) throw new UsageError('name the range with exactly one of --change and --range')
  return resolveRange(root, { change: values.change ?? null, range: values.range ?? null, since: values.since ?? null })
}

function start(root, values) {
  const config = reviewConfig(root)
  const range = rangeOf(root, values)
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
  return {
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
}

function input(root, cwd, values) {
  if (!values.round || !values.out) throw new UsageError('input needs --round and --out')
  const round = positive('round', values.round)
  if (round === 1 && values.since) throw new UsageError('round 1 reviews the whole range: --since belongs to round 2 and later')
  if (round > 1 && !values.since) throw new UsageError(`round ${round} reviews the fix range: pass --since <sha>, the HEAD recorded before the round's fixes`)
  const config = reviewConfig(root)
  const promptPath = values.prompt ? resolve(cwd, values.prompt) : config.prompt ? join(root, config.prompt) : null
  if (!promptPath) throw new Error('no review prompt: set review.prompt in the registry, or pass --prompt <file>')
  let prompt
  try {
    prompt = readFileSync(promptPath, 'utf8')
  } catch {
    throw new Error(`cannot read the review prompt ${promptPath}`)
  }
  const range = rangeOf(root, values)
  const { files, diffs } = collect(root, range, config)
  if (files.length === 0) return { ok: false, error: `the filtered diff of ${range.spec} is empty: there is nothing to review`, range }
  const slices = proposeSlices(files, config.maxBytes)
  let chosen = files.map((f) => f.file)
  let slice = null
  if (slices) {
    if (!values.slice) return { ok: false, error: `the diff is over review.maxBytes (${config.maxBytes}): pass --slice <n>, 1-${slices.length}, as start proposed`, range, slices: slices.length }
    const n = positive('slice', values.slice)
    const s = slices[n - 1]
    if (!s) return { ok: false, error: `--slice ${n} is not a slice: 1-${slices.length}`, range }
    chosen = s.files
    slice = { index: s.index, of: slices.length, dir: s.dir }
  } else if (values.slice) return { ok: false, error: `the diff fits one reviewer (${config.maxBytes} bytes): there are no slices`, range }
  const diff = chosen.map((f) => diffs.get(f)).join('')
  const payload = buildPayload({ prompt, diff, range, blockOn: config.blockOn, round, slice })
  const file = resolve(cwd, values.out)
  writeFileSync(file, payload, 'utf8')
  return { ok: true, file, round, slice, range, files: chosen.length, bytes: Buffer.byteLength(diff, 'utf8'), payloadBytes: Buffer.byteLength(payload, 'utf8') }
}

function readText(cwd, file) {
  try {
    return readFileSync(resolve(cwd, file), 'utf8')
  } catch {
    throw new Error(`cannot read ${file}`)
  }
}

function response(root, cwd, values) {
  if (!values.file) throw new UsageError('response needs --file')
  const kind = values.kind ?? 'findings'
  if (kind !== 'findings' && kind !== 'fix') throw new UsageError('--kind is findings or fix')
  const text = readText(cwd, values.file)
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

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [command, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(TAKES, command)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && !TAKES[command].includes(k))
  if (stray.length > 0) throw new UsageError(`--${stray.join(', --')} does not belong to ${command}`)
  const root = resolve(cwd, values.root ?? '.')
  switch (command) {
    case 'start':
      return start(root, values)
    case 'input':
      return input(root, cwd, values)
    case 'response':
      return response(root, cwd, values)
    case 'render':
      return render(root, cwd, values)
    case 'markers': {
      const { markers, invalid } = scanMarkers(root)
      return { ok: invalid.length === 0, markers, invalid }
    }
    case 'mark':
      if (!values.file || !values.line || !values.key || !values.reason) throw new UsageError('mark needs --file, --line, --key and --reason')
      return { ok: true, ...markIgnore(root, { file: values.file, line: positive('line', values.line), key: values.key, reason: values.reason }) }
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
