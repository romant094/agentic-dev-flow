#!/usr/bin/env node
// CLI over lib/verify.mjs. Prints one JSON object on stdout; exit 1 on a refusal, a failing
// check (run, skill-edit) or a FAIL verdict (verdict), exit 2 on a usage error. --root is the
// change worktree (default: the current directory).
//
//   verify.mjs run --change <name> [--root <dir>] [--fresh] [--skill-edit <sha> ...]
//       run the mechanical checks; each writes its raw output under
//       .superpowers/sdd/<change>/verify/ and the list is kept in verify/run.json with the
//       session id. A run in another session than the one that wrote run.json (read from
//       CLAUDE_CODE_SESSION_ID) clears that directory first; --fresh forces the clearing.
//       The approved skill edits are the ledger's skill-edit records; --skill-edit names more
//   verify.mjs verdict --change <name> [--root <dir>] [--out <file>] [--report]
//       read run.json and the verify/<id>.json sections, apply the developer's rulings from the
//       ledger, and compute the `Verdict:` line. A refusal lists `refusals`, `redispatch` (the
//       section ids to dispatch again), `needsRuling` (the not-run checks) and `rerun`. --out
//       also writes the result to a file; --report adds `report`, the text block to show
//   verify.mjs assemble --change <name> [--root <dir>] [--commit]
//       render openspec/changes/<change>/verify.md from the template, run.json, the sections,
//       the verdict, the rulings and the approved skill edits; its last line is the verdict's
//       `line`. --commit commits the record alone ("docs(openspec): verify <change>").
//       Refused when the verdict refuses: { ok:false, refusals, redispatch, needsRuling, report }.
//       Otherwise { ok:true, file, verdict, line, commit, report }, also on a FAIL verdict
//   verify.mjs skill-edit --change <name> --message "<type(scope): description>" [--root <dir>]
//       commit the approved skill edit in the working tree, refused when any staged, changed or
//       untracked path lies outside .claude/skills/; record its sha in the ledger; run again
//   verify.mjs skill-candidates --change <name> [--root <dir>]
//       the lines of each host .claude/skills/*/SKILL.md and README.md that name a path,
//       symbol, command or route the range's diff changed; the listing also goes to
//       verify/c8-candidates.txt, the input of the verify c8 dispatch
//   verify.mjs developer --change <name> --text-file <file> --verdict <pass|warn|fail|not-run>
//                        [--summary <text>] [--root <dir>]
//       write verify/developer.txt (the file's text, verbatim) and its section developer.json
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { loadSchema } from './lib/schema.mjs'
import { assemble, computeVerdict, renderReport, runChecks, skillCandidates, skillEdit, writeDeveloper } from './lib/verify.mjs'

export const USAGE = `usage:
  verify.mjs run --change <name> [--root <dir>] [--fresh] [--skill-edit <sha> ...]
  verify.mjs verdict --change <name> [--root <dir>] [--out <file>] [--report]
  verify.mjs assemble --change <name> [--root <dir>] [--commit]
  verify.mjs skill-edit --change <name> --message <message> [--root <dir>]
  verify.mjs skill-candidates --change <name> [--root <dir>]
  verify.mjs developer --change <name> --text-file <file> --verdict <verdict> [--summary <text>] [--root <dir>]`

export class UsageError extends Error {}

const VALUED = ['--change', '--root', '--skill-edit', '--out', '--message', '--text-file', '--verdict', '--summary']
const BOOLEAN = ['--fresh', '--report', '--commit']
// The options each subcommand takes, besides --change and --root.
const TAKES = {
  run: ['fresh', 'skill-edit'],
  verdict: ['out', 'report'],
  assemble: ['commit'],
  'skill-edit': ['message'],
  'skill-candidates': [],
  developer: ['text-file', 'verdict', 'summary']
}

function parse(argv) {
  const values = { 'skill-edit': [] }
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
    if (arg === '--skill-edit') values['skill-edit'].push(value)
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  if (values['skill-edit'].length === 0) delete values['skill-edit']
  return { values, rest }
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { values, rest } = parse(argv)
  const [command, ...extra] = rest
  const { change, root = cwd } = values
  if (!change || extra.length > 0 || !Object.hasOwn(TAKES, command)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'change' && k !== 'root' && !TAKES[command].includes(k))
  if (stray.length > 0) throw new UsageError(`--${stray.join(', --')} does not belong to ${command}`)
  const tracks = () => loadSchema().apply?.tracks ?? 'tasks.md'
  switch (command) {
    case 'run':
      return runChecks(root, { change, skillEdits: values['skill-edit'] ?? [], fresh: Boolean(values.fresh), tracks: tracks(), env })
    case 'verdict': {
      const result = computeVerdict(root, { change })
      const out = values.report ? { ...result, report: renderReport(result, { change }) } : result
      if (values.out) writeFileSync(resolve(cwd, values.out), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
      return out
    }
    case 'assemble':
      return assemble(root, { change, commit: Boolean(values.commit) })
    case 'skill-edit':
      if (!values.message) throw new UsageError('skill-edit needs --message')
      return skillEdit(root, { change, message: values.message, tracks: tracks(), env })
    case 'skill-candidates':
      return skillCandidates(root, { change })
    case 'developer':
      if (!values['text-file'] || !values.verdict) throw new UsageError('developer needs --text-file and --verdict')
      return writeDeveloper(root, { change, text: readFileSync(resolve(cwd, values['text-file']), 'utf8'), verdict: values.verdict, summary: values.summary })
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
