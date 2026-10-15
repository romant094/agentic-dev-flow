// subagent-driven-development resolves its scratch workspace from the plan file's basename,
// and every change's plan is `plan.md` — so every change resolves to `.superpowers/sdd/plan/`.
// A controller reading a previous change's ledger as its own progress skips completed work.
//
// The rule that prevents it: create `.superpowers/sdd/<change-name>/` before the first
// dispatch and pass explicit output paths to task-brief and review-package. This check does
// not re-decide that rule — it stops the rule from depending on whether an agent read it.
//
// Paths here are relative to the host project's root; the caller's `read` and `list` resolve
// them, or `fsIo` binds them to a root on disk.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { installedPath } from './installed.mjs'
import { PLUGIN_ID as SUPERPOWERS_ID } from './superpowers.mjs'

export const ROOT = '.superpowers/sdd'
export const LEGACY = 'plan'

// A ledger's first line names the plan it belongs to.
export const planOf = (text) => {
  const m = /^#\s*SDD ledger\s*[—-]\s*plan:\s*(\S+)/m.exec(text)
  return m ? m[1] : null
}

export function checkSddWorkspace({ changeName, read, list }) {
  let entries
  try {
    entries = list(ROOT)
  } catch {
    return { ok: true, foreign: null }
  }
  if (!entries.includes(LEGACY)) return { ok: true, foreign: null }

  const path = `${ROOT}/${LEGACY}`
  let ledger
  try {
    ledger = read(`${path}/progress.md`)
  } catch (e) {
    // Only "the file is not there" means there is no ledger. Any other read error — a
    // permission problem, an I/O fault, a directory where the file should be — leaves a
    // ledger that may exist and cannot be identified, which is the case this check fails
    // closed on. Swallowing every error would switch the guard off on exactly the
    // misconfigured runner where it matters.
    if (e.code === 'ENOENT') return { ok: true, foreign: null }
    return { ok: false, foreign: { path, plan: null, unreadable: e.code ?? 'unknown' } }
  }

  // A ledger whose first line does not name a plan is the foreign ledger this check exists
  // for — one written by a version of the skill with a different header. Fail closed: an
  // unidentifiable ledger is exactly what must not be read as this change's own progress.
  const plan = planOf(ledger)
  if (!plan) return { ok: false, foreign: { path, plan: null } }
  if (plan.includes(`/${changeName}/`)) return { ok: true, foreign: null }

  return { ok: false, foreign: { path, plan } }
}

// The refusal for a foreign ledger, one sentence per line.
export function stopMessage(changeName, foreign) {
  return [
    foreign.plan
      ? `STOP: ${foreign.path} holds a ledger belonging to ${foreign.plan}.`
      : `STOP: ${foreign.path} holds a ledger whose owning plan its first line does not name.`,
    'Reading it as this change progress would skip work that was never done here.',
    `Move it aside, then use ${ROOT}/${changeName}/ for this change,`,
    'passing explicit output paths to task-brief and review-package.'
  ]
}

// The change's own workspace and its identity line, written before the skill is invoked so the
// skill's ledger is named by the change and never by the plan's file name.
export const progressPath = (changeName) => `${ROOT}/${changeName}/progress.md`
export const identityLine = (planPath) => `# SDD ledger — plan: ${planPath}`

// Runs the check, then writes the identity line when the change's progress.md is missing. An
// existing progress.md is the skill's working memory of a resumed apply: kept when its first
// line names this change's plan, refused when it names another plan or none.
export function initSddWorkspace({ changeName, planPath, read, list, write }) {
  const check = checkSddWorkspace({ changeName, read, list })
  const progress = progressPath(changeName)
  if (!check.ok) return { ok: false, foreign: check.foreign, progress, written: false }
  let text
  try {
    text = read(progress)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, foreign: { path: `${ROOT}/${changeName}`, plan: null, unreadable: e.code ?? 'unknown' }, progress, written: false }
    }
    write(progress, `${identityLine(planPath)}\n`)
    return { ok: true, foreign: null, progress, written: true }
  }
  const plan = planOf(text)
  if (plan && plan.endsWith(`/openspec/changes/${changeName}/plan.md`)) return { ok: true, foreign: null, progress, written: false }
  return { ok: false, foreign: { path: `${ROOT}/${changeName}`, plan }, progress, written: false }
}

// ---------------------------------------------------------------- on disk

// The check and the init against the host project's files, `root` being the change worktree.
export function fsIo(root) {
  return {
    read: (f) => readFileSync(join(root, f), 'utf8'),
    list: (d) => readdirSync(join(root, d)),
    write: (f, text) => {
      mkdirSync(dirname(join(root, f)), { recursive: true })
      writeFileSync(join(root, f), text, 'utf8')
    }
  }
}

