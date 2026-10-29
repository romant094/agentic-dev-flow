// The project registry and the plugin declarations: the whole extension contract the core
// has today. The contract is versioned major.minor (see contract/README.md); this file
// knows the format, never a plugin by name.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { validateBranches } from './branches.mjs'
import { installedPath, PLUGIN_ID } from './installed.mjs'
import { trackerReport } from './roles.mjs'

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

// A path inside the plugin or the host: relative, and never climbing out with `..`.
const inside = (path) => typeof path === 'string' && path !== '' && !isAbsolute(path) && !normalize(path).startsWith('..')

// Whether version `a` is at or below version `b`, both major.minor.
const atOrBelow = (a, b) => {
  const x = parseVersion(a)
  const y = parseVersion(b)
  return Boolean(x && y && (x.major < y.major || (x.major === y.major && x.minor <= y.minor)))
}

// The operations of a point a declaration of contract `version` must implement: every operation
// the point had at that version. `operationSince` maps an operation added after the point to the
// contract version that added it; an operation it does not name came with the point. A later
// operation is optional for an earlier declaration, and the core treats it as not provided.
export function requiredOperations(point, version) {
  const since = point?.operationSince ?? {}
  return (point?.operations ?? []).filter((op) => !Object.hasOwn(since, op) || atOrBelow(since[op], version))
}

// `points` is the contract's map of point name to { kind, operations, operationSince? }. A
// plugin that provides a point names the script that runs it and implements every operation the
// point defined at the plugin's contract version (requiredOperations).
export function validateDeclaration(declaration, points) {
  const errors = []
  if (!NAME.test(declaration?.name ?? '')) errors.push(`name "${declaration?.name}" is not kebab-case`)
  if (!parseVersion(declaration?.contract)) errors.push(`contract "${declaration?.contract}" is not major.minor`)
  const provides = declaration?.provides
  if (provides === null || typeof provides !== 'object' || Array.isArray(provides)) {
    errors.push('provides must be an object')
    return errors
  }
  for (const [point, given] of Object.entries(provides)) {
    if (!Object.hasOwn(points, point)) {
      errors.push(`point "${point}" is not defined by the contract`)
      continue
    }
    if (!inside(given?.script)) errors.push(`${point}: script must be a path inside the plugin`)
    const missing = requiredOperations(points[point], declaration.contract).filter((op) => !given?.operations?.includes(op))
    if (missing.length) errors.push(`${point}: operations ${missing.join(', ')} are missing`)
  }
  const hostFiles = declaration.hostFiles ?? []
  if (!Array.isArray(hostFiles) || !hostFiles.every((f) => inside(f?.from) && inside(f?.to))) {
    errors.push('hostFiles must be a list of { from, to } paths inside the plugin and the host')
  }
  return errors
}

export function validateRegistry(registry) {
  const errors = []
  if (!parseVersion(registry?.contract)) errors.push(`contract "${registry?.contract}" is not major.minor`)
  if (!Array.isArray(registry?.extensions)) return [...errors, 'extensions must be an array']
  const seen = new Set()
  for (const [i, entry] of registry.extensions.entries()) {
    const byPath = typeof entry?.path === 'string' && entry.path !== ''
    const byId = typeof entry?.plugin === 'string' && PLUGIN_ID.test(entry.plugin)
    if (byPath === byId) {
      errors.push(`extensions[${i}] needs exactly one of plugin (name@marketplace) or path`)
      continue
    }
    if (entry.points !== undefined && !(Array.isArray(entry.points) && entry.points.every((p) => typeof p === 'string'))) {
      errors.push(`extensions[${i}].points must be a list of point names`)
    }
    const key = byId ? entry.plugin : normalize(entry.path)
    if (seen.has(key)) errors.push(`extensions[${i}] repeats ${entry.path}`)
    seen.add(key)
  }
  if (registry.branches !== undefined) errors.push(...validateBranches(registry.branches))
  // Paths verify's out-of-plan check never reports: globs relative to the project root, such
  // as a reports folder no plan names. Optional and empty by default.
  const outside = registry.outsidePlan
  if (outside !== undefined && (!Array.isArray(outside) || !outside.every((glob) => inside(glob) && glob.trim() === glob))) {
    errors.push('outsidePlan must be a list of glob patterns relative to the project root')
  }
  // The review stage's settings (lib/review.mjs): the host prompt, globs added to or taken back
  // from the default exclusion list, the diff size one reviewer takes, the blocking severities.
  if (registry.review !== undefined) errors.push(...validateReviewSettings(registry.review))
  if (registry.debt !== undefined) errors.push(...validateDebtSettings(registry.debt))
  if (registry.metrics !== undefined) errors.push(...validateMetricsSettings(registry.metrics))
  return errors
}

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const REVIEW_KEYS = ['prompt', 'exclude', 'include', 'maxBytes', 'blockOn']
const globs = (value) => Array.isArray(value) && value.every((glob) => inside(glob) && glob.trim() === glob)

