// The move of a project from the earlier layout to the current one (#26): the flow's directory
// `openspec/` (LEGACY_ROOT) becomes `adf/` (ROOT), and the planning guide, `planning.md`, which
// mixed the plugin's instructions with the project's values, becomes the settings
// (`settings.json`, lib/settings.mjs) and the prose guide (`guide.md`). This is the only module
// that parses the old guide's sections; live code reads the settings.
//
//   convertGuide(text)     the old guide's text to { settings, guide, notes }: each value section
//                          to its key, the prose sections and any section of the project's own
//                          to guide.md, and a note for each value it could not take; nothing of
//                          the project's text is dropped
//   reviewPromptPath(p)    the registry's review.prompt after the move: a path under the legacy
//                          root moves with the directory; any other path stays
//   legacyMentions(root)   the tracked files outside the flow's directory that still name the
//                          legacy directory, with their lines, for the developer to fix
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_ROOT, ROOT } from './layout.mjs'
import { DEFAULTS, settingsErrors } from './settings.mjs'

// The old guide's file name, under either root.
export const LEGACY_GUIDE = 'planning.md'
const GUIDE_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'host', 'guide.md')

// ---------------------------------------------------------------- the old guide's sections

// The value sections of the old guide, each with its key and how its body was read.
export const VALUE_SECTIONS = [
  ['## Packages', 'packages', 'tokens'],
  ['## How to run the checks', 'checks', 'lines'],
  ['## Whole-suite command', 'wholeSuiteCommand', 'line'],
  ['## Affected tests command', 'affectedTestsCommand', 'line'],
  ['## Failed-tests command', 'failedTestsCommand', 'line'],
  ['## Fresh-run proof', 'freshRunProof', 'line'],
  ['## Test-first shares', 'testFirstShares', 'shares'],
  ['## Worktree copies', 'worktreeCopies', 'tokens'],
  ['## Worktree preparation', 'worktreePreparation', 'recipe'],
  ['## Format command', 'formatCommand', 'line']
]
// The prose sections, which go to guide.md as they are.
export const PROSE_SECTIONS = ['## Where to look', '## Checks that need the developer']

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')
const inside = (path) => !isAbsolute(path) && !normalize(path).startsWith('..') && !path.includes('`')

// The text before the first `## ` heading, and each section: { heading, body } with the body's
// lines up to the next heading of level one or two.
export function sections(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = { preamble: [], sections: [] }
  let current = null
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      current = { heading: line.trim(), body: [] }
      out.sections.push(current)
    } else if (/^#\s/.test(line) && current) {
      current = null
      out.preamble.push(line)
    } else (current ? current.body : out.preamble).push(line)
  }
  return out
}

// One line: a fenced block, an inline code span or a plain line; null when empty; throws when it
// holds more than one line.
function oneLine(body) {
  const text = stripComments(body)
  const fence = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1\s*$/m.exec(text)
  const candidates = (fence ? fence[2] : text).split('\n').map((l) => l.trim()).filter(Boolean)
  if (candidates.length === 0) return null
  if (candidates.length > 1) throw new Error(`it holds ${candidates.length} lines, not one`)
  const inline = /^`([^`]+)`\.?$/.exec(candidates[0])
  return (inline ? inline[1] : candidates[0]).trim() || null
}

// Every line, a list marker and the fence lines left out (`## How to run the checks`).
const everyLine = (body) =>
  stripComments(body)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(```|~~~)/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''))

// One path per line, a list item, a code span or a plain line (`## Test-first shares`).
const shareLines = (body) =>
  stripComments(body)
    .split('\n')
    .map((l) => l.trim().replace(/^[-*]\s+/, '').replace(/^`([^`]+)`\.?$/, '$1').trim())
    .filter((l) => l && !/^(```|~~~)/.test(l))

// Every backticked token, a trailing slash or glob left out (`## Packages`, `## Worktree copies`).
const tokens = (body) => [...new Set([...stripComments(body).matchAll(/`([^`]+)`/g)].map((t) => t[1].trim().replace(/\/\*\*$|\/\*$|\/+$/, '')).filter(Boolean))]

// One step per list item: the first code span the command, the others its input paths.
function recipe(body) {
  const steps = []
  for (const line of stripComments(body).split('\n').filter((l) => /^\s*[-*]\s/.test(l))) {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
    if (spans.length === 0) continue
    const [command, ...inputs] = spans
    if (inputs.length === 0) throw new Error(`the step \`${command}\` names no input path`)
    steps.push({ command, inputs: inputs.map((p) => p.replace(/\/+$/, '')) })
  }
  return steps
}

