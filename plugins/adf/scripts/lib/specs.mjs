// Spec parsing and validation, ported from the openspec CLI 1.5.0 (core/validation/validator.js,
// core/parsers/{markdown-parser,requirement-blocks,spec-structure}.js and the zod schemas) so
// that `openspec validate --json` and this module agree on every item, issue level, path and
// message. Quirks of the original are kept on purpose; scripts/parity/openspec-validate.mjs
// checks the two against a real corpus. Node standard library only.
//
// The archive merge at the end (buildUpdatedSpec and the rest) ports core/specs-apply.js of the
// same CLI and adds the three-way check against the change's merge base.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { changeDir, changeMeta } from './changes.mjs'
import { baseRef } from './plan-symbols.mjs'

export const MIN_PURPOSE_LENGTH = 50
export const MAX_REQUIREMENT_TEXT_LENGTH = 500

export const MESSAGES = {
  REQUIREMENT_EMPTY: 'Requirement text cannot be empty',
  REQUIREMENT_NO_SHALL: 'Requirement must contain SHALL or MUST keyword',
  REQUIREMENT_NO_SCENARIOS: 'Requirement must have at least one scenario',
  SPEC_NO_REQUIREMENTS: 'Spec must have at least one requirement',
  CHANGE_NO_DELTAS: 'Change must have at least one delta',
  PURPOSE_TOO_BRIEF: `Purpose section is too brief (less than ${MIN_PURPOSE_LENGTH} characters)`,
  REQUIREMENT_TOO_LONG: `Requirement text is very long (>${MAX_REQUIREMENT_TEXT_LENGTH} characters). Consider breaking it down.`,
  GUIDE_NO_DELTAS: 'No deltas found. Ensure your change has a specs/ directory with capability folders (e.g. specs/http-server/spec.md) containing .md files that use delta headers (## ADDED/MODIFIED/REMOVED/RENAMED Requirements) and that each requirement includes at least one "#### Scenario:" block.',
  GUIDE_MISSING_SPEC_SECTIONS: 'Missing required sections. Expected headers: "## Purpose" and "## Requirements". Example:\n## Purpose\n[brief purpose]\n\n## Requirements\n### Requirement: Clear requirement statement\nUsers SHALL ...\n\n#### Scenario: Descriptive name\n- **WHEN** ...\n- **THEN** ...',
  GUIDE_SCENARIO_FORMAT: 'Scenarios must use level-4 headers. Convert bullet lists into:\n#### Scenario: Short name\n- **WHEN** ...\n- **THEN** ...\n- **AND** ...'
}

const normalizeLineEndings = (content) => content.replace(/\r\n?/g, '\n')

// ---- Requirement blocks (requirement-blocks.js): delta specs, and the archive merge later ----

const REQUIREMENT_HEADER = /^###\s*Requirement:\s*(.+)\s*$/i

export function normalizeRequirementName(name) {
  return name.trim()
}

// The ## Requirements section of a main spec split into the text before it, its header, the
// preamble, one raw block per requirement, and the text after it.
export function extractRequirementsSection(content) {
  const lines = normalizeLineEndings(content).split('\n')
  const headerIndex = lines.findIndex((l) => /^##\s+Requirements\s*$/i.test(l))
  if (headerIndex === -1) {
    const before = content.trimEnd()
    return {
      before: before ? `${before}\n\n` : '',
      headerLine: '## Requirements',
      preamble: '',
      bodyBlocks: [],
      after: '\n'
    }
  }
  let endIndex = lines.length
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIndex = i
      break
    }
  }
  const before = lines.slice(0, headerIndex).join('\n')
  const body = lines.slice(headerIndex + 1, endIndex)
  const preambleLines = []
  let cursor = 0
  while (cursor < body.length && !REQUIREMENT_HEADER.test(body[cursor])) preambleLines.push(body[cursor++])
  const blocks = []
  while (cursor < body.length) {
    const headerLine = body[cursor]
    const match = headerLine.match(REQUIREMENT_HEADER)
    if (!match) {
      cursor++
      continue
    }
    cursor++
    const blockLines = [headerLine]
    while (cursor < body.length && !REQUIREMENT_HEADER.test(body[cursor]) && !/^##\s+/.test(body[cursor])) {
      blockLines.push(body[cursor++])
    }
    blocks.push({ headerLine, name: normalizeRequirementName(match[1]), raw: blockLines.join('\n').trimEnd() })
  }
  const after = lines.slice(endIndex).join('\n')
  return {
    before: before.trimEnd() ? `${before}\n` : before,
    headerLine: lines[headerIndex],
    preamble: preambleLines.join('\n').trimEnd(),
    bodyBlocks: blocks,
    after: after.startsWith('\n') ? after : `\n${after}`
  }
}

// Body of every "## <title>" section; a later section with the same title wins.
function splitTopLevelSections(content) {
  const lines = content.split('\n')
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(##)\s+(.+)$/)
    if (match) heads.push({ title: match[2].trim(), index: i })
  }
  const sections = {}
  for (let i = 0; i < heads.length; i++) {
    const end = heads[i + 1] ? heads[i + 1].index : lines.length
    sections[heads[i].title] = lines.slice(heads[i].index + 1, end).join('\n')
  }
  return sections
}

function sectionCaseInsensitive(sections, desired) {
  const target = desired.toLowerCase()
  for (const [title, body] of Object.entries(sections)) {
    if (title.toLowerCase() === target) return { body, found: true }
  }
  return { body: '', found: false }
}

function parseRequirementBlocks(body) {
  if (!body) return []
  const lines = normalizeLineEndings(body).split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    while (i < lines.length && !REQUIREMENT_HEADER.test(lines[i])) i++
    if (i >= lines.length) break
    const headerLine = lines[i]
    const match = headerLine.match(REQUIREMENT_HEADER)
    const buf = [headerLine]
    i++
    while (i < lines.length && !REQUIREMENT_HEADER.test(lines[i]) && !/^##\s+/.test(lines[i])) buf.push(lines[i++])
    blocks.push({ headerLine, name: normalizeRequirementName(match[1]), raw: buf.join('\n').trimEnd() })
  }
  return blocks
}

function parseRemovedNames(body) {
  if (!body) return []
  const names = []
  for (const line of normalizeLineEndings(body).split('\n')) {
    const header = line.match(REQUIREMENT_HEADER)
    if (header) {
      names.push(normalizeRequirementName(header[1]))
      continue
    }
    const bullet = line.match(/^\s*-\s*`?###\s*Requirement:\s*(.+?)`?\s*$/)
    if (bullet) names.push(normalizeRequirementName(bullet[1]))
  }
  return names
}

