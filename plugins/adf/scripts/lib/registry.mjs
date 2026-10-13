// The project registry and the plugin declarations: the whole extension contract the core
// has today. The contract is versioned major.minor (see contract/README.md); this file
// knows the format, never a plugin by name.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export const REGISTRY_PATH = '.claude/adf-extensions.json'
export const DECLARATION_FILE = 'adf-extension.json'
const NAME = /^[a-z][a-z0-9-]*$/

export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)$/.exec(String(text))
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

// A plugin runs on a core with the same major and at least the plugin's minor: a minor adds
// points or optional fields, so a plugin written for 1.2 may use something 1.1 lacks.
export function isCompatible(core, plugin) {
  const c = parseVersion(core)
  const p = parseVersion(plugin)
  return Boolean(c && p && c.major === p.major && c.minor >= p.minor)
}

export function validateDeclaration(declaration, points) {
  const errors = []
  if (!NAME.test(declaration?.name ?? '')) errors.push(`name "${declaration?.name}" is not kebab-case`)
  if (!parseVersion(declaration?.contract)) errors.push(`contract "${declaration?.contract}" is not major.minor`)
  const provides = declaration?.provides
  if (provides === null || typeof provides !== 'object' || Array.isArray(provides)) {
    errors.push('provides must be an object')
    return errors
  }
  for (const point of Object.keys(provides)) {
    if (!points.includes(point)) errors.push(`point "${point}" is not defined by the contract`)
  }
  return errors
}

export function validateRegistry(registry) {
  const errors = []
  if (!parseVersion(registry?.contract)) errors.push(`contract "${registry?.contract}" is not major.minor`)
  if (!Array.isArray(registry?.extensions)) return [...errors, 'extensions must be an array']
  const seen = new Set()
  for (const [i, entry] of registry.extensions.entries()) {
    if (typeof entry?.path !== 'string' || entry.path === '') {
      errors.push(`extensions[${i}] has no path`)
      continue
    }
    const key = normalize(entry.path)
    if (seen.has(key)) errors.push(`extensions[${i}] repeats ${entry.path}`)
    seen.add(key)
  }
  return errors
}

export function readRegistry(root) {
  const file = join(root, REGISTRY_PATH)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

function writeRegistry(root, registry) {
  const file = join(root, REGISTRY_PATH)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`)
}

export function initRegistry(root, coreContract) {
  if (readRegistry(root)) return { created: false }
  writeRegistry(root, { contract: coreContract, extensions: [] })
  return { created: true }
}

function readDeclaration(root, path) {
  const file = join(isAbsolute(path) ? path : join(root, path), DECLARATION_FILE)
  if (!existsSync(file)) throw new Error(`${path}: no ${DECLARATION_FILE}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function loadPlugin(root, path, { coreContract, points }) {
  const declaration = readDeclaration(root, path)
  const errors = validateDeclaration(declaration, points)
  if (errors.length) throw new Error(`${path}: ${errors.join('; ')}`)
  if (!isCompatible(coreContract, declaration.contract)) {
    throw new Error(
      `${declaration.name} needs contract ${declaration.contract}; this core runs ${coreContract}`,
    )
  }
  return declaration
}

function requireRegistry(root) {
  const registry = readRegistry(root)
  if (!registry) throw new Error('this project has no ADF registry; run /adf:init first')
  return registry
}

export function addExtension(root, path, { config, coreContract, points }) {
  const registry = requireRegistry(root)
  const declaration = loadPlugin(root, path, { coreContract, points })
  for (const entry of registry.extensions) {
    if (normalize(entry.path) === normalize(path)) throw new Error(`${path} is already enabled`)
    if (readDeclaration(root, entry.path).name === declaration.name) {
      throw new Error(`a plugin named ${declaration.name} is already enabled (${entry.path})`)
    }
  }
  const entry = config === undefined ? { path } : { path, config }
  writeRegistry(root, { ...registry, extensions: [...registry.extensions, entry] })
  return { name: declaration.name, points: Object.keys(declaration.provides) }
}

export function removeExtension(root, name) {
  const registry = requireRegistry(root)
  const index = registry.extensions.findIndex((entry) => {
    try {
      return readDeclaration(root, entry.path).name === name
    } catch {
      return false
    }
  })
  if (index === -1) throw new Error(`${name} is not enabled`)
  const [removed] = registry.extensions.splice(index, 1)
  writeRegistry(root, registry)
  return removed
}

export function checkRegistry(root, { coreContract, points }) {
  const registry = readRegistry(root)
  if (!registry) return { ok: false, errors: ['no registry; run /adf:init'], plugins: [] }
  const errors = validateRegistry(registry)
  if (errors.length === 0 && !isCompatible(coreContract, registry.contract)) {
    errors.push(`registry is written for contract ${registry.contract}; this core runs ${coreContract}`)
  }
  const plugins = []
  for (const entry of registry.extensions ?? []) {
    try {
      const declaration = loadPlugin(root, entry.path, { coreContract, points })
      plugins.push({ name: declaration.name, path: entry.path, points: Object.keys(declaration.provides) })
    } catch (error) {
      errors.push(error.message)
    }
  }
  return { ok: errors.length === 0, errors, plugins }
}
