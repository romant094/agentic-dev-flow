// The Markdown a person reads of any agent reply: the escalation of an implementer, the findings of
// a review or of the sweep, the c4 coherence and the c8 skill edits of verify. A script renders it
// from the JSON, so no agent writes prose for the developer and no orchestrator retells a reply.
//
// `render(reply, { name, result })`: the role comes from the reply's `role`, else from the dispatch
// name (the review stage's and archive's replies carry none), else from the shape (an array is a
// spec-merge reply). `result` is the computed result the valid event recorded (lib/attempts.mjs);
// with it the text shows what the script computed (the status, the finding ids, the verdict),
// without it only what the reply says. Deciding nothing: it renders.
//
// `c4Lines` and `c8Lines` give the lists the verify record renders under its labelled fields
// (lib/verify.mjs assemble), so the record and this text say the same.
import { parseName } from './dispatch.mjs'

export class RenderError extends Error {}

// A fence longer than any backtick run of the text.
export function fence(text, info = '') {
  const body = String(text ?? '').replace(/\n+$/, '')
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length))
  const mark = '`'.repeat(Math.max(3, longest + 1))
  return `${mark}${info}\n${body}\n${mark}`
}

const at = (file, line) => (Number.isInteger(line) ? `${file}:${line}` : file)
const list = (items) => (items.length === 0 ? ['none'] : items.map((i) => `- ${i}`))
const section = (heading, lines) => ['', `**${heading}:**`, '', ...lines]
const short = (sha) => String(sha ?? '').slice(0, 7)

// The role of a reply: its own field, the dispatch name's, or a spec-merge array.
export function roleOf(reply, name) {
  const parts = name === undefined ? null : parseName(name)
  if (name !== undefined && !parts) throw new RenderError(`"${name}" is not a dispatch name in the fixed form`)
  if (reply && !Array.isArray(reply) && typeof reply.role === 'string') return reply.role
  if (parts) return parts.role === 'verify' ? `verify-${parts.check}` : parts.role
  if (Array.isArray(reply)) return 'spec-merge'
  throw new RenderError('the reply names no role; pass the dispatch name')
}

// ---------------------------------------------------------------- apply

function implLines(reply, result) {
  const out = [`**Status:** ${result?.status ?? reply.outcome}`, '', reply.summary]
  if (reply.blocker) out.push(...section('Blocker', [reply.blocker]))
  const commits = result?.commits ?? reply.commits.map((sha) => ({ sha, subject: '' }))
  out.push(...section('Commits', list(commits.map((c) => `\`${short(c.sha)}\`${c.subject ? ` ${c.subject}` : ''}`))))
  if (result?.tests) {
    const t = result.tests
    const counts = t.counts ? `, ${t.counts.pass} passed, ${t.counts.fail} failed, ${t.counts.skipped} skipped of ${t.counts.total}` : ''
    out.push(...section('Covering tests', list(t.runs.map((r) => `${r.file}: \`${r.command}\`, exit ${r.exit ?? 'none'}${r.timedOut ? ', timed out' : ''}`))))
    out.push('', `**Test result:** ${t.result ?? 'no run'}${counts}`)
  } else out.push(...section('Covering tests', list((reply.testRuns ?? []).map((f) => f))))
  const concerns = result?.concerns ?? reply.concerns.map((c) => ({ ...c, source: 'agent' }))
  out.push(...section('Concerns', list(concerns.map((c) => `${c.file ? `${c.file}: ` : ''}${c.text}${c.source === 'script' ? ' (found by script)' : ''}`))))
  return out
}

const findingLine = (f) => `${f.id ? `**${f.id}** ` : ''}[${f.severity}, ${f.kind ? `${f.kind}/` : ''}${f.category}${f.planMandated ? ', plan-mandated' : ''}] ${at(f.file, f.line)}: ${f.title}`

function findingsLines(findings) {
  if (findings.length === 0) return ['none']
  return findings.flatMap((f) => [`- ${findingLine(f)}`, ...(f.body ? [`  ${f.body.replace(/\n/g, '\n  ')}`] : []), ...(f.suggestion ? [`  Suggestion: ${f.suggestion}`] : [])])
}

