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
//   fix sweep r<k>, re-review sweep r<k>, sweep r<k>   (a sweep finding's consolidation, round k:
//                  the fix, its re-review and the re-sweep; lib/sweep.mjs consolidate)
//   verify c4 | verify c8   (schema/instructions/verify.md)
//   ai-review r<k>, ai-review r<k> s<n>, ai-fix F<n> r<k>   (the review stage)
//   spec-merge <capability>, ingest   (archive)
//   scope-check <KEY>   (propose's issue check, lib/scope.mjs; checked by scope.mjs check)
//   land-comment <KEY>  (the hand-off fields after the merge, lib/land.mjs; checked by land.mjs comment)
//   retro <id>     (the retrospective, lib/retro.mjs; no change; <id> is <date>-window,
//                  <date>-period or <date>-<change>)
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
// The retrospective: one agent reasons over a window of archived changes and replies in JSON,
// checked by lib/retro.mjs through the lib/reply.mjs role table. It serves no change: its state
// lives in .superpowers/retro/<id>/ of the retrospective's worktree.
export const RETRO_ROLES = {
  retro: { level: 'architecture', schema: 'retro.schema.json' }
}
// Propose's issue check: one read-only agent per taken or partial scope item, named
// `scope-check <KEY>`, replying in JSON checked by `scope.mjs check` (lib/scope.mjs). It runs in
// the main checkout before the change has a worktree; its input and reply live in
// .superpowers/sdd/<change>/scope/.
export const SCOPE_ROLES = {
  'scope-check': { level: 'integration', schema: 'scope-check.schema.json' }
}
// A scope item's key: a tracker key or a debt id, with no space, colon, pipe or backtick.
export const SCOPE_KEY = /^[^\s:|`]+$/
export const scopeCheckName = (key) => {
  if (!SCOPE_KEY.test(key ?? '')) refuse(`"${key ?? ''}" is not a scope key`)
  return `scope-check ${key}`
}
// The hand-off after the merge: one read-only agent per taken or partial tracker issue, named
// `land-comment <KEY>`, writing the comment's fields in JSON checked by `land.mjs comment`
// (lib/land.mjs). It runs in the main checkout; its input and reply live in
// .superpowers/sdd/<change>/land/.
export const LAND_ROLES = {
  'land-comment': { level: 'integration', schema: 'land-comment.schema.json' }
}
export const landCommentName = (key) => {
  if (!SCOPE_KEY.test(key ?? '')) refuse(`"${key ?? ''}" is not a scope key`)
  return `land-comment ${key}`
}
// The JSON Schema under schema/ of each apply role's reply: lib/reply.mjs ROLES checks the reply
// under it, and the role's prompt names its path in the `reply` rule.
export const APPLY_SCHEMAS = {
  impl: 'impl.schema.json',
  fix: 'impl.schema.json',
  review: 'task-review.schema.json',
  'final-review': 'task-review.schema.json',
  'merge-review': 'task-review.schema.json',
  're-review': 're-review.schema.json',
  sweep: 'sweep.schema.json',
  investigate: 'investigate.schema.json'
}
const SCHEMA_ROLES = { ...Object.fromEntries(Object.entries(APPLY_SCHEMAS).map(([role, schema]) => [role, { schema }])), ...REVIEW_ROLES, ...ARCHIVE_ROLES, ...RETRO_ROLES }
export const ROLES = [...new Set([...TASK_ROLES, ...Object.keys(TASKLESS), 'verify', ...Object.keys(REVIEW_ROLES), ...Object.keys(ARCHIVE_ROLES), ...Object.keys(RETRO_ROLES)])]
// Roles whose question the orchestrator must write: the prompt refuses an empty slot, except for a
// fix or re-review whose prompt renders the subject's open findings (lib/loop.mjs).
export const QUESTION_REQUIRED = ['review', 're-review', 'fix', 'final-review', 'merge-review', 'investigate']
export const MAX_ATTEMPTS = 2
// Task-less roles that loop in rounds: the fix and re-review after a merge review or the final
// review.
export const ROUNDED = ['fix', 're-review']
// The subject of a consolidation's fix and re-review (`--subject sweep`), whose round is the
// consolidation's; the re-sweep after it is `sweep r<k>`.
export const SWEEP_SUBJECT = 'sweep'

const TOPIC = /^[A-Za-z0-9]+$/
const GROUP = /^[A-Z]$/
const FINDING = /^F[1-9]\d*$/
const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/
// A retrospective's id: its date and its mode, or, for one change, the change's name.
export const RETRO_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/

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

// ---------------------------------------------------------------- the Execution Graph

export const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')

const cells = (row) =>
  stripComments(row)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function parseTaskList(cell) {
  const out = []
  for (const m of cell.matchAll(/(\d+)\s*(?:-|–|to)\s*(\d+)|(\d+)/g)) {
    if (m[3]) out.push(Number(m[3]))
    else for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(n)
  }
  return out
}

// "A", "Group A" or "A — shared contract": the letter is the first word.
const letterOf = (cell) => /^(\w+)/.exec(cell.replace(/[`*]/g, '').replace(/^Group\s+/i, '').trim())?.[1] ?? ''