function parseRenamedPairs(body) {
  if (!body) return []
  const pairs = []
  let current = {}
  for (const line of normalizeLineEndings(body).split('\n')) {
    const from = line.match(/^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/)
    const to = line.match(/^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/)
    if (from) {
      current.from = normalizeRequirementName(from[1])
    } else if (to) {
      current.to = normalizeRequirementName(to[1])
      if (current.from && current.to) {
        pairs.push({ from: current.from, to: current.to })
        current = {}
      }
    }
  }
  return pairs
}

// A delta spec as { added, modified, removed, renamed, sectionPresence }.
export function parseDeltaSpec(content) {
  const sections = splitTopLevelSections(normalizeLineEndings(content))
  const added = sectionCaseInsensitive(sections, 'ADDED Requirements')
  const modified = sectionCaseInsensitive(sections, 'MODIFIED Requirements')
  const removed = sectionCaseInsensitive(sections, 'REMOVED Requirements')
  const renamed = sectionCaseInsensitive(sections, 'RENAMED Requirements')
  return {
    added: parseRequirementBlocks(added.body),
    modified: parseRequirementBlocks(modified.body),
    removed: parseRemovedNames(removed.body),
    renamed: parseRenamedPairs(renamed.body),
    sectionPresence: { added: added.found, modified: modified.found, removed: removed.found, renamed: renamed.found }
  }
}

// ---- Main spec (markdown-parser.js) ----

function fenceMarker(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})/)
  return match ? { marker: match[1][0], length: match[1].length } : null
}

function isClosingFence(line, fence) {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*$/)
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length)
}

function codeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let active = null
  for (let i = 0; i < lines.length; i++) {
    if (!active) {
      active = fenceMarker(lines[i])
      if (active) mask[i] = true
      continue
    }
    mask[i] = true
    if (isClosingFence(lines[i], active)) active = null
  }
  return mask
}

// Every markdown header outside a code fence as a tree of { level, title, content, children };
// content runs to the next header of the same or a higher level.
export function parseSections(content) {
  const lines = normalizeLineEndings(content).split('\n')
  const mask = codeFenceMask(lines)
  const contentUntilNextHeader = (start, level) => {
    const out = []
    for (let i = start; i < lines.length; i++) {
      const match = mask[i] ? null : lines[i].match(/^(#{1,6})\s+/)
      if (match && match[1].length <= level) break
      out.push(lines[i])
    }
    return out.join('\n').trim()
  }
  const sections = []
  const stack = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (!match) continue
    const level = match[1].length
    const section = { level, title: match[2].trim(), content: contentUntilNextHeader(i + 1, level), children: [] }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length === 0) sections.push(section)
    else stack[stack.length - 1].children.push(section)
    stack.push(section)
  }
  return sections
}

// Depth-first, document order, any header level, title compared case-insensitively.
export function findSection(sections, title) {
  for (const section of sections) {
    if (section.title.toLowerCase() === title.toLowerCase()) return section
    const child = findSection(section.children, title)
    if (child) return child
  }
  return undefined
}

// A requirement is any child header of the Requirements section; its text is the first
// non-empty line before a line starting with '#', else the header title. A scenario is any
// child header of the requirement with non-empty content.
function parseRequirements(section) {
  return section.children.map((child) => {
    let text = child.title
    if (child.content.trim()) {
      const before = []
      for (const line of child.content.split('\n')) {
        if (line.trim().startsWith('#')) break
        before.push(line)
      }
      const direct = before.join('\n').trim()
      if (direct) {
        const first = direct.split('\n').find((l) => l.trim())
        if (first) text = first.trim()
      }
    }
    const scenarios = child.children.filter((s) => s.content.trim()).map((s) => ({ rawText: s.content }))
    return { text, scenarios }
  })
}

// A main spec as { name, overview, requirements }. Throws, as the CLI does, when the Purpose
// section is missing or empty, or the Requirements section is missing.
export function parseSpec(content, name) {
  const sections = parseSections(content)
  const purpose = findSection(sections, 'Purpose')?.content || ''
  const requirementsSection = findSection(sections, 'Requirements')
  if (!purpose) throw new Error('Spec must have a Purpose section')
  if (!requirementsSection) throw new Error('Spec must have a Requirements section')
  return { name, overview: purpose.trim(), requirements: parseRequirements(requirementsSection) }
}

// ---- Main spec structure (spec-structure.js) ----

function stripFencedCodeBlocks(content) {
  const out = []
  let active = null
  for (const line of content.split('\n')) {
    if (!active) {
      const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      if (match) {
        active = { marker: match[1][0], length: match[1].length }
        out.push('')
      } else {
        out.push(line)
      }
      continue
    }
    out.push('')
    if (isClosingFence(line, active)) active = null
  }
  return out.join('\n')
}

