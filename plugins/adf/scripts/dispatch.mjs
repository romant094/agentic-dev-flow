#!/usr/bin/env node
// CLI over lib/dispatch.mjs: the name, agent, worktree, reply or section files and prompt of a
// subagent dispatch, and the count of its attempts. Prints one JSON object on stdout; exit 1 on a
// refusal, exit 2 on a usage error.
//
//   dispatch.mjs plan    --change <name> --role <role> [--task <N>] [--group <G>] [--round <k>]
//                        [--topic <word>] [--check c4|c8] [--root <change worktree>]
//       { ok, name, role, agent, worktree, replyFile, ... }; a verify dispatch also names the
//       sectionFile its recorded reply becomes
//       --round names a task's fix round, or a fix or re-review round after a merge review or
//       the final review (fix B r2)
//   dispatch.mjs plan    --change <name> --role ai-review --round <k> [--slice <n>] [--root <dir>]
//   dispatch.mjs plan    --change <name> --role ai-fix --finding F<n> --round <k> [--root <dir>]
//       the review stage: `ai-review r<k>` (`ai-review r<k> s<n>` for one slice of a diff over
//       review.maxBytes) at architecture, with `inputFile`, the file `review.mjs input --out`
//       writes; `ai-fix F<n> r<k>`, one per finding, at integration, architecture from round 2
//   dispatch.mjs prompt  (the inputs of plan) [--question-file <file>] [--base <sha> --head <sha>]
//       the plan and `prompt`, the full text with every fixed field filled; the question file's
//       content goes into the question slot verbatim. --base and --head name a review's range.
//       ai-review refuses while its input file is missing. ai-fix reads the finding from the
//       round's findings file (`review.mjs response` wrote it, ids renumbered) and refuses unless
//       the finding is the `next` of the round's fix plan (`review.mjs fixplan`); it names the
//       finding's file in scope and, for a false-positive claim the developer rejected, the
//       rejected argument and their decision.
//   dispatch.mjs plan    --change <name> --role spec-merge --capability <capability> [--root <dir>]
//   dispatch.mjs plan    --change <name> --role ingest [--root <dir>]
//       archive: `spec-merge <capability>` adjudicates the capability's conflicts of the
//       three-way spec merge check; `ingest` puts what the change taught into the knowledge
//       base. Both at architecture, both replying in JSON under the core's schemas, checked by
//       `specs.mjs resolution` and `ingest.mjs check`. The spec-merge prompt writes the base,
//       current and delta text of each conflict to .superpowers/sdd/<change>/spec-merge/
//       <capability>/ and names those files; it refuses a capability with no unresolved
//       conflict. The ingest prompt reads `ingest.mjs stale`'s input file and refuses while it
//       is missing; its change may already be archived.
//   dispatch.mjs attempt --change <name> --name "<dispatch name>" [--root <change worktree>]
//       records one attempt of the dispatch and returns { ok, name, attempt, next }, next one of
//       dispatch (the first), retry (the one retry of a refused reply), stop (BLOCKED)
//   dispatch.mjs round   --change <name> [--task <N> | --group <G>] [--root <change worktree>]
//       where a fix loop stands, read from the recorded attempts: a task's, a group's after its
//       merge review, or, with neither, the final review's. A round is complete once its
//       re-review was attempted. { ok, subject, completed, max, next, round?, fix?, reReview? }:
//       next `fix` names the round's two dispatches; at the breaker (MAX_ROUNDS) next is
//       `adjudicate` for a task and `escalate-to-developer` for a group or the final review
//   dispatch.mjs reply   --change <name> --name "<dispatch name>" --file <reply file>
//                        [--resume yes|no] [--root <change worktree>]
//       checks the reply through its role's checker (the role read from the name) and records a
//       `valid` or `invalid` event of the name (lib/attempts.mjs). { ok, valid, errors, next, mode,
//       invalid, replyFile, log, result? }: next `proceed` for a valid reply; for a refused one
//       `retry` (the first) or `stop` (the second: BLOCKED, nothing it reported is recorded);
//       mode `resume` on a retry, `fresh` when --resume no says the harness cannot resume the
//       agent, else null. A missing reply file is a refused reply. The checkers: lib/reply.mjs
//       for the apply roles, whose computed `result` (the impl status, the review verdicts, ...)
//       the valid event records and the output carries; review.mjs checkFindings for ai-review,
//       checkFix for ai-fix (its finding must be the name's), spec-merge.mjs
//       checkSpecMergeReply against the capability's conflicts,
//       ingest.mjs checkIngestFile against the ingest input; lib/verify-reply.mjs for `verify c4`
//       and `verify c8`, which on a valid reply also writes the section verify.mjs verdict reads
//       (and, for c8, verify/c8.diff), returned as `section`; their retries count from the verify
//       session's start. A valid `sweep` reply's dispositions are written as `debt` records in
//       the same call (lib/sweep.mjs recordDispositions), listed as `debt`: each id, or why it
//       was skipped
//
// prompt reads the loop state by script (lib/loop.mjs). A `fix` or `re-review` whose subject (the
// task, the group, or the final review) has an accepted review carries `Open findings`, rendered
// from the results and the rulings, so its question file becomes optional; with no open finding
// it refuses. `final-review` writes .superpowers/sdd/<change>/deferred.json and carries what the
// earlier reviews deferred. The `review` of a test-first task runs its proof first when the
// planning guide has a `## Test-first shares` section (lib/tdd-proof.mjs taskProof) and carries
// the result; without it, the reviewer runs tdd-proof. reply then adds to a task review's result
// the proof's critical finding (proof false, commitPasses true), to a sweep's the HEAD it ran
// on, and rewrites deferred.json after every accepted review or re-review.
//
// prompt for a `re-review` with --base and --head (the fix's range) also returns `unplanned`:
// the files that range touched which no task of the plan names, each with its owning task
// (the task itself for a task's round), the files to record with `plan.mjs added`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readArchiveState } from './lib/archive.mjs'
import { attemptsFile, recordDispatch, recordReply, standing } from './lib/attempts.mjs'
import {
  ARCHIVE_ROLES,
  DispatchError,
  parseName,
  planDispatch,
  REVIEW_ROLES,
  renderPrompt,
  roundOf,
  sddDir,
  taskBody,
  verifyDirOf
} from './lib/dispatch.mjs'
import { changeArtifacts, checkIngestFile, findChangeDir, ingestInputFile } from './lib/ingest.mjs'
import { mainCheckout } from './lib/installed.mjs'
import { isMain } from './lib/main.mjs'
import { unplannedIn } from './lib/plan.mjs'
import { parsePlanTasks } from './lib/plan-symbols.mjs'
import { checkReply, replyContext, ROLES as REPLY_ROLES } from './lib/reply.mjs'
import { checkFindings, checkFix } from './lib/review.mjs'
import { checkSpecMergeReply, writeConflictTexts } from './lib/spec-merge.mjs'
import { mergePreview } from './lib/specs.mjs'
import { fixTarget, Refusal, reviewSince } from './lib/review-state.mjs'
import { recordDispositions, sweepInputs } from './lib/sweep.mjs'
import { LOOP_ROLES, openFindings, renderDeferred, subjectHistory, subjectOf, subjectState, withProofFinding, writeDeferred } from './lib/loop.mjs'
import { readTaskProof, taskProof } from './lib/tdd-proof.mjs'
import { gitIn } from './lib/workspace.mjs'
import { c4Inputs, candidatesFile, recordVerifyReply, schemaPath } from './lib/verify-reply.mjs'
import { skillCandidates } from './lib/verify.mjs'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PROMPTS_DIR = join(PLUGIN_ROOT, 'schema', 'prompts')

