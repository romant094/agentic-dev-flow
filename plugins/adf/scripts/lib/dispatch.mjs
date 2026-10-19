// Every subagent dispatch of a change has a fixed name, a fixed agent level, a fixed reply or
// section file and a fixed worktree, and its prompt carries fixed fields and fixed clauses. The
// apply and verify instructions state the orchestrator's rules and the skeletons under
// schema/prompts/ state what an agent is told; this module applies both, so a dispatch does not
// depend on the orchestrator remembering them. The metrics read the role, the task and the
// round from the name: 17 of 39 dispatches of one origin change missed the form.
//
// Names (schema/instructions/apply.md, "Name every dispatch in the fixed form"):
//   T<n> <role>, T<n> <role> r<k>          role impl | review | re-review | fix
//   final-review, sweep, investigate <topic>, merge-review <G>
//   fix [<G>] [r<k>], re-review [<G>] [r<k>]
//   verify c4 | verify c8   (schema/instructions/verify.md)
//   ai-review r<k>, ai-review r<k> s<n>, ai-fix F<n> r<k>   (the review stage)
//   spec-merge <capability>, ingest   (archive)
//
// Pure: every read of the tree is done by the caller and passed in.
import { join } from 'node:path'

export const LEVELS = ['mechanical', 'integration', 'architecture']
export const TASK_ROLES = ['impl', 'review', 're-review', 'fix']
// Task-less roles: the level each takes and whether it names a group (`required`, `optional`
// or `none`). fix, re-review and investigate have no level in the instruction's table: they go at
// integration, the level the agent definitions give integration, debugging and investigation.
export const TASKLESS = {
  'final-review': { level: 'architecture', group: 'none' },
  'merge-review': { level: 'architecture', group: 'required' },
  fix: { level: 'integration', group: 'optional' },
  're-review': { level: 'integration', group: 'optional' },
  sweep: { level: 'integration', group: 'none' },
  investigate: { level: 'integration', group: 'none' }
}
// schema/instructions/verify.md, the dispatch table.
export const VERIFY_CHECKS = {
  c4: { section: 'c4', level: 'architecture' },
  c8: { section: 'c8', level: 'integration' }
}
// The review stage (lib/review.mjs): one reviewer per round, or one per slice of a diff over
// review.maxBytes, and one fixer per finding, so concurrent fixes never share a name. Both
// reply in JSON under the core's schemas, checked by `review.mjs response`, not lib/reply.mjs.
// The reviewer is never downgraded; the fixer goes one level up from round 2.
export const REVIEW_ROLES = {
  'ai-review': { level: 'architecture', schema: 'review-findings.schema.json' },
  'ai-fix': { level: 'integration', schema: 'review-fix.schema.json' }
}
// Archive: the adjudication of one capability's spec merge conflicts, and the ingest of what
// the change taught. Both write their JSON reply under the core's schema; spec-merge writes no
// other file (lib/spec-merge.mjs), and the ingest edits the knowledge base (lib/ingest.mjs).
export const ARCHIVE_ROLES = {
  'spec-merge': { level: 'architecture', schema: 'spec-merge-resolution.schema.json' },
  ingest: { level: 'architecture', schema: 'ingest.schema.json' }
}
const SCHEMA_ROLES = { ...REVIEW_ROLES, ...ARCHIVE_ROLES }
export const ROLES = [...new Set([...TASK_ROLES, ...Object.keys(TASKLESS), 'verify', ...Object.keys(REVIEW_ROLES), ...Object.keys(ARCHIVE_ROLES)])]
// Roles whose question the orchestrator must write: the prompt refuses an empty slot.
export const QUESTION_REQUIRED = ['review', 're-review', 'fix', 'final-review', 'merge-review', 'investigate']
export const MAX_ATTEMPTS = 2
// Task-less roles that loop in rounds: the fix and re-review after a merge review or the final
// review.
export const ROUNDED = ['fix', 're-review']

const TOPIC = /^[A-Za-z0-9]+$/
const GROUP = /^[A-Z]$/
const FINDING = /^F[1-9]\d*$/
const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/

export class DispatchError extends Error {}
const refuse = (message) => {
  throw new DispatchError(message)
}