function reviewLines(reply, result) {
  const out = [reply.summary]
  if (result) out.push('', `**Spec:** ${result.spec}; **quality:** ${result.quality}; **next:** ${result.result}`)
  out.push(...section('Findings', findingsLines(result?.findings ?? reply.findings)))
  if (reply.unverifiable.length) out.push(...section('Unverifiable', list(reply.unverifiable.map((u) => `${u.requirement}: ${u.check}`))))
  return out
}

function reReviewLines(reply, result) {
  const out = [reply.summary]
  if (result) out.push('', `**Open:** ${result.open.length ? result.open.join(', ') : 'none'}; **next:** ${result.result}`)
  out.push(...section('Previous findings', list(reply.previous.map((p) => `${p.id}: ${p.status}${p.file ? ` (${at(p.file, p.line)})` : ''}`))))
  out.push(...section('New findings', findingsLines(result?.findings ?? reply.findings)))
  out.push(...section('Out of scope', list(reply.outOfScope.map((o) => `${at(o.file, o.line)}: ${o.title}`))))
  return out
}

function sweepLines(reply, result) {
  const out = []
  if (result) out.push(`**Verdict:** ${result.verdict}`)
  const findings = result?.findings ?? reply.findings
  out.push(...section('Duplicates', list(findings.map((f) => `${f.introduced} duplicates ${f.existing}: ${f.why}`))))
  if (result?.dropped?.length) out.push(...section('Accepted by a DUP marker', list(result.dropped.map((f) => `${f.introduced} (${f.marker})`))))
  if (reply.dispositions) out.push(...section('Code dispositions', list(reply.dispositions.map((d) => `${d.requirement}: ${d.disposition}`))))
  return out
}

const investigateLines = (reply) => [reply.answer, ...section('Evidence', list(reply.evidence.map((e) => at(e.file, e.line))))]

// ---------------------------------------------------------------- the review stage and archive

const aiReviewLines = (reply) => [reply.summary, ...section('Findings', findingsLines(reply.findings))]

