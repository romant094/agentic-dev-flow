// The description of the issue that mirrors a group of debt entries: rendered by script from a
// template, never written by an agent. The default template ships in the plugin
// (templates/debt.md); the registry config's `debtTemplate` names a host file that replaces it.
//
// Template format: the one section `<!-- description -->`, in the format of the hand-off
// template (lib/comment.mjs); text above the marker is a preface and is not rendered. Inside it
// one block, `{{#entries}}` to `{{/entries}}` on lines of their own, repeats once per entry
// with {{id}}, {{title}}, {{anchors}}, {{class}} and {{block}}; {{root}}, the debt tree's
// directory, may stand anywhere.
//
// The shape of a rendered description (debtShape) is what lets sync-debt rewrite only a
// description it built: a regular expression over the description's non-blank lines
// (lib/apply.mjs bodyLines), the head and the tail literal, the entries block repeated once or
// more with any value in each placeholder.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeWiki, parseTemplate } from './comment.mjs'

export const DEFAULT_DEBT_TEMPLATE = join('templates', 'debt.md')
export const ENTRY_VALUES = ['id', 'title', 'anchors', 'class', 'block']
const SHAPE = { states: ['description'], lists: ['entries'], scalars: [...ENTRY_VALUES, 'root'] }
const TOKEN = /\{\{\s*([#/]?)([a-z]+)\s*\}\}/g
const OPEN = /^\s*\{\{#entries\}\}\s*$/
const CLOSE = /^\s*\{\{\/entries\}\}\s*$/

// { head, entry, tail }: the lines before the entries block, inside it, and after it.
export function parseDebtTemplate(text, source) {
  const lines = parseTemplate(text, source, SHAPE).description
  const opens = lines.filter((l) => OPEN.test(l)).length
  if (opens !== 1) throw new Error(`${source}: ${opens === 0 ? 'no {{#entries}} block; the description lists the entries of the group' : 'a second {{#entries}} block'}`)
  const open = lines.findIndex((l) => OPEN.test(l))
  const close = lines.findIndex((l) => CLOSE.test(l))
  const head = lines.slice(0, open)
  const entry = lines.slice(open + 1, close)
  const tail = lines.slice(close + 1)
  for (const line of [...head, ...tail]) {
    for (const [, , name] of line.matchAll(TOKEN)) {
      if (name !== 'root') throw new Error(`${source}: {{${name}}} stands outside the entries block; only {{root}} may`)
    }
  }
  for (const line of entry) {
    if ([...line.matchAll(TOKEN)].some(([, kind]) => kind !== '')) throw new Error(`${source}: a block inside the entries block`)
  }
  if (!entry.some((l) => l.trim() !== '')) throw new Error(`${source}: the entries block is empty`)
  return { head, entry, tail }
}

// The template in force: the host's file named by config.debtTemplate, else the plugin's.
export function loadDebtTemplate({ root, pluginRoot, debtTemplate }) {
  const path = debtTemplate ? join(root, debtTemplate) : join(pluginRoot, DEFAULT_DEBT_TEMPLATE)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read the debt template ${debtTemplate ?? DEFAULT_DEBT_TEMPLATE}`)
  }
  return parseDebtTemplate(text, debtTemplate ?? DEFAULT_DEBT_TEMPLATE)
}

const valuesOf = (e) => ({ id: e.id, title: e.title, anchors: e.anchors.join(', '), class: e.class, block: e.block })
const fill = (line, values) => line.replace(TOKEN, (_, __, name) => escapeWiki(values[name]))

// entries: [{ id, title, anchors, class, block }], in tree order; root: the tree's directory.
export function renderDebtDescription(template, { root, entries }) {
  const out = [
    ...template.head.map((l) => fill(l, { root })),
    ...entries.flatMap((e) => template.entry.map((l) => fill(l, { root, ...valuesOf(e) }))),
    ...template.tail.map((l) => fill(l, { root }))
  ]
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One trimmed, non-blank template line as a pattern: {{root}} literal, any other placeholder
// any text on the line.
function linePattern(line, root) {
  let out = ''
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    out += escapeRe(line.slice(last, m.index))
    out += m[2] === 'root' ? escapeRe(escapeWiki(root)) : '[^\\n]*'
    last = m.index + m[0].length
  }
  return `${out}${escapeRe(line.slice(last))}\\n`
}

const patterns = (lines, root) => lines.map((l) => l.trim()).filter(Boolean).map((l) => linePattern(l, root)).join('')

// The shape every description this template renders has, for any non-empty list of entries.
export function debtShape(template, { root }) {
  return `^${patterns(template.head, root)}(?:${patterns(template.entry, root)})+${patterns(template.tail, root)}$`
}