export const USAGE = `usage:
  dispatch.mjs plan --change <name> --role <role> [--task <N>] [--group <G>] [--round <k>] [--topic <word>] [--check c4|c8] [--slice <n>] [--finding F<n>] [--capability <capability>] [--root <dir>]
  dispatch.mjs prompt (the inputs of plan) [--question-file <file>] [--base <sha> --head <sha>]
  dispatch.mjs attempt --change <name> --name "<dispatch name>" [--root <dir>]
  dispatch.mjs reply --change <name> --name "<dispatch name>" --file <reply file> [--resume yes|no] [--root <dir>]
  dispatch.mjs round --change <name> [--task <N> | --group <G>] [--root <dir>]`

export class UsageError extends Error {}

const FLAGS = ['--change', '--role', '--task', '--group', '--round', '--topic', '--check', '--slice', '--finding', '--capability', '--root', '--question-file', '--base', '--head', '--name', '--file', '--resume']

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    if (!FLAGS.includes(arg)) throw new UsageError(`unknown flag ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    const key = arg.slice(2)
    if (Object.hasOwn(values, key)) throw new UsageError(`${arg} is given twice`)
    values[key] = value
    i++
  }
  return { values, rest }
}

const number = (v) => (v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : v)
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function skeletons() {
  const out = {}
  for (const f of readdirSync(PROMPTS_DIR)) if (f.endsWith('.md')) out[f.slice(0, -3)] = readFileSync(join(PROMPTS_DIR, f), 'utf8')
  return out
}

// The review stage's fields: the reviewer reads its input file alone; the fixer reads its one
// finding from the round's findings file and works in that finding's file.
function reviewFields(inputs, plan, root) {
  const fields = [['Dispatch name', plan.name], ['Change', inputs.change], ['Round', plan.round]]
  if (inputs.role === 'ai-review') {
    if (!existsSync(plan.inputFile)) throw new DispatchError(`no ${plan.inputFile}: run review.mjs input --out ${plan.inputFile} first`)
    if (plan.slice !== undefined) fields.push(['Slice', plan.slice])
    return [...fields, ['Input file', plan.inputFile], ['Reply file', plan.replyFile]]
  }
  let target
  try {
    target = fixTarget(root, inputs.change, { round: plan.round, finding: plan.finding })
  } catch (error) {
    if (error instanceof Refusal) throw new DispatchError(error.message)
    throw new DispatchError(`cannot read round ${plan.round}'s findings: ${error.message}`)
  }
  const { findingsFile, finding, rejected } = target
  if (typeof finding.file !== 'string' || finding.file === '') throw new DispatchError(`${plan.finding} in ${findingsFile} names no file`)
  const where = `${join(plan.worktree, finding.file)}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}`
  fields.push(['Worktree', plan.worktree], ['Finding', `${plan.finding} (${finding.severity}): ${finding.title}`], ['Findings file', findingsFile], ['Files in scope', [where]])
  if (rejected) fields.push(['Rejected false-positive argument', rejected.argument], ["Developer's decision", rejected.decision])
  return [...fields, ['Reply file', plan.replyFile]]
}

