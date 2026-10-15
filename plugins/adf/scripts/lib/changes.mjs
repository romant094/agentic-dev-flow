// Changes in a host project: create one, list them, report an artifact's status, and give the
// agent what it needs to write the next artifact or to apply. Replaces the openspec CLI's
// `new change`, `list`, `status` and `instructions`; the JSON keeps the fields the flow read
// from those commands.
//
// Host layout: `openspec/changes/<name>/` per change, `openspec/changes/archive/` for the
// archived ones, and the project's own guidance in `openspec/context.md` (the project, for
// every artifact), `openspec/rules/<artifact>.md` (one rule per `- ` line) and the project
// guides an artifact names in the schema (`guides`), such as `openspec/planning.md`.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildOrder, readSchemaFile } from './schema.mjs'

export const CHANGES_DIR = 'openspec/changes'
export const ARCHIVE = 'archive'
export const META_FILE = '.adf.json'
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
