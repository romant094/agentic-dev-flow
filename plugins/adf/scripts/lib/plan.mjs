// One model of a change's plan.md, and the checks and computations a machine can do over it.
//
// The plan instruction asks an agent to keep plan.md anchored to tasks.md, to give every task
// the same fields, to reconcile every design risk, to sweep a deleted file's references and to
// build the Execution Graph from the tasks' file sets. Each of those is a rule a script states
// the same way every time; this module does them, and leaves to the agent what needs judgement:
// the content of a task, the partition into groups, raising a coupling floor, the criticality of
// a medium pair, and the reason text.
//
// Everything here is pure over text, except the functions that take an injected `grep` or `git`.
import { pathMatcher, plannedPaths } from './verify.mjs'
import { EXTENSIONS, parsePlanTasks } from './plan-symbols.mjs'

export const LEVELS = ['mechanical', 'integration', 'architecture']
export const COUPLINGS = ['none', 'weak', 'medium', 'strong']
export const WEAK_OR_MEDIUM = 'weak-or-medium'
export const DEFAULT_CAP = 3

const rank = (coupling) => (coupling === WEAK_OR_MEDIUM ? 1 : COUPLINGS.indexOf(coupling))
const PATH_EXT = new RegExp(`\\.(?:${EXTENSIONS})$`)
export const isPathLike = (t) => /^[^\s()`]+$/.test(t) && (t.includes('/') || PATH_EXT.test(t))
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')

// ---------------------------------------------------------------- tasks.md

const ITEM_LINE = /^[-*]\s+\[([ xX])\]\s+(\d+)\.(\d+)(?=\s|$)\s*(.*)$/

// The checkbox items of a tasks file, in order: { id, group, done, line, text }. `line` is 1-based.
export function parseTaskItems(text) {
  const items = []
  text.split('\n').forEach((raw, i) => {
    const m = ITEM_LINE.exec(raw)
    if (m) items.push({ id: `${m[2]}.${m[3]}`, group: Number(m[2]), done: m[1] !== ' ', line: i + 1, text: m[4] })
  })
  return items
}

const COMMAND = /^(?:npm|npx|node|yarn|pnpm|git|cd|bash|sh|make|jest|vitest|pytest|go|cargo|docker|curl|python3?)\s/

// The grammar the apply phase parses, and the two kinds of "how" that belong in plan.md.
// Findings: { severity, kind, line, message }; an error makes the file unusable to apply.
export function lintTasks(text) {
  const findings = []
  const say = (severity, kind, line, message) => findings.push({ severity, kind, line, message })
  let group = null
  const seen = new Map()
  let inComment = false
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    // An HTML comment (the template's guidance) is not content.
    const wasComment = inComment
    if (raw.includes('<!--')) inComment = !raw.includes('-->', raw.lastIndexOf('<!--'))
    else if (inComment && raw.includes('-->')) inComment = false
    const visible = stripComments(raw)
    if (wasComment && !raw.includes('-->')) return
    if (!visible.trim()) return

    const heading = /^##\s+(.*)$/.exec(visible)
    if (heading) {
      const n = /^(\d+)\.\s+\S/.exec(heading[1])
      if (n) group = Number(n[1])
      else say('error', 'group-heading', line, `"## ${heading[1].trim()}" is not a numbered group heading such as "## 1. Name"`)
      return
    }
    if (/^\s*[-*]\s+\[/.test(visible)) {
      const m = ITEM_LINE.exec(visible)
      if (!m || !m[4].trim()) {
        say('error', 'checkbox-grammar', line, `"${visible.trim()}" is not "- [ ] X.Y description" at the start of the line`)
        return
      }
      const id = `${m[2]}.${m[3]}`
      if (group === null) say('error', 'no-group', line, `${id} stands under no numbered "##" group`)
      else if (Number(m[2]) !== group) say('error', 'group-mismatch', line, `${id} stands under group ${group}`)
      if (seen.has(id)) say('error', 'duplicate', line, `${id} is already item of line ${seen.get(id)}`)
      else seen.set(id, line)
    } else if (/^[-*]\s+\d+\.\d+\s/.test(visible)) {
      say('error', 'untracked-item', line, `"${visible.trim()}" has no checkbox, so apply does not track it`)
      return
    }
    for (const [, token] of visible.matchAll(/`([^`]+)`/g)) {
      if (COMMAND.test(token)) say('warning', 'command', line, `\`${token}\` looks like a command; test commands belong in plan.md`)
      else if (isPathLike(token.replace(/:\d+(?:-\d+)?$/, ''))) say('warning', 'path', line, `\`${token}\` looks like a source path; paths belong in plan.md`)
    }
  })
  if (seen.size === 0) say('error', 'no-items', null, 'no "- [ ] X.Y" item found')
  return findings
}

// ---------------------------------------------------------------- plan.md