const shown = (path) => path ?? 'absent'

// spec-merge: the capability's unresolved conflicts, each text in a file the agent reads.
function specMergeFields(inputs, plan, root) {
  let preview
  try {
    preview = mergePreview(root, inputs.change)
  } catch (error) {
    throw new DispatchError(`cannot preview the spec merge: ${error.message}`)
  }
  const conflicts = preview.conflicts.filter((c) => c.capability === plan.capability)
  if (conflicts.length === 0) throw new DispatchError(`${plan.capability} has no unresolved conflict in ${inputs.change}; there is nothing to adjudicate`)
  const fields = [['Dispatch name', plan.name], ['Change', inputs.change], ['Worktree', plan.worktree], ['Capability', plan.capability]]
  if (preview.base) fields.push(['Merge base', preview.base.sha])
  writeConflictTexts(root, inputs.change, plan.capability, conflicts).forEach((c, i) => {
    const what = c.operation === 'RENAMED' ? `RENAMED to "${c.to}"` : c.operation
    fields.push([`Conflict ${i + 1}`, [`requirement: ${c.requirement} (${what}), side: ${c.side}`, `base: ${shown(c.base)}`, `current: ${shown(c.current)}`, `delta: ${shown(c.delta)}`]])
  })
  return [...fields, ['Reply file', plan.replyFile]]
}