function aiFixLines(reply) {
  const out = [`**${reply.finding}:** ${reply.outcome}${reply.sha ? ` in \`${short(reply.sha)}\`` : ''}`, '', `**Failure mode:** ${reply.failureMode}`]
  if (reply.argument) out.push('', `**Argument:** ${reply.argument}`)
  return out
}

const specMergeLines = (reply) =>
  reply.flatMap((r) => ['', `**${r.capability}: ${r.requirement}**`, '', r.reason, '', r.text ? fence(r.text, 'markdown') : '(empty: the removal is kept)'])

function ingestLines(reply) {
  if (reply.nothingLearned) return ['Nothing learned.', ...section('Stale pages', list(reply.stale.map((s) => `${s.path}: ${s.outcome}${s.argument ? `, ${s.argument}` : ''}`)))]
  const out = [...section('Pages', list(reply.pages.map((p) => `${p.path}: ${p.why}`)))]
  out.push(...section('Stale pages', list(reply.stale.map((s) => `${s.path}: ${s.outcome}${s.argument ? `, ${s.argument}` : ''}`))))
  out.push('', `**Invariant:** ${reply.invariant}`, '', `**Likely mistake:** ${reply.likelyMistake}`)
  if (reply.log) out.push(...section(`Log: ${reply.log.title}`, list(reply.log.bullets)))
  return out
}

// ---------------------------------------------------------------- verify

// The lists the c4 section renders: { findings, proseEdits, removalAccounting, exercised }.
// `result.proseEdits` (the script's) carries each edit's position against `## Requirements`.
export function c4Lines(reply, result) {
  const positions = new Map((result?.proseEdits ?? []).map((p) => [`${p.capability} ${short(p.commit)}`, p.position]))
  const where = (f) => f.where.map((w) => at(w.file, w.line)).join(' and ')
  return {
    findings: reply.findings.map((f) => `${f.kind} at ${where(f)}: ${f.text}`),
    proseEdits: reply.proseEdits.map((p) => {
      const position = positions.get(`${p.capability} ${short(p.commit)}`)
      return `${p.capability} in \`${short(p.commit)}\`${position ? ` (${position === 'below' ? 'at or below' : 'above'} \`## Requirements\`)` : ''}: ${p.reason ?? 'no reason stated'}`
    }),
    removalAccounting: reply.removalAccounting.map(
      (r) => `${r.op} ${r.requirement}: ${r.disposition ?? 'no Code Disposition'}; ${r.holds ? 'the code holds it' : 'the code contradicts it'}; the old path is ${r.oldPathReachable ? 'still reachable' : 'unreachable'}`
    ),
    exercised: reply.exercised.map((e) => `${e.mechanism}, ${e.path}: ${e.exercisedBy === null ? 'not exercised (warning)' : `exercised by ${e.exercisedBy}`}`)
  }
}

// The c8 candidates by class, and the joined patch of the CONFIRMED ones (null when none).
export function c8Lines(reply) {
  const of = (cls) => reply.candidates.filter((c) => c.class === cls).map((c) => `${at(c.file, c.line)}: ${c.fact} (${c.why})`)
  const patches = reply.candidates.filter((c) => c.class === 'CONFIRMED').map((c) => (c.patch.endsWith('\n') ? c.patch : `${c.patch}\n`))
  return { confirmed: of('CONFIRMED'), plausible: of('PLAUSIBLE'), none: of('none'), patch: patches.length ? patches.join('') : null }
}

const verdictLine = (result) => (result ? [`**Verdict:** ${result.verdict}: ${result.summary}`, ''] : [])

function c4Render(reply, result) {
  const l = c4Lines(reply, result)
  return [
    ...verdictLine(result),
    `**Case:** ${reply.case}`,
    '',
    reply.summary,
    ...section('Findings', list(l.findings)),
    ...section('Hand-edited capability prose', list(l.proseEdits)),
    ...section('Removal accounting', l.removalAccounting.length ? list(l.removalAccounting) : ['N/A: no REMOVED or RENAMED requirement']),
    ...section('Exercised and not exercised', list(l.exercised))
  ]
}

function c8Render(reply, result) {
  const l = c8Lines(reply)
  const confirmed = reply.candidates.filter((c) => c.class === 'CONFIRMED')
  const out = [...verdictLine(result), reply.summary, ...section('CONFIRMED', confirmed.length ? [] : ['none'])]
  for (const c of confirmed) out.push(`- ${at(c.file, c.line)}: ${c.fact} (${c.why})`, '', fence(c.patch, 'diff'), '')
  if (confirmed.length) out.pop()
  out.push(...section('PLAUSIBLE', list(l.plausible)), ...section('None', list(l.none)))
  return out
}

// ---------------------------------------------------------------- the table

const RENDERERS = {
  impl: implLines,
  fix: implLines,
  review: reviewLines,
  'final-review': reviewLines,
  'merge-review': reviewLines,
  're-review': reReviewLines,
  sweep: sweepLines,
  investigate: investigateLines,
  'ai-review': aiReviewLines,
  'ai-fix': aiFixLines,
  'spec-merge': specMergeLines,
  ingest: ingestLines,
  'verify-c4': c4Render,
  'verify-c8': c8Render
}
export const RENDERED_ROLES = Object.keys(RENDERERS)

// The Markdown of one parsed reply, headed by its dispatch name (or its role).
export function render(reply, { name, result } = {}) {
  const role = roleOf(reply, name)
  if (!Object.hasOwn(RENDERERS, role)) throw new RenderError(`no renderer for the role ${role}; known: ${RENDERED_ROLES.join(', ')}`)
  const lines = RENDERERS[role](reply, result ?? undefined)
  while (lines[0] === '') lines.shift()
  return [`## ${name ?? role}`, '', ...lines, ''].join('\n')
}