export function validateReviewSettings(review) {
  if (review === null || typeof review !== 'object' || Array.isArray(review)) return ['review must be an object']
  const errors = []
  for (const key of Object.keys(review)) if (!REVIEW_KEYS.includes(key)) errors.push(`review.${key} is not a review setting (${REVIEW_KEYS.join(', ')})`)
  if (review.prompt !== undefined && !(inside(review.prompt) && review.prompt.trim() === review.prompt)) errors.push('review.prompt must be a path relative to the project root')
  for (const key of ['exclude', 'include']) {
    if (review[key] !== undefined && !globs(review[key])) errors.push(`review.${key} must be a list of glob patterns relative to the project root`)
  }
  if (review.maxBytes !== undefined && !(Number.isInteger(review.maxBytes) && review.maxBytes > 0)) errors.push('review.maxBytes must be a positive integer')
  const blockOn = review.blockOn
  if (blockOn !== undefined && !(Array.isArray(blockOn) && blockOn.length > 0 && blockOn.every((s) => SEVERITIES.includes(s)) && new Set(blockOn).size === blockOn.length)) {
    errors.push(`review.blockOn must list distinct severities of ${SEVERITIES.join(', ')}`)
  }
  return errors
}

// ---------------------------------------------------------------- debt

// The technical debt store (lib/debt.mjs): `debt.root`, the tree's directory relative to the
// project root, asked by /adf:init.
const DEBT_KEYS = ['root']

export function validateDebtSettings(debt) {
  if (debt === null || typeof debt !== 'object' || Array.isArray(debt)) return ['debt must be an object']
  const errors = []
  for (const key of Object.keys(debt)) if (!DEBT_KEYS.includes(key)) errors.push(`debt.${key} is not a debt setting (${DEBT_KEYS.join(', ')})`)
  if (debt.root !== undefined && !(inside(debt.root) && debt.root.trim() === debt.root)) errors.push('debt.root must be a path relative to the project root')
  return errors
}

// The tree's path relative to the project root, or null when the registry sets none.
export function readDebtRoot(root) {
  const debt = readRegistry(root)?.debt
  if (debt === undefined || validateDebtSettings(debt).length > 0) return null
  return debt.root ?? null
}

export function setDebtRoot(root, path) {
  const registry = readRegistry(root)
  if (!registry) throw new Error('this project has no ADF registry; run /adf:init first')
  const debt = { ...registry.debt, root: path }
  const errors = validateDebtSettings(debt)
  if (errors.length > 0) throw new Error(errors.join('; '))
  writeRegistry(root, { ...registry, debt })
  return path
}

// ---------------------------------------------------------------- metrics

// The metrics settings (lib/prices.mjs): `metrics.pricesUrl`, the page the price table is
// fetched from, an http(s) URL. Optional, with its default in lib/transcripts.mjs; /adf:init
// does not ask for it.
const METRICS_KEYS = ['pricesUrl']

export function validateMetricsSettings(metrics) {
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) return ['metrics must be an object']
  const errors = []
  for (const key of Object.keys(metrics)) if (!METRICS_KEYS.includes(key)) errors.push(`metrics.${key} is not a metrics setting (${METRICS_KEYS.join(', ')})`)
  if (metrics.pricesUrl !== undefined && !(typeof metrics.pricesUrl === 'string' && /^https?:\/\/\S+$/.test(metrics.pricesUrl))) errors.push('metrics.pricesUrl must be an http or https URL')
  return errors
}