// ingest: the archived change's artifacts, the knowledge base's instruction and the stale list,
// from the input file `ingest.mjs stale` wrote.
function ingestFields(inputs, plan, root) {
  const file = ingestInputFile(root, inputs.change)
  const text = readOr(file)
  if (text === null) throw new DispatchError(`no ${file}: run ingest.mjs stale --change ${inputs.change} first`)
  const input = JSON.parse(text)
  const dir = join(root, input.changeDir)
  return [
    ['Dispatch name', plan.name],
    ['Change', inputs.change],
    ['Worktree', plan.worktree],
    ['Change artifacts', existsSync(dir) ? changeArtifacts(dir) : []],
    ['Ingest instruction', input.knowledge.instruction],
    ['Knowledge index', input.knowledge.index ? join(root, input.knowledge.index) : undefined],
    ['Knowledge paths', input.knowledge.paths],
    ['Stale pages', input.stale.length === 0 ? 'none' : input.stale.map((s) => `${join(root, s.path)}: ${s.reasons.join('; ')}`)],
    ['Reply file', plan.replyFile]
  ]
}

// The test-first proof the flow ran, as the review prompt's field entries.
const proofLines = (p) => [
  `proof: ${p.proof}`,
  `parentFails: ${p.parentFails}`,
  `commitPasses: ${p.commitPasses}`,
  `commit: ${p.commit}`,
  `test: ${p.test}`,
  `test files: ${(p.testFiles ?? []).join(', ')}`,
  `outputs: ${p.outputFiles?.parent}, ${p.outputFiles?.commit}`,
  ...(p.error ? [`error: ${p.error}`] : []),
  `record: ${p.file}`
]

