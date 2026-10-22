// The hand-off comment: the core sends fields, never text with markup; this module renders them
// into Jira wiki markup through a template, so every hand-off comment has the same shape. The
// default template ships in the plugin (templates/handoff.md); the registry config's
// `commentTemplate` names a host file that replaces it.
//
// Template format: a section per item state, each opened by a marker line `<!-- <state> -->`;
// text before the first marker is a preface and is not rendered. Inside a section:
//   {{name}}            a value. A line holding a list value repeats once per item; a line
//                       holding an empty value is dropped.
//   {{#name}} {{/name}} on lines of their own: the lines between are kept only when the value
//                       is not empty.
// The values are done, test, remains, tried (lists of short sentences, the agent's), commit
// (a commit hash) and mr (the merge request URL, the forge's; null with no forge).
//
// The correction comment of `start` (decision D7) has the same format with one section,
// `<!-- corrected -->`, and two lists: corrections (one line per correction the issue check
// made) and answers (one line per question the developer answered). The default is
// templates/corrections.md; the registry config's `correctionTemplate` replaces it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATES = ['taken', 'partial', 'not-reproduced']
export const LISTS = ['done', 'test', 'remains', 'tried']
export const SCALARS = ['commit', 'mr']
export const DEFAULT_TEMPLATE = join('templates', 'handoff.md')
export const DEFAULT_CORRECTION_TEMPLATE = join('templates', 'corrections.md')

// What a template may hold: its sections, its lists and its scalars.
const HANDOFF = { states: STATES, lists: LISTS, scalars: SCALARS }
const CORRECTION = { states: ['corrected'], lists: ['corrections', 'answers'], scalars: [] }

// The fields each state takes, required first. The required ones are the core's (contract 1.7,
// `tracker`): the core decides which fields a state needs, and every text field arrives as a
// list of one-line texts.
export const FIELDS = {
  taken: { required: ['done', 'test'], optional: ['commit'] },
  partial: { required: ['done', 'test', 'remains'], optional: ['commit'] },
  'not-reproduced': { required: ['tried', 'commit'], optional: ['test'] }
}