const levelAt = (i) => LEVELS[Math.min(Math.max(i, 0), LEVELS.length - 1)]
const atLeast = (level, floor) => levelAt(Math.max(LEVELS.indexOf(level), LEVELS.indexOf(floor)))
// A task-less dispatch's level; a fix from round 2 on goes one level up, as a task's fix does.
const taskless = (role, round) => {
  const level = TASKLESS[role].level
  return role === 'fix' && round >= 2 ? levelAt(LEVELS.indexOf(level) + 1) : level
}
const reviewLevel = (role, round) => {
  const level = REVIEW_ROLES[role].level
  return role === 'ai-fix' && round >= 2 ? levelAt(LEVELS.indexOf(level) + 1) : level
}

// ---------------------------------------------------------------- the plan

// The `**Level:**` of `### Task <n>`, or null when the plan has no such task.
export function taskBody(planText, n) {
  const lines = planText.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^###\\s+Task\\s+${n}\\b`).test(l))
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && /^###\s+Task\s+\d+\b/.test(l))
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n')
}

export function levelOf(body) {
  const m = /^\*\*Level:\*\*\s*([a-z]+)/m.exec(body)
  return m && LEVELS.includes(m[1]) ? m[1] : null
}

const taskList = (cell) =>
  cell
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part)
      if (!m) return /^\d+$/.test(part) ? [Number(part)] : []
      const out = []
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i)
      return out
    })