// The `## Execution Graph` section: { line, end, groups, pairs, depends, single } or null. The
// one parser of the plan's graph: plan.mjs lints and schedules from it, and dispatch names and
// places a task's or a group's dispatch from the same groups.
export function parseExecutionGraph(planText) {
  const lines = planText.split('\n')
  const start = lines.findIndex((l) => /^##\s+Execution Graph\b/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++)
    if (/^##\s|^###\s+Task\s+\d/.test(lines[i])) {
      end = i
      break
    }
  const groups = []
  const pairs = []
  const depends = {}
  let table = null
  // The Files and Wave columns by their header, else the third and the fourth.
  let at = { files: 2, wave: 3 }
  const column = (header, name, fallback) => {
    const i = header.findIndex((x) => new RegExp(`^${name}\\b`, 'i').test(x))
    return i > 1 ? i : fallback
  }
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i]
    if (!/^\s*\|/.test(raw)) {
      table = null
      // One line may carry several: "Group B (wave 2) depends on: Group A. Group C (wave 2) …".
      for (const dep of stripComments(raw).matchAll(/Group\s+`?(\w+)`?\s*\(wave\s*2\)\s*depends\s+on:\s*(.*?)(?=Group\s+`?\w+`?\s*\(wave|$)/gi))
        depends[dep[1]] = [...dep[2].matchAll(/Group\s+`?(\w+)`?/gi)].map((m) => m[1])
      continue
    }
    const c = cells(raw)
    if (c.every((x) => /^:?-+:?$/.test(x) || x === '')) continue
    if (!table) {
      if (/^group$/i.test(c[0]) && /^tasks$/i.test(c[1] ?? '')) {
        table = 'groups'
        at = { files: column(c, 'files', 2), wave: column(c, 'wave', 3) }
      } else if (/^group a$/i.test(c[0]) && /^group b$/i.test(c[1] ?? '')) table = 'pairs'
      else table = 'other'
      continue
    }
    if (table === 'groups') {
      const letter = letterOf(c[0] ?? '')
      if (!letter) continue
      groups.push({
        letter,
        tasks: parseTaskList(c[1] ?? ''),
        files: [...(c[at.files] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]),
        wave: Number(/\d+/.exec(c[at.wave] ?? '')?.[0] ?? NaN),
        line: i + 1
      })
    } else if (table === 'pairs') {
      const a = letterOf(c[0] ?? '')
      const b = letterOf(c[1] ?? '')
      if (!a || !b) continue
      pairs.push({ a, b, coupling: (/^[a-z-]+/i.exec(c[2] ?? '')?.[0] ?? '').toLowerCase(), reason: c.slice(3).join(' | '), line: i + 1 })
    }
  }
  const prose = stripComments(lines.slice(start + 1, end).filter((l) => !/^\s*\|/.test(l)).join('\n'))
  return { line: start + 1, end, groups, pairs, depends, single: /\bsingle group\b/i.test(prose) }
}

