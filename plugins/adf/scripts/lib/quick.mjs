// The quick task's candidates: the large-item filter, and the estimate, which is one read-only
// `quick-estimate` agent over every candidate that is left. Both run in the main checkout before
// the change's worktree exists. The scope is the one `scope.mjs gather` wrote (lib/scope.mjs);
// the estimate's verdicts for the tracker issues go through scope.mjs `answer`, so `scope.mjs
// start` reads them as it reads a checked item's.
//
// State: <main>/.superpowers/sdd/<change>/quick/ (gitignored): estimate-input.md, the prompt
// with its candidates and the reply schema; replies/estimate.json, the agent's reply; and
// estimate.json, the reply once it passed the check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchFields, QUICK_ROLES, sddDir, withPreamble } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { answer, readScope, Refusal, renderSkeleton, select, writeScope } from './scope.mjs'

export { Refusal }

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ESTIMATE_SCHEMA = join(PLUGIN_ROOT, 'schema', QUICK_ROLES['quick-estimate'].schema)
const PROMPT = join(PLUGIN_ROOT, 'schema', 'prompts', 'quick-estimate.md')
export const MAX_FILES = 3
export const ESTIMATE_NAME = 'quick-estimate'
const CHANGE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

export const quickDir = (main, change) => join(sddDir(main, change), 'quick')

function load(root, change) {
  if (!CHANGE.test(change ?? '')) refuse(`"${change ?? ''}" is not a kebab-case change name`)
  const main = mainCheckout(root)
  const scope = readScope(main, change)
  if (!scope) refuse(`${change} has no scope yet; run scope.mjs gather --change ${change} first`)
  return { main, scope }
}

// The distinct files of a debt entry's anchors, each `path:line` or a bare path.
const anchorFiles = (item) => new Set((item.anchors ?? []).map((a) => a.split(':')[0].trim()).filter(Boolean))

// Why a candidate is too large for a quick task, or null: a tracker epic or story; a debt entry
// that is not a defect; a debt entry anchored in more than MAX_FILES files.
function largeReason(item) {
  if (item.source === 'tracker') return item.kind === 'epic' || item.kind === 'story' ? `kind ${item.kind}` : null
  if (item.class !== 'defect') return `class ${item.class}`
  const files = anchorFiles(item).size
  return files > MAX_FILES ? `${files} files` : null
}

// The scope's items that are too large, in scope order: [{ key, reason }]. An excluded item is
// no candidate.
export const largeItems = (scope) => scope.items.filter((i) => i.state !== 'excluded').flatMap((i) => {
  const reason = largeReason(i)
  return reason === null ? [] : [{ key: i.key, reason }]
})

const candidatesOf = (scope) => scope.items.filter((i) => i.state !== 'excluded')

// Excludes each large candidate as `scope.mjs select --exclude` does. A key the developer named
// is never excluded: its item gets a flag line instead, once.
export function filter(root, change) {
  const { main, scope } = load(root, change)
  const named = new Set(scope.from?.keys ?? [])
  const excluded = []
  const flagged = []
  for (const large of largeItems(scope)) {
    if (!named.has(large.key)) {
      excluded.push(large)
      continue
    }
    const item = scope.items.find((i) => i.key === large.key)
    const flag = `${large.key} looks too large for a quick task (${large.reason})`
    if (!item.flags.includes(flag)) item.flags.push(flag)
    flagged.push({ key: large.key, flag })
  }
  if (flagged.length) writeScope(main, change, scope)
  if (excluded.length) select(root, change, { exclude: excluded.map(({ key, reason }) => ({ key, reason: `too large for a quick task (${reason})` })) })
  const left = candidatesOf(readScope(main, change)).map((i) => i.key)
  return { ok: true, change, step: 'filter', excluded, flagged, candidates: left, next: left.length ? `estimate-input: quick.mjs estimate-input --change ${change}` : 'no candidate is left for a quick task; take the rest to /adf:propose' }
}