// The group table of `## Execution Graph`: [{ letter, number, tasks, wave }], numbered by row.
export function parseGraph(planText) {
  const lines = planText.split('\n')
  const at = lines.findIndex((l) => /^##\s+Execution Graph\s*$/.test(l))
  if (at === -1) return []
  const groups = []
  let inTable = false
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(line)) break
    const cells = line.trim().startsWith('|') ? line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : null
    if (!cells) {
      if (inTable) break
      continue
    }
    if (!inTable) {
      inTable = /^group$/i.test(cells[0]) && /^tasks$/i.test(cells[1] ?? '')
      continue
    }
    if (/^-+$/.test(cells[0])) continue
    const letter = cells[0].replace(/^(?:group\s+)?/i, '').replace(/[`*]/g, '').trim()
    if (!GROUP.test(letter)) continue
    groups.push({ letter, number: groups.length + 1, tasks: taskList(cells[1] ?? ''), wave: Number(/\d+/.exec(cells.at(-1))?.[0] ?? 0) })
  }
  return groups
}

// ---------------------------------------------------------------- names

export function dispatchName({ role, task, group, round, topic, check, slice, finding, capability }) {
  if (!ROLES.includes(role)) refuse(`unknown role "${role}"; known: ${ROLES.join(', ')}`)
  if (capability !== undefined && role !== 'spec-merge') refuse('--capability belongs to spec-merge')
  if (Object.hasOwn(ARCHIVE_ROLES, role)) {
    if (task !== undefined || group !== undefined || round !== undefined || topic !== undefined || check !== undefined || slice !== undefined || finding !== undefined) {
      refuse(`${role} takes ${role === 'spec-merge' ? 'only --capability' : 'no task, group, round or other option'}`)
    }
    if (role === 'ingest') return 'ingest'
    if (!CAPABILITY.test(capability ?? '')) refuse(`spec-merge needs --capability <capability>, a kebab-case name, not "${capability ?? ''}"`)
    return `spec-merge ${capability}`
  }
  if (round !== undefined && !(Number.isInteger(round) && round >= 1)) refuse(`round "${round}" is not a positive integer`)
  if (topic !== undefined && role !== 'investigate') refuse('--topic belongs to investigate')
  if (check !== undefined && role !== 'verify') refuse('--check belongs to verify')
  if (slice !== undefined && role !== 'ai-review') refuse('--slice belongs to ai-review')
  if (finding !== undefined && role !== 'ai-fix') refuse('--finding belongs to ai-fix')
  if (Object.hasOwn(REVIEW_ROLES, role)) {
    if (task !== undefined || group !== undefined) refuse(`${role} takes no --task or --group: it serves the review stage`)
    if (round === undefined) refuse(`${role} needs --round <k>`)
    if (role === 'ai-fix') {
      if (!FINDING.test(finding ?? '')) refuse(`ai-fix needs --finding F<n>, not "${finding ?? ''}"`)
      return `ai-fix ${finding} r${round}`
    }
    if (slice === undefined) return `ai-review r${round}`
    if (!(Number.isInteger(slice) && slice >= 1)) refuse(`slice "${slice}" is not a positive integer`)
    return `ai-review r${round} s${slice}`
  }
  if (role === 'verify') {
    if (task !== undefined || group !== undefined || round !== undefined) refuse('verify takes only --check')
    if (!Object.hasOwn(VERIFY_CHECKS, check ?? '')) refuse(`verify needs --check, one of ${Object.keys(VERIFY_CHECKS).join(', ')}`)
    return `verify ${check}`
  }
  if (task !== undefined) {
    if (!TASK_ROLES.includes(role)) refuse(`${role} serves no single task; drop --task`)
    if (!(Number.isInteger(task) && task >= 1)) refuse(`task "${task}" is not a positive integer`)
    if (group !== undefined) refuse('a task dispatch takes its group from the plan; drop --group')
    return round === undefined ? `T${task} ${role}` : `T${task} ${role} r${round}`
  }
  if (!Object.hasOwn(TASKLESS, role)) refuse(`${role} needs --task`)
  if (round !== undefined && !ROUNDED.includes(role)) refuse('--round belongs to a task dispatch, or to a fix or re-review')
  if (role === 'investigate') {
    if (!TOPIC.test(topic ?? '')) refuse(`investigate needs --topic, one word of letters and digits, not "${topic ?? ''}"`)
    return `investigate ${topic}`
  }
  const rule = TASKLESS[role].group
  if (group !== undefined && !GROUP.test(group)) refuse(`group "${group}" is not a group letter`)
  if (rule === 'required' && group === undefined) refuse(`${role} needs --group <letter>`)
  if (rule === 'none' && group !== undefined) refuse(`${role} takes no --group`)
  const suffix = round === undefined ? '' : ` r${round}`
  return `${group === undefined ? role : `${role} ${group}`}${suffix}`
}

// The parts of a fixed-form name, or null when the name is not in the form.
export function parseName(name) {
  const text = String(name ?? '')
  let m = /^T([1-9]\d*) (impl|review|re-review|fix)(?: r([1-9]\d*))?$/.exec(text)
  if (m) return { role: m[2], task: Number(m[1]), ...(m[3] ? { round: Number(m[3]) } : {}) }
  m = /^verify (c4|c8)$/.exec(text)
  if (m) return { role: 'verify', check: m[1] }
  m = /^ai-review r([1-9]\d*)(?: s([1-9]\d*))?$/.exec(text)
  if (m) return { role: 'ai-review', round: Number(m[1]), ...(m[2] ? { slice: Number(m[2]) } : {}) }
  m = /^ai-fix (F[1-9]\d*) r([1-9]\d*)$/.exec(text)
  if (m) return { role: 'ai-fix', finding: m[1], round: Number(m[2]) }
  m = /^spec-merge ([a-z0-9][a-z0-9-]*)$/.exec(text)
  if (m) return { role: 'spec-merge', capability: m[1] }
  if (text === 'ingest') return { role: 'ingest' }
  m = /^investigate ([A-Za-z0-9]+)$/.exec(text)
  if (m) return { role: 'investigate', topic: m[1] }
  m = /^(final-review|sweep)$/.exec(text)
  if (m) return { role: m[1] }
  m = /^(merge-review) ([A-Z])$/.exec(text) ?? /^(fix|re-review)(?: ([A-Z]))?(?: r([1-9]\d*))?$/.exec(text)
  if (m) return { role: m[1], ...(m[2] ? { group: m[2] } : {}), ...(m[3] ? { round: Number(m[3]) } : {}) }
  return null
}

export const sddDir = (root, change) => join(root, '.superpowers', 'sdd', change)
export const verifyDirOf = (root, change) => join(sddDir(root, change), 'verify')
// The reviewer's input file, which `review.mjs input --out` writes before the dispatch.
export const reviewInputFile = (root, change, round, slice) => join(sddDir(root, change), 'review', `input-r${round}${slice === undefined ? '' : `-s${slice}`}.md`)

// `<root>/.superpowers/sdd/<change>/replies/<name, spaces as hyphens>.json`, or `-2`, `-3`
// before `.json` when the name is taken.
export function replyFile(root, change, name, exists) {
  const base = join(sddDir(root, change), 'replies', name.replace(/ /g, '-'))
  if (!exists(`${base}.json`)) return `${base}.json`
  for (let k = 2; ; k++) if (!exists(`${base}-${k}.json`)) return `${base}-${k}.json`
}

// ---------------------------------------------------------------- the plan of one dispatch

// inputs: { change, role, task?, group?, round?, topic?, check?, slice?, finding?, capability? }
// tree:   { root, main, planText (null when absent), exists(path) }
export function planDispatch(inputs, { root, main, planText, exists }) {
  const name = dispatchName(inputs)
  const { change, role, task, group, round, check } = inputs
  const out = { name, role }

  if (role === 'verify') {
    const { section, level } = VERIFY_CHECKS[check]
    const dir = verifyDirOf(root, change)
    out.check = check
    out.agent = `adf:${level}`
    out.worktree = root
    out.section = section
    out.sectionFiles = [join(dir, `${section}-agent.txt`), join(dir, `${section}.json`)]
    return out
  }

  if (Object.hasOwn(ARCHIVE_ROLES, role)) {
    out.agent = `adf:${ARCHIVE_ROLES[role].level}`
    out.worktree = root
    if (role === 'spec-merge') out.capability = inputs.capability
    out.replyFile = replyFile(root, change, name, exists)
    return out
  }

  if (Object.hasOwn(REVIEW_ROLES, role)) {
    out.agent = `adf:${reviewLevel(role, round)}`
    out.worktree = root
    out.round = round
    if (role === 'ai-review') {
      if (inputs.slice !== undefined) out.slice = inputs.slice
      out.inputFile = reviewInputFile(root, change, round, inputs.slice)
    } else out.finding = inputs.finding
    out.replyFile = replyFile(root, change, name, exists)
    return out
  }

  if (role === 'investigate' || role === 'final-review' || role === 'sweep' || (task === undefined && group === undefined)) {
    out.agent = `adf:${taskless(role, round)}`
    out.worktree = root
    out.replyFile = replyFile(root, change, name, exists)
    return out
  }

  if (planText == null) refuse(`openspec/changes/${change}/plan.md does not exist`)
  const graph = parseGraph(planText)
  if (task === undefined) {
    // merge-review <G>, fix <G>, re-review <G>: in the change worktree, over the group's tasks.
    const row = graph.find((g) => g.letter === group)
    if (!row) refuse(`group ${group} is not in the plan's Execution Graph`)
    out.agent = `adf:${taskless(role, round)}`
    out.worktree = root
    out.group = group
    out.tasks = row.tasks
    out.replyFile = replyFile(root, change, name, exists)
    return out
  }

  const body = taskBody(planText, task)
  if (body === null) refuse(`Task ${task} is not in the plan`)
  const level = levelOf(body)
  if (!level) refuse(`Task ${task} carries no **Level:** of ${LEVELS.join(' | ')}`)
  const row = graph.find((g) => g.tasks.includes(task))
  if (!row) refuse(`Task ${task} is in no group of the plan's Execution Graph`)
  let agentLevel = level
  if (role === 'review' || role === 're-review') agentLevel = atLeast(level, 'integration')
  if (role === 'fix' && round >= 2) agentLevel = levelAt(LEVELS.indexOf(level) + 1)
  const single = graph.filter((g) => g.wave === 1).length === 1
  out.agent = `adf:${agentLevel}`
  out.taskLevel = level
  out.group = row.letter
  out.worktree = single ? root : join(main, '.claude', 'worktrees', `${change}--group-${row.number}`)
  out.replyFile = replyFile(root, change, name, exists)
  return out
}

// ---------------------------------------------------------------- the prompt

const COMMENT = /^\s*<!--.*-->\s*$/

// The verbatim blocks of a skeleton: [{ source, text }].
export function verbatimBlocks(skeleton) {
  return [...skeleton.matchAll(/<!-- verbatim (\S+) -->\n([\s\S]*?)<!-- \/verbatim -->/g)].map((m) => ({ source: m[1], text: m[2] }))
}

export const normalize = (text) => text.replace(/\s+/g, ' ').trim()

// Fill a skeleton: drop full-line comments, then replace every {{field}} and every instruction
// token (`<change>`, `<root>`, ...) the dispatch knows.
export function fill(skeleton, values, tokens) {
  let text = skeleton
    .split('\n')
    .filter((l) => !COMMENT.test(l))
    .join('\n')
  text = text.replace(/\{\{(\w+)\}\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all))
  for (const [token, value] of Object.entries(tokens)) if (value !== undefined) text = text.split(token).join(String(value))
  return text.trim()
}

// Which skeletons, in order, make up the rules of a dispatch.
export function ruleSkeletons({ role, check, round }, { testFirst = false, dispositions = false } = {}) {
  if (role === 'verify') return ['verify', `verify-${check}`]
  // The review stage's replies are the JSON its skeletons name, so `reply` is not among them.
  if (role === 'ai-review') return round >= 2 ? ['ai-review', 'ai-review-round'] : ['ai-review']
  if (role === 'ai-fix') return ['ai-fix', 'git']
  if (role === 'spec-merge') return ['spec-merge', 'read-only']
  if (role === 'ingest') return ['ingest']
  const parts = []
  if (role === 'impl' || role === 'fix') parts.push('implementer')
  if (['review', 're-review', 'final-review', 'merge-review'].includes(role)) parts.push('reviewer')
  if (role === 'merge-review') parts.push('merge-review')
  if (role === 'review' && testFirst) parts.push('test-first')
  if (role === 'sweep') parts.push('read-only', 'sweep', ...(dispositions ? ['sweep-dispositions'] : []))
  if (role === 'investigate') parts.push('read-only')
  parts.push('git', 'reply')
  return parts
}

// skeletons: { name: text }; fields: [[label, value]] in display order (empty values dropped).
export function renderPrompt({ plan, change, skeletons, fields, question, tokens, testFirst, dispositions }) {
  if (question === undefined && QUESTION_REQUIRED.includes(plan.role)) {
    refuse(`${plan.role} needs --question-file: the question is the part the orchestrator writes`)
  }
  const values = {
    name: plan.name,
    level: plan.agent.replace(/^adf:/, ''),
    change,
    role: plan.role,
    replyFile: plan.replyFile ?? '',
    inputFile: plan.inputFile ?? '',
    schema: Object.hasOwn(SCHEMA_ROLES, plan.role) ? join('${CLAUDE_PLUGIN_ROOT}', 'schema', SCHEMA_ROLES[plan.role].schema) : '',
    base: tokens['<base>'] ?? ''
  }
  const rules = ruleSkeletons(plan, { testFirst, dispositions }).map((n) => fill(skeletons[n], values, tokens))
  const fieldText = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([label, v]) => (Array.isArray(v) ? `${label}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `${label}: ${v}`))
    .map((l) => `- ${l}`)
    .join('\n')
  return fill(
    skeletons.frame,
    { ...values, fields: fieldText, question: question === undefined ? 'None beyond the rules below.' : question.trim(), rules: rules.join('\n\n') },
    {}
  )
}

// ---------------------------------------------------------------- attempts

// apply.md: a refused reply goes back once, to the same agent, resumed; a second refusal is
// BLOCKED. The n-th recorded attempt of one dispatch name: 1 dispatches, 2 retries, 3 stops.
export const nextFor = (attempt) => (attempt === 1 ? 'dispatch' : attempt <= MAX_ATTEMPTS ? 'retry' : 'stop')

// The `dispatch` events of one name (lib/attempts.mjs); a line with no `event` is one.
export function countAttempts(text, name) {
  return text
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try {
        const event = JSON.parse(line)
        return event.name === name && (event.event ?? 'dispatch') === 'dispatch'
      } catch {
        return false
      }
    }).length
}

// ---------------------------------------------------------------- fix rounds

// apply.md: a fix round is one `fix` dispatch and one scoped `re-review`; the loop has at most
// MAX_ROUNDS of them per task, per group after its merge review, and after the final review.
export const MAX_ROUNDS = 5

// Where a fix loop stands, from the attempts recorded so far. A round is complete once its
// re-review was dispatched. Below the breaker the next round is dispatched (`fix`); at it, a
// task's open findings are adjudicated by the orchestrator (`adjudicate`), and a group's or the
// final review's go to the developer (`escalate-to-developer`).
//   subject: { task } | { group } | {} (after the final review)
export function roundOf(attemptsText, { task, group } = {}) {
  if (task !== undefined && group !== undefined) refuse('a fix loop is a task\'s or a group\'s, not both')
  if (task !== undefined && !(Number.isInteger(task) && task >= 1)) refuse(`task "${task}" is not a positive integer`)
  if (group !== undefined && !GROUP.test(group)) refuse(`group "${group}" is not a group letter`)
  let completed = 0
  for (const line of String(attemptsText ?? '').split('\n')) {
    let parsed
    try {
      parsed = parseName(JSON.parse(line).name)
    } catch {
      continue
    }
    if (parsed?.role !== 're-review' || parsed.round === undefined) continue
    if (parsed.task !== task || parsed.group !== group) continue
    completed = Math.max(completed, parsed.round)
  }
  const subject = task !== undefined ? `T${task}` : group !== undefined ? group : 'final'
  if (completed >= MAX_ROUNDS) {
    return { subject, completed, max: MAX_ROUNDS, next: task !== undefined ? 'adjudicate' : 'escalate-to-developer' }
  }
  const round = completed + 1
  const names = (role) => dispatchName({ role, round, ...(task !== undefined ? { task } : {}), ...(group !== undefined ? { group } : {}) })
  return { subject, completed, max: MAX_ROUNDS, next: 'fix', round, fix: names('fix'), reReview: names('re-review') }
}