// The group table of `## Execution Graph`: [{ letter, number, tasks, wave }], numbered by row.
export function parseGraph(planText) {
  return (parseExecutionGraph(planText)?.groups ?? []).map((g, i) => ({ letter: g.letter, number: i + 1, tasks: g.tasks, wave: g.wave }))
}

// ---------------------------------------------------------------- names

export function dispatchName({ role, task, group, round, topic, check, slice, finding, capability, id, subject }) {
  if (!ROLES.includes(role)) refuse(`unknown role "${role}"; known: ${ROLES.join(', ')}`)
  if (subject !== undefined) {
    if (!ROUNDED.includes(role)) refuse('--subject belongs to fix and re-review')
    if (subject !== SWEEP_SUBJECT) refuse(`--subject is ${SWEEP_SUBJECT}, not "${subject}"`)
    if (task !== undefined || group !== undefined) refuse(`--subject ${SWEEP_SUBJECT} takes no --task or --group`)
    if (round === undefined) refuse(`${role} --subject ${SWEEP_SUBJECT} needs --round <k>, the consolidation's round`)
    if (!(Number.isInteger(round) && round >= 1)) refuse(`round "${round}" is not a positive integer`)
    return `${role} ${SWEEP_SUBJECT} r${round}`
  }
  if (capability !== undefined && role !== 'spec-merge') refuse('--capability belongs to spec-merge')
  if (id !== undefined && role !== 'retro') refuse('an id belongs to retro')
  if (role === 'retro') {
    if (task !== undefined || group !== undefined || round !== undefined || topic !== undefined || check !== undefined || slice !== undefined || finding !== undefined) {
      refuse('retro takes only an id')
    }
    if (!RETRO_ID.test(id ?? '')) refuse(`retro needs an id <YYYY-MM-DD>-<window | period | change name>, not "${id ?? ''}"`)
    return `retro ${id}`
  }
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
  if (round !== undefined && !ROUNDED.includes(role) && role !== 'sweep') refuse('--round belongs to a task dispatch, to a fix or re-review, or to a re-sweep')
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
  m = /^retro (\S+)$/.exec(text)
  if (m && RETRO_ID.test(m[1])) return { role: 'retro', id: m[1] }
  m = /^investigate ([A-Za-z0-9]+)$/.exec(text)
  if (m) return { role: 'investigate', topic: m[1] }
  m = /^scope-check (\S+)$/.exec(text)
  if (m && SCOPE_KEY.test(m[1])) return { role: 'scope-check', key: m[1] }
  m = /^land-comment (\S+)$/.exec(text)
  if (m && SCOPE_KEY.test(m[1])) return { role: 'land-comment', key: m[1] }
  m = /^(final-review|sweep)$/.exec(text)
  if (m) return { role: m[1] }
  m = /^(fix|re-review) sweep r([1-9]\d*)$/.exec(text)
  if (m) return { role: m[1], subject: SWEEP_SUBJECT, round: Number(m[2]) }
  m = /^sweep r([1-9]\d*)$/.exec(text)
  if (m) return { role: 'sweep', round: Number(m[1]) }
  m = /^(merge-review) ([A-Z])$/.exec(text) ?? /^(fix|re-review)(?: ([A-Z]))?(?: r([1-9]\d*))?$/.exec(text)
  if (m) return { role: m[1], ...(m[2] ? { group: m[2] } : {}), ...(m[3] ? { round: Number(m[3]) } : {}) }
  return null
}

export const sddDir = (root, change) => join(root, '.superpowers', 'sdd', change)
export const verifyDirOf = (root, change) => join(sddDir(root, change), 'verify')
// The reviewer's input file, which `review.mjs input --out` writes before the dispatch.
export const reviewInputFile = (root, change, round, slice) => join(sddDir(root, change), 'review', `input-r${round}${slice === undefined ? '' : `-s${slice}`}.md`)