function promptFor(inputs, plan, values, root, planText, main) {
  const { change } = inputs
  const sdd = sddDir(root, change)
  const fields = [['Dispatch name', plan.name], ['Change', change]]
  const tokens = { '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT, '<change>': change, '<root>': root, '<worktree>': plan.worktree }
  if (Object.hasOwn(ARCHIVE_ROLES, inputs.role)) {
    if (values.base !== undefined || values.head !== undefined) throw new UsageError(`--base and --head do not belong to ${inputs.role}`)
    const question = values['question-file'] === undefined ? undefined : readQuestion(values['question-file'])
    const archiveFields = inputs.role === 'spec-merge' ? specMergeFields(inputs, plan, root) : ingestFields(inputs, plan, root)
    return renderPrompt({ plan, change, skeletons: skeletons(), fields: archiveFields, question, tokens })
  }
  if (Object.hasOwn(REVIEW_ROLES, inputs.role)) {
    if (values.base !== undefined || values.head !== undefined) throw new UsageError(`--base and --head do not belong to ${inputs.role}: its range is in its input`)
    const question = values['question-file'] === undefined ? undefined : readQuestion(values['question-file'])
    return renderPrompt({ plan, change, skeletons: skeletons(), fields: reviewFields(inputs, plan, root), question, tokens })
  }
  let testFirst = false
  let dispositions = false
  let proof = null
  let questionOptional = false
  const range = values.base && values.head ? `${values.base}..${values.head}` : undefined
  if ((values.base === undefined) !== (values.head === undefined)) throw new UsageError('--base and --head go together')

  if (inputs.task !== undefined) {
    const task = parsePlanTasks(planText).find((t) => t.number === inputs.task)
    const body = taskBody(planText, inputs.task)
    testFirst = /\*\*Step \d+: RED\*\*/.test(body)
    tokens['<n>'] = inputs.task
    if (values.head) tokens["<the task's commit>"] = values.head
    fields.push(['Task', `Task ${inputs.task} (group ${plan.group})`])
    fields.push(['Worktree', plan.worktree])
    fields.push(['Files in scope', task.files.map((f) => `${f.verb}: ${join(plan.worktree, f.path)}${f.to ? ` -> ${join(plan.worktree, f.to)}` : ''}`)])
    if (inputs.role === 'impl') fields.push(['Task brief', join(sdd, `task-${inputs.task}-brief.md`)])
    // A test-first task's proof runs here, before its review, when the planning guide names the
    // shares (lib/tdd-proof.mjs taskProof); otherwise the reviewer runs it.
    if (inputs.role === 'review' && testFirst) {
      proof = taskProof(root, change, inputs.task, { planText, main })
      fields.push(['Test-first proof', proof.ran ? proofLines(proof) : `not run by the flow: ${proof.reason}`])
    }
  } else if (plan.tasks) {
    const tasks = parsePlanTasks(planText).filter((t) => plan.tasks.includes(t.number))
    fields.push(['Tasks', `group ${plan.group}: ${plan.tasks.map((n) => `Task ${n}`).join(', ')}`])
    fields.push(['Worktree', plan.worktree])
    fields.push(['Files in scope', [...new Set(tasks.flatMap((t) => t.files.map((f) => join(plan.worktree, f.path))))]])
  } else {
    fields.push(['Worktree', plan.worktree])
  }
  // A dispatch that serves no single task records its compromises without a task number.
  if (inputs.task === undefined) tokens[' --task <n>'] = ''
  if (inputs.role !== 'verify') {
    fields.push(['Plan', join(root, 'openspec', 'changes', change, 'plan.md')])
    // A fix and its re-review carry the subject's open findings, rendered from the accepted
    // review results and the rulings, once a review of the subject is recorded.
    if (inputs.role === 'fix' || inputs.role === 're-review') {
      const state = subjectState(root, change, subjectOf(inputs))
      if (state.state !== 'unreviewed') {
        try {
          fields.push(['Open findings', openFindings(state, change)])
        } catch (error) {
          throw new DispatchError(error.message)
        }
        questionOptional = true
      }
    }
    // The final review receives what the earlier reviews deferred.
    if (inputs.role === 'final-review') {
      const deferred = writeDeferred(root, change)
      const items = deferred.items.filter((i) => i.subject !== 'final')
      fields.push(['Deferred', items.length ? items.map(renderDeferred) : 'none'], ['Deferred file', deferred.file])
    }
    if (range) {
      fields.push(['Range', range])
      fields.push(['Review package', join(sdd, `review-${values.base.slice(0, 7)}..${values.head.slice(0, 7)}.diff`)])
    }
    if (inputs.role === 'sweep') {
      let sweep
      try {
        sweep = sweepInputs(root, change)
      } catch (error) {
        throw new DispatchError(error.message)
      }
      tokens['<base>'] = sweep.base
      dispositions = sweep.secondQuestion
      fields.push(['Base', sweep.base], ['Range', sweep.range], ['Planning guide', join(root, 'openspec', 'planning.md')])
      fields.push([
        'Removed or renamed',
        sweep.removedOrRenamed.map((r) => `${r.op} ${r.from ? `${r.from} -> ${r.requirement ?? '(no TO)'}` : r.requirement} (${r.spec}): ${r.codeDisposition ?? 'no Code Disposition'}`)
      ])
    }
    fields.push(['Reply role', plan.role], ['Reply file', plan.replyFile])
  } else {
    const verify = verifyDirOf(root, change)
    tokens['<verify>'] = `${verify}/`
    tokens['<id>'] = plan.section ?? ''
    const run = readOr(join(verify, 'run.json'))
    if (run === null) throw new DispatchError(`no ${join(verify, 'run.json')}: run verify.mjs run first`)
    const { base, head } = JSON.parse(run)
    fields.push(['Base', base], ['Range', base && head ? `${base}..${head}` : undefined], ['Run record', join(verify, 'run.json')])
    const changeDir = join(root, 'openspec', 'changes', change)
    if (inputs.check === 'c4') {
      fields.push(['Files in scope', [join(changeDir, 'design.md'), join(changeDir, 'specs'), join(changeDir, 'tasks.md'), join(changeDir, 'plan.md')]])
      // The lists the reply answers entry by entry, from the script (lib/verify-reply.mjs).
      let listed
      try {
        listed = c4Inputs(root, change)
      } catch (error) {
        throw new DispatchError(error.message)
      }
      const where = (p) => (p.position === 'below' ? 'at or below' : 'above')
      fields.push(['Case', listed.case ?? 'no design and no delta specs'])
      fields.push(['Prose edits', listed.proseEdits.length ? listed.proseEdits.map((p) => `${p.capability} ${p.commit} (${where(p)} ## Requirements)`) : 'none'])
      fields.push(['Removed or renamed', listed.removals.length ? listed.removals.map((r) => `${r.op} ${r.requirement}${r.from ? ` (from ${r.from})` : ''} (${r.spec}): ${r.codeDisposition ?? 'no Code Disposition'}`) : 'none'])
    }
    if (inputs.check === 'c8') {
      if (!existsSync(candidatesFile(root, change))) skillCandidates(root, { change })
      fields.push(['Files in scope', [join(verify, 'c8-candidates.txt')]])
    }
    fields.push(['Reply schema', schemaPath(inputs.check)], ['Reply file', plan.replyFile])
  }
  const question = values['question-file'] === undefined ? undefined : readQuestion(values['question-file'])
  return renderPrompt({ plan, change, skeletons: skeletons(), fields, question, tokens, testFirst, dispositions, proof: Boolean(proof?.ran), questionOptional })
}

// The errors of one reply under its role's checker and, for an apply role, the computed result
// of a valid one: { errors, result? }. `parts` is the parsed dispatch name.
function replyCheck(parts, text, ctx) {
  if (!Object.hasOwn(REPLY_ROLES, parts.role)) return { errors: replyErrors(parts, text, ctx) }
  const checked = checkReply(parts.role, text, () => replyContext(ctx.root, ctx.change, ctx.name, { main: ctx.main }))
  const result = checked.valid && checked.result !== undefined ? withRecords(parts, checked.result, ctx) : undefined
  return { errors: checked.errors, ...(result === undefined ? {} : { result }) }
}

// What the recorded result adds to the computed one from the change's own records: a task
// review's test-first proof (lib/loop.mjs withProofFinding), and the HEAD a sweep ran on, against
// which a later sweep's silence on a finding counts as a consolidation (lib/loop.mjs sweepState).
function withRecords(parts, result, { root, change }) {
  if (parts.role === 'review' && parts.task !== undefined) {
    const history = subjectHistory(readOr(attemptsFile(root, change)) ?? '', `T${parts.task}`)
    return withProofFinding(result, readTaskProof(root, change, parts.task), history)
  }
  if (parts.role === 'sweep') {
    try {
      return { ...result, head: gitIn(root)('rev-parse', 'HEAD') }
    } catch {
      return result
    }
  }
  return result
}

// The errors of one reply of a review-stage or archive role under its checker.
function replyErrors(parts, text, { root, change, file, main }) {
  const { role } = parts
  if (role === 'ai-review') return checkFindings(text).errors
  if (role === 'ai-fix') {
    const checked = checkFix(text)
    if (!checked.valid) return checked.errors
    return checked.reply.finding === parts.finding ? [] : [`$.finding: ${checked.reply.finding} is not ${parts.finding}, the finding this dispatch was sent to fix`]
  }
  if (role === 'spec-merge') {
    let conflicts
    try {
      conflicts = mergePreview(root, change).conflicts.filter((c) => c.capability === parts.capability)
    } catch (error) {
      throw new DispatchError(`cannot preview the spec merge: ${error.message}`)
    }
    if (conflicts.length === 0) throw new DispatchError(`${parts.capability} has no unresolved conflict in ${change}; there is nothing to resolve`)
    return checkSpecMergeReply(text, { capability: parts.capability, conflicts }).errors
  }
  if (role === 'ingest') {
    // The debt files archive's placement wrote changed for another reason (archive.mjs ingest).
    const exclude = readArchiveState(main, change).steps.placements.detail?.debtFiles ?? []
    try {
      return checkIngestFile(root, change, file, { exclude }).errors
    } catch (error) {
      throw new DispatchError(error.message)
    }
  }
  throw new DispatchError(`a ${role} reply has no checker here`)
}

function recordReplyOf(values, { root, change, main }) {
  const { name, file } = values
  const parts = parseName(name)
  if (!parts) throw new DispatchError(`"${name}" is not a dispatch name in the fixed form`)
  if (values.resume !== undefined && !['yes', 'no'].includes(values.resume)) throw new UsageError('--resume is yes or no')
  if (parts.role === 'verify') return recordVerifyReply(root, change, { name, file, resume: values.resume !== 'no' })
  const path = resolve(root, file)
  // The review stage counts only its current run's events (lib/review-state.mjs).
  const since = ['ai-review', 'ai-fix'].includes(parts.role) ? reviewSince(root, change) : null
  // A stopped dispatch's reply is not checked: recordReply refuses it.
  const stopped = standing(readOr(attemptsFile(root, change)) ?? '', name, { since }).next === 'stop'
  const text = stopped ? null : readOr(path)
  const { errors, result } = stopped
    ? { errors: [] }
    : text === null
      ? { errors: [`no reply file ${path}: a reply that is prose and no file is a refusal`] }
      : replyCheck(parts, text, { root, change, name, file: path, main })
  const recorded = recordReply(root, change, { name, file: path, errors, result, resume: values.resume !== 'no', since })
  // The deferred list follows every accepted review and re-review.
  if (recorded.valid && LOOP_ROLES.includes(parts.role)) writeDeferred(root, change)
  // An accepted sweep's dispositions become debt records in the same call (lib/sweep.mjs).
  const debt = recorded.valid && parts.role === 'sweep' && result?.dispositions ? recordDispositions(root, change, result.dispositions) : undefined
  return { ...recorded, ...(result === undefined ? {} : { result }), ...(debt === undefined ? {} : { debt }) }
}

function existsArchived(root, change) {
  try {
    return Boolean(findChangeDir(root, change))
  } catch {
    return false
  }
}

function readQuestion(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    throw new UsageError(`cannot read --question-file ${file}: ${e.message}`)
  }
}

