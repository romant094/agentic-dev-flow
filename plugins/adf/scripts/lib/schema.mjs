// The flow's schema: the artifact graph of a change, read from the plugin's `schema/`
// directory. `schema.json` holds the graph; the prose it points at lives in markdown files
// beside it (`templates/`, `instructions/`), so no YAML parser is needed and each block can be
// read and measured on its own.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChangeMeta } from './changes.mjs'
import { findChangeDir } from './ingest.mjs'

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
const ID = /^[a-z][a-z0-9-]*$/
const GUIDE = /^[a-z0-9][a-z0-9-]*\.md$/

// The checks an artifact may declare in `gates`, run by `changes.mjs done` and by every later
// `next` (lib/propose.mjs runs them). A gate names a script's check, so the schema states which
// check guards which artifact and the agent never decides whether to run one. `specs-base` also
// writes the change's specs-base.json (lib/specs.mjs writeSpecsBase). `scope-sources` checks
// that the proposal's `## Scope sources` is the rendering of the change's scope.json, when it
// has one (lib/scope.mjs). `quick-plan` checks the plan of a quick change's quick.md;
// `quick-summary` checks its `## Summary`, which no artifact lists: the end of a quick change
// runs it, when the summary is written.
export const GATES = ['scope-sources', 'specs-validate', 'specs-capabilities', 'specs-against-main', 'specs-base', 'tasks-lint', 'plan-symbols', 'plan-lint', 'quick-plan', 'quick-summary']

const SECTION = /^##[ \t]+(.+?)[ \t]*$/
const STEP = /^\d+\.[ \t]+/
const MAX_QUICK_STEPS = 3

// The lines of the `## <heading>` section of a markdown text, up to the next `##` heading; null
// when the section is missing.
function section(text, heading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => SECTION.exec(l)?.[1] === heading)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => SECTION.test(l))
  return end === -1 ? rest : rest.slice(0, end)
}

