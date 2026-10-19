// What /adf:propose does by script once the developer has answered: make the branch, the
// worktree, the change and its session record in one call; hand out the next artifact to write;
// mark an artifact done by running the gates the schema declares for it; commit the change.
//
// A gate is bound to its artifact in schema.json (`gates`), not to the agent's memory: `done`
// runs the artifact's gates, `next` runs the gates of every artifact already written before it
// hands out a later one, and `commit` runs them all again. Nothing records that a gate passed;
// it is run again, so an artifact edited after its gate passed is checked as it is now. One gate
// also writes: `specs-base` takes the delta specs' base snapshot (specs-base.json), keeping the
// entries of unchanged delta blocks, so the commit holds it as the deltas are at that moment.
//
// `done` also does two things the instructions asked the agent to remember: it moves what a
// Superpowers skill wrote to its own default folder into the change, and it reports any project
// rule, context or guide paragraph copied verbatim into the artifact.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  artifactInstructions,
  changeDir,
  changeMeta,
  changeStatus,
  META_FILE,
  newChange,
  requiredArtifacts,
  resolveOutputs
} from './changes.mjs'
import { commitPaths } from './commit.mjs'
import { mainCheckout } from './installed.mjs'
import { appendRecord } from './ledger.mjs'
import { changeAgainstMain, checkCapabilities, validateProject, writeSpecsBase } from './specs.mjs'
import { create as createWorkspace } from './workspace.mjs'
import { run as tasksCli } from '../tasks.mjs'
import { run as planCli } from '../plan.mjs'
import { run as planSymbolsCli } from '../plan-symbols.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (root, path) => relative(root, path).split(sep).join('/')

// ---------------------------------------------------------------- gates

const RUNNERS = {
  'specs-validate': (root, change) => {
    let result
    try {
      result = validateProject(root, { change })
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const invalid = result.items.filter((i) => !i.valid)
    return { ok: invalid.length === 0, invalid: invalid.map((i) => ({ id: i.id, issues: i.issues })) }
  },
  'specs-capabilities': (root, change) => checkCapabilities(root, change),
  'specs-against-main': (root, change) => {
    const result = changeAgainstMain(root, change)
    return { ok: result.ok, findings: result.capabilities.flatMap((c) => c.findings.map((f) => ({ capability: c.capability, ...f }))) }
  },
  'specs-base': (root, change) => {
    try {
      return writeSpecsBase(root, change)
    } catch (error) {
      return { ok: false, error: error.message }
    }
  },
  'tasks-lint': (root, change) => cliGate(tasksCli(['lint', '--change', change, '--root', root])),
  'plan-symbols': async (root, change) => cliGate(await planSymbolsCli([change, '--root', root])),
  'plan-lint': async (root, change) => cliGate(await planCli(['lint', '--change', change, '--root', root]))
}

export const GATE_RUNNERS = Object.keys(RUNNERS)

function cliGate({ code, result }) {
  const all = result.findings ?? []
  const warnings = all.filter((f) => f.severity === 'warning')
  return {
    ok: code === 0,
    ...(result.error ? { error: result.error } : {}),
    findings: all.filter((f) => f.severity !== 'warning'),
    ...(warnings.length ? { warnings } : {})
  }
}

// The artifact's gates, in the order the schema lists them: [{ gate, ok, ... }].
export async function runGates(root, change, artifact) {
  const results = []
  for (const gate of artifact.gates ?? []) {
    const run = RUNNERS[gate]
    if (!run) throw new Error(`no runner for gate "${gate}"`)
    results.push({ gate, ...(await run(root, change)) })
  }
  return results
}

// ---------------------------------------------------------------- Superpowers output

// Where a Superpowers skill writes when left to its default, per artifact.
export const SKILL_OUTPUT = { brainstorm: 'docs/superpowers/specs', plan: 'docs/superpowers/plans' }

// The change file a skill's default-location file belongs in: a brainstorm file to
// brainstorm.md, any other file of the brainstorming skill (its design document) to design.md,
// a writing-plans file to plan.md.
export function redirectTarget(artifactId, fileName) {
  if (artifactId === 'plan') return 'plan.md'
  return /brainstorm/i.test(fileName) ? 'brainstorm.md' : 'design.md'
}

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

// Files the skill wrote to its default folder since the change was created, in the change
// worktree or in the main checkout (where the session usually runs), moved into the change when
// their target is missing. One whose target exists is a stray: the agent merges it by hand.
export function redirectSkillOutput(root, change, artifactId) {
  const folder = SKILL_OUTPUT[artifactId]
  if (!folder) return { moved: [], strays: [] }
  const dir = changeDir(root, change)
  const since = statSync(join(dir, META_FILE)).mtimeMs
  const bases = [...new Set([root, mainCheckout(root)].filter(existsSync).map((p) => realpathSync(p)))]
  const moved = []
  const strays = []
  for (const base of bases) {
    const source = join(base, folder)
    if (!existsSync(source)) continue
    const files = readdirSync(source, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(source, e.name))
      .filter((path) => statSync(path).mtimeMs >= since)
      .sort()
    for (const path of files) {
      const target = join(dir, redirectTarget(artifactId, path.split(sep).pop()))
      if (existsSync(target)) strays.push({ file: path, target: rel(root, target) })
      else {
        move(path, target)
        moved.push({ from: path, to: rel(root, target) })
      }
    }
  }
  return { moved, strays }
}

// ---------------------------------------------------------------- copied guidance

const flat = (text) => text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim()
export const MIN_RULE = 30
export const MIN_PARAGRAPH = 80

// Each project rule line, and each paragraph of the project context and of the artifact's
// guides, that an output holds verbatim (whitespace aside). Short lines are left out: a short
// phrase repeats by chance.
export function copiedGuidance(root, artifact, outputs) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null)
  const sources = []
  const rules = read(`openspec/rules/${artifact.id}.md`)
  for (const line of (rules ?? '').split('\n').filter((l) => l.startsWith('- '))) sources.push({ source: `openspec/rules/${artifact.id}.md`, kind: 'rule', text: flat(line.slice(2)), min: MIN_RULE })
  for (const path of ['openspec/context.md', ...(artifact.guides ?? []).map((g) => `openspec/${g}`)]) {
    for (const paragraph of (read(path) ?? '').split(/\n\s*\n/)) sources.push({ source: path, kind: path === 'openspec/context.md' ? 'context' : 'guide', text: flat(paragraph), min: MIN_PARAGRAPH })
  }
  const copied = []
  for (const output of outputs) {
    const text = flat(readFileSync(output, 'utf8'))
    for (const s of sources) {
      if (s.text.length >= s.min && text.includes(s.text)) copied.push({ file: rel(root, output), source: s.source, kind: s.kind, text: s.text.length > 120 ? `${s.text.slice(0, 117)}...` : s.text })
    }
  }
  return copied
}