// `sdd.mjs init`: a foreign ledger in the change's own workspace is refused in the same words
// as one on the shared path.
export function initSdd(root, change) {
  const out = initSddWorkspace({
    changeName: change,
    planPath: join(resolve(root), 'openspec', 'changes', change, 'plan.md'),
    ...fsIo(root)
  })
  const result = { ok: out.ok, change, foreign: out.foreign, progress: out.progress, written: out.written }
  return out.ok ? result : { ...result, error: stopMessage(change, out.foreign).join(' ') }
}

// ---------------------------------------------------------------- the skill's two scripts

// task-brief and review-package ship inside the Superpowers skill as bash scripts. They are run
// with `bash` named explicitly, never executed directly: a marketplace unpacker can strip the
// exec bit. On Windows Claude Code runs its Bash tool through Git Bash, whose `bash` must be on
// PATH; the paths passed to it are written with forward slashes, which Git Bash reads.
export const SKILL_SCRIPTS = join('skills', 'subagent-driven-development', 'scripts')

export function skillScriptsDir(root, { home } = {}) {
  const dir = join(installedPath(SUPERPOWERS_ID, root, home ? { home } : {}), SKILL_SCRIPTS)
  if (!existsSync(dir)) throw new Error(`${SUPERPOWERS_ID} has no ${SKILL_SCRIPTS.replace(/\\/g, '/')} at ${dir}; the skill changed its layout`)
  return dir
}

export const briefFile = (change, task) => `${ROOT}/${change}/task-${task}-brief.md`
export const packageFile = (change, base, head) => `${ROOT}/${change}/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`

const forBash = (path) => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path)

function entries(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return null
  }
}

// Runs one skill script with its output argument, then moves anything it wrote to the shared
// default `.superpowers/sdd/plan/` into the change's workspace and reports it. Entries that were
// there before the call are not this call's and are left where they are.
function callSkill(root, change, script, args, { home } = {}) {
  const path = join(skillScriptsDir(root, { home }), script)
  if (!existsSync(path)) throw new Error(`the skill has no ${script} script at ${path}`)
  const legacy = join(root, ROOT, LEGACY)
  const own = join(root, ROOT, change)
  const before = entries(legacy)
  mkdirSync(own, { recursive: true })
  const run = spawnSync('bash', [forBash(path), ...args.map(forBash)], { cwd: root, encoding: 'utf8', windowsHide: true })
  const stray = []
  for (const name of (entries(legacy) ?? []).filter((n) => !(before ?? []).includes(n))) {
    const to = join(own, name)
    if (existsSync(to)) {
      stray.push({ from: `${ROOT}/${LEGACY}/${name}`, to: null, error: `${ROOT}/${change}/${name} exists; left in place` })
      continue
    }
    renameSync(join(legacy, name), to)
    stray.push({ from: `${ROOT}/${LEGACY}/${name}`, to: `${ROOT}/${change}/${name}` })
  }
  if (before === null && entries(legacy)?.length === 0) rmdirSync(legacy)
  if (run.error) {
    const why = run.error.code === 'ENOENT' ? 'bash is not on PATH (on Windows, Git Bash provides it)' : run.error.message
    return { ok: false, error: `${script} could not run: ${why}`, stray }
  }
  const said = `${run.stdout}${run.stderr}`.trim()
  if (run.status !== 0) return { ok: false, error: `${script} exited ${run.status}: ${said}`, stray }
  return { ok: true, said, stray }
}

const planFile = (root, change) => join(resolve(root), 'openspec', 'changes', change, 'plan.md')

export function brief(root, change, task, { home } = {}) {
  if (!/^[1-9]\d*$/.test(String(task ?? ''))) throw new Error(`task "${task}" is not a positive number`)
  const plan = planFile(root, change)
  if (!existsSync(plan)) throw new Error(`openspec/changes/${change}/plan.md does not exist in ${root}`)
  const file = briefFile(change, task)
  const out = callSkill(root, change, 'task-brief', [plan, String(task), join(resolve(root), file)], { home })
  return { ...out, change, task: Number(task), file: join(resolve(root), file) }
}

// BASE and HEAD are resolved to commit ids first: the package is cut while other groups move
// their own branches, and its file name carries the first seven characters of each.
export function reviewPackage(root, change, baseRef, headRef, { home } = {}) {
  const plan = planFile(root, change)
  if (!existsSync(plan)) throw new Error(`openspec/changes/${change}/plan.md does not exist in ${root}`)
  const sha = (ref) => {
    const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${ref} does not resolve to a commit in ${root}`)
    return r.stdout.trim()
  }
  const base = sha(baseRef)
  const head = sha(headRef)
  const file = packageFile(change, base, head)
  const out = callSkill(root, change, 'review-package', [plan, base, head, join(resolve(root), file)], { home })
  return { ...out, change, base, head, file: join(resolve(root), file) }
}
