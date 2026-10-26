// Worktree preparation: what a fresh worktree lacks because git ignores it, such as a built
// workspace package or generated code, rebuilt by the project's own commands. The recipe lives
// under `## Worktree preparation` in `openspec/planning.md`, one list item per step:
//
//   - `<command>` from `<input path>`, `<input path>`
//
// the first code span the command, every other code span an input path relative to the project
// root (HTML comments ignored). `/adf:init` gathers candidates (`candidates`) and writes the ones
// the developer confirms (`addStep`).
//
// `prepareWorktree` runs, in recipe order and with the worktree as the working directory, each
// step whose inputs changed since its last successful run in that worktree: never run there, a
// commit since then whose diff touches an input, or uncommitted changes to an input that differ
// from those at the last run; `force` runs every step. The state, the commit and the uncommitted
// fingerprint of each step's last run, is the worktree's own: a file in git's per-worktree
// directory (`git rev-parse --git-path adf-prepare.json`), which git never shows and no other
// worktree shares. A failed step stops the run and records nothing for itself, so the next run
// tries it again. It runs at provisioning (lib/provision.mjs), before each covering and
// whole-suite run (lib/suite.mjs) and after a group merge (lib/groups.mjs); no agent runs these
// commands itself.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

export const HEADING = '## Worktree preparation'
export const STATE_NAME = 'adf-prepare.json'
export const DEFAULT_TIMEOUT_MINUTES = 30
const GUIDE = 'openspec/planning.md'
const TAIL_LINES = 20

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trimEnd()
function attempt(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}
const inside = (path) => path !== '' && !isAbsolute(path) && !normalize(path).startsWith('..')

// ---------------------------------------------------------------- the recipe

// [start, end) line indexes of the section body, or null when the heading is absent.
function bounds(lines) {
  const at = lines.findIndex((l) => l.trim() === HEADING)
  if (at < 0) return null
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  if (end < 0) end = lines.length
  return { start: at + 1, end }
}

export function recipeIn(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const b = bounds(lines)
  if (!b) return []
  const body = lines.slice(b.start, b.end).join('\n').replace(/<!--[\s\S]*?-->/g, '')
  const steps = []
  for (const line of body.split('\n').filter((l) => /^\s*[-*]\s/.test(l))) {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
    if (spans.length === 0) continue
    const [command, ...inputs] = spans
    if (inputs.length === 0) throw new Error(`${HEADING}: the step \`${command}\` names no input path; a step runs when its inputs change`)
    const outside = inputs.filter((p) => !inside(p))
    if (outside.length) throw new Error(`${HEADING}: ${outside.join(', ')} is not a path inside the project`)
    steps.push({ command, inputs: inputs.map((p) => p.replace(/\/+$/, '')) })
  }
  return steps
}

export function readRecipe(root) {
  const file = join(resolve(root), GUIDE)
  return existsSync(file) ? recipeIn(readFileSync(file, 'utf8')) : []
}

