// The ingest at archive: an agent at level `architecture` decides what the archived change
// taught and what it made stale, and returns every page edit in its reply as a git patch; it
// writes no page. The script does the rest: it lists the stale pages before the dispatch, and
// after it checks the reply against `schema/ingest.schema.json`, against the tree and against
// the edits, without writing (checkIngestReply, checkPageEdits), so the agent cannot skip a
// stale page or edit outside the knowledge base. `archive.mjs ingest` then applies the edits
// with `git apply`, the mechanism of `verify.mjs skill-edit` (lib/verify.mjs gitApply), and
// writes the log entry through the knowledge role's `log`, from the reply.
//
// Stale page: a page of the knowledge base (a `.md` file under the knowledge role's `paths`, the
// log excluded) that
//   - names a path the change deleted, renamed or rewrote, by its repository-relative path in
//     the text or by a relative link that resolves to it. Rewrote: a modified file whose deleted
//     lines are at least REWRITE_SHARE of the lines it had at the merge base; a binary file
//     counts as rewritten. Files under the knowledge paths are not looked for: a link to a
//     deleted page is the knowledge role's own `check`;
//   - or names a capability whose requirement the change's delta touches (ADDED, MODIFIED,
//     REMOVED or RENAMED): its path `openspec/specs/<capability>`, a link into that directory,
//     or its name in a code span; or names one of those requirements by its full name.
//
// The rules of a reply the schema cannot state, in checkIngestReply:
//   - the tree holds no change under the knowledge paths: the agent writes no page and no log
//     entry, so a changed file there is refused;
//   - each page names a relative path inside the repository (no absolute path, no `.` or `..`
//     segment), under the knowledge paths and not the log, reached through no symbolic link; its
//     patch edits that path and nothing else, makes no symbolic link, and passes
//     `git apply --check` against the tree (checkPageEdits); a path is listed once;
//   - every stale entry has exactly one answer, and no answer names a page that is not stale;
//   - each answer is read against the tree as the edits leave it: `removed` needs the page
//     deleted, by the reply or before it, `updated` needs an edit of it that keeps it,
//     `still-true` needs an argument;
//   - `nothingLearned: true` means no pages and no log, and yet every stale entry still needs an
//     answer: with no page changed, each answer is `still-true` with its argument;
//   - with something learned, the two answers are not empty and the log has a title and at least
//     one bullet, none holding a blank line.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCHIVE, CHANGES_DIR, globToRegExp, META_FILE, readChangeMeta } from './changes.mjs'
import { sddDir } from './dispatch.mjs'
import { baseRef } from './plan-symbols.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { parseDeltaSpec } from './specs.mjs'
import { applyCheck, patchPaths } from './verify.mjs'

export const INGEST_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'ingest.schema.json')
export const REWRITE_SHARE = 0.5
export const OUTCOMES = ['updated', 'removed', 'still-true']
// A requirement named in a page counts only from this length: a short name is a common phrase.
const MIN_REQUIREMENT_NAME = 12

export const ingestInputFile = (root, change) => join(sddDir(root, change), 'ingest', 'input.json')

const toPosix = (path) => path.split(sep).join('/')
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const matcher = (globs) => {
  const res = globs.map((g) => globToRegExp(g))
  return (file) => res.some((re) => re.test(file))
}

// ---------------------------------------------------------------- the change

// The change's directory: active under openspec/changes/, or archived as
// openspec/changes/archive/<date>-<name> (the latest such date).
export function findChangeDir(root, change) {
  const active = join(root, CHANGES_DIR, change)
  if (existsSync(active)) return active
  const archive = join(root, CHANGES_DIR, ARCHIVE)
  const dated = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  const found = existsSync(archive) ? readdirSync(archive).filter((n) => dated.test(n)).sort() : []
  if (found.length === 0) throw new Error(`no change "${change}" in ${CHANGES_DIR} or ${CHANGES_DIR}/${ARCHIVE}`)
  return join(archive, found.at(-1))
}

// Every file of the change directory, absolute, in path order.
export function changeArtifacts(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...changeArtifacts(path))
    else out.push(path)
  }
  return out
}

