// Ticks a coarse task of a change's tasks file when its dispatch returns. Only the script
// ticks: an agent that ticks by hand ticks the wrong line or forgets the last one.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir } from './changes.mjs'

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