const stepLine = ({ command, inputs }) => `- \`${command}\` from ${inputs.map((p) => `\`${p}\``).join(', ')}`

// Adds a step to the recipe, or replaces the step of the same command; creates the file or the
// section when absent. Committing it is the caller's job.
export function addStep(root, { command, inputs }) {
  const cmd = String(command ?? '').trim()
  if (!cmd || /[`\r\n]/.test(cmd)) throw new Error('the command is one line with no backtick')
  const paths = (inputs ?? []).map((p) => String(p).trim().replace(/\/+$/, '')).filter(Boolean)
  if (paths.length === 0) throw new Error('a step needs at least one input path')
  const outside = paths.filter((p) => !inside(p) || p.includes('`'))
  if (outside.length) throw new Error(`${outside.join(', ')} is not a path inside the project`)
  const file = join(resolve(root), GUIDE)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const line = stepLine({ command: cmd, inputs: paths })
  const b = bounds(lines)
  if (!b) {
    while (lines.length && lines.at(-1) === '') lines.pop()
    lines.push(...(lines.length ? [''] : []), HEADING, '', line, '')
  } else {
    const same = lines.findIndex((l, i) => i >= b.start && i < b.end && /^\s*[-*]\s/.test(l) && /`([^`]+)`/.exec(l)?.[1].trim() === cmd)
    if (same >= 0) lines[same] = line
    else {
      let last = b.end - 1
      while (last >= b.start && lines[last].trim() === '') last--
      lines.splice(last + 1, 0, ...(last + 1 === b.start ? [''] : []), line)
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  const out = lines.join(eol)
  writeFileSync(file, out.endsWith(eol) ? out : out + eol)
  return { file, steps: readRecipe(root) }
}

// ---------------------------------------------------------------- candidates

function readJson(file) {
  return attempt(() => JSON.parse(readFileSync(file, 'utf8')))
}

// The workspace directories a manifest's `workspaces` names: a literal path, or one ending in
// `/*` for each directory under it.
function workspaceDirs(root, pkg) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : []
  const dirs = []
  for (const pattern of patterns.filter((p) => typeof p === 'string' && inside(p))) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2)
      for (const entry of attempt(() => readdirSync(join(root, parent), { withFileTypes: true })) ?? []) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`)
      }
    } else if (!pattern.includes('*')) dirs.push(pattern.replace(/\/+$/, ''))
  }
  return dirs.sort()
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// The steps init offers the developer: the `build` script of each workspace package another
// workspace depends on, whose built output a fresh worktree lacks. The command is the root
// script that builds that package when one names it, else the package manager's workspace call;
// the input is the package's directory. Only candidates: the developer confirms each one.
export function candidates(rootArg) {
  const root = resolve(rootArg)
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg) return []
  const manager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm'
  const packages = workspaceDirs(root, pkg)
    .map((dir) => ({ dir, manifest: readJson(join(root, dir, 'package.json')) }))
    .filter((p) => p.manifest && typeof p.manifest.name === 'string')
  const rootScripts = Object.entries(pkg.scripts ?? {})
  const out = []
  for (const { dir, manifest } of packages) {
    if (typeof manifest.scripts?.build !== 'string') continue
    const users = packages.filter((p) => p.dir !== dir && DEPENDENCY_FIELDS.some((f) => Object.hasOwn(p.manifest[f] ?? {}, manifest.name)))
    if (users.length === 0) continue
    const script = rootScripts.find(([, value]) => typeof value === 'string' && /\bbuild\b/.test(value) && (value.includes(manifest.name) || value.includes(dir)))
    const command = script
      ? `${manager} run ${script[0]}`
      : manager === 'pnpm'
        ? `pnpm --filter ${manifest.name} run build`
        : manager === 'yarn'
          ? `yarn workspace ${manifest.name} run build`
          : `npm run build --workspace ${manifest.name}`
    out.push({ command, inputs: [dir], why: `${users.map((u) => u.manifest.name).join(', ')} depend${users.length === 1 ? 's' : ''} on ${manifest.name}, whose build output git does not track` })
  }
  return out
}

// ---------------------------------------------------------------- the run

// The worktree's own state file, in git's per-worktree directory.
export function stateFile(worktree) {
  return resolve(worktree, git(worktree, 'rev-parse', '--git-path', STATE_NAME))
}

// The uncommitted state of a step's inputs: '' when clean, else a hash of their status and diff.
function dirtyOf(dir, inputs) {
  const status = attempt(() => git(dir, 'status', '--porcelain', '--untracked-files=all', '--', ...inputs)) ?? ''
  if (status === '') return ''
  const diff = attempt(() => git(dir, 'diff', 'HEAD', '--', ...inputs)) ?? ''
  return createHash('sha1').update(`${status}\n${diff}`).digest('hex')
}

// Why a step runs now, or null when its inputs are unchanged since its last run here.
function whyRun(dir, step, last, head, dirty) {
  if (!last) return 'never prepared in this worktree'
  if (last.commit !== head) {
    const changed = attempt(() => git(dir, 'diff', '--name-only', last.commit, head, '--', ...step.inputs))
    if (changed === null) return `its last commit ${last.commit.slice(0, 7)} is not readable here`
    if (changed !== '') {
      const files = changed.split('\n')
      return `inputs changed since ${last.commit.slice(0, 7)}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? `, and ${files.length - 3} more` : ''}`
    }
  }
  if (dirty !== (last.dirty ?? '')) return 'uncommitted changes to its inputs'
  return null
}

function runStep(command, cwd, timeoutMinutes) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 1 << 28, timeout: Math.round(timeoutMinutes * 60000), windowsHide: true })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { exit: r.status, error: r.error?.message ?? null, tail: output.split(/\r?\n/).filter(Boolean).slice(-TAIL_LINES).join('\n') }
}

// Returns { ok, worktree, ran: [{ command, reason, exit }], skipped: [{ command, reason }],
// report, error? }. `guideRoot` is where the recipe is read (default: the worktree itself).
export function prepareWorktree(worktreeArg, { guideRoot = worktreeArg, force = false, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = {}) {
  const dir = resolve(worktreeArg)
  const steps = readRecipe(guideRoot)
  const result = { ok: true, worktree: dir, ran: [], skipped: [] }
  if (steps.length === 0) return { ...result, report: `Preparation: no ${HEADING} steps` }
  const file = stateFile(dir)
  const state = readJson(file) ?? {}
  const head = git(dir, 'rev-parse', 'HEAD')
  for (const step of steps) {
    const dirty = dirtyOf(dir, step.inputs)
    const reason = force ? 'forced' : whyRun(dir, step, state[step.command], head, dirty)
    if (!reason) {
      result.skipped.push({ command: step.command, reason: 'inputs unchanged' })
      continue
    }
    const ran = runStep(step.command, dir, timeoutMinutes)
    result.ran.push({ command: step.command, reason, exit: ran.exit })
    if (ran.exit !== 0) {
      result.ok = false
      result.error = `${step.command} failed (exit ${ran.exit ?? ran.error ?? 'none'}) in ${dir}; the steps after it did not run. Output tail:\n${ran.tail}`
      break
    }
    state[step.command] = { commit: head, dirty, at: new Date().toISOString() }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  }
  const report = [
    ...result.ran.map((r) => `Preparation: ${r.command} ${r.exit === 0 ? 'ran' : 'failed'} (${r.reason})`),
    ...result.skipped.map((s) => `Preparation: ${s.command} skipped (${s.reason})`),
    ...(result.error ? [result.error] : [])
  ].join('\n')
  return { ...result, report }
}