// Delta headers in a main spec, and requirement headers outside its ## Requirements section.
export function findMainSpecStructureIssues(content) {
  const lines = stripFencedCodeBlocks(normalizeLineEndings(content)).split('\n')
  const issues = []
  const headerIndex = lines.findIndex((l) => /^##\s+Requirements\s*$/i.test(l))
  let endIndex = lines.length
  if (headerIndex !== -1) {
    for (let i = headerIndex + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        endIndex = i
        break
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i.test(line)) {
      issues.push({
        line: i + 1,
        message: `Main spec contains delta header "${trimmed}". ` +
          'Delta headers are only valid inside openspec/changes/<name>/specs/<capability>/spec.md ' +
          'and truncate the parsed ## Requirements section.'
      })
      continue
    }
    if (!/^###\s+Requirement:\s*(.+)\s*$/i.test(line)) continue
    if (!(headerIndex !== -1 && i > headerIndex && i < endIndex)) {
      issues.push({
        line: i + 1,
        message: `Requirement header "${trimmed}" appears outside the main ## Requirements section. ` +
          'Main specs only parse requirements inside that section, so this requirement is currently invisible to validate, list, and archive.'
      })
    }
  }
  return issues
}

// ---- Validation (validator.js) ----

// Strict mode, off by default in the CLI, also fails an item on any WARNING.
function report(issues, strict) {
  const count = (level) => issues.filter((i) => i.level === level).length
  const errors = count('ERROR')
  const warnings = count('WARNING')
  return {
    valid: strict ? errors === 0 && warnings === 0 : errors === 0,
    issues,
    summary: { errors, warnings, info: count('INFO') }
  }
}

// The checks the CLI's SpecSchema (zod) makes, in its issue order. The name and overview
// checks cannot fail here: parseSpec has already thrown on an empty Purpose, and the name is
// the capability directory.
function schemaIssues(spec) {
  const issues = []
  const error = (path, message) => issues.push({ level: 'ERROR', path, message })
  if (spec.requirements.length === 0) error('requirements', MESSAGES.SPEC_NO_REQUIREMENTS)
  spec.requirements.forEach((req, i) => {
    if (req.text.length < 1) error(`requirements.${i}.text`, MESSAGES.REQUIREMENT_EMPTY)
    if (!(req.text.includes('SHALL') || req.text.includes('MUST'))) error(`requirements.${i}.text`, MESSAGES.REQUIREMENT_NO_SHALL)
    if (req.scenarios.length < 1) error(`requirements.${i}.scenarios`, MESSAGES.REQUIREMENT_NO_SCENARIOS)
  })
  return issues
}

function specRuleIssues(spec, content) {
  const issues = findMainSpecStructureIssues(content).map(({ line, message }) => ({ level: 'ERROR', path: 'file', line, message }))
  if (spec.overview.length < MIN_PURPOSE_LENGTH) {
    issues.push({ level: 'WARNING', path: 'overview', message: MESSAGES.PURPOSE_TOO_BRIEF })
  }
  spec.requirements.forEach((req, i) => {
    if (req.text.length > MAX_REQUIREMENT_TEXT_LENGTH) {
      issues.push({ level: 'INFO', path: `requirements[${i}]`, message: MESSAGES.REQUIREMENT_TOO_LONG })
    }
    if (req.scenarios.length === 0) {
      issues.push({
        level: 'WARNING',
        path: `requirements[${i}].scenarios`,
        message: `${MESSAGES.REQUIREMENT_NO_SCENARIOS}. ${MESSAGES.GUIDE_SCENARIO_FORMAT}`
      })
    }
  })
  return issues
}

function enrichTopLevelError(message) {
  const msg = message.trim()
  if (msg === MESSAGES.CHANGE_NO_DELTAS) return `${msg}. ${MESSAGES.GUIDE_NO_DELTAS}`
  if (msg.includes('Spec must have a Purpose section') || msg.includes('Spec must have a Requirements section')) {
    return `${msg}. ${MESSAGES.GUIDE_MISSING_SPEC_SECTIONS}`
  }
  return msg
}

export function validateSpecContent(content, { name = 'spec', strict = false } = {}) {
  let issues
  try {
    const spec = parseSpec(content, name)
    issues = [...schemaIssues(spec), ...specRuleIssues(spec, content)]
  } catch (error) {
    issues = [{ level: 'ERROR', path: 'file', message: enrichTopLevelError(error.message) }]
  }
  return report(issues, strict)
}

export function validateSpecFile(file, { name, strict = false } = {}) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    return report([{ level: 'ERROR', path: 'file', message: enrichTopLevelError(error.message) }], strict)
  }
  return validateSpecContent(content, { name, strict })
}

// The first line of a requirement block after its header that is neither blank nor a
// "**Key**:" metadata line, stopping at the first "####" header.
function requirementText(raw) {
  const lines = raw.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^####\s+/.test(lines[i])) break
    const trimmed = lines[i].trim()
    if (trimmed.length === 0) continue
    if (/^\*\*[^*]+\*\*:/.test(trimmed)) continue
    return trimmed
  }
  return undefined
}

const containsShallOrMust = (text) => /\b(SHALL|MUST)\b/.test(text)

function missingShallOrMust(action, name) {
  const base = `${action} "${name}" must contain SHALL or MUST`
  if (containsShallOrMust(name)) {
    return `${base} in the requirement body, not only in the header. Move the SHALL/MUST statement to the line immediately after the "### Requirement: ..." header.`
  }
  return base
}

