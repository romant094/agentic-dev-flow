// Changes in a host project: create one, list them, report an artifact's status, and give the
// agent what it needs to write the next artifact or to apply. Replaces the openspec CLI's
// `new change`, `list`, `status` and `instructions`; the JSON keeps the fields the flow read
// from those commands.
//
// Host layout: `openspec/changes/<name>/` per change, `openspec/changes/archive/` for the
// archived ones, and the project's own guidance in `openspec/context.md` (the project, for
// every artifact), `openspec/rules/<artifact>.md` (one rule per `- ` line) and the project
// guides an artifact names in the schema (`guides`), such as `openspec/planning.md`.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { readBranches } from './branches.mjs'
import { ledgerPath } from './ledger.mjs'
import { buildOrder, readSchemaFile } from './schema.mjs'

export const CHANGES_DIR = 'openspec/changes'
export const ARCHIVE = 'archive'
export const META_FILE = '.adf.json'
// The metadata file of a change an earlier flow created (the openspec CLI's), still in flight.
export const ORIGIN_META_FILE = '.openspec.yaml'
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
  })
}

// `**/` matches zero or more directories, any other `**` anything at all (`dir/**` is every
// file under dir), `*` and `?` stay within one path segment.
export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

export function resolveOutputs(changeDir, generates) {
  if (!/[*?[]/.test(generates)) {
    const path = join(changeDir, generates)
    return existsSync(path) && statSync(path).isFile() ? [path] : []
  }
  const pattern = globToRegExp(generates)
  return walk(changeDir)
    .filter((path) => pattern.test(relative(changeDir, path).split(sep).join('/')))
    .sort()
}

export function changeDir(root, name) {
  return join(root, CHANGES_DIR, name)
}

function requireChange(root, name) {
  if (!NAME.test(name ?? '') || name === ARCHIVE || !existsSync(changeDir(root, name))) {
    throw new Error(`no change "${name}" in ${CHANGES_DIR}`)
  }
  return changeDir(root, name)
}

// `base` is the branch the change forked from and is merged back into (lib/workspace.mjs).
export function newChange(root, name, schema, { base, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!NAME.test(name ?? '') || name === ARCHIVE) throw new Error(`change name "${name}" is not kebab-case`)
  const dir = changeDir(root, name)
  if (existsSync(dir)) throw new Error(`change "${name}" already exists`)
  mkdirSync(dir, { recursive: true })
  const meta = { schema: schema.name, schemaVersion: schema.version, created: today, ...(base ? { base } : {}) }
  writeFileSync(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  return { name, changeRoot: dir, ...meta }
}

const TASK = /^[-*]\s+\[([ xX])\]\s*(.+?)\s*$/

export function parseTasks(text) {
  return text
    .split('\n')
    .map((line) => TASK.exec(line))
    .filter(Boolean)
    .map((match, i) => ({ id: String(i + 1), description: match[2], done: match[1] !== ' ' }))
}

function readTasks(dir, file) {
  const path = join(dir, file)
  return existsSync(path) ? parseTasks(readFileSync(path, 'utf8')) : null
}

export function listChanges(root, schema) {
  const base = join(root, CHANGES_DIR)
  if (!existsSync(base)) return { changes: [] }
  const tracks = schema.apply?.tracks ?? 'tasks.md'
  const changes = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE && !entry.name.startsWith('.'))
    .map((entry) => {
      const dir = join(base, entry.name)
      const tasks = readTasks(dir, tracks) ?? []
      const completed = tasks.filter((t) => t.done).length
      const modified = Math.max(statSync(dir).mtimeMs, ...walk(dir).map((path) => statSync(path).mtimeMs))
      return {
        name: entry.name,
        completedTasks: completed,
        totalTasks: tasks.length,
        lastModified: new Date(modified).toISOString(),
        status: tasks.length === 0 ? 'no-tasks' : completed === tasks.length ? 'complete' : 'in-progress'
      }
    })
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified) || a.name.localeCompare(b.name))
  return { changes }
}