// ---------------------------------------------------------------- done, next, skip

const doneCommand = (root, change, id) => `node "${join(SCRIPTS, 'changes.mjs')}" done ${id} --change ${change} --root ${root}`

export async function markDone(root, change, artifactId, schema) {
  const artifact = schema.artifacts.find((a) => a.id === artifactId)
  if (!artifact) throw new Error(`no artifact "${artifactId}" in schema ${schema.name}; known: ${schema.artifacts.map((a) => a.id).join(', ')}`)
  changeStatus(root, change, schema)
  const { moved, strays } = redirectSkillOutput(root, change, artifactId)
  const outputs = resolveOutputs(changeDir(root, change), artifact.generates)
  const out = { ok: false, change, artifact: artifactId, outputs: outputs.map((p) => rel(root, p)), moved, strays, copied: [], gates: [] }
  if (outputs.length === 0) return { ...out, refusal: `${artifactId} has no output at openspec/changes/${change}/${artifact.generates}; write it first` }
  out.copied = copiedGuidance(root, artifact, outputs)
  out.gates = await runGates(root, change, artifact)
  const failed = out.gates.filter((g) => !g.ok).map((g) => g.gate)
  const problems = [
    ...(strays.length ? [`${strays.length} file(s) the skill wrote outside the change already have a target; merge each into its target and delete it`] : []),
    ...(out.copied.length ? [`${out.copied.length} passage(s) of the project's rules, context or guides are copied into the artifact; remove them`] : []),
    ...(failed.length ? [`gate(s) failed: ${failed.join(', ')}; fix what they report and run done again`] : [])
  ]
  return problems.length ? { ...out, refusal: problems.join('. ') } : { ...out, ok: true }
}

