// Files /adf:init adds to the host project, each only when missing: the `.gitignore` lines that
// keep the flow's local state out of the tree, the settings the flow's scripts read and write,
// the planning guide the team fills in, and the review prompt the team tunes.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRICES_DIR } from './prices.mjs'
import { readRegistry, validateReviewSettings, writeRegistry } from './registry.mjs'
import { RETRO_DIR } from './window.mjs'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'
import { GUIDE_FILE, REVIEW_PROMPT, SETTINGS_FILE } from './layout.mjs'
import { INITIAL, writeSettings } from './settings.mjs'

export { REVIEW_PROMPT }
const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'host')
const GUIDE_TEMPLATE = join(HOST_DIR, 'guide.md')
const REVIEW_TEMPLATE = join(HOST_DIR, 'review-prompt.md')

// Local working state of the flow, never committed: change worktrees, the execution ledger
// and Superpowers' own workspace, the Superpowers skills' default output folder, which the
// flow redirects into the change, and `.adf/`, the extension plugins' local work directory.
export const IGNORED = [`${WORKTREES_DIR}/`, '.superpowers/', 'docs/superpowers/', '.adf/*']
// The core's own directories in `.adf/`, committed: re-included after `.adf/*`.
export const COMMITTED = [`${PRICES_DIR}/`, `${RETRO_DIR}/`]

export function ignoreLocalDirs(root) {
  const git = gitIn(root)
  const ignored = (dir) => {
    try {
      git('check-ignore', '-q', `${dir.replace(/\*$/, '')}probe`)
      return true
    } catch {
      return false
    }
  }
  const missing = IGNORED.filter((dir) => !ignored(dir))
  append(root, missing)
  const reincluded = COMMITTED.filter(ignored).map((dir) => `!${dir}`)
  append(root, reincluded)
  return { added: [...missing, ...reincluded] }
}

function append(root, lines) {
  if (lines.length === 0) return
  const file = join(root, '.gitignore')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`)
}

// The planning guide's prose, a project file from then on: written once, never updated.
export function createGuide(root) {
  const file = join(root, GUIDE_FILE)
  if (existsSync(file)) return { path: GUIDE_FILE, created: false }
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(GUIDE_TEMPLATE, file)
  return { path: GUIDE_FILE, created: true }
}

// The settings with every key at its initial value (lib/settings.mjs INITIAL).
export function createSettings(root) {
  if (existsSync(join(root, SETTINGS_FILE))) return { path: SETTINGS_FILE, created: false }
  writeSettings(root, INITIAL)
  return { path: SETTINGS_FILE, created: true }
}

// The review criteria at the registry's `review.prompt`. A registry without the key gets the
// default path; a file already there, or a key that is not a path inside the project, is left
// as it is. Call it after the registry exists.
export function createReviewPrompt(root) {
  const registry = readRegistry(root)
  const set = registry.review?.prompt
  if (set !== undefined && validateReviewSettings({ prompt: set }).length > 0) return { path: set, created: false, registered: false, invalid: true }
  const path = set ?? REVIEW_PROMPT
  if (set === undefined) writeRegistry(root, { ...registry, review: { ...registry.review, prompt: path } })
  const file = join(root, path)
  if (existsSync(file)) return { path, created: false, registered: set === undefined }
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(REVIEW_TEMPLATE, file)
  return { path, created: true, registered: set === undefined }
}