export function run(argv, { cwd = process.cwd(), main } = {}) {
  const { values, rest } = parse(argv)
  const [command, ...extra] = rest
  if (extra.length > 0 || !['plan', 'prompt', 'attempt', 'round', 'reply'].includes(command) || !values.change) throw new UsageError(USAGE)
  const root = resolve(cwd, values.root ?? '.')
  const change = values.change
  // The ingest runs on the archived change; every other dispatch on an active one.
  const archived = values.role === 'ingest' || values.name === 'ingest'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change) || !(existsSync(join(root, 'openspec', 'changes', change)) || (archived && existsArchived(root, change)))) {
    throw new DispatchError(`no change "${change}" in ${join(root, 'openspec', 'changes')}`)
  }

  if (command === 'attempt') {
    if (!values.name || Object.keys(values).some((k) => !['change', 'name', 'root'].includes(k))) throw new UsageError(USAGE)
    return { ok: true, ...recordDispatch(root, change, values.name) }
  }

  if (command === 'reply') {
    if (!values.name || !values.file || Object.keys(values).some((k) => !['change', 'name', 'file', 'resume', 'root'].includes(k))) throw new UsageError(USAGE)
    return { name: values.name, ...recordReplyOf(values, { root, change, main: main ?? mainCheckout(root) }) }
  }

  if (command === 'round') {
    if (Object.keys(values).some((k) => !['change', 'task', 'group', 'root'].includes(k))) throw new UsageError(USAGE)
    return { ok: true, ...roundOf(readOr(attemptsFile(root, change)) ?? '', { task: number(values.task), group: values.group }) }
  }

  if (!values.role) throw new UsageError(USAGE)
  if (values.name) throw new UsageError('--name belongs to attempt and reply')
  if (values.file || values.resume) throw new UsageError('--file and --resume belong to reply')
  if (command === 'plan' && (values['question-file'] || values.base || values.head)) throw new UsageError('--question-file, --base and --head belong to prompt')
  const inputs = {
    change,
    role: values.role,
    task: number(values.task),
    group: values.group,
    round: number(values.round),
    topic: values.topic,
    check: values.check,
    slice: number(values.slice),
    finding: values.finding,
    capability: values.capability
  }
  const planText = readOr(join(root, 'openspec', 'changes', change, 'plan.md'))
  const checkout = main ?? mainCheckout(root)
  const plan = planDispatch(inputs, { root, main: checkout, planText, exists: existsSync })
  if (command === 'plan') return { ok: true, ...plan }
  const prompt = promptFor(inputs, plan, values, root, planText, checkout)
  if (inputs.role !== 're-review' || !values.base) return { ok: true, ...plan, prompt }
  let found
  try {
    found = unplannedIn(root, change, planText, { range: `${values.base}..${values.head}`, owner: inputs.task })
  } catch (error) {
    throw new DispatchError(`cannot read the fix's range ${values.base}..${values.head}: ${error.message}`)
  }
  return { ok: true, ...plan, prompt, unplanned: found.files.map(({ file, verb, owner }) => ({ file, verb, owner })) }
}

if (isMain(import.meta.url)) {
  try {
    const out = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (out.ok === false) process.exitCode = 1
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(usage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