const LABELS = {
  files: /^\*\*Files:\*\*/,
  interfaces: /^\*\*Interfaces:\*\*/,
  level: /^\*\*Level:\*\*/,
  behaviour: /^\*\*Behaviou?r and acceptance:?\*\*/
}
const STEP = /^\s*-\s*\[[ xX]\]\s*\*\*Step\s+\d+\s*:\s*([^*]*)\*\*/

// Every task of a plan with the line numbers its findings point at. Files, consumes and
// produces come from plan-symbols' parser, so both scripts read the same plan the same way.
export function parsePlan(text) {
  const lines = text.split('\n')
  const parsed = parsePlanTasks(text)
  const starts = []
  lines.forEach((line, i) => {
    const m = /^###\s+Task\s+(\d+)\b\s*:?\s*(.*)$/.exec(line)
    if (m) starts.push({ number: Number(m[1]), i, title: m[2].trim() })
  })
  const tasks = starts.map(({ number, i, title }, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length
    const at = (re) => {
      for (let j = i + 1; j < end; j++) if (re.test(lines[j])) return j
      return -1
    }
    const p = parsed[k]
    const fields = {}
    for (const [name, re] of Object.entries(LABELS)) {
      const j = at(re)
      if (j >= 0) fields[name] = j + 1
    }
    let level = null
    if (fields.level) {
      const value = lines[fields.level - 1].replace(LABELS.level, '').replace(/[`*]/g, '').trim()
      level = /^([A-Za-z-]+)/.exec(value)?.[1].toLowerCase() ?? ''
    }
    const steps = []
    for (let j = i + 1; j < end; j++) {
      const m = STEP.exec(lines[j])
      if (m) steps.push({ name: m[1].trim(), line: j + 1 })
    }
    const has = (word) => steps.find((s) => new RegExp(`\\b${word}\\b`, 'i').test(s.name))
    const implAt = at(/^>\s*Implements\s/)
    // A Files bullet's line: the first line of the block naming its path.
    const fileLine = (path) => {
      const from = fields.files ? fields.files : i + 1
      for (let j = from; j < end; j++) if (lines[j].includes(path)) return j + 1
      return fields.files ?? i + 1
    }
    const files = p.files.map((f) => ({ ...f, line: fileLine(f.bare ?? f.path.split('/').pop()) }))
    return {
      number,
      title,
      line: i + 1,
      end,
      implements: p.implements,
      implementsLine: implAt >= 0 ? implAt + 1 : null,
      fields,
      level,
      steps,
      red: Boolean(has('RED')),
      green: Boolean(has('GREEN')),
      refactor: has('REFACTOR')?.line ?? null,
      commit: Boolean(has('Commit')),
      files,
      consumes: p.consumes,
      produces: p.produces,
      text: lines.slice(i, end).join('\n')
    }
  })
  return { tasks, lines }
}

// The test-first tasks: those that carry both a RED and a GREEN step.
export const testFirst = (tasks) => tasks.filter((t) => t.red && t.green).map((t) => t.number)

// The packages a planning guide lists under `## Packages`: every backticked directory-like token.
export function packagesFromGuide(guideText) {
  if (!guideText) return []
  const m = /^##\s+Packages\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(stripComments(guideText))
  if (!m) return []
  return [...new Set([...m[1].matchAll(/`([^`]+)`/g)].map((t) => t[1].replace(/\/\*\*$|\/\*$|\/$/, '')).filter((t) => /^[\w.@-][\w./@-]*$/.test(t)))]
}

// The package a path is in: the longest listed package it is under, or with no list its
// top-level directory. A path at the root, or under no listed package, is in none.
export function packageOf(path, packages) {
  if (packages.length) {
    const hit = packages.filter((p) => path === p || path.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0]
    return hit ?? null
  }
  return path.includes('/') ? path.slice(0, path.indexOf('/')) : null
}

// ---------------------------------------------------------------- risks

const STOP = new Set('the and for with from that this are was not but its may can into when which their have has one all any than then them they there will would been also only each per our out own'.split(' '))
const words = (s) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/s$/, ''))
  )

// The `[Risk] → Mitigation` bullets of design.md's Risks section: { text, line }.
export function parseRisks(designText) {
  if (!designText) return []
  const lines = designText.split('\n')
  const start = lines.findIndex((l) => /^##\s+Risks\b/i.test(l))
  if (start < 0) return []
  const bullets = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (/^[-*]\s/.test(lines[i])) bullets.push({ body: lines[i], line: i + 1 })
    else if (/^\s+\S/.test(lines[i]) && bullets.length) bullets.at(-1).body += ` ${lines[i].trim()}`
  }
  return bullets
    .map(({ body, line }) => {
      const m = /^[-*]\s+\[([^\]]+)\]\s*(?:→|->)/.exec(body)
      return m ? { text: m[1].trim(), line } : null
    })
    .filter(Boolean)
}

// A plan line names a risk when it names a Task or a deferral and at least half the significant
// words of the shorter of the two are shared: a short paraphrase of a long risk passes, a line
// about another risk does not.
export function reconcileRisks(risks, planLines) {
  const candidates = planLines.filter((l) => /\bTasks?\s+\d+|\bdefer/i.test(l)).map(words)
  return risks.filter((risk) => {
    const want = words(risk.text)
    if (want.size === 0) return false
    return !candidates.some((have) => {
      const hits = [...want].filter((w) => have.has(w)).length
      return hits / Math.min(want.size, have.size) >= 0.5 && hits >= Math.min(2, want.size)
    })
  })
}

// ---------------------------------------------------------------- Delete sweep

// The names a source file exports, read from its text.
export function exportedNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of source.matchAll(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/gm))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name)
    }
  return [...names].filter((n) => n.length >= 3)
}

// For each `Delete:` path, every file that still names it (its path, its file name, an import
// of its stem) or one of its exported names, outside the task's own Files block. `grep` is
// injected: grep({ fixed: [..], word }) → the tracked files matching any pattern, the change
// records excluded. `read(path)` returns the file's text or throws.
export async function sweepDeletes(tasks, { grep, read }) {
  const findings = []
  for (const task of tasks) {
    const own = task.files.flatMap((f) => [f.path, ...(f.to ? [f.to] : [])]).map(pathMatcher)
    const ownsFile = (file) => own.some((covers) => covers(file))
    for (const f of task.files.filter((x) => x.verb === 'Delete')) {
      const base = f.path.split('/').pop()
      const stem = base.replace(/\.[^.]+$/, '')
      const patterns = [f.path, base, ...(stem !== base && stem !== 'index' ? [`/${stem}'`, `/${stem}"`] : [])]
      const report = (file, by, severity) =>
        findings.push({
          severity,
          kind: 'delete-reference',
          task: task.number,
          line: f.line,
          path: f.path,
          file,
          message: `Task ${task.number} deletes ${f.path}, and ${file} still names ${by}; list it in the task's Files`
        })
      const byPath = new Set()
      for (const file of await grep({ fixed: patterns, word: false })) {
        if (file === f.path || ownsFile(file)) continue
        byPath.add(file)
        report(file, 'the file', 'error')
      }
      let source = ''
      try {
        source = await read(f.path)
      } catch {
        // already gone, or unreadable: only the path is searched
      }
      for (const name of exportedNames(source)) {
        for (const file of await grep({ fixed: [name], word: true })) {
          if (file === f.path || ownsFile(file) || byPath.has(file)) continue
          report(file, `its export \`${name}\``, 'warning')
        }
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------- plan lint

// Everything plan-lint checks except the graph and the Delete sweep. Inputs are texts; a missing
// design or guide is null. Findings: { severity, kind, task?, file, line, message }.
export function lintPlanText({ planText, tasksText, designText = null, guideText = null, planFile = 'plan.md', tasksFile = 'tasks.md', designFile = 'design.md' }) {
  const { tasks, lines } = parsePlan(planText)
  const findings = []
  const at = (file, line) => ({ file, line })
  const say = (severity, kind, where, message, extra = {}) => findings.push({ severity, kind, ...extra, ...where, message })
  if (!tasks.length) {
    say('error', 'no-tasks', at(planFile, null), 'no `### Task N` heading found')
    return { tasks, findings }
  }
  const items = parseTaskItems(tasksText ?? '')
  const ids = items.map((i) => i.id)
  const refs = new Map()

  tasks.forEach((t, k) => {
    const here = at(planFile, t.line)
    const x = { task: t.number }
    if (t.number !== k + 1) say('error', 'numbering', here, `Task ${t.number} is the plan's task ${k + 1}; number tasks 1, 2, 3 in order`, x)
    if (!t.implements) say('error', 'no-back-reference', here, `Task ${t.number} has no "> Implements tasks.md N.M" line`, x)
    else if (!ids.includes(t.implements))
      say('error', 'unknown-item', at(planFile, t.implementsLine), `Task ${t.number} implements ${t.implements}, which ${tasksFile} does not have; add the checkbox first`, x)
    else if (refs.has(t.implements))
      say('error', 'duplicate-reference', at(planFile, t.implementsLine), `Task ${t.number} implements ${t.implements}, as Task ${refs.get(t.implements)} does`, x)
    else if (ids[k] !== t.implements)
      say('error', 'order', at(planFile, t.implementsLine), `Task ${t.number} implements ${t.implements}; in ${tasksFile} order it is ${ids[k] ?? 'no item'}`, x)
    if (t.implements && !refs.has(t.implements)) refs.set(t.implements, t.number)

    for (const [name, label] of [['files', 'Files'], ['interfaces', 'Interfaces'], ['level', 'Level'], ['behaviour', 'Behaviour and acceptance']])
      if (!t.fields[name]) say('error', 'missing-field', here, `Task ${t.number} has no **${label}:**`, { ...x, field: label })
    if (t.fields.level && !LEVELS.includes(t.level))
      say('error', 'level', at(planFile, t.fields.level), `Task ${t.number} level "${t.level}" is not one of ${LEVELS.join(', ')}`, x)
    if (!t.commit) say('error', 'no-commit-step', here, `Task ${t.number} has no Commit step`, x)
    if (t.red !== t.green) say('error', 'red-green', here, `Task ${t.number} has ${t.red ? 'RED without GREEN' : 'GREEN without RED'}`, x)
    if (t.refactor) say('error', 'refactor-step', at(planFile, t.refactor), `Task ${t.number} has a REFACTOR step; no task gets one`, x)

    const packages = packagesFromGuide(guideText)
    const spanned = [...new Set(t.files.flatMap((f) => [f.path, f.to].filter(Boolean)).map((p) => packageOf(p, packages)).filter(Boolean))]
    if (spanned.length >= 2)
      say('warning', 'cross-package', at(planFile, t.fields.files ?? t.line), `Task ${t.number} spans ${spanned.join(', ')}; split it if it also changes a failure or rollback path`, { ...x, packages: spanned })
  })
  for (const item of items)
    if (!refs.has(item.id)) say('error', 'unplanned-item', at(tasksFile, item.line), `${tasksFile} ${item.id} has no plan task`, { item: item.id })

  for (const risk of reconcileRisks(parseRisks(designText), lines))
    say('error', 'risk-unreconciled', at(designFile, risk.line), `no plan line names the risk "${risk.text}" with a Task or a deferral`, { risk: risk.text })

  for (const f of graphFindings(planText, tasks)) findings.push({ ...f, file: planFile })
  return { tasks, findings }
}

// ---------------------------------------------------------------- Execution Graph

const cells = (row) =>
  stripComments(row)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function parseTaskList(cell) {
  const out = []
  for (const m of cell.matchAll(/(\d+)\s*(?:-|–|to)\s*(\d+)|(\d+)/g)) {
    if (m[3]) out.push(Number(m[3]))
    else for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(n)
  }
  return out
}

// "A", "Group A" or "A — shared contract": the letter is the first word.
const letterOf = (cell) => /^(\w+)/.exec(cell.replace(/[`*]/g, '').replace(/^Group\s+/i, '').trim())?.[1] ?? ''

// The `## Execution Graph` section: { line, end, groups, pairs, depends, single } or null.
export function parseGraph(planText) {
  const lines = planText.split('\n')
  const start = lines.findIndex((l) => /^##\s+Execution Graph\b/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++)
    if (/^##\s|^###\s+Task\s+\d/.test(lines[i])) {
      end = i
      break
    }
  const groups = []
  const pairs = []
  const depends = {}
  let table = null
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i]
    if (!/^\s*\|/.test(raw)) {
      table = null
      // One line may carry several: "Group B (wave 2) depends on: Group A. Group C (wave 2) …".
      for (const dep of stripComments(raw).matchAll(/Group\s+`?(\w+)`?\s*\(wave\s*2\)\s*depends\s+on:\s*(.*?)(?=Group\s+`?\w+`?\s*\(wave|$)/gi))
        depends[dep[1]] = [...dep[2].matchAll(/Group\s+`?(\w+)`?/gi)].map((m) => m[1])
      continue
    }
    const c = cells(raw)
    if (c.every((x) => /^:?-+:?$/.test(x) || x === '')) continue
    if (!table) {
      if (/^group$/i.test(c[0]) && /^tasks$/i.test(c[1] ?? '')) table = 'groups'
      else if (/^group a$/i.test(c[0]) && /^group b$/i.test(c[1] ?? '')) table = 'pairs'
      else table = 'other'
      continue
    }
    if (table === 'groups') {
      const letter = letterOf(c[0] ?? '')
      if (!letter) continue
      groups.push({
        letter,
        tasks: parseTaskList(c[1] ?? ''),
        files: [...(c[2] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]),
        wave: Number(/\d+/.exec(c[3] ?? '')?.[0] ?? NaN),
        line: i + 1
      })
    } else if (table === 'pairs') {
      const a = letterOf(c[0] ?? '')
      const b = letterOf(c[1] ?? '')
      if (!a || !b) continue
      pairs.push({ a, b, coupling: (/^[a-z-]+/i.exec(c[2] ?? '')?.[0] ?? '').toLowerCase(), reason: c.slice(3).join(' | '), line: i + 1 })
    }
  }
  const prose = stripComments(lines.slice(start + 1, end).filter((l) => !/^\s*\|/.test(l)).join('\n'))
  return { line: start + 1, end, groups, pairs, depends, single: /\bsingle group\b/i.test(prose) }
}

const pairKey = (a, b) => [a, b].sort().join('/')
const blocking = (p) => p.coupling === 'strong' || (p.coupling === 'medium' && /\bhigh\b/i.test(p.reason ?? ''))

// The file-overlap floor of two groups: `strong` when both write a file, `weak-or-medium` when
// they share a file one of them only reads (a Consumes path), `none` otherwise.
export function couplingFloor(a, b) {
  const both = [...a.writes].filter((f) => b.writes.has(f))
  if (both.length) return { floor: 'strong', shared: both }
  const shared = [...new Set([...a.writes, ...a.reads].filter((f) => b.writes.has(f) || b.reads.has(f)))]
  return shared.length ? { floor: WEAK_OR_MEDIUM, shared } : { floor: 'none', shared: [] }
}

function fileSets(tasks, numbers) {
  const writes = new Set()
  const reads = new Set()
  for (const t of tasks.filter((x) => numbers.includes(x.number))) {
    for (const f of t.files) {
      writes.add(f.path)
      if (f.to) writes.add(f.to)
    }
    for (const c of t.consumes) if (c.path) reads.add(c.path)
  }
  return { writes, reads }
}

// The waves and dependencies of a set of groups, from explicit dependencies and from the pairs
// that may not share a wave. Every group starts in wave 1; a group with a dependency, or the
// later of a blocking pair of wave-1 groups, goes to wave 2 and depends on the other. Returns
// errors for what would need a third tier.
export function assignWaves(letters, pairs, explicit = {}) {
  const wave = Object.fromEntries(letters.map((l) => [l, 1]))
  const dependsOn = Object.fromEntries(letters.map((l) => [l, [...(explicit[l] ?? [])]]))
  const errors = []
  for (const [g, deps] of Object.entries(explicit)) {
    if (!letters.includes(g)) errors.push(`dependency of unknown group ${g}`)
    else if (deps.length) wave[g] = 2
    for (const d of deps) if (!letters.includes(d)) errors.push(`group ${g} depends on unknown group ${d}`)
  }
  for (const a of letters)
    for (const b of letters.slice(letters.indexOf(a) + 1)) {
      const p = pairs.find((x) => pairKey(x.a, x.b) === pairKey(a, b))
      if (!p || !blocking(p)) continue
      if (wave[a] === 1 && wave[b] === 1) {
        wave[b] = 2
        dependsOn[b].push(a)
      } else if (wave[a] === 2 && wave[b] === 2) errors.push(`groups ${a} and ${b} are both wave 2 and may not share a wave; there is no wave 3`)
      else if (wave[a] === 2) dependsOn[a].push(b)
      else dependsOn[b].push(a)
    }
  for (const g of letters) {
    dependsOn[g] = [...new Set(dependsOn[g])]
    for (const d of dependsOn[g]) if (wave[d] === 2) errors.push(`group ${g} depends on wave-2 group ${d}; there is no wave 3`)
  }
  return { wave, dependsOn, errors }
}

// "A=1,2;B=3-5" → [{ letter, tasks }]
export function parseGroupsSpec(spec) {
  if (!spec || !spec.trim()) throw new Error('--groups is empty')
  return spec.split(';').map((part) => {
    const m = /^\s*(\w+)\s*=\s*(.+)$/.exec(part)
    if (!m) throw new Error(`"${part}" is not "<letter>=<task numbers>"`)
    const tasks = parseTaskList(m[2])
    if (!tasks.length) throw new Error(`group ${m[1]} has no task number`)
    return { letter: m[1], tasks }
  })
}

// "C=A,B;D=A" → { C: ['A', 'B'], D: ['A'] }
export function parseDependsSpec(spec) {
  if (!spec) return {}
  return Object.fromEntries(
    spec.split(';').map((part) => {
      const m = /^\s*(\w+)\s*=\s*([\w\s,]+)$/.exec(part)
      if (!m) throw new Error(`"${part}" is not "<group>=<group>,<group>"`)
      return [m[1], m[2].split(',').map((s) => s.trim()).filter(Boolean)]
    })
  )
}

// The graph of a chosen partition. `coupling` holds the agent's decisions per pair, keyed "A/B"
// or "A-B": { coupling, criticality?, reason? }. A decision may raise the floor, never lower it.
// Returns { groups, pairs, undecided, errors }; `undecided` lists the pairs whose floor is
// weak-or-medium and that no decision settles.
export function computeGraph(tasks, spec, { depends = {}, coupling = {} } = {}) {
  const errors = []
  const numbers = tasks.map((t) => t.number)
  const owner = new Map()
  for (const g of spec)
    for (const n of g.tasks) {
      if (!numbers.includes(n)) errors.push(`group ${g.letter} names Task ${n}, which the plan does not have`)
      else if (owner.has(n)) errors.push(`Task ${n} is in group ${owner.get(n)} and group ${g.letter}`)
      else owner.set(n, g.letter)
    }
  for (const n of numbers) if (!owner.has(n)) errors.push(`Task ${n} is in no group`)
  if (new Set(spec.map((g) => g.letter)).size !== spec.length) errors.push('a group letter is used twice')

  const decisions = Object.fromEntries(Object.entries(coupling).map(([k, v]) => [pairKey(...k.split(/[/-]/)), v]))
  const groups = spec.map((g) => ({ letter: g.letter, tasks: [...g.tasks].sort((a, b) => a - b), ...fileSets(tasks, g.tasks) }))
  const pairs = []
  const undecided = []
  for (const a of groups)
    for (const b of groups.slice(groups.indexOf(a) + 1)) {
      const { floor, shared } = couplingFloor(a, b)
      const d = decisions[pairKey(a.letter, b.letter)]
      const pair = { a: a.letter, b: b.letter, floor, shared, coupling: floor, reason: '' }
      if (d) {
        if (!COUPLINGS.includes(d.coupling)) errors.push(`pair ${a.letter}/${b.letter}: "${d.coupling}" is not one of ${COUPLINGS.join(', ')}`)
        else if (rank(d.coupling) < rank(floor)) errors.push(`pair ${a.letter}/${b.letter}: ${d.coupling} is below the floor ${floor}; a floor is only raised`)
        else if (d.coupling === 'medium' && !['high', 'low'].includes(d.criticality))
          errors.push(`pair ${a.letter}/${b.letter}: a medium pair needs criticality high or low`)
        pair.coupling = d.coupling
        pair.criticality = d.criticality
        pair.reason = d.reason ?? ''
      } else if (floor === WEAK_OR_MEDIUM) undecided.push(`${a.letter}/${b.letter}`)
      if (pair.coupling === 'medium' && pair.criticality) {
        const word = `${pair.criticality[0].toUpperCase()}${pair.criticality.slice(1)} criticality`
        if (!/\b(?:high|low)\b/i.test(pair.reason)) pair.reason = pair.reason ? `${word}: ${pair.reason}` : `${word}.`
      }
      if (!pair.reason && shared.length) pair.reason = `${floor === 'strong' ? 'Both write' : 'Share'} ${shared.map((f) => `\`${f}\``).join(', ')}.`
      pairs.push(pair)
    }
  const { wave, dependsOn, errors: waveErrors } = assignWaves(
    groups.map((g) => g.letter),
    pairs,
    depends
  )
  errors.push(...waveErrors)
  for (const g of groups) {
    g.wave = wave[g.letter]
    g.dependsOn = dependsOn[g.letter]
    g.files = [...new Set([...g.writes])].sort()
  }
  return { groups, pairs, undecided, errors }
}

const compress = (numbers) => {
  const out = []
  for (const n of numbers) {
    const last = out.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  return out.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a}, ${b}` : `${a}-${b}`)).join(', ')
}

// The tables in the template's format, the one apply reads.
export function renderGraph({ groups, pairs }) {
  const out = ['| Group | Tasks | Files | Wave |', '|---|---|---|---|']
  for (const g of groups) out.push(`| ${g.letter} | ${compress(g.tasks)} | ${g.files.length ? g.files.map((f) => `\`${f}\``).join(', ') : 'none'} | ${g.wave} |`)
  out.push('', '| Group A | Group B | Coupling | Reasoning (required if medium) |', '|---|---|---|---|')
  for (const p of pairs.filter((x) => x.coupling !== 'none')) out.push(`| ${p.a} | ${p.b} | ${p.coupling} | ${p.reason.replace(/\|/g, '\\|')} |`)
  const deps = groups.filter((g) => g.wave === 2)
  if (deps.length) out.push('')
  for (const g of deps) out.push(`Group ${g.letter} (wave 2) depends on: ${g.dependsOn.map((d) => `Group ${d}`).join(', ')}`)
  return out.join('\n')
}

// plan.md with its Execution Graph tables and dependency lines replaced by `rendered`. The
// section's prose stays, ahead of the tables; the template's guidance comments go. A plan with
// no section gets one before the first task (and before the rule that precedes it).
export function writeGraph(planText, rendered) {
  const lines = planText.split('\n')
  const graph = parseGraph(planText)
  if (!graph) {
    let at = lines.findIndex((l) => /^###\s+Task\s+\d/.test(l))
    if (at < 0) throw new Error('plan.md has no `### Task N` heading to put the graph before')
    let j = at - 1
    while (j >= 0 && !lines[j].trim()) j--
    if (j >= 0 && /^---\s*$/.test(lines[j])) at = j
    lines.splice(at, 0, '## Execution Graph', '', rendered, '')
    return lines.join('\n')
  }
  const body = stripComments(lines.slice(graph.line, graph.end).join('\n')).split('\n')
  const prose = body.filter((l) => !/^\s*\|/.test(l) && !/^Group\s+`?\w+`?\s*\(wave\s*2\)\s*depends\s+on:/i.test(l.trim()))
  // A closing rule stays after the tables.
  const trim = (xs) => {
    while (xs.length && !xs[0].trim()) xs.shift()
    while (xs.length && !xs.at(-1).trim()) xs.pop()
    return xs
  }
  trim(prose)
  const rule = prose.length && /^---\s*$/.test(prose.at(-1)) ? prose.pop() : null
  trim(prose)
  // Collapse the blank runs the removed tables leave behind.
  const kept = prose.filter((l, i) => l.trim() || prose[i - 1]?.trim())
  const section = ['', ...(kept.length ? [...kept, ''] : []), rendered, '', ...(rule ? [rule, ''] : [])]
  return [...lines.slice(0, graph.line), ...section, ...lines.slice(graph.end)].join('\n')
}

// The graph checks plan-lint runs and schedule refuses on: { severity, kind, line, message }.
export function graphFindings(planText, tasks = parsePlan(planText).tasks) {
  const graph = parseGraph(planText)
  const findings = []
  const say = (severity, kind, line, message) => findings.push({ severity, kind, line, message })
  if (!graph) {
    say('error', 'graph-missing', null, 'plan.md has no `## Execution Graph` section; apply does not dispatch it')
    return findings
  }
  if (!graph.groups.length) {
    if (!graph.single) say('error', 'graph-no-groups', graph.line, 'the Execution Graph has no group table and does not state a single group')
    return findings
  }
  const letters = graph.groups.map((g) => g.letter)
  const seen = new Map()
  for (const g of graph.groups) {
    if (![1, 2].includes(g.wave)) say('error', 'graph-wave', g.line, `group ${g.letter} has wave "${g.wave}"; a wave is 1 or 2`)
    for (const n of g.tasks) {
      if (!tasks.some((t) => t.number === n)) say('error', 'graph-unknown-task', g.line, `group ${g.letter} names Task ${n}, which the plan does not have`)
      else if (seen.has(n)) say('error', 'graph-task-twice', g.line, `Task ${n} is in group ${seen.get(n)} and group ${g.letter}`)
      else seen.set(n, g.letter)
    }
  }
  for (const t of tasks) if (!seen.has(t.number)) say('error', 'graph-task-unassigned', graph.line, `Task ${t.number} is in no group`)
  const wave = Object.fromEntries(graph.groups.map((g) => [g.letter, g.wave]))
  for (const p of graph.pairs) {
    if (!letters.includes(p.a) || !letters.includes(p.b)) {
      say('error', 'graph-unknown-group', p.line, `pair ${p.a}/${p.b} names a group the table does not have`)
      continue
    }
    if (!COUPLINGS.includes(p.coupling)) say('error', 'graph-coupling', p.line, `pair ${p.a}/${p.b}: "${p.coupling}" is not one of ${COUPLINGS.join(', ')}`)
    if (p.coupling === 'medium' && !/\b(?:high|low)\b/i.test(p.reason)) say('error', 'graph-criticality', p.line, `pair ${p.a}/${p.b} is medium and does not say high or low criticality`)
    if (blocking(p) && wave[p.a] === wave[p.b]) say('error', 'graph-same-wave', p.line, `pair ${p.a}/${p.b} is ${p.coupling}${p.coupling === 'medium' ? ' high-criticality' : ''} and both are wave ${wave[p.a]}`)
  }
  // The floor from the tasks' own files: a declared coupling below it is a lowered floor.
  const sets = Object.fromEntries(graph.groups.map((g) => [g.letter, fileSets(tasks, g.tasks)]))
  for (const a of letters)
    for (const b of letters.slice(letters.indexOf(a) + 1)) {
      const { floor, shared } = couplingFloor(sets[a], sets[b])
      if (floor === 'none') continue
      const p = graph.pairs.find((x) => pairKey(x.a, x.b) === pairKey(a, b))
      const declared = p && COUPLINGS.includes(p.coupling) ? p.coupling : 'none'
      if (rank(declared) < rank(floor))
        say('error', 'graph-floor', p?.line ?? graph.line, `pair ${a}/${b} is ${declared}, below its floor ${floor} (${shared.join(', ')}); a floor is only raised`)
    }
  for (const [g, deps] of Object.entries(graph.depends)) {
    if (!letters.includes(g)) say('error', 'graph-unknown-group', graph.line, `a dependency names group ${g}, which the table does not have`)
    else if (wave[g] !== 2) say('error', 'graph-dependency-wave', graph.line, `group ${g} has a dependency but is wave ${wave[g]}`)
    for (const d of deps) {
      if (!letters.includes(d)) say('error', 'graph-unknown-group', graph.line, `group ${g} depends on group ${d}, which the table does not have`)
      else if (wave[d] === 2) say('error', 'graph-depends-on-wave-2', graph.line, `group ${g} depends on wave-2 group ${d}; there is no wave 3`)
    }
  }
  for (const g of graph.groups.filter((x) => x.wave === 2)) {
    const coupled = graph.pairs.some((p) => blocking(p) && (p.a === g.letter || p.b === g.letter))
    if (!graph.depends[g.letter]?.length && !coupled)
      say('warning', 'graph-wave-2-unexplained', g.line, `group ${g.letter} is wave 2 with no stated dependency and no blocking pair; schedule makes it wait for every wave-1 group`)
  }
  return findings
}

// ---------------------------------------------------------------- schedule

// Which groups run now. `state(n, letter)` → { merged, kept } is injected (git). `ticked(item)`
// says whether a tasks.md item is ticked. Groups are numbered by their row, the first row 1.
export function schedule(planText, { state, ticked = () => false, cap = DEFAULT_CAP }) {
  const graph = parseGraph(planText)
  const { tasks } = parsePlan(planText)
  const errors = graphFindings(planText, tasks).filter((f) => f.severity === 'error')
  if (errors.length) return { ok: false, findings: errors }
  const rows = graph.groups.length ? graph.groups : [{ letter: 'A', tasks: tasks.map((t) => t.number), wave: 1 }]
  const wave1 = rows.filter((g) => g.wave === 1).map((g) => g.letter)
  const items = Object.fromEntries(tasks.map((t) => [t.number, t.implements]))
  const groups = rows.map((g, i) => {
    const explicit = graph.depends[g.letter] ?? []
    const coupled = graph.pairs
      .filter((p) => blocking(p) && (p.a === g.letter || p.b === g.letter))
      .map((p) => (p.a === g.letter ? p.b : p.a))
      .filter((other) => rows.find((r) => r.letter === other)?.wave === 1)
    let dependsOn = g.wave === 2 ? [...new Set([...explicit, ...coupled])] : []
    if (g.wave === 2 && !dependsOn.length) dependsOn = wave1
    const n = i + 1
    const done = g.tasks.every((t) => items[t] && ticked(items[t]))
    return { n, letter: g.letter, tasks: g.tasks, wave: g.wave, dependsOn, done, ...state(n, g.letter) }
  })
  const single = wave1.length === 1
  const byLetter = Object.fromEntries(groups.map((g) => [g.letter, g]))
  for (const g of groups) {
    if (single) g.state = g.done ? 'done' : 'pending'
    else g.state = g.merged ? 'merged' : g.kept ? 'running' : 'pending'
  }
  const pending = groups.filter((g) => g.state === 'pending')
  if (single) return { ok: true, single, cap, groups, startNow: pending.slice(0, 1).map((g) => g.n), waiting: pending.slice(1).map((g) => g.n) }
  const ready = pending.filter((g) => g.dependsOn.every((d) => byLetter[d]?.state === 'merged'))
  const slots = Math.max(0, cap - groups.filter((g) => g.state === 'running').length)
  const startNow = ready.slice(0, slots).map((g) => g.n)
  return { ok: true, single, cap, groups, startNow, waiting: pending.filter((g) => !startNow.includes(g.n)).map((g) => g.n) }
}

// ---------------------------------------------------------------- added during apply

// The paths each task's Files block names, as verify reads them.
export function taskMatchers(tasks) {
  return tasks.map((t) => ({ number: t.number, covers: plannedPaths(t.text).paths.map(pathMatcher) }))
}

// The files `commits` touched that no task names, each with the task that owns it: the one
// whose files the commits touching it changed most (ties to the lower number), or null.
// commits: [{ sha, files }]; exempt(file) excludes the change records and outsidePlan.
export function unplannedFiles(planText, commits, { exempt = () => false, status = {} } = {}) {
  const { tasks } = parsePlan(planText)
  const per = taskMatchers(tasks)
  const all = plannedPaths(planText).paths.map(pathMatcher)
  const out = new Map()
  for (const { sha, files } of commits)
    for (const file of files) {
      if (exempt(file) || all.some((covers) => covers(file))) continue
      if (!out.has(file)) out.set(file, { file, commits: [], votes: new Map() })
      const entry = out.get(file)
      entry.commits.push(sha)
      for (const other of files)
        for (const t of per) if (t.covers.some((covers) => covers(other))) entry.votes.set(t.number, (entry.votes.get(t.number) ?? 0) + 1)
    }
  return [...out.values()].map(({ file, commits: shas, votes }) => {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    return { file, verb: status[file] ?? 'Modify', commits: shas, owner: ranked[0]?.[0] ?? null, votes: Object.fromEntries(ranked) }
  })
}

// plan.md with ``- <Verb>: `<path>` — Added during apply, <date>: <why>`` appended to Task N's
// Files block. A path the task already names is left alone.
export function addDuringApply(planText, { task, path, why, verb = 'Modify', date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error(`date "${date}" is not YYYY-MM-DD`)
  if (!why || !why.trim()) throw new Error('--why is empty')
  if (!['Create', 'Modify', 'Test', 'Move', 'Delete', 'Revert'].includes(verb)) throw new Error(`verb "${verb}" is not a Files verb`)
  const { tasks, lines } = parsePlan(planText)
  const t = tasks.find((x) => x.number === task)
  if (!t) throw new Error(`plan.md has no Task ${task}`)
  if (!t.fields.files) throw new Error(`Task ${task} has no **Files:** block`)
  if (plannedPaths(t.text).paths.map(pathMatcher).some((covers) => covers(path))) return { text: planText, added: false, task, line: null, bullet: null }
  // The block runs from its label to the next label, step, heading or rule; blank lines inside
  // it do not end it.
  let last = t.fields.files - 1
  for (let j = t.fields.files; j < t.end; j++) {
    const line = lines[j]
    if (/^(?:\*\*|#|---|\s*- \[[ xX]\])/.test(line)) break
    if (line.trim() && !/^\s*<!--.*-->\s*$/.test(line)) last = j
  }
  const bullet = `- ${verb}: \`${path}\` — Added during apply, ${date}: ${why.trim()}`
  lines.splice(last + 1, 0, bullet)
  return { text: lines.join('\n'), added: true, task, line: last + 2, bullet }
}

