// Spec parsing and validation, ported from the openspec CLI 1.5.0 (core/validation/validator.js,
// core/parsers/{markdown-parser,requirement-blocks,spec-structure}.js and the zod schemas) so
// that `openspec validate --json` and this module agree on every item, issue level, path and
// message. Quirks of the original are kept on purpose; scripts/parity/openspec-validate.mjs
// checks the two against a real corpus. Node standard library only.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