export function readRegistry(root) {
  const file = join(root, REGISTRY_PATH)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export function writeRegistry(root, registry) {
  const file = join(root, REGISTRY_PATH)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`)
}

export function initRegistry(root, coreContract) {
  if (readRegistry(root)) return { created: false }
  writeRegistry(root, { contract: coreContract, extensions: [] })
  return { created: true }
}

// The plugin's directory: a path as written, or an installed plugin's recorded location.
export function pluginDir(root, entry, { home } = {}) {
  if (entry.plugin) return installedPath(entry.plugin, root, { home })
  return isAbsolute(entry.path) ? entry.path : join(root, entry.path)
}

const label = (entry) => entry.plugin ?? entry.path

function readDeclaration(root, entry, opts) {
  const file = join(pluginDir(root, entry, opts), DECLARATION_FILE)
  if (!existsSync(file)) throw new Error(`${label(entry)}: no ${DECLARATION_FILE}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function loadPlugin(root, entry, { coreContract, points, home }) {
  const declaration = readDeclaration(root, entry, { home })
  const errors = validateDeclaration(declaration, points)
  if (errors.length) throw new Error(`${label(entry)}: ${errors.join('; ')}`)
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

const roleOf = (points, point) => points[point]?.kind === 'role'

// A file the plugin asks the host to hold, such as a template a forge's own interface reads.
// Copied only when missing: a host that edited its copy keeps it.
function copyHostFiles(root, entry, declaration, opts) {
  const dir = pluginDir(root, entry, opts)
  const copied = []
  const kept = []
  for (const { from, to } of declaration.hostFiles ?? []) {
    const target = join(root, to)
    if (existsSync(target)) {
      kept.push(to)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(dir, from), target)
    copied.push(to)
  }
  return { copied, kept }
}

// `target` is an installed plugin's id (`name@marketplace`) or a path to a plugin directory.
export function addExtension(root, target, { config, coreContract, points, home }) {
  const registry = requireRegistry(root)
  const entry = PLUGIN_ID.test(target) ? { plugin: target } : { path: target }
  const declaration = loadPlugin(root, entry, { coreContract, points, home })
  for (const other of registry.extensions) {
    if (label(other) === label(entry) || (other.path && entry.path && normalize(other.path) === normalize(entry.path))) {
      throw new Error(`${target} is already enabled`)
    }
    let theirs
    try {
      theirs = readDeclaration(root, other, { home })
    } catch (error) {
      // An entry whose plugin is not installed or disabled provides nothing, so it conflicts with nothing.
      if (error.absent) continue
      throw error
    }
    if (theirs.name === declaration.name) {
      throw new Error(`a plugin named ${declaration.name} is already enabled (${label(other)})`)
    }
    for (const point of Object.keys(declaration.provides)) {
      if (roleOf(points, point) && Object.hasOwn(theirs.provides ?? {}, point)) {
        throw new Error(`the role ${point} is already provided by ${theirs.name}; remove it first`)
      }
    }
  }
  // The points are recorded so that the core can name this entry for the right point when the
  // plugin is absent on a machine, without reading its declaration.
  entry.points = Object.keys(declaration.provides)
  if (config !== undefined) entry.config = config
  writeRegistry(root, { ...registry, extensions: [...registry.extensions, entry] })
  const hostFiles = copyHostFiles(root, entry, declaration, { home })
  return { name: declaration.name, points: Object.keys(declaration.provides), hostFiles }
}

export function removeExtension(root, name, { home } = {}) {
  const registry = requireRegistry(root)
  const index = registry.extensions.findIndex((entry) => {
    try {
      return readDeclaration(root, entry, { home }).name === name
    } catch {
      return entry.plugin?.split('@')[0] === name
    }
  })
  if (index === -1) throw new Error(`${name} is not enabled`)
  const [removed] = registry.extensions.splice(index, 1)
  writeRegistry(root, registry)
  return removed
}

// The enabled plugins with their directories, for the core to call, and the entries whose plugin
// is not installed or is disabled: every extension is optional, so such an entry is absent.
// `absent` holds { id, reason, points }, `points` as the entry recorded them (none for an entry
// written before they were). Throws on a broken entry.
export function registryPlugins(root, { coreContract, points, home }) {
  const registry = requireRegistry(root)
  const plugins = []
  const absent = []
  for (const entry of registry.extensions) {
    let dir
    try {
      dir = pluginDir(root, entry, { home })
    } catch (error) {
      if (!error.absent) throw error
      absent.push({ ...error.absent, points: Array.isArray(entry.points) ? entry.points : [] })
      continue
    }
    plugins.push({ entry, dir, declaration: loadPlugin(root, entry, { coreContract, points, home }) })
  }
  return { plugins, absent }
}

export function enabledPlugins(root, core) {
  return registryPlugins(root, core).plugins
}

export function checkRegistry(root, { coreContract, points, home }) {
  const registry = readRegistry(root)
  if (!registry) return { ok: false, errors: ['no registry; run /adf:init'], warnings: [], plugins: [] }
  const errors = validateRegistry(registry)
  if (errors.length === 0 && !isCompatible(coreContract, registry.contract)) {
    errors.push(`registry is written for contract ${registry.contract}; this core runs ${coreContract}`)
  }
  const warnings = []
  const plugins = []
  const providers = {}
  for (const entry of registry.extensions ?? []) {
    try {
      const declaration = loadPlugin(root, entry, { coreContract, points, home })
      plugins.push({ name: declaration.name, ...(entry.plugin ? { plugin: entry.plugin } : { path: entry.path }), points: Object.keys(declaration.provides) })
      for (const point of Object.keys(declaration.provides)) {
        if (!roleOf(points, point)) continue
        if (providers[point]) errors.push(`the role ${point} is provided by both ${providers[point]} and ${declaration.name}`)
        providers[point] = declaration.name
      }
    } catch (error) {
      // A plugin that is not installed or is disabled is optional: the flow runs without it, so it only warns.
      const { id, reason } = error.absent ?? {}
      if (reason === 'not-installed') warnings.push(`${id} is in the registry but not installed; its points are skipped (run: claude plugin install ${id} --scope project)`)
      else if (reason === 'disabled') warnings.push(`${id} is in the registry but disabled; its points are skipped (run: claude plugin enable ${id})`)
      else errors.push(error.message)
    }
  }
  if (registry.branches === undefined) errors.push('no branches are set; run /adf:init')
  return { ok: errors.length === 0, errors, warnings, plugins }
}

// ---------------------------------------------------------------- reports

const plugins = (check) => (check.plugins.length ? check.plugins.map((p) => `${p.name} (${p.points.length ? p.points.join(', ') : 'no points'})`).join('; ') : 'none')
const checkLine = (check) =>
  [
    check.ok ? 'Registry check: ok' : `Registry check: ${check.errors.length} error(s)\n${check.errors.map((e) => `- ${e}`).join('\n')}`,
    ...(check.warnings ?? []).map((w) => `Warning: ${w}`)
  ].join('\n')
const policy = (branches) => `Branch policy: integration ${branches.integration}; protected ${branches.protected.join(', ')}`

const reviewPromptLine = (p) => {
  if (p.invalid) return `Review prompt: review.prompt "${p.path}" is not a path inside the project; nothing installed`
  const where = p.created ? `created at ${p.path}; the team tunes its criteria` : `${p.path} already exists`
  return `Review prompt: ${where}${p.registered ? '; review.prompt set in the registry' : ''}`
}

// The text /adf:init shows, from the fields of `extensions.mjs init`.
export function initReport(r) {
  return [
    `Registry: ${r.created ? 'created' : 'already existed'} (.claude/adf-extensions.json)`,
    `Contract: ${r.contract}`,
    `Settings added: ${r.settings.added.length ? r.settings.added.join(', ') : 'none'}`,
    ...r.settings.notes.map((n) => `Note: ${n}`),
    r.branches ? policy(r.branches) : `Branch policy: not set; ask for the integration branch${r.detectedIntegration ? ` (detected: ${r.detectedIntegration})` : ''} and other protected branches, then run extensions.mjs branches`,
    `.gitignore: ${r.gitignore.added.length ? `added ${r.gitignore.added.join(', ')}` : 'unchanged'}`,
    `Planning guide: ${r.planningGuide.created ? `created at ${r.planningGuide.path}; the team fills it in` : `${r.planningGuide.path} already exists`}`,
    reviewPromptLine(r.reviewPrompt),
    `Superpowers: ${r.superpowers.ok ? 'available' : `not available (${r.superpowers.reason}); install it with \`${r.superpowers.install}\``}`,
    `Enabled plugins: ${plugins(r.check)}`,
    checkLine(r.check),
    ...(r.tracker ? [trackerReport('check', r.tracker)] : []),
    'Enable a plugin with /adf:add <plugin id or path>.',
    'Nothing was committed: the developer commits the registry, the settings, .gitignore, the planning guide and the review prompt.'
  ].join('\n')
}

export function branchesReport(branches, check) {
  return [policy(branches), `Enabled plugins: ${plugins(check)}`, checkLine(check)].join('\n')
}

export function addReport(added, check, tracker) {
  return [
    `Enabled: ${added.name} (${added.points.length ? added.points.join(', ') : 'no points'})`,
    `Host files copied: ${added.hostFiles.copied.length ? added.hostFiles.copied.join(', ') : 'none'}`,
    `Host files already present: ${added.hostFiles.kept.length ? added.hostFiles.kept.join(', ') : 'none'}`,
    checkLine(check),
    ...(tracker ? [trackerReport('check', tracker)] : []),
    'Nothing was committed: the developer commits the registry and the copied host files.'
  ].join('\n')
}

export function removeReport(removed, check) {
  return [`Removed: ${removed.plugin ?? removed.path}`, `Enabled plugins: ${plugins(check)}`, checkLine(check), 'Nothing was committed: the developer commits the registry.'].join('\n')
}
