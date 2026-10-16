#!/usr/bin/env node
// CLI over lib/dispatch.mjs: the name, agent, worktree, reply or section files and prompt of a
// subagent dispatch, and the count of its attempts. Prints one JSON object on stdout; exit 1 on a
// refusal, exit 2 on a usage error.
//
//   dispatch.mjs plan    --change <name> --role <role> [--task <N>] [--group <G>] [--round <k>]
//                        [--topic <word>] [--check c4|c8] [--root <change worktree>]
//       { ok, name, role, agent, worktree, replyFile | sectionFiles, ... }
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
//   dispatch.mjs attempt --change <name> --name "<dispatch name>" [--root <change worktree>]
//       records one attempt of the dispatch and returns { ok, name, attempt, next }, next one of
//       dispatch (the first), retry (the one retry of a refused reply), stop (BLOCKED)
//   dispatch.mjs round   --change <name> [--task <N> | --group <G>] [--root <change worktree>]
//       where a fix loop stands, read from the recorded attempts: a task's, a group's after its
//       merge review, or, with neither, the final review's. A round is complete once its
//       re-review was attempted. { ok, subject, completed, max, next, round?, fix?, reReview? }:
//       next `fix` names the round's two dispatches; at the breaker (MAX_ROUNDS) next is
//       `adjudicate` for a task and `escalate-to-developer` for a group or the final review
//
// prompt for a `re-review` with --base and --head (the fix's range) also returns `unplanned`:
// the files that range touched which no task of the plan names, each with its owning task
// (the task itself for a task's round), the files to record with `plan.mjs added`.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countAttempts,
  DispatchError,
  nextFor,
  parseName,
  planDispatch,
  REVIEW_ROLES,
  renderPrompt,
  roundOf,
  sddDir,
  taskBody,
  verifyDirOf
} from './lib/dispatch.mjs'
import { mainCheckout } from './lib/installed.mjs'
import { isMain } from './lib/main.mjs'
import { unplannedIn } from './lib/plan.mjs'
import { parsePlanTasks } from './lib/plan-symbols.mjs'
import { fixTarget, Refusal } from './lib/review-state.mjs'
import { sweepInputs } from './lib/sweep.mjs'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PROMPTS_DIR = join(PLUGIN_ROOT, 'schema', 'prompts')

export const USAGE = `usage:
  dispatch.mjs plan --change <name> --role <role> [--task <N>] [--group <G>] [--round <k>] [--topic <word>] [--check c4|c8] [--slice <n>] [--finding F<n>] [--root <dir>]
  dispatch.mjs prompt (the inputs of plan) [--question-file <file>] [--base <sha> --head <sha>]
  dispatch.mjs attempt --change <name> --name "<dispatch name>" [--root <dir>]
  dispatch.mjs round --change <name> [--task <N> | --group <G>] [--root <dir>]`

export class UsageError extends Error {}

const FLAGS = ['--change', '--role', '--task', '--group', '--round', '--topic', '--check', '--slice', '--finding', '--root', '--question-file', '--base', '--head', '--name']

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

function promptFor(inputs, plan, values, root, planText) {
  const { change } = inputs
  const sdd = sddDir(root, change)
  const fields = [['Dispatch name', plan.name], ['Change', change]]
  const tokens = { '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT, '<change>': change, '<root>': root, '<worktree>': plan.worktree }
  if (Object.hasOwn(REVIEW_ROLES, inputs.role)) {
    if (values.base !== undefined || values.head !== undefined) throw new UsageError(`--base and --head do not belong to ${inputs.role}: its range is in its input`)
    const question = values['question-file'] === undefined ? undefined : readQuestion(values['question-file'])
    return renderPrompt({ plan, change, skeletons: skeletons(), fields: reviewFields(inputs, plan, root), question, tokens })
  }
  let testFirst = false
  let dispositions = false
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
    if (inputs.check === 'c4') fields.push(['Files in scope', [join(changeDir, 'design.md'), join(changeDir, 'specs'), join(changeDir, 'tasks.md'), join(changeDir, 'plan.md')]])
    if (inputs.check === 'c8') fields.push(['Files in scope', [join(verify, 'c8-candidates.txt')]])
    fields.push(['Output file', plan.sectionFiles[0]], ['Section file', plan.sectionFiles[1]])
  }
  const question = values['question-file'] === undefined ? undefined : readQuestion(values['question-file'])
  return renderPrompt({ plan, change, skeletons: skeletons(), fields, question, tokens, testFirst, dispositions })
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
  if (extra.length > 0 || !['plan', 'prompt', 'attempt', 'round'].includes(command) || !values.change) throw new UsageError(USAGE)
  const root = resolve(cwd, values.root ?? '.')
  const change = values.change
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change) || !existsSync(join(root, 'openspec', 'changes', change))) {
    throw new DispatchError(`no change "${change}" in ${join(root, 'openspec', 'changes')}`)
  }

  if (command === 'attempt') {
    if (!values.name || Object.keys(values).some((k) => !['change', 'name', 'root'].includes(k))) throw new UsageError(USAGE)
    if (!parseName(values.name)) throw new DispatchError(`"${values.name}" is not a dispatch name in the fixed form`)
    const dir = sddDir(root, change)
    const file = join(dir, 'attempts.jsonl')
    mkdirSync(dir, { recursive: true })
    appendFileSync(file, `${JSON.stringify({ name: values.name, at: new Date().toISOString() })}\n`)
    const attempt = countAttempts(readFileSync(file, 'utf8'), values.name)
    return { ok: true, name: values.name, attempt, next: nextFor(attempt), file }
  }

  if (command === 'round') {
    if (Object.keys(values).some((k) => !['change', 'task', 'group', 'root'].includes(k))) throw new UsageError(USAGE)
    const file = join(sddDir(root, change), 'attempts.jsonl')
    return { ok: true, ...roundOf(readOr(file) ?? '', { task: number(values.task), group: values.group }) }
  }

  if (!values.role) throw new UsageError(USAGE)
  if (values.name) throw new UsageError('--name belongs to attempt')
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
    finding: values.finding
  }
  const planText = readOr(join(root, 'openspec', 'changes', change, 'plan.md'))
  const plan = planDispatch(inputs, { root, main: main ?? mainCheckout(root), planText, exists: existsSync })
  if (command === 'plan') return { ok: true, ...plan }
  const prompt = promptFor(inputs, plan, values, root, planText)
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
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(usage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