function completedArtifacts(schema, dir) {
  return new Set(schema.artifacts.filter((a) => resolveOutputs(dir, a.generates).length > 0).map((a) => a.id))
}

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function changeStatus(root, name, schema) {
  const dir = requireChange(root, name)
  const done = completedArtifacts(schema, dir)
  const order = buildOrder(schema)
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  const artifactPaths = {}
  const artifacts = order.map((id) => {
    const artifact = byId.get(id)
    artifactPaths[id] = {
      outputPath: artifact.generates,
      resolvedOutputPath: join(dir, artifact.generates),
      existingOutputPaths: resolveOutputs(dir, artifact.generates)
    }
    const missingDeps = artifact.requires.filter((r) => !done.has(r)).sort()
    const status = done.has(id) ? 'done' : missingDeps.length === 0 ? 'ready' : 'blocked'
    return { id, outputPath: artifact.generates, status, ...(status === 'blocked' ? { missingDeps } : {}) }
  })
  const meta = readMeta(dir)
  return {
    changeName: name,
    schemaName: schema.name,
    schemaVersion: schema.version,
    ...(meta?.schemaVersion !== undefined && meta.schemaVersion !== schema.version
      ? { pinnedSchemaVersion: meta.schemaVersion }
      : {}),
    changeRoot: dir,
    artifactPaths,
    isComplete: done.size === schema.artifacts.length,
    applyRequires: schema.apply?.requires ?? order,
    artifacts
  }
}

function projectGuidance(root, artifact) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null)
  const rules = read(`openspec/rules/${artifact.id}.md`)
  return {
    context: read('openspec/context.md')?.trim() || null,
    rules: rules === null ? [] : rules.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
    guides: (artifact.guides ?? []).map((file) => ({ path: `openspec/${file}`, text: read(`openspec/${file}`)?.trim() || null }))
  }
}

export function artifactInstructions(root, name, artifactId, schema) {
  const dir = requireChange(root, name)
  const artifact = schema.artifacts.find((a) => a.id === artifactId)
  if (!artifact) {
    throw new Error(`no artifact "${artifactId}" in schema ${schema.name}; known: ${schema.artifacts.map((a) => a.id).join(', ')}, apply`)
  }
  const done = completedArtifacts(schema, dir)
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  return {
    changeName: name,
    artifactId,
    schemaName: schema.name,
    changeDir: dir,
    outputPath: artifact.generates,
    resolvedOutputPath: join(dir, artifact.generates),
    existingOutputPaths: resolveOutputs(dir, artifact.generates),
    description: artifact.description,
    instruction: readSchemaFile(schema, 'instructions', artifact.instruction),
    ...projectGuidance(root, artifact),
    template: readSchemaFile(schema, 'templates', artifact.template),
    dependencies: artifact.requires.map((id) => ({
      id,
      done: done.has(id),
      path: byId.get(id).generates,
      description: byId.get(id).description
    })),
    unlocks: schema.artifacts.filter((a) => a.requires.includes(artifactId)).map((a) => a.id).sort()
  }
}

export function applyInstructions(root, name, schema) {
  const dir = requireChange(root, name)
  const apply = schema.apply ?? {}
  const required = apply.requires ?? schema.artifacts.map((a) => a.id)
  const done = completedArtifacts(schema, dir)
  const missingArtifacts = required.filter((id) => !done.has(id))
  const contextFiles = {}
  for (const artifact of schema.artifacts) {
    const outputs = resolveOutputs(dir, artifact.generates)
    if (outputs.length > 0) contextFiles[artifact.id] = outputs
  }
  const tasks = apply.tracks ? readTasks(dir, apply.tracks) : []
  const complete = (tasks ?? []).filter((t) => t.done).length
  const total = (tasks ?? []).length

  let state = 'ready'
  let instruction = readSchemaFile(schema, 'instructions', apply.instruction)?.trim() ?? null
  if (missingArtifacts.length > 0) {
    state = 'blocked'
    instruction = `Cannot apply this change yet. Missing artifacts: ${missingArtifacts.join(', ')}. Create them first.`
  } else if (apply.tracks && tasks === null) {
    state = 'blocked'
    instruction = `${apply.tracks} is missing. Create it before applying.`
  } else if (apply.tracks && total === 0) {
    state = 'blocked'
    instruction = `${apply.tracks} lists no tasks. Add tasks before applying.`
  } else if (apply.tracks && complete === total) {
    state = 'all_done'
    instruction = 'Every task is complete. Verify the change next.'
  }
  return {
    changeName: name,
    changeDir: dir,
    schemaName: schema.name,
    contextFiles,
    progress: { total, complete, remaining: total - complete },
    tasks: tasks ?? [],
    state,
    ...(missingArtifacts.length > 0 ? { missingArtifacts } : {}),
    ...(apply.guides ? { guides: projectGuidance(root, { id: 'apply', guides: apply.guides }).guides } : {}),
    instruction
  }
}