// Artifacts propose does not write: those requiring, directly or not, an artifact apply needs
// (verify, review). What is neither these nor required is optional at propose (design).
function laterPhase(schema) {
  const applyNeeds = new Set(schema.apply?.requires ?? [])
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  const reaches = (id, seen = new Set()) => {
    if (seen.has(id)) return false
    seen.add(id)
    return byId.get(id).requires.some((r) => applyNeeds.has(r) || reaches(r, seen))
  }
  return new Set(schema.artifacts.filter((a) => !applyNeeds.has(a.id) && reaches(a.id)).map((a) => a.id))
}

export async function nextArtifact(root, change, schema) {
  const status = changeStatus(root, change, schema)
  const required = requiredArtifacts(schema)
  const later = laterPhase(schema)
  const skipped = new Set(changeMeta(root, change).skipped ?? [])
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  for (const a of status.artifacts.filter((x) => x.status === 'done' && !later.has(x.id))) {
    const gates = await runGates(root, change, byId.get(a.id))
    if (gates.some((g) => !g.ok)) {
      return { ok: false, done: false, change, blockedBy: a.id, gates, refusal: `${a.id} fails its gate(s) ${gates.filter((g) => !g.ok).map((g) => g.gate).join(', ')}; fix it, then run ${doneCommand(root, change, a.id)}` }
    }
  }
  const pick = status.artifacts.find((a) => a.status === 'ready' && !later.has(a.id) && (required.has(a.id) || !skipped.has(a.id)))
  if (!pick) {
    const left = status.applyRequires.filter((id) => status.artifacts.find((a) => a.id === id)?.status !== 'done')
    if (left.length === 0) return { ok: true, done: true, change }
    return { ok: false, done: false, change, refusal: `no artifact is ready, yet ${left.join(', ')} is not done; run changes.mjs status` }
  }
  const instructions = artifactInstructions(root, change, pick.id, schema)
  const dir = changeDir(root, change)
  return {
    ok: true,
    done: false,
    change,
    artifact: pick.id,
    optional: !required.has(pick.id),
    ...(required.has(pick.id) ? {} : { optionalNote: `${pick.id} is optional: write it, or run changes.mjs skip ${pick.id} --change ${change} --root ${root}` }),
    dependencyFiles: instructions.dependencies.filter((d) => d.done).flatMap((d) => resolveOutputs(dir, byId.get(d.id).generates)),
    gates: byId.get(pick.id).gates ?? [],
    then: doneCommand(root, change, pick.id),
    instructions
  }
}

// ---------------------------------------------------------------- create and commit

// From the main checkout, after the developer chose the base and confirmed the branch: the
// worktree and branch, the change with its base, and the propose session in the ledger.
export function createChange(mainRoot, { change, branch, base }, schema, { env = process.env } = {}) {
  const made = createWorkspace(mainRoot, { change, branch, base })
  const created = newChange(made.root, change, schema, { base: made.base })
  let ledger
  try {
    const { record, path } = appendRecord(made.root, change, 'session', { phase: 'propose' }, { env })
    ledger = { recorded: true, id: record.id, path }
  } catch (error) {
    ledger = { recorded: false, error: error.message }
  }
  return { ok: true, change, root: made.root, branch: made.branch, base: made.base, baseRef: made.baseRef, changeRoot: created.changeRoot, ledger }
}

export const proposeMessage = (change) => `docs(openspec): propose ${change}`

// The propose commit: refused until every artifact apply needs is done and every gate of every
// written artifact passes; then only the change directory is committed.
export async function commitChange(root, change, schema) {
  const status = changeStatus(root, change, schema)
  const left = status.applyRequires.filter((id) => status.artifacts.find((a) => a.id === id)?.status !== 'done')
  if (left.length) return { ok: false, refusal: `${left.join(', ')} is not done; run changes.mjs next` }
  const later = laterPhase(schema)
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  const gates = []
  for (const a of status.artifacts.filter((x) => x.status === 'done' && !later.has(x.id))) {
    for (const g of await runGates(root, change, byId.get(a.id))) gates.push({ artifact: a.id, ...g })
  }
  const failed = gates.filter((g) => !g.ok)
  if (failed.length) return { ok: false, gates: failed, refusal: `gate(s) fail: ${failed.map((g) => `${g.artifact}/${g.gate}`).join(', ')}; nothing was committed` }
  return { ...commitPaths(root, { only: [`openspec/changes/${change}`], message: proposeMessage(change) }), gates: gates.map((g) => g.gate) }
}
