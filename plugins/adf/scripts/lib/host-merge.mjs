// The host files /adf:update compares: for each, the old release's template (base), the new
// release's (theirs) and the project's copy (ours, read by the caller). `hostFiles` lists them
// from two clones of the repository at two tags, `classify` says what to do with each, and
// `replaceFromUpdate` and `mergeKeep` produce the text.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLANNING_GUIDE, REVIEW_PROMPT } from './host-files.mjs'

// The sections of openspec/planning.md the project fills in; an update never overwrites them.
export const MANAGED = ['## Whole-suite command', '## Worktree copies', '## Worktree preparation', '## Format command', '## Affected tests command']

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
    entry(PLANNING_GUIDE, 'plugins/adf/host/planning.md'),
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
// A null base (the old release did not ship it) matches nothing. For openspec/planning.md (with
// `path` given) the MANAGED sections are values, not edits: all three are compared without them.
export function classify({ base, ours, theirs, path }) {
  if (theirs === null) return 'absent'
  if (ours === null) return 'new'
  if (path === PLANNING_GUIDE) [base, ours, theirs] = [base, ours, theirs].map((text) => (text === null ? null : unmanaged(text)))
  if (ours === theirs) return 'same'
  if (base !== null && base === theirs) return 'kept'
  if (base !== null && ours === base) return 'replace'
  return 'edited'
}

// `## ` sections: a heading line through the line before the next one; text before the first
// heading is the preamble.
function sections(text) {
  const parts = []
  let current = { heading: null, lines: [] }
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (current.heading !== null || current.lines.length > 0) parts.push(current)
      current = { heading: line, lines: [] }
    }
    current.lines.push(line)
  }
  parts.push(current)
  return parts
}

const sectionText = (section) => section.lines.join('\n')
const named = (section, heading) => section.heading !== null && section.heading.trimEnd() === heading

function unmanaged(text) {
  return sections(text)
    .filter((section) => !MANAGED.some((heading) => named(section, heading)))
    .map(sectionText)
    .join('\n')
}

// The new template, with the project's own MANAGED sections of openspec/planning.md carried over.
export function replaceFromUpdate(path, ours, theirs) {
  if (path !== PLANNING_GUIDE) return theirs
  const mine = sections(ours)
  const result = sections(theirs)
  const appended = []
  for (const heading of MANAGED) {
    const own = mine.find((section) => named(section, heading))
    if (own === undefined) continue
    const target = result.find((section) => named(section, heading))
    if (target === undefined) appended.push(own)
    else target.lines = own.lines
  }
  let text = result.map(sectionText).join('\n')
  for (const section of appended) {
    text = `${text.replace(/\n*$/, '')}\n\n${sectionText(section)}`
  }
  return text
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

// *Keep everything* for one file: mergeKeep, except that openspec/planning.md's MANAGED
// sections are the project's values. The merge runs with ours' MANAGED sections set to the old
// template's, so a template change there merges cleanly, and ours' are put back afterwards.
export function keepFromUpdate(path, base, ours, theirs) {
  if (path !== PLANNING_GUIDE || base === null) return mergeKeep(base, ours, theirs)
  const merged = mergeKeep(base, replaceFromUpdate(path, base, ours), theirs)
  return { text: replaceFromUpdate(path, ours, merged.text), conflicts: merged.conflicts }
}