const MARKER = /^<!--\s*([a-z-]+)\s*-->\s*$/
const TOKEN = /\{\{\s*([#/]?)([a-z]+)\s*\}\}/g
const BLOCK_OPEN = /^\s*\{\{#([a-z]+)\}\}\s*$/
const BLOCK_CLOSE = /^\s*\{\{\/([a-z]+)\}\}\s*$/
const LINK = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S/i
const COMMIT = /^[0-9a-f]{7,40}$/

export function parseTemplate(text, source, shape = HANDOFF) {
  const { states } = shape
  const sections = {}
  let current = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = MARKER.exec(line)
    if (marker) {
      const state = marker[1]
      if (!states.includes(state)) throw new Error(`${source}: unknown section "${state}"; the sections are ${states.join(', ')}`)
      if (sections[state]) throw new Error(`${source}: section "${state}" appears twice`)
      sections[state] = []
      current = state
      continue
    }
    if (current) sections[current].push(line)
  }
  for (const state of states) {
    if (!sections[state]) throw new Error(`${source}: no section "${state}"; every template has ${states.join(', ')}`)
    checkSection(sections[state], `${source} (${state})`, shape)
  }
  return sections
}

function checkSection(lines, where, { lists, scalars }) {
  const open = []
  for (const line of lines) {
    const tokens = [...line.matchAll(TOKEN)]
    for (const [, kind, name] of tokens) {
      if (![...lists, ...scalars].includes(name)) throw new Error(`${where}: unknown placeholder {{${kind}${name}}}`)
    }
    const opened = BLOCK_OPEN.exec(line)
    const closed = BLOCK_CLOSE.exec(line)
    if (opened) open.push(opened[1])
    else if (closed) {
      if (open.pop() !== closed[1]) throw new Error(`${where}: {{/${closed[1]}}} closes no open block`)
    } else {
      if (tokens.some(([, kind]) => kind !== '')) throw new Error(`${where}: a block marker must stand on a line of its own`)
      if (tokens.filter(([, , name]) => lists.includes(name)).length > 1) throw new Error(`${where}: a line holds more than one list`)
    }
  }
  if (open.length > 0) throw new Error(`${where}: {{#${open.at(-1)}}} is never closed`)
}

// The template in force: the host's file named by config.commentTemplate, else the plugin's.
export function loadTemplate({ root, pluginRoot, commentTemplate }) {
  return readTemplate(root, pluginRoot, commentTemplate, DEFAULT_TEMPLATE, HANDOFF)
}

// The correction template in force: config.correctionTemplate, else the plugin's.
export function loadCorrectionTemplate({ root, pluginRoot, correctionTemplate }) {
  return readTemplate(root, pluginRoot, correctionTemplate, DEFAULT_CORRECTION_TEMPLATE, CORRECTION)
}

function readTemplate(root, pluginRoot, configured, fallback, shape) {
  const path = configured ? join(root, configured) : join(pluginRoot, fallback)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read the comment template ${configured ?? fallback}`)
  }
  return parseTemplate(text, configured ?? fallback, shape)
}

const present = (value) => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '')

// Agent text goes into wiki markup as text: brackets and braces would open a link or a macro.
export function escapeWiki(text) {
  return String(text).replace(/[[\]{}]/g, (c) => `\\${c}`)
}

export function renderSection(lines, values, lists = LISTS) {
  const out = []
  const keep = []
  for (const line of lines) {
    const opened = BLOCK_OPEN.exec(line)
    if (opened) {
      keep.push(present(values[opened[1]]))
      continue
    }
    if (BLOCK_CLOSE.test(line)) {
      keep.pop()
      continue
    }
    if (keep.includes(false)) continue
    const names = [...line.matchAll(TOKEN)].map(([, , name]) => name)
    if (names.some((n) => !present(values[n]))) continue
    const list = names.find((n) => lists.includes(n))
    const fill = (item) => line.replace(TOKEN, (_, __, name) => (name === list ? escapeWiki(item) : name === 'mr' ? values.mr : escapeWiki(values[name])))
    if (list) for (const item of values[list]) out.push(fill(item))
    else out.push(fill(null))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function renderComment(template, state, fields, mr) {
  const values = { done: [], test: [], remains: [], tried: [], commit: null, ...fields, mr: mr?.url ?? null }
  return renderSection(template[state], values)
}

// The correction comment of a start item: one line per correction (`what: now (was was)`) and
// one per answered question (`question — answer`), whitespace folded so each stays one list line.
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

export function renderCorrection(template, corrections = [], answers = []) {
  const values = {
    corrections: corrections.map(({ what, was, now }) => `${oneLine(what)}: ${oneLine(now)}${oneLine(was) ? ` (was ${oneLine(was)})` : ''}`),
    answers: answers.map(({ question, answer }) => `${oneLine(question)} — ${oneLine(answer)}`)
  }
  return renderSection(template.corrected, values, CORRECTION.lists)
}

// The fields of one hand-off item, checked before anything is read or sent: the state's
// required fields present, no unknown field, every list a list of one-line texts, no link in
// any agent text, a commit a hash.
export function checkFields(key, state, fields) {
  const errors = []
  const spec = FIELDS[state]
  if (!spec) return [`${key}: state "${state}" is not one of ${STATES.join(', ')}`]
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return [`${key}: fields is not an object`]
  for (const name of Object.keys(fields)) {
    if (![...spec.required, ...spec.optional].includes(name)) errors.push(`${key}: ${state} takes no field ${name}`)
  }
  for (const name of spec.required) if (!present(fields[name])) errors.push(`${key}: ${state} needs ${name}`)
  for (const name of LISTS) {
    if (fields[name] === undefined) continue
    const list = fields[name]
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && t.trim() !== '' && !t.includes('\n'))) {
      errors.push(`${key}: ${name} is not a list of one-line texts`)
      continue
    }
    if (list.some((t) => LINK.test(t))) errors.push(`${key}: ${name} holds a link; agent text carries no link`)
  }
  if (fields.commit !== undefined && !(typeof fields.commit === 'string' && COMMIT.test(fields.commit))) {
    errors.push(`${key}: commit is not a commit hash`)
  }
  return errors
}

export function checkMr(mr) {
  if (mr === null) return []
  if (mr === undefined) return ['mr is missing; it is { url } or null']
  if (typeof mr !== 'object' || Array.isArray(mr) || !/^https?:\/\/\S+$/.test(String(mr.url ?? ''))) return ['mr is not { url } with an http or https URL, or null']
  return []
}
