#!/usr/bin/env node
// CLI over lib/scope.mjs: propose's scope, gathered, selected, checked and started before and
// just after the change's branch is made. Prints one JSON object on stdout; exit 1 on a refusal
// or a result with ok false, exit 2 on a usage error. --root is any checkout of the host (default:
// the current directory); the state lives in the main checkout's
// .superpowers/sdd/<change>/scope/, the tracker's files in .superpowers/sdd/<change>/tracker/.
// --home names the Claude Code home where the plugins are found.
//
//   scope.mjs gather --change <name> [--keys K1,K2] [--text "<phrase>"] [--skip-tracker "<reason>"]
//       the tracker's check, then its gather of the keys and the phrase, a debt id among the
//       keys left out (none with no tracker
//       plugin; degraded says so with its hint, and --skip-tracker records working without it
//       for this change); the debt entries whose Tracker cell or id is a gathered key, or whose
//       title matches the phrase's words (with neither, the change name's); the in-flight
//       changes whose scope takes a gathered key. A gather again keeps each item's selection and
//       check, and names only the flags no earlier gather showed.
//       { ok, tracker, items, inFlight, flags, empty, report, next }; empty: nothing to select
//   scope.mjs select --change <name> [--take K1,K2] [--partial "K3: <reason>"]...
//                    [--exclude "K4: <reason>"]... [--rest "<reason>"]
//       records each choice; a partial or excluded item needs its reason; --rest excludes every
//       undecided item. { ok, items, undecided, branch, next }; branch: the key of the lowest
//       rank ({ key, token }), a tie ({ tie: [keys] }) or null
//   scope.mjs check-input --change <name> [--key <KEY>]
//       one input file and one prompt per taken or partial item (or the one named), the base
//       commit recorded. { ok, base, dispatches: [{ name, key, agent, worktree, inputFile,
//       promptFile, replyFile }] }: dispatch each as `scope-check <KEY>`, read-only
//   scope.mjs check --change <name> --key <KEY> --file <reply json>
//       the reply checked against schema/scope-check.schema.json and the script's rules, and
//       recorded. { ok, valid, errors?, verdict?, questions?, next }; a refusal is exit 1: send
//       the errors to the same agent once
//   scope.mjs answer --change <name> --key <KEY> --question <n> --answer "<text>"
//   scope.mjs answer --change <name> --key <KEY> --verdict current|corrected|obsolete [--reason "<text>"]
//       one answer of the developer; then the verdict the answers give (obsolete excludes the
//       item with the reason). { ok, verdict, state, open, next }
//   scope.mjs render --change <name> [--root <change worktree>]
//       writes the proposal's `## Scope sources` section from the change's scope.json;
//       { ok, written, section? }. The proposal gate scope-sources checks it
//   scope.mjs retest --change <name> [--yes]
//       the not-reproduced items through the tracker's handoff (state not-reproduced, fields
//       { tried, commit }). Without --yes pending: { held, plan, preview, report, waiting };
//       with it applied, and each applied item excluded: "does not reproduce; sent to retest"
//   scope.mjs start --change <name> [--yes]
//       after propose.mjs create: the taken and partial tracker issues through the tracker's
//       start, each with its corrections and answers. Held as retest is
//   scope.mjs state --change <name>
//       the record, read-only. { ok, file, scope, branch, recordable }
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMain } from './lib/main.mjs'
import { CORE } from './lib/roles.mjs'
import { answer, check, checkInput, gather, Refusal, render, retest, select, start, state } from './lib/scope.mjs'
import { claudeHome } from './lib/superpowers.mjs'