// The files a step's `**Files:**` line names: backticks and commas dropped, a comment or a
// `<placeholder>` of the template not counted.
function stepFiles(lines) {
  const line = lines.find((l) => /\*\*Files:\*\*/.test(l))
  if (line === undefined) return []
  return line.replace(/^.*\*\*Files:\*\*/, '').replace(/<!--.*?-->/g, ' ').replace(/[`,;]/g, ' ').split(/\s+/).filter((t) => t !== '' && !/^<.*>$/.test(t))
}

// The numbered steps of a `## Plan` section, each as its lines.
function planSteps(plan) {
  const steps = []
  for (const line of plan) {
    if (STEP.test(line)) steps.push([line])
    else if (steps.length > 0) steps.at(-1).push(line)
  }
  return steps
}

// The files the `**Files:**` lines of a quick.md's plan name, each once; [] with no `## Plan`.
export function quickPlanFiles(text) {
  return [...new Set(planSteps(section(text, 'Plan') ?? []).flatMap(stepFiles))]
}

// The number of numbered steps under a quick.md's `## Plan`; 0 with no `## Plan`.
export const quickPlanSteps = (text) => planSteps(section(text, 'Plan') ?? []).length

// The quick-plan gate over the text of a quick.md: 1 to 3 numbered steps under `## Plan`, each
// with a `**Files:**` line that names at least one file. { ok, findings: [{ message }] }.
export function checkQuickPlan(text) {
  const plan = section(text, 'Plan')
  if (plan === null) return { ok: false, findings: [{ message: 'quick.md has no "## Plan" section' }] }
  const steps = planSteps(plan)
  const findings = []
  if (steps.length === 0) findings.push({ message: '"## Plan" has no numbered step; write 1 to 3 steps, each as "1. <what>"' })
  if (steps.length > MAX_QUICK_STEPS) findings.push({ message: `"## Plan" has ${steps.length} steps; a quick plan has at most ${MAX_QUICK_STEPS}; propose the change instead` })
  steps.forEach((lines, i) => {
    if (stepFiles(lines).length === 0) findings.push({ message: `plan step ${i + 1} names no file; add a "**Files:**" line with at least one path` })
  })
  return { ok: findings.length === 0, findings }
}

// The quick-summary gate over the text of a quick.md: `## Summary` holds text. The template's
// comments do not count.
export function checkQuickSummary(text) {
  const body = (section(text, 'Summary') ?? []).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()
  return body === ''
    ? { ok: false, findings: [{ message: 'quick.md "## Summary" is empty; write what was wrong, what changed, the tests run and the review result' }] }
    : { ok: true, findings: [] }
}

// `skippable: true` lets a change skip an artifact apply needs, with a reason (`changes.mjs skip
// <id> --reason`): the skipped artifact meets what requires it, and verify and archive read the
// reason. An optional artifact is skipped without one.
const isText = (value) => typeof value === 'string' && value.length > 0

export function validateSchema(schema, dir) {
  const errors = []
  if (!isText(schema?.name)) errors.push('name is required')
  if (!Number.isInteger(schema?.version) || schema.version < 1) errors.push('version must be a positive integer')
  const artifacts = Array.isArray(schema?.artifacts) ? schema.artifacts : []
  if (artifacts.length === 0) errors.push('artifacts must list at least one artifact')

  const ids = new Set()
  for (const artifact of artifacts) {
    const id = artifact?.id
    if (!ID.test(id ?? '')) errors.push(`artifact id "${id}" is not kebab-case`)
    if (ids.has(id)) errors.push(`artifact id "${id}" is duplicated`)
    ids.add(id)
    if (!isText(artifact.generates)) errors.push(`artifact "${id}": generates is required`)
    if (!isText(artifact.description)) errors.push(`artifact "${id}": description is required`)
    if (!Array.isArray(artifact.requires)) errors.push(`artifact "${id}": requires must be an array`)
    for (const [field, folder] of [['template', 'templates'], ['instruction', 'instructions']]) {
      if (artifact[field] !== undefined && !existsSync(join(dir, folder, artifact[field]))) {
        errors.push(`artifact "${id}": ${field} ${folder}/${artifact[field]} does not exist`)
      }
    }
    if (artifact.guides !== undefined && !(Array.isArray(artifact.guides) && artifact.guides.every((g) => GUIDE.test(g)))) {
      errors.push(`artifact "${id}": guides must list file names such as planning.md`)
    }
    if (artifact.skippable !== undefined && typeof artifact.skippable !== 'boolean') errors.push(`artifact "${id}": skippable must be a boolean`)
    if (artifact.gates !== undefined) {
      if (!Array.isArray(artifact.gates)) errors.push(`artifact "${id}": gates must be an array`)
      else {
        for (const gate of artifact.gates) if (!GATES.includes(gate)) errors.push(`artifact "${id}": unknown gate "${gate}"; known: ${GATES.join(', ')}`)
        if (new Set(artifact.gates).size !== artifact.gates.length) errors.push(`artifact "${id}": a gate is listed twice`)
      }
    }
  }
  for (const artifact of artifacts) {
    for (const required of artifact.requires ?? []) {
      if (!ids.has(required)) errors.push(`artifact "${artifact.id}" requires unknown artifact "${required}"`)
    }
  }
  if (errors.length === 0 && buildOrder(schema).length !== artifacts.length) {
    errors.push('the artifact graph has a cycle')
  }

  const apply = schema?.apply
  if (apply !== undefined) {
    if (!Array.isArray(apply.requires) || apply.requires.length === 0) errors.push('apply.requires must list at least one artifact')
    for (const required of apply.requires ?? []) {
      if (!ids.has(required)) errors.push(`apply requires unknown artifact "${required}"`)
    }
    if (apply.guides !== undefined && !(Array.isArray(apply.guides) && apply.guides.every((g) => GUIDE.test(g)))) {
      errors.push('apply: guides must list file names such as planning.md')
    }
    if (apply.instruction !== undefined && !existsSync(join(dir, 'instructions', apply.instruction))) {
      errors.push(`apply: instruction instructions/${apply.instruction} does not exist`)
    }
  }
  for (const [name, file] of Object.entries(schema?.blocks ?? {})) {
    if (!existsSync(join(dir, 'instructions', file))) errors.push(`block "${name}": instructions/${file} does not exist`)
  }
  return errors
}

// Kahn's algorithm with ties broken by id, so the order is stable across runs.
export function buildOrder(schema) {
  const inDegree = new Map(schema.artifacts.map((a) => [a.id, a.requires.length]))
  const dependents = new Map(schema.artifacts.map((a) => [a.id, []]))
  for (const artifact of schema.artifacts) {
    for (const required of artifact.requires) dependents.get(required)?.push(artifact.id)
  }
  const queue = [...inDegree].filter(([, n]) => n === 0).map(([id]) => id).sort()
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    const ready = []
    for (const next of dependents.get(id)) {
      inDegree.set(next, inDegree.get(next) - 1)
      if (inDegree.get(next) === 0) ready.push(next)
    }
    queue.push(...ready.sort())
  }
  return order
}

export function loadSchemaDir(dir = SCHEMA_DIR) {
  const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'))
  const errors = validateSchema(schema, dir)
  if (errors.length > 0) throw new Error(`invalid schema in ${dir}: ${errors.join('; ')}`)
  return { ...schema, dir }
}

// The schema of a cycle: `full` (the core's; `adf`, the name it had, reads as `full`) or `quick`.
export function loadSchema(name = 'full') {
  if (name === 'full' || name === 'adf') return loadSchemaDir(SCHEMA_DIR)
  if (name === 'quick') return loadSchemaDir(join(SCHEMA_DIR, 'quick'))
  throw new Error(`unknown schema "${name}"; known: full, quick`)
}

// The schema a named change was created with, read from its metadata; `full` when it names none.
export function schemaOf(root, change) {
  return loadSchema(readChangeMeta(root, findChangeDir(root, change))?.schema ?? 'full')
}

export function readSchemaFile(schema, folder, file) {
  return file === undefined ? null : readFileSync(join(schema.dir, folder, file), 'utf8')
}