const READERS = { line: oneLine, lines: everyLine, shares: shareLines, tokens, recipe }

// ---------------------------------------------------------------- the conversion

const bodyText = (lines) => lines.join('\n').replace(/^\n+|\n+$/g, '')

// The template of guide.md with the project's prose in its sections, and the project's own
// sections and anything the conversion could not take after them.
function guideText(prose, extra) {
  const template = sections(readFileSync(GUIDE_TEMPLATE, 'utf8'))
  const parts = [bodyText(template.preamble)]
  for (const section of template.sections) {
    const own = prose.get(section.heading)
    const comment = bodyText(section.body)
    parts.push(`${section.heading}\n\n${own ? stripComments(own).trim() || comment : comment}`)
  }
  for (const { heading, body } of extra) parts.push(`${heading}\n\n${body}`)
  return `${parts.filter(Boolean).join('\n\n')}\n`
}

export function convertGuide(text) {
  const parsed = sections(text)
  const settings = { ...DEFAULTS }
  const notes = []
  const prose = new Map()
  const extra = []
  const seen = new Set()
  for (const { heading, body } of parsed.sections) {
    const raw = body.join('\n')
    const value = VALUE_SECTIONS.find(([h]) => h === heading)
    if (value && !seen.has(heading)) {
      seen.add(heading)
      const [, key, how] = value
      try {
        let read = READERS[how](raw)
        if (['packages', 'testFirstShares', 'worktreeCopies'].includes(key)) {
          const outside = read.filter((p) => !inside(p))
          if (outside.length) {
            notes.push(`${heading}: ${outside.join(', ')} is not a path inside the project; left out of ${key} and kept in guide.md`)
            extra.push({ heading: `${heading} (not converted)`, body: outside.map((p) => `- \`${p}\``).join('\n') })
            read = read.filter(inside)
          }
        }
        if (key === 'worktreePreparation') {
          const outside = read.filter((s) => !s.inputs.every(inside))
          if (outside.length) {
            notes.push(`${heading}: a step names a path outside the project; left out of ${key} and kept in guide.md`)
            extra.push({ heading: `${heading} (not converted)`, body: outside.map((s) => `- \`${s.command}\` from ${s.inputs.map((p) => `\`${p}\``).join(', ')}`).join('\n') })
            read = read.filter((s) => s.inputs.every(inside))
          }
        }
        settings[key] = read
      } catch (error) {
        notes.push(`${heading}: ${error.message}; left out of ${key} and kept in guide.md`)
        extra.push({ heading: `${heading} (not converted)`, body: bodyText(stripComments(raw).split('\n')) })
      }
      continue
    }
    if (PROSE_SECTIONS.includes(heading) && !prose.has(heading)) prose.set(heading, raw)
    else {
      const kept = bodyText(stripComments(raw).split('\n'))
      if (kept || !value) extra.push({ heading, body: kept })
      if (value) notes.push(`${heading} appears twice; the first one is converted, the second is kept in guide.md`)
    }
  }
  // An old guide without the section has no test-first proof by the flow (null), one with it
  // a list; the template had the section, so a project that kept it keeps the proof.
  if (!seen.has('## Test-first shares')) settings.testFirstShares = null
  const errors = settingsErrors(settings)
  if (errors.length) throw new Error(`the converted settings fail their schema: ${errors.join('; ')}`)
  return { settings, guide: guideText(prose, extra), notes }
}

// ---------------------------------------------------------------- the review prompt and mentions

export function reviewPromptPath(path) {
  return typeof path === 'string' && path.startsWith(`${LEGACY_ROOT}/`) ? `${ROOT}/${path.slice(LEGACY_ROOT.length + 1)}` : path
}

// [{ file, lines: [n] }] for every tracked file outside ROOT/ that names `LEGACY_ROOT/`, read from
// the index of `root`.
export function legacyMentions(root) {
  let out
  try {
    out = execFileSync('git', ['grep', '--cached', '-n', '-I', '-F', '-e', `${LEGACY_ROOT}/`, '--', '.', `:!${ROOT}`, `:!${LEGACY_ROOT}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  const byFile = new Map()
  for (const line of out.split('\n').filter(Boolean)) {
    const m = /^(.*?):(\d+):/.exec(line)
    if (!m) continue
    if (!byFile.has(m[1])) byFile.set(m[1], [])
    byFile.get(m[1]).push(Number(m[2]))
  }
  return [...byFile].map(([file, lines]) => ({ file, lines }))
}
