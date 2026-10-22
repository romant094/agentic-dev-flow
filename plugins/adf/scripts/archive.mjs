#!/usr/bin/env node
// CLI over lib/archive.mjs: /adf:archive's deterministic steps, each resumable. Prints one JSON
// object on stdout; exit 1 on a refusal or a failed step, exit 2 on a usage error. --root is the
// change worktree (default: the current directory); --home names the Claude Code home where the
// knowledge and forge plugins are found.
//
// The steps, in this order; each runs once every step before it is settled (done, degraded or
// skipped), a done or skipped step is reported as it is, a failed or degraded one runs again:
//   archive.mjs check --change <name>
//       the review record PASS only (BLOCKED refused), committed, its reviewed commit an ancestor
//       of HEAD, no commit after it touching anything but the record, the refusal naming the
//       change root and the repository root; a missing or stale specs-base.json entry refused,
//       no specs-base.json at all a warning; artifacts not done and unchecked tasks as
//       detail.warnings; the hand-edited capabilities verify.md lists as detail.handEdited
//   archive.mjs placements --change <name>
//       detail.unplaced: every debt with no resolve, every recorded or accepted review finding
//       with no `resolve --finding`, every deviation cited by no debt and no ruling, each with
//       the command that places it; anything listed fails the step; on a pass the debt entries
//       scope.json takes in full removed, detail.removedDebt, an entry already gone in
//       detail.goneDebt
//   archive.mjs merge --change <name> [--resolutions <file> ...] [--purpose <capability>=<file> ...]
//       the delta specs into the main specs, all or nothing; the resolution files are joined; a
//       conflict fails the step with detail.conflicts (the spec-merge dispatches and their text
//       files); a new capability's placeholder Purpose refuses until --purpose gives it
//   archive.mjs move --change <name>
//       changes.mjs archive: the ledger copied once, the change moved to archive/<date>-<name>
//   archive.mjs commit-specs --change <name>
//       `docs(specs): archive <name>`: the old and new change directories and the main spec
//       files of the change's capabilities; any other uncommitted file of the change tree, the
//       main specs, the knowledge base or the debt tree refuses, named
//   archive.mjs ingest --change <name> [--reply <file>] [--resume yes|no]
//       the ingest reply checked (ingest.mjs check) and recorded as an event of the dispatch
//       `ingest` (lib/attempts.mjs), the log written through the knowledge role; a refused
//       reply fails the step with detail.next `retry` (detail.mode `resume`, or `fresh` with
//       --resume no) the first time and `stop` the second, after which archive stops; the debt
//       ids placements removed go into the log entry; with no knowledge provider the step is
//       skipped and says so, and that the removed ids were not logged
//   archive.mjs commit-memory --change <name>
//       `docs(memory): ingest what <name> taught`: only the paths the ingest and the placement
//       wrote; nothing to commit is no commit
//   archive.mjs metrics --change <name>
//       the metrics record (lib/metrics.mjs) as metrics.json in the archived directory, with a
//       copy of attempts.jsonl, and the price table updated from the registry's
//       metrics.pricesUrl; a failed price fetch is detail.prices.state `stale` or `none`, not a
//       failure; no transcripts: degraded, the record written and detail.gap naming why; a record
//       that fails its schema: failed, nothing written
//   archive.mjs commit-metrics --change <name>
//       `chore(metrics): record <name>`: only the paths metrics wrote; nothing to commit is no
//       commit
//   archive.mjs mr --change <name> [--body <file> --summary "<scope>: <description>" | --title <t>]
//       the forge role's finalize; no forge: skipped (no --body needed); a forge and no --body:
//       held, pending, nothing recorded, with bodyFile and waiting; degraded: the role's
//       fallback kept and the step degraded
//   archive.mjs merge-local --change <name> [--yes | --no]
//       with no forge only: without a flag, the commands, nothing recorded; --yes merges with
//       `git merge --no-ff` in the main checkout when it has the base checked out and is clean,
//       nothing pushed, the branch kept; --no records that the developer merges it
//   archive.mjs remove --change <name>
//       workspace.mjs remove from the main checkout
// Each prints { ok, change, step, state, detail, next, already?, refusal? }. Each takes --no-ci:
// it is kept in the archive state, so a resumed run keeps it, and the mr step passes it to the
// forge as `ci: false` (a push with no CI run).
//
// Read-only:
//   archive.mjs mr-input --change <name>
//       { ok, change, changeDir, tasks: { done, open }, why, scenarios: [{ capability,
//         requirement, scenario, given, when, then }], evidence: { verdict, sections: [{ title,
//         text }] }, bodyFile }
//   archive.mjs state --change <name>     { ok, change, ci, steps: { <step>: { state, at, detail } }, next }
//   archive.mjs next --change <name>      { ok, change, next: <step> | null, state }
//   archive.mjs report --change <name>    { ok, change, complete, next, steps, handEdited, window,
//                                         lintDue, candidates, signals, report }: built last, from
//                                         the states; complete only when every step is done or
//                                         skipped, metrics degraded allowed. Then, each only when
//                                         it has content: the changes archived since the last
//                                         window retro on the integration ref, with its fetch age
//                                         (one fetch; a failed one reported, never fatal); one
//                                         corpus lint line, due when verify.md lists hand-edited
//                                         capability prose or 3 or more changes are counted; the
//                                         removal candidates; the record's hurt signals (a stopped
//                                         dispatch, the review round cap, a compaction) with a
//                                         suggested /adf:retro --change; no record when metrics
//                                         failed
import { parseArgs } from 'node:util'
import {
  archiveContext,
  checkStep,
  commitMemoryStep,
  commitMetricsStep,
  commitSpecsStep,
  ingestStep,
  mergeLocalStep,
  mergeStep,
  metricsStep,
  moveStep,
  mrInput,
  mrStep,
  nextStep,
  placementsStep,
  readArchiveState,
  Refusal,
  removeStep,
  report,
  setNoCi,
  STEPS
} from './lib/archive.mjs'
import { isMain } from './lib/main.mjs'
import { claudeHome } from './lib/superpowers.mjs'