// Counts every "#### " line in the block, code fences included, whatever the header says.
const countScenarios = (raw) => (raw.match(/^####\s+/gm) ?? []).length

function formatSectionList(sections) {
  if (sections.length <= 1) return sections[0] ?? ''
  return `${sections.slice(0, -1).join(', ')} and ${sections[sections.length - 1]}`
}

function checkBlocks(action, blocks, names, error) {
  for (const block of blocks) {
    const key = normalizeRequirementName(block.name)
    if (names.has(key)) error(`Duplicate requirement in ${action}: "${block.name}"`)
    else names.add(key)
    const text = requirementText(block.raw)
    if (!text) error(`${action} "${block.name}" is missing requirement text`)
    else if (!containsShallOrMust(text)) error(missingShallOrMust(action, block.name))
    if (countScenarios(block.raw) < 1) error(`${action} "${block.name}" must include at least one scenario`)
  }
}

// Every <changeDir>/specs/<capability>/spec.md, in directory order. A missing specs/
// directory counts as no deltas.
export function validateChangeDeltaSpecs(changeDir, { strict = false } = {}) {
  const issues = []
  const emptySections = []
  const missingHeaders = []
  let totalDeltas = 0
  let entries = []
  try {
    entries = readdirSync(join(changeDir, 'specs'), { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let content
    try {
      content = readFileSync(join(changeDir, 'specs', entry.name, 'spec.md'), 'utf8')
    } catch {
      continue
    }
    const plan = parseDeltaSpec(content)
    const path = `${entry.name}/spec.md`
    const error = (message) => issues.push({ level: 'ERROR', path, message })
    const present = ['added', 'modified', 'removed', 'renamed']
      .filter((k) => plan.sectionPresence[k])
      .map((k) => `## ${k.toUpperCase()} Requirements`)
    if (plan.added.length + plan.modified.length + plan.removed.length + plan.renamed.length === 0) {
      if (present.length > 0) emptySections.push({ path, sections: present })
      else missingHeaders.push(path)
    }
    const added = new Set()
    const modified = new Set()
    const removed = new Set()
    const renamedFrom = new Set()
    const renamedTo = new Set()
    checkBlocks('ADDED', plan.added, added, error)
    checkBlocks('MODIFIED', plan.modified, modified, error)
    totalDeltas += plan.added.length + plan.modified.length
    for (const name of plan.removed) {
      const key = normalizeRequirementName(name)
      totalDeltas++
      if (removed.has(key)) error(`Duplicate requirement in REMOVED: "${name}"`)
      else removed.add(key)
    }
    for (const { from, to } of plan.renamed) {
      totalDeltas++
      const fromKey = normalizeRequirementName(from)
      const toKey = normalizeRequirementName(to)
      if (renamedFrom.has(fromKey)) error(`Duplicate FROM in RENAMED: "${from}"`)
      else renamedFrom.add(fromKey)
      if (renamedTo.has(toKey)) error(`Duplicate TO in RENAMED: "${to}"`)
      else renamedTo.add(toKey)
    }
    for (const n of modified) {
      if (removed.has(n)) error(`Requirement present in both MODIFIED and REMOVED: "${n}"`)
      if (added.has(n)) error(`Requirement present in both MODIFIED and ADDED: "${n}"`)
    }
    for (const n of added) {
      if (removed.has(n)) error(`Requirement present in both ADDED and REMOVED: "${n}"`)
    }
    for (const { from, to } of plan.renamed) {
      if (modified.has(normalizeRequirementName(from))) error(`MODIFIED references old name from RENAMED. Use new header for "${to}"`)
      if (added.has(normalizeRequirementName(to))) error(`RENAMED TO collides with ADDED for "${to}"`)
    }
  }
  for (const { path, sections } of emptySections) {
    issues.push({
      level: 'ERROR',
      path,
      message: `Delta sections ${formatSectionList(sections)} were found, but no requirement entries parsed. Ensure each section includes at least one "### Requirement:" block (REMOVED may use bullet list syntax).`
    })
  }
  for (const path of missingHeaders) {
    issues.push({
      level: 'ERROR',
      path,
      message: 'No delta sections found. Add headers such as "## ADDED Requirements" or move non-delta notes outside specs/.'
    })
  }
  if (totalDeltas === 0) {
    issues.push({ level: 'ERROR', path: 'file', message: enrichTopLevelError(MESSAGES.CHANGE_NO_DELTAS) })
  }
  return report(issues, strict)
}

// ---- Item discovery and the bulk report (utils/item-discovery.js, commands/validate.js) ----

function listDirs(dir, keep) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && keep(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

// Active changes: directories under openspec/changes, archive excluded, holding proposal.md.
export function listChangeIds(root) {
  const dir = join(root, 'openspec', 'changes')
  return listDirs(dir, (name) => name !== 'archive' && existsSync(join(dir, name, 'proposal.md')))
}

// Capabilities: directories under openspec/specs holding spec.md.
export function listSpecIds(root) {
  const dir = join(root, 'openspec', 'specs')
  return listDirs(dir, (name) => existsSync(join(dir, name, 'spec.md')))
}

export function validateItem(root, type, id, { strict = false } = {}) {
  const start = Date.now()
  const result = type === 'change'
    ? validateChangeDeltaSpecs(join(root, 'openspec', 'changes', id), { strict })
    : validateSpecFile(join(root, 'openspec', 'specs', id, 'spec.md'), { name: id, strict })
  return { id, type, valid: result.valid, issues: result.issues, durationMs: Date.now() - start }
}

function summarize(items, types) {
  const count = (list) => {
    const passed = list.filter((i) => i.valid).length
    return { items: list.length, passed, failed: list.length - passed }
  }
  const byType = {}
  for (const type of types) byType[type] = count(items.filter((i) => i.type === type))
  return { totals: count(items), byType }
}

// The report of `openspec validate --json`: items sorted by id (changes and specs mixed, as the
// CLI sorts them), and a summary whose byType names the selected types only.
export function validateProject(root, { change, spec, strict = false } = {}) {
  let items
  let types
  if (change !== undefined) {
    if (!listChangeIds(root).includes(change)) throw new Error(`Unknown change '${change}'.`)
    items = [validateItem(root, 'change', change, { strict })]
    types = ['change']
  } else if (spec !== undefined) {
    if (!listSpecIds(root).includes(spec)) throw new Error(`Unknown spec '${spec}'.`)
    items = [validateItem(root, 'spec', spec, { strict })]
    types = ['spec']
  } else {
    items = [
      ...listChangeIds(root).map((id) => validateItem(root, 'change', id, { strict })),
      ...listSpecIds(root).map((id) => validateItem(root, 'spec', id, { strict }))
    ].sort((a, b) => a.id.localeCompare(b.id))
    types = ['change', 'spec']
  }
  return { items, summary: summarize(items, types), version: '1.0' }
}

// ---- Propose-time gates: the proposal's capabilities, and the deltas against the main specs ----

const CAPABILITY = /^[a-z0-9]+(-[a-z0-9]+)*$/
const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')

// The capability names of a proposal's `## Capabilities` section, by `### New Capabilities` and
// `### Modified Capabilities`: the first token of each top-level bullet, backticks and emphasis
// removed. A template placeholder (`<name>`) is skipped; "None" is no bullet.
export function parseProposalCapabilities(proposalText) {
  const out = { new: [], modified: [], section: false }
  const lines = stripHtmlComments(normalizeLineEndings(proposalText)).split('\n')
  let part = null
  let inside = false
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inside = /^##\s+Capabilities\s*$/i.test(line)
      if (inside) out.section = true
      part = null
      continue
    }
    if (!inside) continue
    const sub = /^###\s+(New|Modified)\s+Capabilities\s*$/i.exec(line)
    if (sub) {
      part = sub[1].toLowerCase()
      continue
    }
    if (/^###\s/.test(line)) {
      part = null
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (!part || !bullet) continue
    const token = /^[`*_]*([^`*_:\s]+)/.exec(bullet[1].trim())?.[1]
    if (!token || /^<.*>$/.test(token) || /^none\.?$/i.test(token)) continue
    if (!out[part].includes(token)) out[part].push(token)
  }
  return out
}

// The contract between a change's proposal and its delta specs: every listed capability has
// `specs/<capability>/spec.md`, every spec folder is listed, a modified capability names an
// existing main spec, a new one does not, and a new name is kebab-case of at least two words.
export function checkCapabilities(root, change) {
  const dir = join(root, 'openspec', 'changes', change)
  const proposalPath = join(dir, 'proposal.md')
  if (!existsSync(proposalPath)) {
    return { ok: false, error: `openspec/changes/${change}/proposal.md does not exist`, new: [], modified: [], missingSpec: [], unlistedSpec: [], modifiedNotFound: [], newCollides: [], badName: [], listedTwice: [] }
  }
  const caps = parseProposalCapabilities(readFileSync(proposalPath, 'utf8'))
  const specsDir = join(dir, 'specs')
  const specs = listDirs(specsDir, (name) => existsSync(join(specsDir, name, 'spec.md')))
  const main = new Set(listSpecIds(root))
  const listed = [...caps.new, ...caps.modified]
  const result = {
    new: caps.new,
    modified: caps.modified,
    missingSpec: listed.filter((c) => !specs.includes(c)),
    unlistedSpec: specs.filter((c) => !listed.includes(c)),
    modifiedNotFound: caps.modified.filter((c) => !main.has(c)),
    newCollides: caps.new.filter((c) => main.has(c)),
    badName: listed.filter((c) => !CAPABILITY.test(c) || (caps.new.includes(c) && !c.includes('-'))),
    listedTwice: caps.new.filter((c) => caps.modified.includes(c))
  }
  const problems = ['missingSpec', 'unlistedSpec', 'modifiedNotFound', 'newCollides', 'badName', 'listedTwice'].filter((k) => result[k].length > 0)
  if (!caps.section) return { ok: false, error: 'proposal.md has no ## Capabilities section', ...result }
  return { ok: problems.length === 0, ...result }
}

const FIELD = (label) => new RegExp(`\\*\\*${label}:?\\*\\*`, 'i')
const sameText = (a, b) => a.split('\n').map((l) => l.trimEnd()).join('\n').trim() === b.split('\n').map((l) => l.trimEnd()).join('\n').trim()

// One delta spec against its capability's main spec (null when there is none yet), as archive
// will apply it: every MODIFIED, REMOVED and RENAMED-from header names a requirement the main
// spec holds, exactly; an ADDED or RENAMED-to name is not already there with other text; REMOVED
// carries Reason, Migration and Code Disposition, RENAMED carries Code Disposition.
// Findings: { kind, operation, requirement, message }.
export function deltaAgainstMain(deltaText, mainText) {
  const content = normalizeLineEndings(deltaText)
  const delta = parseDeltaSpec(content)
  const sections = splitTopLevelSections(content)
  const main = new Map((mainText === null ? [] : extractRequirementsSection(mainText).bodyBlocks).map((b) => [b.name, b.raw]))
  const findings = []
  const say = (kind, operation, requirement, message) => findings.push({ kind, operation, requirement, message })
  const where = mainText === null ? 'the capability has no main spec yet' : 'the main spec has no requirement with this exact header'
  const renamedTo = new Set(delta.renamed.map((p) => p.to))
  for (const { from, to } of delta.renamed) {
    if (!main.has(from)) say('unmatched-header', 'RENAMED', from, `RENAMED FROM "${from}": ${where}`)
    if (main.has(to)) say('already-in-main', 'RENAMED', to, `RENAMED TO "${to}": the main spec already holds that name`)
  }
  for (const block of delta.added) {
    if (main.has(block.name) && !sameText(main.get(block.name), block.raw)) say('already-in-main', 'ADDED', block.name, `ADDED "${block.name}": the main spec already holds it with other text; use MODIFIED`)
  }
  for (const block of delta.modified) {
    if (!main.has(block.name) && !renamedTo.has(block.name)) say('unmatched-header', 'MODIFIED', block.name, `MODIFIED "${block.name}": ${where}`)
  }
  for (const name of delta.removed) {
    if (!main.has(name)) say('unmatched-header', 'REMOVED', name, `REMOVED "${name}": ${where}`)
  }
  const removed = sectionCaseInsensitive(sections, 'REMOVED Requirements')
  if (removed.found) {
    const blocks = parseRequirementBlocks(removed.body)
    const withBody = new Set(blocks.map((b) => b.name))
    const checks = [...blocks.map((b) => [b.name, b.raw]), ...delta.removed.filter((n) => !withBody.has(n)).map((n) => [n, removed.body])]
    for (const [name, text] of checks) {
      for (const label of ['Reason', 'Migration', 'Code Disposition']) {
        if (!FIELD(label).test(text)) say('missing-field', 'REMOVED', name, `REMOVED "${name}" has no **${label}:**`)
      }
    }
  }
  const renamed = sectionCaseInsensitive(sections, 'RENAMED Requirements')
  if (renamed.found) {
    const froms = (renamed.body.match(/^\s*-?\s*FROM:/gm) ?? []).length
    if (froms !== delta.renamed.length) say('unparsed-rename', 'RENAMED', null, `RENAMED holds ${froms} FROM line(s) but ${delta.renamed.length} complete FROM/TO pair(s); write each as \`- FROM: \`### Requirement: <old>\`\` then \`- TO: \`### Requirement: <new>\`\``)
    if (delta.renamed.length > 0 && !FIELD('Code Disposition').test(renamed.body)) say('missing-field', 'RENAMED', delta.renamed[0].from, 'RENAMED has no **Code Disposition:**')
  }
  return findings
}

// Every delta spec of a change against the main specs: { ok, capabilities: [{ capability,
// mainSpec, findings }] }.
export function changeAgainstMain(root, change) {
  const specsDir = join(root, 'openspec', 'changes', change, 'specs')
  const capabilities = listDirs(specsDir, (name) => existsSync(join(specsDir, name, 'spec.md'))).map((capability) => {
    const mainPath = join(root, 'openspec', 'specs', capability, 'spec.md')
    const mainText = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : null
    return { capability, mainSpec: mainText !== null, findings: deltaAgainstMain(readFileSync(join(specsDir, capability, 'spec.md'), 'utf8'), mainText) }
  })
  return { ok: capabilities.every((c) => c.findings.length === 0), capabilities }
}

// ---- The archive merge (specs-apply.js) and the three-way check ----

// The Purpose a new capability's skeleton carries until archive writes the real one from
// proposal.md. It is longer than MIN_PURPOSE_LENGTH so the strict validation of the rebuilt
// spec passes; the caller detects it with hasPlaceholderPurpose and refuses to commit it.
export const PURPOSE_PLACEHOLDER = 'ADF-PURPOSE-PLACEHOLDER: archive replaces this line with the capability Purpose from proposal.md.'

export const hasPlaceholderPurpose = (content) => content.includes(PURPOSE_PLACEHOLDER)

// openspec's skeleton for a new capability, with the Purpose line given (openspec writes
// "TBD - created by archiving change <name>. Update Purpose after archive.").
export function buildSpecSkeleton(capability, purpose = PURPOSE_PLACEHOLDER) {
  return `# ${capability} Specification\n\n## Purpose\n${purpose}\n\n## Requirements\n`
}

const collapseBlankRuns = (text) => normalizeLineEndings(text).replace(/\n{3,}/g, '\n\n')
// Two requirement blocks are the same when they differ only in line endings, trailing spaces
// and runs of blank lines, which the rebuild collapses.
const sameBlock = (a, b) => (a === null || b === null ? a === b : sameText(collapseBlankRuns(a), collapseBlankRuns(b)))

const operationCount = (plan) => plan.added.length + plan.modified.length + plan.removed.length + plan.renamed.length
const countsOf = (plan) => ({ added: plan.added.length, modified: plan.modified.length, removed: plan.removed.length, renamed: plan.renamed.length })

function blocksByName(mainText) {
  if (mainText === null) return new Map()
  return new Map(extractRequirementsSection(mainText).bodyBlocks.map((b) => [normalizeRequirementName(b.name), b.raw]))
}

// openspec's checks of a delta before it touches the main spec: no requirement twice in one
// section, none in two sections, a MODIFIED naming a rename's new header, no ADDED colliding
// with a RENAMED target, at least one operation. Throws on the first failure.
export function checkDeltaPlan(capability, plan) {
  const key = normalizeRequirementName
  const fail = (message) => {
    throw new Error(message)
  }
  const unique = (names, section) => {
    const seen = new Set()
    for (const name of names) {
      if (seen.has(key(name))) fail(`${capability} validation failed - duplicate requirement in ${section} for header "### Requirement: ${name}"`)
      seen.add(key(name))
    }
    return seen
  }
  const added = unique(plan.added.map((b) => b.name), 'ADDED')
  const modified = unique(plan.modified.map((b) => b.name), 'MODIFIED')
  const removed = unique(plan.removed, 'REMOVED')
  const renamedFrom = new Set()
  const renamedTo = new Set()
  for (const { from, to } of plan.renamed) {
    if (renamedFrom.has(key(from))) fail(`${capability} validation failed - duplicate FROM in RENAMED for header "### Requirement: ${from}"`)
    if (renamedTo.has(key(to))) fail(`${capability} validation failed - duplicate TO in RENAMED for header "### Requirement: ${to}"`)
    renamedFrom.add(key(from))
    renamedTo.add(key(to))
  }
  const conflicts = []
  for (const n of modified) {
    if (removed.has(n)) conflicts.push({ name: n, a: 'MODIFIED', b: 'REMOVED' })
    if (added.has(n)) conflicts.push({ name: n, a: 'MODIFIED', b: 'ADDED' })
  }
  for (const n of added) if (removed.has(n)) conflicts.push({ name: n, a: 'ADDED', b: 'REMOVED' })
  for (const { from, to } of plan.renamed) {
    if (modified.has(key(from))) fail(`${capability} validation failed - when a rename exists, MODIFIED must reference the NEW header "### Requirement: ${to}"`)
    if (added.has(key(to))) fail(`${capability} validation failed - RENAMED TO header collides with ADDED for "### Requirement: ${to}"`)
  }
  if (conflicts.length > 0) {
    const c = conflicts[0]
    fail(`${capability} validation failed - requirement present in multiple sections (${c.a} and ${c.b}) for header "### Requirement: ${c.name}"`)
  }
  if (operationCount(plan) === 0) {
    fail(`Delta parsing found no operations for ${capability}. Provide ADDED/MODIFIED/REMOVED/RENAMED sections in change spec.`)
  }
}

// The rebuilt main spec of one capability, as openspec 1.5.0's buildUpdatedSpec makes it, with
// its messages: the delta's sections checked for duplicates and cross-section conflicts, then
// RENAMED, REMOVED, MODIFIED and ADDED applied in that order; a MODIFIED block replaces the
// whole requirement; kept blocks stay in their original order and the rest (added, and renamed:
// a quirk of the original) are appended. `plan` is parseDeltaSpec's; `mainText` is null for a
// new capability, which starts from buildSpecSkeleton(capability, purpose). Throws on a refusal.
// Returns { rebuilt, counts, isNew, warnings }.
export function buildUpdatedSpec({ capability, plan, mainText, purpose = PURPOSE_PLACEHOLDER }) {
  checkDeltaPlan(capability, plan)
  const key = normalizeRequirementName
  const fail = (message) => {
    throw new Error(message)
  }
  const warnings = []
  const isNew = mainText === null
  let target = mainText
  if (isNew) {
    if (plan.modified.length > 0 || plan.renamed.length > 0) {
      fail(`${capability}: target spec does not exist; only ADDED requirements are allowed for new specs. MODIFIED and RENAMED operations require an existing spec.`)
    }
    if (plan.removed.length > 0) warnings.push(`${capability} - ${plan.removed.length} REMOVED requirement(s) ignored for new spec (nothing to remove).`)
    target = buildSpecSkeleton(capability, purpose)
  }
  const structure = findMainSpecStructureIssues(target)
  if (structure.length > 0) {
    fail(`${capability}: target spec is structurally invalid and cannot be updated until fixed:\n${structure.map((i) => `line ${i.line}: ${i.message}`).join('\n')}`)
  }
  const parts = extractRequirementsSection(target)
  const blocks = new Map(parts.bodyBlocks.map((b) => [key(b.name), b]))
  for (const r of plan.renamed) {
    const from = key(r.from)
    const to = key(r.to)
    if (!blocks.has(from)) fail(`${capability} RENAMED failed for header "### Requirement: ${r.from}" - source not found`)
    if (blocks.has(to)) fail(`${capability} RENAMED failed for header "### Requirement: ${r.to}" - target already exists`)
    const lines = blocks.get(from).raw.split('\n')
    lines[0] = `### Requirement: ${to}`
    blocks.delete(from)
    blocks.set(to, { headerLine: lines[0], name: to, raw: lines.join('\n') })
  }
  for (const name of plan.removed) {
    if (!blocks.has(key(name))) {
      if (!isNew) fail(`${capability} REMOVED failed for header "### Requirement: ${name}" - not found`)
      continue
    }
    blocks.delete(key(name))
  }
  for (const mod of plan.modified) {
    const k = key(mod.name)
    if (!blocks.has(k)) fail(`${capability} MODIFIED failed for header "### Requirement: ${mod.name}" - not found`)
    const header = mod.raw.split('\n')[0].match(REQUIREMENT_HEADER)
    if (!header || key(header[1]) !== k) fail(`${capability} MODIFIED failed for header "### Requirement: ${mod.name}" - header mismatch in content`)
    blocks.set(k, mod)
  }
  for (const add of plan.added) {
    const k = key(add.name)
    if (blocks.has(k)) fail(`${capability} ADDED failed for header "### Requirement: ${add.name}" - already exists`)
    blocks.set(k, add)
  }
  const ordered = []
  const seen = new Set()
  for (const block of parts.bodyBlocks) {
    const replacement = blocks.get(key(block.name))
    if (replacement) {
      ordered.push(replacement)
      seen.add(key(block.name))
    }
  }
  for (const [k, block] of blocks) if (!seen.has(k)) ordered.push(block)
  const body = [parts.preamble && parts.preamble.trim() ? parts.preamble.trimEnd() : '']
    .filter(Boolean)
    .concat(ordered.map((b) => b.raw))
    .join('\n\n')
    .trimEnd()
  const rebuilt = [parts.before.trimEnd(), parts.headerLine, body, parts.after]
    .filter((s, i) => !(i === 0 && s === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return { rebuilt, counts: countsOf(plan), isNew, warnings }
}

// Whether the main spec already holds everything the delta says: every ADDED and MODIFIED block
// with the same text, no REMOVED name, every RENAMED target and no source. Such a delta is
// `merged`: a re-run writes nothing instead of refusing an ADDED name that already exists.
export function deltaAlreadyMerged(plan, mainText) {
  if (mainText === null || operationCount(plan) === 0) return false
  const main = blocksByName(mainText)
  const key = normalizeRequirementName
  const holds = (block) => main.has(key(block.name)) && sameBlock(main.get(key(block.name)), block.raw)
  return plan.added.every(holds) &&
    plan.modified.every(holds) &&
    plan.removed.every((name) => !main.has(key(name))) &&
    plan.renamed.every(({ from, to }) => !main.has(key(from)) && main.has(key(to)))
}

// The requirements a delta changes in the main spec, by their name there: a MODIFIED and a
// REMOVED by name, a RENAMED by its FROM name; a MODIFIED of a RENAMED target belongs to the
// rename. `delta` is the delta's own text for the requirement, shown to whoever resolves it.
function touchedRequirements(plan, deltaText) {
  const key = normalizeRequirementName
  const sections = splitTopLevelSections(normalizeLineEndings(deltaText))
  const removedBlocks = new Map(parseRequirementBlocks(sectionCaseInsensitive(sections, 'REMOVED Requirements').body).map((b) => [key(b.name), b.raw]))
  const modified = new Map(plan.modified.map((b) => [key(b.name), b.raw]))
  const renameTargets = new Set(plan.renamed.map((r) => key(r.to)))
  return [
    ...plan.modified.filter((b) => !renameTargets.has(key(b.name))).map((b) => ({ requirement: key(b.name), operation: 'MODIFIED', delta: b.raw })),
    ...plan.removed.map((name) => ({ requirement: key(name), operation: 'REMOVED', delta: removedBlocks.get(key(name)) ?? `### Requirement: ${key(name)}` })),
    ...plan.renamed.map(({ from, to }) => ({
      requirement: key(from),
      operation: 'RENAMED',
      to: key(to),
      delta: [`- FROM: \`### Requirement: ${key(from)}\``, `- TO: \`### Requirement: ${key(to)}\``, ...(modified.has(key(to)) ? ['', modified.get(key(to))] : [])].join('\n')
    }))
  ]
}

// The three-way check of one capability: every requirement the delta modifies, removes or
// renames whose main-spec text at `nowText` differs from its text at `baseText` (the change's
// merge base). Each conflict carries the base text, the current text (null where the
// requirement is absent) and the delta's text; `side` names where the current text was read.
export function findConflicts(plan, deltaText, { baseText, nowText, side }) {
  const base = blocksByName(baseText)
  const now = blocksByName(nowText)
  return touchedRequirements(plan, deltaText)
    .filter(({ requirement }) => !sameBlock(base.get(requirement) ?? null, now.get(requirement) ?? null))
    .map((t) => ({ ...t, side, base: base.get(t.requirement) ?? null, current: now.get(t.requirement) ?? null }))
}

const RESOLUTION_FIELDS = ['capability', 'requirement', 'text', 'reason']

// A resolutions file's content: an array of { capability, requirement, text, reason }, at most
// one per requirement. `text` is the whole requirement block the main spec ends up with, its
// header first; an empty text is allowed for a REMOVED conflict only and keeps the removal.
export function checkResolutions(resolutions) {
  if (!Array.isArray(resolutions)) throw new Error('resolutions must be a JSON array of { capability, requirement, text, reason }')
  const seen = new Set()
  resolutions.forEach((r, i) => {
    for (const field of RESOLUTION_FIELDS) {
      if (typeof r?.[field] !== 'string') throw new Error(`resolution ${i}: "${field}" must be a string`)
    }
    if (!r.reason.trim()) throw new Error(`resolution ${i}: "reason" is empty`)
    const id = `${r.capability}\n${normalizeRequirementName(r.requirement)}`
    if (seen.has(id)) throw new Error(`resolution ${i}: ${r.capability} "${r.requirement}" is resolved twice`)
    seen.add(id)
  })
  return resolutions
}

// The plan with one conflict's resolved text in place of the delta's operation on it.
function resolvePlan(plan, conflict, resolution) {
  const key = normalizeRequirementName
  const text = normalizeLineEndings(resolution.text).trim()
  const where = `resolution for ${resolution.capability} "${conflict.requirement}"`
  if (!text) {
    if (conflict.operation !== 'REMOVED') throw new Error(`${where}: an empty text resolves a REMOVED conflict only`)
    return plan
  }
  const header = text.split('\n')[0].match(REQUIREMENT_HEADER)
  const expected = conflict.operation === 'RENAMED' ? conflict.to : conflict.requirement
  if (!header || key(header[1]) !== expected) throw new Error(`${where}: the text must start with "### Requirement: ${expected}"`)
  const block = { headerLine: text.split('\n')[0], name: expected, raw: text }
  if (conflict.operation === 'MODIFIED') return { ...plan, modified: plan.modified.map((b) => (key(b.name) === expected ? block : b)) }
  if (conflict.operation === 'REMOVED') {
    return { ...plan, removed: plan.removed.filter((n) => key(n) !== expected), modified: [...plan.modified, block] }
  }
  return { ...plan, modified: [...plan.modified.filter((b) => key(b.name) !== expected), block] }
}

// ---- The merge over a change: read, check, build, validate; write only when all is well ----

const SPECS_DIR = join('openspec', 'specs')
const mainSpecPath = (root, capability) => join(root, SPECS_DIR, capability, 'spec.md')
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

function gitText(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
}

// The change's base branch as a ref (`origin/<base>` when the remote has it) and its merge base
// with HEAD: { ref, sha }.
export function changeMergeBase(root, change) {
  const meta = changeMeta(root, change)
  if (typeof meta.base !== 'string' || !meta.base.trim()) throw new Error(`openspec/changes/${change}/.adf.json has no "base" branch; the three-way check needs it`)
  const ref = baseRef(meta, (name) => {
    try {
      gitText(root, 'rev-parse', '--verify', '--quiet', name)
      return true
    } catch {
      return false
    }
  })
  try {
    return { ref, sha: gitText(root, 'merge-base', ref, 'HEAD').trim() }
  } catch {
    throw new Error(`${ref} and HEAD have no merge base`)
  }
}

// A capability's main spec at a commit; null when it has none there.
function mainSpecAt(root, rev, capability) {
  try {
    return gitText(root, 'show', `${rev}:./openspec/specs/${capability}/spec.md`)
  } catch {
    return null
  }
}

const deltaCapabilities = (root, change) => {
  const dir = join(changeDir(root, change), 'specs')
  return listDirs(dir, (name) => existsSync(join(dir, name, 'spec.md')))
}

// The merge of every delta spec of `change` into the main specs under `root`, nothing written:
// per capability its counts, `new`, `merged` (the main spec already holds the delta), the
// conflicts of the three-way check and any refusal. The three-way check reads the main text at
// the change's merge base against the text on the base branch now (`side: 'base-branch'`) and
// in the working tree (`side: 'worktree'`); a conflict with a resolution is applied, one without
// leaves the capability unbuilt. A resolution that answers no conflict is refused (throws).
// `purposes` gives a new capability's Purpose line; the default is PURPOSE_PLACEHOLDER.
// Returns { preview, rebuilt: Map(capability -> text) }.
function prepareMerge(root, change, { resolutions = [], purposes = {} } = {}) {
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in openspec/changes`)
  checkResolutions(resolutions)
  const used = new Set()
  const rebuilt = new Map()
  const capabilities = []
  let base = null
  for (const capability of deltaCapabilities(root, change)) {
    const deltaText = readFileSync(join(changeDir(root, change), 'specs', capability, 'spec.md'), 'utf8')
    let plan = parseDeltaSpec(deltaText)
    const mainText = readOrNull(mainSpecPath(root, capability))
    const entry = { capability, new: mainText === null, merged: false, counts: countsOf(plan), conflicts: [] }
    capabilities.push(entry)
    try {
      checkDeltaPlan(capability, plan)
    } catch (error) {
      entry.error = error.message
      continue
    }
    if (deltaAlreadyMerged(plan, mainText)) {
      entry.merged = true
      continue
    }
    if (mainText !== null && plan.modified.length + plan.removed.length + plan.renamed.length > 0) {
      base ??= changeMergeBase(root, change)
      const baseText = mainSpecAt(root, base.sha, capability)
      const found = findConflicts(plan, deltaText, { baseText, nowText: mainSpecAt(root, base.ref, capability), side: 'base-branch' })
      const named = new Set(found.map((c) => c.requirement))
      found.push(...findConflicts(plan, deltaText, { baseText, nowText: mainText, side: 'worktree' }).filter((c) => !named.has(c.requirement)))
      for (const conflict of found) {
        const resolution = resolutions.find((r) => r.capability === capability && normalizeRequirementName(r.requirement) === conflict.requirement)
        if (resolution) {
          used.add(resolution)
          plan = resolvePlan(plan, conflict, resolution)
          entry.conflicts.push({ ...conflict, resolved: true, reason: resolution.reason })
        } else {
          entry.conflicts.push({ ...conflict, resolved: false })
        }
      }
    }
    if (entry.conflicts.some((c) => !c.resolved)) continue
    // A re-run with the same resolutions finds the resolved text already in place.
    if (entry.conflicts.length > 0 && deltaAlreadyMerged(plan, mainText)) {
      entry.merged = true
      continue
    }
    try {
      const built = buildUpdatedSpec({ capability, plan, mainText, purpose: purposes[capability] })
      if (built.warnings.length > 0) entry.warnings = built.warnings
      const report = validateSpecContent(built.rebuilt, { name: capability, strict: true })
      if (!report.valid) {
        entry.error = `Validation errors in rebuilt spec for ${capability}`
        entry.issues = report.issues.filter((i) => i.level !== 'INFO')
        continue
      }
      if (hasPlaceholderPurpose(built.rebuilt)) entry.placeholderPurpose = true
      rebuilt.set(capability, built.rebuilt)
    } catch (error) {
      entry.error = error.message
    }
  }
  const unused = resolutions.filter((r) => !used.has(r))
  if (unused.length > 0) {
    throw new Error(`resolutions answer no conflict: ${unused.map((r) => `${r.capability} "${r.requirement}"`).join(', ')}; a resolution applies to a conflict of the three-way check only`)
  }
  const totals = { added: 0, modified: 0, removed: 0, renamed: 0 }
  for (const c of capabilities) for (const k of Object.keys(totals)) totals[k] += c.counts[k]
  const conflicts = capabilities.flatMap((c) => c.conflicts.filter((x) => !x.resolved).map((x) => ({ capability: c.capability, ...x })))
  const errors = capabilities.filter((c) => c.error).map(({ capability, error, issues }) => ({ capability, error, ...(issues ? { issues } : {}) }))
  const preview = {
    ok: conflicts.length === 0 && errors.length === 0,
    change,
    noChanges: capabilities.length === 0,
    merged: capabilities.length > 0 && capabilities.every((c) => c.merged),
    base,
    capabilities,
    totals,
    newCapabilities: capabilities.filter((c) => c.new && !c.merged).map((c) => c.capability),
    placeholderPurpose: capabilities.filter((c) => c.placeholderPurpose).map((c) => c.capability),
    conflicts,
    errors
  }
  return { preview, rebuilt }
}

// The read-only preview of the merge (`specs.mjs merge --dry-run`): prepareMerge's result.
// { ok, change, noChanges, merged, base: { ref, sha } | null, capabilities: [{ capability, new,
//   merged, counts, conflicts, warnings?, error?, issues?, placeholderPurpose? }], totals,
//   newCapabilities, placeholderPurpose, conflicts, errors }
export function mergePreview(root, change, options = {}) {
  return prepareMerge(root, change, options).preview
}

// The writing merge, for archive.mjs after its gate: all or nothing. Nothing is written while
// any capability has an unresolved conflict or a refusal, or a rebuilt spec fails the strict
// validation; otherwise every capability not already merged gets its rebuilt main spec.
// Returns the preview plus `written`, the repository-relative paths written.
export function writeMerge(root, change, options = {}) {
  const { preview, rebuilt } = prepareMerge(root, change, options)
  if (!preview.ok) return { ...preview, written: [] }
  const written = []
  for (const [capability, text] of rebuilt) {
    const path = mainSpecPath(root, capability)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    written.push(`openspec/specs/${capability}/spec.md`)
  }
  return { ...preview, written }
}