// A retrospective's state: its input file, its replies and its attempts log.
export const retroDir = (root, id) => join(root, '.superpowers', 'retro', id)
export const retroInputFile = (root, id) => join(retroDir(root, id), 'input.json')

// `<root>/.superpowers/sdd/<change>/replies/<name, spaces as hyphens>.json`, or `-2`, `-3`
// before `.json` when the name is taken. A retro's replies are under its own directory.
export function replyFile(root, change, name, exists) {
  const id = parseName(name)?.id
  const base = join(id === undefined ? sddDir(root, change) : retroDir(root, id), 'replies', name.replace(/ /g, '-'))
  if (!exists(`${base}.json`)) return `${base}.json`
  for (let k = 2; ; k++) if (!exists(`${base}-${k}.json`)) return `${base}-${k}.json`
}

// ---------------------------------------------------------------- the plan of one dispatch

// inputs: { change, role, task?, group?, round?, topic?, check?, slice?, finding?, capability?,
//           id? }   a retro takes only `id`, no change
// tree:   { root, main, planText (null when absent), exists(path) }
export function planDispatch(inputs, { root, main, planText, exists }) {
  const name = dispatchName(inputs)
  const { change, role, task, group, round, check } = inputs
  const out = { name, role }

  if (role === 'retro') {
    out.agent = `adf:${RETRO_ROLES.retro.level}`
    out.worktree = root
    out.id = inputs.id
    out.inputFile = retroInputFile(root, inputs.id)
    out.replyFile = replyFile(root, undefined, name, exists)
    return out
  }

  if (role === 'verify') {
    const { section, level } = VERIFY_CHECKS[check]
    const dir = verifyDirOf(root, change)
    out.check = check
    out.agent = `adf:${level}`
    out.worktree = root
    out.section = section
    // The agent writes its JSON reply; `dispatch.mjs reply` checks it and writes the section.
    out.replyFile = replyFile(root, change, name, exists)
    out.sectionFile = join(dir, `${section}.json`)
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
    if (inputs.subject !== undefined) out.subject = inputs.subject
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

// Which skeletons, in order, make up the rules of a dispatch. `proof`: the flow ran the test-first
// proof before the review, so the review reads its result instead of running it.
export function ruleSkeletons({ role, check, round, subject }, { testFirst = false, dispositions = false, proof = false } = {}) {
  if (role === 'verify') return ['verify', `verify-${check}`]
  // The review stage's replies are the JSON its skeletons name, so `reply` is not among them.
  if (role === 'ai-review') return round >= 2 ? ['ai-review', 'ai-review-round'] : ['ai-review']
  if (role === 'ai-fix') return ['ai-fix', 'git']
  if (role === 'spec-merge') return ['spec-merge', 'read-only']
  if (role === 'ingest') return ['ingest']
  if (role === 'retro') return ['retro', 'read-only', 'reply']
  const parts = []
  if (role === 'impl' || role === 'fix') parts.push('implementer')
  if (role === 'fix' && subject === SWEEP_SUBJECT) parts.push('consolidation')
  if (['review', 're-review', 'final-review', 'merge-review'].includes(role)) parts.push('reviewer')
  if (role === 'merge-review') parts.push('merge-review')
  if (role === 're-review') parts.push('re-review')
  if (role === 'review' && testFirst) parts.push(proof ? 'test-first-proof' : 'test-first')
  if (role === 'sweep') parts.push('read-only', 'sweep', ...(dispositions ? ['sweep-dispositions'] : []))
  if (role === 'investigate') parts.push('read-only')
  parts.push('git', 'reply')
  return parts
}

// skeletons: { name: text }; fields: [[label, value]] in display order (empty values dropped).
export function renderPrompt({ plan, change, skeletons, fields, question, tokens, testFirst, dispositions, proof, questionOptional = false }) {
  if (question === undefined && QUESTION_REQUIRED.includes(plan.role) && !questionOptional) {
    refuse(`${plan.role} needs --question-file: the question is the part the orchestrator writes`)
  }
  const values = {
    name: plan.name,
    level: plan.agent.replace(/^adf:/, ''),
    change,
    // What the dispatch serves, in the frame's first sentence: a change, or a retrospective.
    subject: plan.role === 'retro' ? `the retrospective ${plan.id}` : `the change \`${change}\``,
    role: plan.role,
    replyFile: plan.replyFile ?? '',
    inputFile: plan.inputFile ?? '',
    schema: Object.hasOwn(SCHEMA_ROLES, plan.role) ? join('${CLAUDE_PLUGIN_ROOT}', 'schema', SCHEMA_ROLES[plan.role].schema) : '',
    base: tokens['<base>'] ?? ''
  }
  const rules = ruleSkeletons(plan, { testFirst, dispositions, proof }).map((n) => fill(skeletons[n], values, tokens))
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

// ---------------------------------------------------------------- fix rounds

// apply.md: a fix round is one `fix` dispatch and one scoped `re-review`; the loop has at most
// MAX_ROUNDS of them per task, per group after its merge review, and after the final review.
export const MAX_ROUNDS = 5

// Where a fix loop stands, from the attempts recorded so far. A round is complete once its
// re-review was dispatched. Below the breaker the next round is dispatched (`fix`); at it, a
// task's open findings are adjudicated by the orchestrator (`adjudicate`), and a group's or the
// final review's go to the developer (`escalate-to-developer`). A round whose fix returned BLOCKED
// with no commit goes the same way before the breaker.
//   subject: { task } | { group } | {} (after the final review); `since` (an ISO time) reads only
//   the events at or after it: the final review's loop of an apply round starts anew.
export function roundOf(attemptsText, { task, group, since = null } = {}) {
  if (task !== undefined && group !== undefined) refuse('a fix loop is a task\'s or a group\'s, not both')
  if (task !== undefined && !(Number.isInteger(task) && task >= 1)) refuse(`task "${task}" is not a positive integer`)
  if (group !== undefined && !GROUP.test(group)) refuse(`group "${group}" is not a group letter`)
  let completed = 0
  const fixes = new Map()
  for (const line of String(attemptsText ?? '').split('\n')) {
    let event
    let parsed
    try {
      event = JSON.parse(line)
      parsed = parseName(event.name)
    } catch {
      continue
    }
    // A consolidation's rounds are its own (lib/sweep.mjs consolidate), never the final review's.
    if (parsed?.round === undefined || parsed.subject !== undefined) continue
    if (since !== null && String(event.at ?? '') < since) continue
    if (parsed.task !== task || parsed.group !== group) continue
    if (parsed.role === 're-review') completed = Math.max(completed, parsed.round)
    else if (parsed.role === 'fix' && event.event === 'valid' && event.result) fixes.set(parsed.round, { name: event.name, result: event.result })
  }
  const subject = task !== undefined ? `T${task}` : group !== undefined ? group : 'final'
  const ruling = task !== undefined ? 'adjudicate' : 'escalate-to-developer'
  if (completed >= MAX_ROUNDS) return { subject, completed, max: MAX_ROUNDS, next: ruling }
  const round = completed + 1
  // The running round's fix came back BLOCKED with no commit: there is nothing to re-review, and
  // every further round would be the same, so its open findings are ruled now, as at the breaker.
  const fix = fixes.get(round)
  if (fix?.result.status === 'BLOCKED' && !(fix.result.commits ?? []).length) {
    return { subject, completed, max: MAX_ROUNDS, next: ruling, blockedFix: fix.name, reason: `${fix.name} returned BLOCKED with no commit: nothing is left to re-review, so the open findings are ruled now` }
  }
  const names = (role) => dispatchName({ role, round, ...(task !== undefined ? { task } : {}), ...(group !== undefined ? { group } : {}) })
  return { subject, completed, max: MAX_ROUNDS, next: 'fix', round, fix: names('fix'), reReview: names('re-review') }
}