export const USAGE = `usage:
  scope.mjs gather --change <name> [--keys K1,K2] [--text "<phrase>"] [--skip-tracker "<reason>"] [--root <dir>] [--home <dir>]
  scope.mjs select --change <name> [--take K1,K2] [--partial "<KEY>: <reason>"]... [--exclude "<KEY>: <reason>"]... [--rest "<reason>"] [--root <dir>]
  scope.mjs check-input --change <name> [--key <KEY>] [--root <dir>] [--home <dir>]
  scope.mjs check --change <name> --key <KEY> --file <reply json> [--root <dir>]
  scope.mjs answer --change <name> --key <KEY> (--question <n> --answer "<text>" | --verdict current|corrected|obsolete [--reason "<text>"]) [--root <dir>]
  scope.mjs render --change <name> [--root <change worktree>]
  scope.mjs retest --change <name> [--yes] [--root <dir>] [--home <dir>]
  scope.mjs start --change <name> [--yes] [--root <dir>] [--home <dir>]
  scope.mjs state --change <name> [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = {
  change: { type: 'string' },
  root: { type: 'string' },
  home: { type: 'string' },
  keys: { type: 'string' },
  text: { type: 'string' },
  'skip-tracker': { type: 'string' },
  take: { type: 'string', multiple: true },
  partial: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  rest: { type: 'string' },
  key: { type: 'string' },
  file: { type: 'string' },
  question: { type: 'string' },
  answer: { type: 'string' },
  verdict: { type: 'string' },
  reason: { type: 'string' },
  yes: { type: 'boolean' }
}
const TAKES = {
  gather: ['keys', 'text', 'skip-tracker', 'home'],
  select: ['take', 'partial', 'exclude', 'rest'],
  'check-input': ['key', 'home'],
  check: ['key', 'file'],
  answer: ['key', 'question', 'answer', 'verdict', 'reason'],
  render: [],
  retest: ['yes', 'home'],
  start: ['yes', 'home'],
  state: []
}
const usage = (message) => {
  throw new UsageError(`${message}\n${USAGE}`)
}

const list = (value) => (value ?? []).flatMap((v) => v.split(',')).map((k) => k.trim()).filter(Boolean)

// "<KEY>: <reason>", split at the first colon; a key holds none.
function withReason(flag, values) {
  return (values ?? []).map((v) => {
    const at = v.indexOf(':')
    if (at === -1) usage(`--${flag} takes "<KEY>: <reason>", not "${v}"`)
    return { key: v.slice(0, at).trim(), reason: v.slice(at + 1).trim() }
  })
}

export function run(argv, { cwd = process.cwd() } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(`${error.message}\n${USAGE}`)
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (!Object.hasOwn(TAKES, command ?? '') || extra.length > 0) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => !['change', 'root'].includes(k) && !TAKES[command].includes(k))
  if (stray.length > 0) usage(`${command} takes no --${stray[0]}`)
  if (!values.change) usage(`${command} needs --change <name>`)
  const root = resolve(cwd, values.root ?? '.')
  const change = values.change
  const core = { ...CORE, home: values.home ?? claudeHome() }
  switch (command) {
    case 'gather':
      return gather(root, change, { keys: list(values.keys === undefined ? [] : [values.keys]), text: values.text ?? null, skipTracker: values['skip-tracker'] ?? null, core })
    case 'select':
      return select(root, change, { take: list(values.take), partial: withReason('partial', values.partial), exclude: withReason('exclude', values.exclude), rest: values.rest ?? null })
    case 'check-input':
      return checkInput(root, change, { key: values.key ?? null, core })
    case 'check':
      if (!values.key || !values.file) usage('check needs --key and --file')
      return check(root, change, { key: values.key, file: resolve(cwd, values.file) })
    case 'answer': {
      if (!values.key) usage('answer needs --key')
      if (values.question !== undefined) {
        if (!/^[1-9]\d*$/.test(values.question)) usage('--question is the question number, from 1')
        if (values.answer === undefined || values.verdict !== undefined || values.reason !== undefined) usage('--question takes --answer, and no --verdict or --reason')
        return answer(root, change, { key: values.key, question: Number(values.question), text: values.answer })
      }
      if (values.verdict === undefined || values.answer !== undefined) usage('answer takes --question <n> --answer "<text>", or --verdict')
      return answer(root, change, { key: values.key, verdict: values.verdict, reason: values.reason ?? null })
    }
    case 'render':
      return render(root, change)
    case 'retest':
      return retest(root, change, { yes: Boolean(values.yes), core })
    case 'start':
      return start(root, change, { yes: Boolean(values.yes), core })
    default:
      return state(root, change)
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const isUsage = error instanceof UsageError
    const extra = error instanceof Refusal ? error.extra : {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...extra, ...(isUsage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = isUsage ? 2 : 1
  }
}
