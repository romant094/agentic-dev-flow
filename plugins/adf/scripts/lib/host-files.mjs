// Files /adf:init adds to the host project, each only when missing: the `.gitignore` lines that
// keep the flow's local state out of the tree, the planning guide the team fills in, and the
// review prompt the team tunes.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry, validateReviewSettings, writeRegistry } from './registry.mjs'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'

export const PLANNING_GUIDE = 'openspec/planning.md'
export const REVIEW_PROMPT = 'openspec/review-prompt.md'
const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'host')
const GUIDE_TEMPLATE = join(HOST_DIR, 'planning.md')
const REVIEW_TEMPLATE = join(HOST_DIR, 'review-prompt.md')

// Local working state of the flow, never committed: change worktrees, the execution ledger
// and Superpowers' own workspace, and the Superpowers skills' default output folder, which the
// flow redirects into the change.
export const IGNORED = [`${WORKTREES_DIR}/`, '.superpowers/', 'docs/superpowers/']

export function ignoreLocalDirs(root) {
  const git = gitIn(root)
  const missing = IGNORED.filter((dir) => {
    try {
      git('check-ignore', '-q', `${dir}probe`)
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    const file = join(root, '.gitignore')
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`)
  }
  return { added: missing }
}

export function createPlanningGuide(root) {
  const file = join(root, PLANNING_GUIDE)
  if (existsSync(file)) return { path: PLANNING_GUIDE, created: false }
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(GUIDE_TEMPLATE, file)
  return { path: PLANNING_GUIDE, created: true }
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