// The change a script acts on when the caller named none: the one active change under `root`.
// Several or none is a refusal that names what was found, so the caller picks; a change is never
// guessed from a branch name.
export function inferChange(root, change, schema) {
  if (change) return change
  const names = listChanges(root, schema).changes.map((c) => c.name)
  if (names.length === 1) return names[0]
  throw new Error(
    names.length === 0
      ? `${root} holds no active change; pass --change <name> and the change worktree as --root`
      : `${root} holds ${names.length} active changes (${names.sort().join(', ')}); pass --change <name>`
  )
}

// Whether `root` is the repository's main checkout rather than a linked worktree. Outside a git
// repository it is not one.
export function isMainCheckout(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const top = git('rev-parse', '--show-toplevel')
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    return realpathSync(dirname(common)) === realpathSync(top)
  } catch {
    return false
  }
}

// A change-scoped operation that writes is refused in the main checkout: the change lives in its
// own worktree, and a call without --root ran on the cwd, usually the main checkout.
export function refuseMainCheckout(root, { allowMain = false } = {}) {
  if (!allowMain && isMainCheckout(root)) {
    throw new Error(`${root} is the main checkout; pass the change worktree as --root (changes.mjs find lists it)`)
  }
}

// The artifacts propose must write: apply's requirements and everything they require. Any other
// artifact whose requirements are met is optional at propose (design), or belongs to a later
// phase (verify, review) when it requires one of these.
export function requiredArtifacts(schema) {
  const byId = new Map(schema.artifacts.map((a) => [a.id, a]))
  const need = new Set()
  const visit = (id) => {
    if (need.has(id)) return
    need.add(id)
    for (const r of byId.get(id).requires) visit(r)
  }
  for (const id of schema.apply?.requires ?? schema.artifacts.map((a) => a.id)) visit(id)
  return need
}

// An artifact the change will not have, recorded in its metadata so `next` stops offering it.
// Only an optional artifact can be skipped.
export function skipArtifact(root, name, artifactId, schema) {
  const dir = requireChange(root, name)
  if (!schema.artifacts.some((a) => a.id === artifactId)) throw new Error(`no artifact "${artifactId}" in schema ${schema.name}`)
  if (requiredArtifacts(schema).has(artifactId)) throw new Error(`${artifactId} is required before apply and cannot be skipped`)
  const meta = readMeta(dir) ?? {}
  const skipped = [...new Set([...(meta.skipped ?? []), artifactId])].sort()
  writeFileSync(join(dir, META_FILE), `${JSON.stringify({ ...meta, skipped }, null, 2)}\n`)
  return { changeName: name, skipped }
}