// The change's merge base: its metadata's base (the remote-tracking ref when it exists) with HEAD.
export function mergeBaseOf(root, dir) {
  const meta = readChangeMeta(root, dir)
  if (!meta) throw new Error(`cannot read ${join(dir, META_FILE)}; pass --base`)
  const ref = baseRef(meta, (name) => {
    try {
      git(root, 'rev-parse', '--verify', '--quiet', name)
      return true
    } catch {
      return false
    }
  })
  try {
    return git(root, 'merge-base', ref, 'HEAD').trim()
  } catch {
    throw new Error(`${ref} and HEAD have no merge base`)
  }
}

// Every requirement the delta specs touch: [{ capability, requirements: [{ name, operation, to? }] }].
export function touchedCapabilities(dir) {
  const specs = join(dir, 'specs')
  if (!existsSync(specs)) return []
  const out = []
  for (const capability of readdirSync(specs).sort()) {
    const file = join(specs, capability, 'spec.md')
    if (!existsSync(file)) continue
    const plan = parseDeltaSpec(readFileSync(file, 'utf8'))
    const requirements = [
      ...plan.added.map((b) => ({ name: b.name.trim(), operation: 'ADDED' })),
      ...plan.modified.map((b) => ({ name: b.name.trim(), operation: 'MODIFIED' })),
      ...plan.removed.map((n) => ({ name: n.trim(), operation: 'REMOVED' })),
      ...plan.renamed.map(({ from, to }) => ({ name: from.trim(), operation: 'RENAMED', to: to.trim() }))
    ]
    if (requirements.length > 0) out.push({ capability, requirements })
  }
  return out
}

// ---------------------------------------------------------------- the diff

