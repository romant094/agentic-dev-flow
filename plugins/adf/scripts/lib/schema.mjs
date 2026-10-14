// The flow's schema: the artifact graph of a change, read from the plugin's `schema/`
// directory. `schema.json` holds the graph; the prose it points at lives in markdown files
// beside it (`templates/`, `instructions/`), so no YAML parser is needed and each block can be
// read and measured on its own.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
const ID = /^[a-z][a-z0-9-]*$/
const GUIDE = /^[a-z0-9][a-z0-9-]*\.md$/

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

export function loadSchema(dir = SCHEMA_DIR) {
  const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'))
  const errors = validateSchema(schema, dir)
  if (errors.length > 0) throw new Error(`invalid schema in ${dir}: ${errors.join('; ')}`)
  return { ...schema, dir }
}

export function readSchemaFile(schema, folder, file) {
  return file === undefined ? null : readFileSync(join(schema.dir, folder, file), 'utf8')
}