// A change's metadata, the one reader of its base for every script: its .adf.json as written.
// A change an earlier flow created has an .openspec.yaml and no .adf.json; its base is a
// `base:` line there, else the host's integration branch, and `from` names the file. Null when
// the change has neither file or its .adf.json does not parse. `dir` is the change directory,
// active or archived; `root` is the checkout whose registry names the integration branch.
export function readChangeMeta(root, dir) {
  if (existsSync(join(dir, META_FILE))) return readMeta(dir)
  const file = join(dir, ORIGIN_META_FILE)
  if (!existsSync(file)) return null
  const base = /^base:[ \t]*["']?([^\s"'#]+)/m.exec(readFileSync(file, 'utf8'))?.[1] ?? readBranches(root)?.integration ?? null
  return { ...(base ? { base } : {}), from: ORIGIN_META_FILE }
}

export function changeMeta(root, name) {
  return readChangeMeta(root, requireChange(root, name)) ?? {}
}

// The resolve step's list, ready to show: one choice per active change and per worktree whose
// change could not be read, and the names held by more than one checkout.
export function findChoices({ changes, unresolved }) {
  const roots = new Map()
  for (const c of changes) roots.set(c.name, [...(roots.get(c.name) ?? []), c.root])
  const duplicates = [...roots].filter(([, list]) => list.length > 1).map(([name, list]) => ({ name, roots: list }))
  const choices = [
    ...changes.map((c) => ({
      name: c.name,
      root: c.root,
      branch: c.branch,
      progress: `${c.completedTasks}/${c.totalTasks} tasks`,
      label: `${c.name} — ${c.branch ?? 'detached'}, ${c.completedTasks}/${c.totalTasks} tasks, in ${c.root}${roots.get(c.name).length > 1 ? ' (one of two copies)' : ''}`
    })),
    ...unresolved.map((u) => ({ name: null, root: u.root, branch: u.branch, progress: null, label: `change name unresolved — ${u.branch ?? 'detached'}, in ${u.root}` }))
  ]
  return { duplicates, choices }
}

// The propose report: the change, its branch, worktree and base, each artifact's status, and the
// next step. The merge request is the forge call's own `report` (forge.mjs), shown beside it.
export function statusReport(status, { branch = null, root, base = null } = {}) {
  const lines = [`Change: ${status.changeName}`, `Branch: ${branch ?? 'unknown'}`, `Worktree: ${root}`, `Base: ${base ?? 'not recorded'}`, 'Artifacts:']
  for (const a of status.artifacts) lines.push(`- ${a.id}: ${a.status}${a.missingDeps ? ` (needs ${a.missingDeps.join(', ')})` : ''}`)
  const ready = status.applyRequires.every((id) => status.artifacts.find((a) => a.id === id)?.status === 'done')
  lines.push(`Next: ${ready ? '/adf:apply' : `/adf:propose ${status.changeName} to finish its artifacts`}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- archive

export const LEDGER_FILE = 'ledger.jsonl'
const DATED = /^\d{4}-\d{2}-\d{2}-/

// The archived directories of a change, `archive/<YYYY-MM-DD>-<name>`, oldest first.
export function archivedDirs(root, name) {
  const dir = join(root, CHANGES_DIR, ARCHIVE)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => DATED.test(entry) && entry.slice(11) === name)
    .sort()
    .map((entry) => join(dir, entry))
}

// The change's directory: active, else its newest archived one; null when there is neither.
export function changeDirOf(root, change) {
  const active = changeDir(root, change)
  return existsSync(active) ? active : (archivedDirs(root, change).at(-1) ?? null)
}

const posixRel = (root, path) => relative(root, path).split(sep).join('/')

// Where archive moves a change: `<changes>/archive/<YYYY-MM-DD>-<name>`, relative to the root, the
// date from `now` in UTC. Archive's placements names it before the move, as the change that
// resolved the debt it takes.
export const archiveDate = (now) => now.toISOString().slice(0, 10)
export const archiveTarget = (name, { now = new Date(), date = archiveDate(now) } = {}) => `${CHANGES_DIR}/${ARCHIVE}/${date}-${name}`

// Moves a change into `<changes>/archive/<YYYY-MM-DD>-<name>`, the date from `now` in UTC (as
// `new` dates a change). The ledger is copied into the change directory first, once: the
// worktree's `.superpowers/` goes with the worktree, and the archive is the copy that stays. A
// missing ledger is no failure; any other failure of the copy refuses before anything moves (the
// origin's `cp ... 2>/dev/null || true` hid it). An existing target is refused with the ways
// out. A change already archived, with no active directory left, is reported, not refused, so a
// second archive run passes this step.
// `date` overrides the date of `now`: archive passes the one placements named the target with.
// Returns { changeName, from, target, ledger: copied|none, already }, paths relative to root.
export function archiveChange(root, name, { now = new Date(), date = archiveDate(now) } = {}) {
  if (!NAME.test(name ?? '') || name === ARCHIVE) throw new Error(`change name "${name}" is not kebab-case`)
  const dir = changeDir(root, name)
  const from = `${CHANGES_DIR}/${name}`
  if (!existsSync(dir)) {
    const done = archivedDirs(root, name).at(-1)
    if (!done) throw new Error(`no change "${name}" in ${CHANGES_DIR}`)
    return { changeName: name, from, target: posixRel(root, done), ledger: existsSync(join(done, LEDGER_FILE)) ? 'copied' : 'none', already: true }
  }
  const target = join(root, archiveTarget(name, { date }))
  if (existsSync(target)) {
    throw new Error(`${posixRel(root, target)} already exists; rename the change, delete the duplicate archive if it is one, or archive it tomorrow`)
  }
  let ledger = 'copied'
  try {
    copyFileSync(ledgerPath(root, name), join(dir, LEDGER_FILE))
  } catch (error) {
    if (error.code !== 'ENOENT' || existsSync(ledgerPath(root, name))) {
      throw new Error(`the ledger could not be copied into ${from} (${error.message}); nothing was moved`)
    }
    ledger = 'none'
  }
  mkdirSync(dirname(target), { recursive: true })
  renameSync(dir, target)
  return { changeName: name, from, target: posixRel(root, target), ledger, already: false }
}
