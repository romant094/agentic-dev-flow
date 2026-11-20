// The host files /adf:update compares: for each, the old release's template (base), the new
// release's (theirs) and the project's copy (ours, read by the caller). `hostFiles` lists them
// from two clones of the repository at two tags, `classify` says what to do with each, and
// `mergeKeep` produces the text of a merge. The flow's own settings are no host file: the project
// keeps only values (lib/settings.mjs), and the instructions live in the plugin, so an update has
// nothing of them to merge (#23).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REVIEW_PROMPT } from './layout.mjs'

const PLUGIN_SUFFIX = '@agentic-dev-flow'

function read(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

// The files each release ships to the host, as { path, base, theirs }; a file missing in a clone
// reads as null. `ours` is left to the caller, which knows the host root.
export function hostFiles(oldClone, newClone, registry) {
  const entry = (path, from) => ({
    path,
    base: read(join(oldClone, from)),
    theirs: read(join(newClone, from)),
  })
  const files = [
    entry(registry?.review?.prompt ?? REVIEW_PROMPT, 'plugins/adf/host/review-prompt.md'),
  ]
  for (const extension of registry?.extensions ?? []) {
    const id = extension.plugin
    if (typeof id !== 'string' || !id.endsWith(PLUGIN_SUFFIX)) continue
    const name = id.slice(0, -PLUGIN_SUFFIX.length)
    const dir = `plugins/${name}`
    const declared = (clone) => {
      const text = read(join(clone, dir, 'adf-extension.json'))
      if (text === null) return []
      try {
        return JSON.parse(text).hostFiles ?? []
      } catch (error) {
        throw new Error(`${join(clone, dir, 'adf-extension.json')} is not valid JSON: ${error.message}`)
      }
    }
    const byTarget = new Map()
    for (const clone of [oldClone, newClone]) {
      for (const file of declared(clone)) byTarget.set(file.to, file.from)
    }
    for (const [to, from] of byTarget) {
      const fileIn = (clone) => {
        const own = declared(clone).find((file) => file.to === to)
        return own === undefined ? null : read(join(clone, dir, own.from))
      }
      files.push({ path: to, base: fileIn(oldClone), theirs: fileIn(newClone) })
    }
  }
  return files
}

// What to do with one host file:
//   absent   the new release no longer ships it
//   new      the host lacks it
//   same     the host already holds the new template
//   kept     the release did not change the template: nothing to do, whatever the project did
//   replace  the project did not touch the old template: take the new one
//   edited   both changed: merge
// A null base (the old release did not ship it) matches nothing.
export function classify({ base, ours, theirs }) {
  if (theirs === null) return 'absent'
  if (ours === null) return 'new'
  if (ours === theirs) return 'same'
  if (base !== null && base === theirs) return 'kept'
  if (base !== null && ours === base) return 'replace'
  return 'edited'
}

// A three-way merge of the project's copy with the new template over the old one. `git
// merge-file` exits with the number of conflicts; a negative status or another error throws.
export function mergeKeep(base, ours, theirs, run = execFileSync) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-merge-'))
  try {
    const write = (name, text) => {
      const file = join(dir, name)
      writeFileSync(file, text ?? '')
      return file
    }
    const files = [write('ours', ours), write('base', base), write('theirs', theirs)]
    try {
      return { text: run('git', ['merge-file', '-p', ...files], { encoding: 'utf8' }), conflicts: false }
    } catch (error) {
      // A conflict count is 1..127; an error is negative, which the process shows as 255.
      if (Number.isInteger(error.status) && error.status >= 1 && error.status <= 127) {
        return { text: error.stdout.toString(), conflicts: true }
      }
      throw new Error(`git merge-file failed: ${error.stderr?.toString().trim() || error.message}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