export const USAGE = `usage:
  archive.mjs check|placements|move|commit-specs|commit-memory|metrics|commit-metrics|remove --change <name> [--no-ci] [--root <dir>] [--home <dir>]
  archive.mjs mr-input|state|next|report --change <name> [--root <dir>] [--home <dir>]
  archive.mjs merge --change <name> [--resolutions <file> ...] [--purpose <capability>=<file> ...] [--no-ci] [--root <dir>]
  archive.mjs ingest --change <name> [--reply <file>] [--resume yes|no] [--no-ci] [--root <dir>] [--home <dir>]
  archive.mjs mr --change <name> [--body <file> (--summary "<scope>: <description>" | --title <t>)] [--no-ci] [--root <dir>] [--home <dir>]
  archive.mjs merge-local --change <name> [--yes | --no] [--no-ci] [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = {
  change: { type: 'string' },
  root: { type: 'string' },
  home: { type: 'string' },
  resolutions: { type: 'string', multiple: true },
  purpose: { type: 'string', multiple: true },
  reply: { type: 'string' },
  resume: { type: 'string' },
  body: { type: 'string' },
  title: { type: 'string' },
  summary: { type: 'string' },
  yes: { type: 'boolean' },
  no: { type: 'boolean' },
  'no-ci': { type: 'boolean' }
}
const COMMON = ['change', 'root', 'home']
const TAKES = {
  check: [],
  placements: [],
  merge: ['resolutions', 'purpose'],
  move: [],
  'commit-specs': [],
  ingest: ['reply', 'resume'],
  'commit-memory': [],
  metrics: [],
  'commit-metrics': [],
  'mr-input': [],
  mr: ['body', 'title', 'summary'],
  'merge-local': ['yes', 'no'],
  remove: [],
  state: [],
  next: [],
  report: []
}

function purposes(values) {
  const out = {}
  for (const item of values ?? []) {
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(.+)$/.exec(item)
    if (!m) throw new UsageError(`--purpose takes <capability>=<file>, not "${item}"`)
    if (out[m[1]] !== undefined) throw new UsageError(`--purpose names ${m[1]} twice`)
    out[m[1]] = m[2]
  }
  return out
}

// deps: as lib/archive.mjs archiveContext takes them; the tests inject the roles and the clock.
export function run(argv, { cwd = process.cwd(), deps = {} } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(error.message)
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (!Object.hasOwn(TAKES, command ?? '') || extra.length > 0 || !values.change) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => !COMMON.includes(k) && !TAKES[command].includes(k) && !(k === 'no-ci' && STEPS.includes(command)))
  if (stray.length > 0) throw new UsageError(`${command} takes no --${stray[0]}\n${USAGE}`)
  if (values.yes && values.no) throw new UsageError('merge-local takes --yes or --no, not both')
  if (values.title && values.summary) throw new UsageError('mr takes --title or --summary, not both')
  const ctx = archiveContext(values.root ?? cwd, values.change, { home: values.home ?? claudeHome(), ...deps })
  if (values['no-ci']) setNoCi(ctx.main, ctx.change)
  switch (command) {
    case 'check':
      return checkStep(ctx)
    case 'placements':
      return placementsStep(ctx)
    case 'merge':
      return mergeStep(ctx, { resolutionFiles: values.resolutions ?? [], purposeFiles: purposes(values.purpose) })
    case 'move':
      return moveStep(ctx)
    case 'commit-specs':
      return commitSpecsStep(ctx)
    case 'ingest':
      if (values.resume !== undefined && !['yes', 'no'].includes(values.resume)) throw new UsageError('--resume is yes or no')
      return ingestStep(ctx, { reply: values.reply ?? null, resume: values.resume !== 'no' })
    case 'commit-memory':
      return commitMemoryStep(ctx)
    case 'metrics':
      return metricsStep(ctx)
    case 'commit-metrics':
      return commitMetricsStep(ctx)
    case 'mr-input':
      return mrInput(ctx)
    case 'mr':
      return mrStep(ctx, { body: values.body ?? null, title: values.title, summary: values.summary })
    case 'merge-local':
      return mergeLocalStep(ctx, { yes: Boolean(values.yes), no: Boolean(values.no) })
    case 'remove':
      return removeStep(ctx)
    case 'state': {
      const state = readArchiveState(ctx.main, ctx.change)
      return { ok: true, change: ctx.change, ci: state.ci !== false, steps: state.steps, next: nextStep(state) }
    }
    case 'next': {
      const state = readArchiveState(ctx.main, ctx.change)
      const next = nextStep(state)
      return { ok: true, change: ctx.change, next, state: next ? state.steps[next].state : null }
    }
    default:
      return report(ctx)
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof Refusal ? error.extra : {}), ...(usage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