// The estimate's input and prompt in one file: the prompt, each candidate with its file, and the
// reply schema. { ok, file, name, ... } with the dispatch fields.
export function estimateInput(root, change, { runtime = 'claude-code' } = {}) {
  const { main, scope } = load(root, change)
  const candidates = candidatesOf(scope)
  if (candidates.length === 0) refuse('no candidate is left to estimate')
  const dir = quickDir(main, change)
  mkdirSync(join(dir, 'replies'), { recursive: true })
  const file = join(dir, 'estimate-input.md')
  const replyFile = join(dir, 'replies', 'estimate.json')
  const level = QUICK_ROLES['quick-estimate'].level
  const agent = dispatchFields(level, runtime)
  const prompt = renderSkeleton(PROMPT, { name: ESTIMATE_NAME, level, change, inputFile: file, replyFile, schema: ESTIMATE_SCHEMA })
  const abs = (rel) => join(main, rel)
  const lines = candidates.map((i) => {
    const where = i.source === 'tracker' ? `file ${i.file ? abs(i.file) : 'none'}` : `files ${(i.files ?? []).map(abs).join(', ') || 'none'}; anchors ${(i.anchors ?? []).join(', ')}`
    return `- \`${i.key}\` (${i.source}, ${i.kind}${i.class ? `, ${i.class}` : ''}): ${i.title}; ${where}${i.flags?.length ? `; flags: ${i.flags.join(' | ')}` : ''}`
  })
  const text = `${prompt.trimEnd()}\n\n## Candidates\n\n${lines.join('\n')}\n\n## Reply schema\n\n\`\`\`json\n${readFileSync(ESTIMATE_SCHEMA, 'utf8').trimEnd()}\n\`\`\`\n`
  writeFileSync(file, withPreamble(text, agent.preamble))
  return { ok: true, change, step: 'estimate-input', file, name: ESTIMATE_NAME, ...agent.fields, worktree: main, replyFile, candidates: candidates.map((i) => i.key), next: `dispatch ${ESTIMATE_NAME} read-only with ${file}; then quick.mjs estimate-check --change ${change} --file ${replyFile}` }
}

// The rules the schema cannot state, for a reply that passed it. Returns the errors.
function checkEstimate(reply, candidates) {
  const errors = []
  const byKey = new Map(candidates.map((i) => [i.key, i]))
  const seen = new Set()
  reply.items.forEach((r, n) => {
    if (!byKey.has(r.key)) errors.push(`items[${n}] names ${r.key}, which is not a candidate; the candidates: ${[...byKey.keys()].join(', ')}`)
    else if (seen.has(r.key)) errors.push(`${r.key} is estimated twice`)
    seen.add(r.key)
  })
  for (const key of byKey.keys()) if (!seen.has(key)) errors.push(`candidate ${key} is not estimated`)
  for (const r of reply.items) {
    const item = byKey.get(r.key)
    if (!item) continue
    if (r.verdict === 'corrected' && (r.corrections ?? []).length === 0) errors.push(`${r.key} has the verdict corrected and lists no correction`)
    if (item.source === 'tracker' && r.fit === 'quick' && r.behaviourChange !== true && r.verdict === undefined) errors.push(`${r.key} is a tracker issue marked quick and has no verdict`)
  }
  return errors
}

export function estimateCheck(root, change, { file }) {
  const { main, scope } = load(root, change)
  const fail = (errors) => ({ ok: false, valid: false, change, errors, next: 'retry: send the errors to the same agent once; a second refusal stops, and the candidates go to /adf:propose' })
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return fail([`no reply file at ${file}`])
  }
  const parsed = parseReply(text)
  const errors = [...parsed.errors]
  if (parsed.reply !== null) {
    const schemaErrors = validateJson(readSchema(ESTIMATE_SCHEMA), parsed.reply)
    errors.push(...schemaErrors)
    if (schemaErrors.length === 0) errors.push(...checkEstimate(parsed.reply, candidatesOf(scope)))
  }
  if (errors.length) return fail(errors)
  // A behaviour change is a proposal, whatever the agent marked.
  const items = parsed.reply.items.map((r) => (r.behaviourChange ? { ...r, fit: 'propose' } : r))
  for (const r of items) {
    const item = scope.items.find((i) => i.key === r.key)
    if (item.source !== 'tracker' || r.verdict === undefined) continue
    // The check `answer` and `start` read: no question, the corrections as the verdict gave them.
    item.check = { verdict: r.verdict, requirements: [], bug: null, corrections: (r.corrections ?? []).map((c) => ({ what: c, was: '', now: c })), questions: [], checked: [], reply: `.superpowers/sdd/${change}/quick/estimate.json` }
    item.verdict = null
  }
  writeScope(main, change, scope)
  for (const r of items) {
    const item = scope.items.find((i) => i.key === r.key)
    if (item.source === 'tracker' && r.verdict !== undefined) answer(root, change, { key: r.key, verdict: r.verdict, reason: r.verdict === 'obsolete' ? r.reason : null })
  }
  mkdirSync(quickDir(main, change), { recursive: true })
  writeFileSync(join(quickDir(main, change), 'estimate.json'), `${JSON.stringify({ items }, null, 2)}\n`)
  return { ok: true, valid: true, change, step: 'estimate-check', items, next: items.some((r) => r.fit === 'quick') ? 'show the estimate to the developer; take the quick items with scope.mjs select' : 'no candidate fits a quick task; take them to /adf:propose' }
}