// Pure. `nameStatus`: the output of `git diff --name-status -M -z`; `numstat`: of
// `git diff --numstat --no-renames -z`; `baseLines(path)`: the line count of a path at the base.
// Returns [{ path, kind: deleted|renamed|rewrote, to?, share? }] in path order.
export function touchedPaths(nameStatus, numstat, baseLines) {
  const parts = nameStatus.split('\0').filter((p) => p !== '')
  const out = []
  const modified = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (/^[RC]\d*$/.test(status)) {
      const [from, to] = [parts[i + 1], parts[i + 2]]
      i += 2
      if (status[0] === 'R') out.push({ path: from, kind: 'renamed', to })
      continue
    }
    const path = parts[++i]
    if (status === 'D') out.push({ path, kind: 'deleted' })
    else if (status === 'M' || status === 'T') modified.push(path)
  }
  const stats = new Map()
  for (const record of numstat.split('\0').filter((p) => p !== '')) {
    const [added, deleted, ...rest] = record.split('\t')
    stats.set(rest.join('\t'), { added, deleted })
  }
  for (const path of modified) {
    const stat = stats.get(path)
    if (!stat) continue
    if (stat.deleted === '-') {
      out.push({ path, kind: 'rewrote', share: 1 })
      continue
    }
    const lines = baseLines(path)
    const share = lines > 0 ? Number(stat.deleted) / lines : 0
    if (share >= REWRITE_SHARE) out.push({ path, kind: 'rewrote', share: Math.min(1, share) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

export function diffTouched(root, base) {
  const nameStatus = git(root, '-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-z', base, 'HEAD')
  const numstat = git(root, '-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', '-z', base, 'HEAD')
  return touchedPaths(nameStatus, numstat, (path) => {
    try {
      return lineCount(git(root, 'show', `${base}:${path}`))
    } catch {
      return 0
    }
  })
}

// ---------------------------------------------------------------- pages

const LINK = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The repository-relative targets of a page's relative links.
export function linkTargets(text, pagePath) {
  const out = []
  for (const m of text.matchAll(LINK)) {
    const target = m[1].replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
    let decoded = target
    try {
      decoded = decodeURI(target)
    } catch {
      // keep it as written
    }
    out.push(posix.normalize(posix.join(posix.dirname(pagePath), decoded)).replace(/\/$/, ''))
  }
  return out
}

const namesPath = (text, path) => new RegExp(`(?:^|[^A-Za-z0-9_./-])${escapeRe(path)}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])`).test(text)
const pct = (share) => `${Math.round(share * 100)}%`

// Pure: why one page is stale; [] when it is not.
//   touched: from touchedPaths; capabilities: from touchedCapabilities.
export function pageReasons(text, pagePath, { touched = [], capabilities = [] } = {}) {
  const targets = linkTargets(text, pagePath)
  const reasons = []
  for (const t of touched) {
    if (!namesPath(text, t.path) && !targets.includes(t.path)) continue
    if (t.kind === 'deleted') reasons.push(`names ${t.path}, which the change deleted`)
    else if (t.kind === 'renamed') reasons.push(`names ${t.path}, which the change renamed to ${t.to}`)
    else reasons.push(`names ${t.path}, which the change rewrote (${pct(t.share)} of its lines)`)
  }
  for (const { capability, requirements } of capabilities) {
    const dir = `openspec/specs/${capability}`
    const named =
      namesPath(text, dir) ||
      text.includes(`${dir}/`) ||
      text.includes(`\`${capability}\``) ||
      targets.some((t) => t === dir || t.startsWith(`${dir}/`))
    if (named) reasons.push(`names the capability ${capability}, whose requirements the change touched (${[...new Set(requirements.map((r) => r.operation))].join(', ')})`)
    for (const r of requirements) {
      if (r.name.length < MIN_REQUIREMENT_NAME || !text.includes(r.name)) continue
      const what = r.operation === 'RENAMED' ? `renamed to "${r.to}"` : r.operation.toLowerCase()
      reasons.push(`names the requirement "${r.name}" of ${capability}, which the change ${what}`)
    }
  }
  return reasons
}

// The knowledge base's pages, repository-relative: tracked and untracked `.md` files under the
// knowledge paths, ignored files and the log excluded.
export function knowledgePages(root, knowledgePaths, logPaths = []) {
  const inBase = matcher(knowledgePaths)
  const isLog = matcher(logPaths)
  return git(root, '-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter((f) => f.endsWith('.md') && inBase(f) && !isLog(f) && existsSync(join(root, f)))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort()
}

// Every stale page of the knowledge base: [{ path, reasons }], in path order. `base` defaults
// to the change's merge base (mergeBaseOf); the diff is `<base>..HEAD`.
export function staleList(root, change, { knowledgePaths, base, logPaths = [] }) {
  if (!Array.isArray(knowledgePaths) || knowledgePaths.length === 0) throw new Error('no knowledge paths: the knowledge role names none')
  const dir = findChangeDir(root, change)
  const from = base ?? mergeBaseOf(root, dir)
  const inBase = matcher(knowledgePaths)
  const touched = diffTouched(root, from).filter((t) => !inBase(t.path))
  const capabilities = touchedCapabilities(dir)
  const out = []
  for (const page of knowledgePages(root, knowledgePaths, logPaths)) {
    const reasons = pageReasons(readFileSync(join(root, page), 'utf8'), page, { touched, capabilities })
    if (reasons.length > 0) out.push({ path: page, reasons })
  }
  return out
}

// ---------------------------------------------------------------- the reply

// Repository-relative paths with uncommitted changes, tracked or untracked, a rename as its two
// ends: `git status --porcelain -z --untracked-files=all`.
export function workingChanges(root) {
  const parts = git(root, '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') out.push(parts[++i])
  }
  return [...new Set(out)].sort()
}

const oneLine = (text) => typeof text === 'string' && text.trim() !== '' && !/[\r\n]/.test(text)

// A path an edit may name: relative, with forward slashes, and no empty, `.` or `..` segment.
const insidePath = (path) => !/^(?:\/|[A-Za-z]:)/.test(path) && !path.includes('\\') && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
const LINK_MODE = /^(?:new file mode|new mode|old mode|deleted file mode) 120000$/m
// A deletion in either form `git apply` takes: a git diff's header, or a plain diff to /dev/null.
const DELETES = /^(?:deleted file mode |\+\+\+ \/dev\/null\s*$)/m

// The first symbolic link on `path` inside <root>, from its first segment to the path itself;
// null when there is none.
function linkOn(root, path) {
  const segments = path.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const at = segments.slice(0, i).join('/')
    let stat
    try {
      stat = lstatSync(join(root, at))
    } catch {
      return null
    }
    if (stat.isSymbolicLink()) return at
  }
  return null
}

// The page edits of a reply, checked in <root> with `git apply` and nothing written:
// { errors, edited: Map(path -> 'changed' | 'deleted'), patch }, `patch` the edits joined in
// page order, for `archive.mjs ingest` to apply.
export function checkPageEdits(root, pages, { knowledgePaths = [], logPaths = [] } = {}) {
  const inBase = matcher(knowledgePaths)
  const isLog = matcher(logPaths)
  const errors = []
  const edited = new Map()
  const patches = []
  pages.forEach((page, i) => {
    const at = `$.pages[${i}]`
    if (!insidePath(page.path)) return errors.push(`${at}.path: ${page.path} is not a relative path inside the repository; give it from the repository root, with no \`.\` or \`..\` segment`)
    if (!inBase(page.path)) return errors.push(`${at}.path: ${page.path} is outside the knowledge base (${knowledgePaths.join(', ')})`)
    if (isLog(page.path)) return errors.push(`${at}.path: ${page.path} is the log, which the script writes from the reply's log`)
    const link = linkOn(root, page.path)
    if (link) return errors.push(`${at}.path: ${link} is a symbolic link; an edit never goes through one`)
    const patch = page.patch.endsWith('\n') ? page.patch : `${page.patch}\n`
    if (LINK_MODE.test(patch)) return errors.push(`${at}.patch: it makes a symbolic link; a page is a regular file`)
    let paths
    try {
      paths = [...new Set(patchPaths(root, patch))]
    } catch (error) {
      return errors.push(`${at}.patch: git apply cannot read it: ${String(error.stderr || error.message).trim()}`)
    }
    if (paths.length !== 1 || paths[0] !== page.path) return errors.push(`${at}.patch: it must edit ${page.path} and nothing else; it touches ${paths.join(', ') || 'no file'}`)
    const failed = applyCheck(root, patch)
    if (failed) return errors.push(`${at}.patch: it does not apply to ${page.path} as the tree holds it (git apply --check: ${failed}); make it against the page as it is now`)
    edited.set(page.path, DELETES.test(patch) ? 'deleted' : 'changed')
    patches.push(patch)
  })
  return { errors, edited, patch: patches.join('') }
}

// The ingest agent's reply, as text or as a parsed object: { valid, errors, fenced, reply, patch }.
//   root: the change worktree, where the page edits are checked (checkPageEdits);
//   stale: [{ path, reasons }] as staleList gave it before the dispatch;
//   changedFiles: repository-relative paths changed in the tree (workingChanges);
//   knowledgePaths, logPaths: globs from the knowledge role's context;
//   exists(path): whether a repository-relative path exists now, before the edits.
export function checkIngestReply(reply, { root, stale = [], changedFiles = [], knowledgePaths = [], logPaths = [], exists = (path) => existsSync(join(root, path)), schema = readSchema(INGEST_SCHEMA_PATH) } = {}) {
  const parsed = typeof reply === 'string' ? parseReply(reply) : { reply, fenced: false, errors: [] }
  if (parsed.errors.length > 0) return { valid: false, ...parsed, patch: '' }
  const errors = validateJson(schema, parsed.reply)
  if (errors.length > 0) return { valid: false, ...parsed, errors, patch: '' }
  const r = parsed.reply
  const inBase = matcher(knowledgePaths)
  const isLog = matcher(logPaths)
  for (const f of changedFiles.filter((f) => isLog(f))) errors.push(`${f} changed: write no log entry yourself; the script writes the log from the reply's log`)
  for (const f of changedFiles.filter((f) => inBase(f) && !isLog(f))) errors.push(`${f} is changed in the tree: write no page yourself; return its edit as a page's patch in the reply`)

  const listed = new Set()
  for (const page of r.pages) {
    if (listed.has(page.path)) errors.push(`$.pages: ${page.path} is listed twice`)
    listed.add(page.path)
  }
  const edits = checkPageEdits(root, r.pages, { knowledgePaths, logPaths })
  errors.push(...edits.errors)
  const { edited } = edits
  // Whether a path exists once the edits are applied.
  const present = (path) => (edited.has(path) ? edited.get(path) !== 'deleted' : exists(path))

  const stalePaths = new Set(stale.map((s) => s.path))
  const answered = new Map()
  for (const entry of r.stale) {
    if (!stalePaths.has(entry.path)) {
      errors.push(`$.stale: ${entry.path} is not on the stale list`)
      continue
    }
    if (answered.has(entry.path)) errors.push(`$.stale: ${entry.path} is answered twice`)
    answered.set(entry.path, entry)
    if (entry.outcome === 'removed' && present(entry.path)) errors.push(`$.stale: ${entry.path} is answered removed, but the reply does not delete it`)
    if (entry.outcome === 'updated' && !edited.has(entry.path)) errors.push(`$.stale: ${entry.path} is answered updated, but the reply carries no edit of it`)
    else if (entry.outcome === 'updated' && !present(entry.path)) errors.push(`$.stale: ${entry.path} is answered updated, but the reply deletes it; answer removed`)
    if (r.nothingLearned && entry.outcome !== 'still-true') errors.push(`$.stale: ${entry.path} is answered ${entry.outcome}, but nothingLearned is true; with no page changed every answer is still-true`)
  }
  for (const path of stalePaths) if (!answered.has(path)) errors.push(`$.stale: ${path} is stale and has no answer`)

  if (r.nothingLearned) {
    if (r.pages.length > 0) errors.push('$.pages: nothingLearned is true, so no page may change')
    if (r.log !== undefined && r.log !== null) errors.push('$.log: nothingLearned is true, so there is no log entry; give null')
  } else {
    if (!oneLine(r.log.title) || r.log.title.includes('|')) errors.push('$.log.title: one line without "|"')
    if (r.log.bullets.length === 0) errors.push('$.log.bullets: at least one bullet')
    r.log.bullets.forEach((b, i) => {
      if (b.replace(/\r\n?/g, '\n').split('\n').some((line) => line.trim() === '')) errors.push(`$.log.bullets[${i}]: holds a blank line`)
    })
  }
  return { valid: errors.length === 0, ...parsed, errors, patch: errors.length === 0 ? edits.patch : '' }
}

// `ingest.mjs check` and `archive.mjs ingest`: the reply file against the dispatch's input
// (written by `ingest.mjs stale`) and the working tree. `exclude` names repository-relative
// files that changed for another reason and are no page of the ingest: the debt files archive's
// placement wrote, when the debt tree sits inside the knowledge base.
// Nothing is written. Returns { ok, valid, errors, log, reply, input, patch }: `log` is the
// knowledge role's `log` input, null when nothing was learned or the reply is refused; `patch`
// the page edits joined, '' when there are none or the reply is refused.
export function checkIngestFile(root, change, replyPath, { exclude = [] } = {}) {
  const file = ingestInputFile(root, change)
  if (!existsSync(file)) throw new Error(`no ${file}: run ingest.mjs stale --change ${change} first`)
  const input = JSON.parse(readFileSync(file, 'utf8'))
  let text
  try {
    text = readFileSync(replyPath, 'utf8')
  } catch (error) {
    throw new Error(`--reply ${replyPath}: ${error.message}`)
  }
  const skip = new Set([relativeTo(root, file), ...exclude])
  const checked = checkIngestReply(text, {
    root,
    stale: input.stale,
    changedFiles: workingChanges(root).filter((f) => !skip.has(f)),
    knowledgePaths: input.knowledge.paths,
    logPaths: input.knowledge.log
  })
  return { ok: checked.valid, valid: checked.valid, errors: checked.errors, log: checked.valid ? ingestLogInput(checked.reply) : null, reply: checked.reply, input, patch: checked.patch }
}

// The knowledge role's `log` input for a valid reply; null when nothing was learned.
export function ingestLogInput(reply) {
  if (reply.nothingLearned) return null
  return { type: 'ingest', title: reply.log.title.trim(), bullets: reply.log.bullets }
}

export const relativeTo = (root, path) => toPosix(relative(root, path))
