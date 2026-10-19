// Ticks a coarse task of a change's tasks file when its dispatch returns. Only the script
// ticks: an agent that ticks by hand ticks the wrong line or forgets the last one.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir } from './changes.mjs'
import { notClean, subjectState } from './loop.mjs'
import { lintTasks, parsePlan } from './plan.mjs'
import { gitIn } from './workspace.mjs'

const ITEM = /^\d+(\.\d+)*$/

export function tickTask(root, change, item, { tracks = 'tasks.md' } = {}) {
  if (!ITEM.test(item ?? '')) throw new Error(`item "${item}" is not a task number such as 1.2`)
  const file = join(changeDir(root, change), tracks)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${change} has no ${tracks}`)
  }
  const escaped = item.replace(/\./g, '\\.')
  const line = new RegExp(`^([-*]\\s+\\[)([ xX])(\\]\\s*${escaped}(?![\\d.])\\s?)`, 'm')
  const found = line.exec(text)
  if (!found) throw new Error(`${tracks} has no task ${item}`)
  if (found[2] !== ' ') return { item, ticked: false, already: true }
  writeFileSync(file, text.replace(line, '$1x$3'))
  return { item, ticked: true, already: false }
}

// The tasks.md item a plan task implements, read from its back-reference.
export function itemForPlanTask(planText, number) {
  const task = parsePlan(planText).tasks.find((t) => t.number === Number(number))
  if (!task) throw new Error(`plan.md has no Task ${number}`)
  if (!task.implements) throw new Error(`Task ${number} has no "> Implements tasks.md N.M" line`)
  return task.implements
}

// A plan task is ticked only once its review loop is clean (lib/loop.mjs loopState, from the
// accepted review results in the change worktree's events log), each item left closed by a
// ruling. Throws naming what is left; returns the loop state.
export function tickGate(root, change, number) {
  const state = subjectState(root, change, `T${Number(number)}`)
  const why = notClean(state, change)
  if (why) throw new Error(`Task ${number} is not ticked: ${why}`)
  return state
}

export const tickMessage = (item, change) => `chore(openspec): tick ${item} of ${change}`

// Commits the tick: the tasks file, and plan.md when it differs from HEAD (an "Added during
// apply" bullet). Staged paths outside these are refused, never swept into the commit, and
// git stages and commits by path only. Returns { sha, paths }, sha null when nothing changed;
// `dryRun` runs the refusal alone.
export function commitTick(root, change, item, { tracks = 'tasks.md', git = gitIn(root), dryRun = false } = {}) {
  const dir = `openspec/changes/${change}`
  const candidates = [`${dir}/${tracks}`, `${dir}/plan.md`]
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
  const foreign = staged.filter((p) => !candidates.includes(p))
  if (foreign.length) throw new Error(`other paths are staged, so the tick is not committed: ${foreign.join(', ')}`)
  if (dryRun) return { sha: null, paths: [] }
  const paths = candidates.filter((p) => git('status', '--porcelain', '--', p) !== '')
  if (!paths.length) return { sha: null, paths: [] }
  git('add', '--', ...paths)
  git('commit', '-m', tickMessage(item, change), '--', ...paths)
  return { sha: git('rev-parse', 'HEAD'), paths }
}

export { lintTasks }
