// Files /adf:init adds to the host project, each only when missing: the `.gitignore` lines that
// keep the flow's local state out of the tree, and the planning guide the team fills in.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'

export const PLANNING_GUIDE = 'openspec/planning.md'
const GUIDE_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'host', 'planning.md')

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
