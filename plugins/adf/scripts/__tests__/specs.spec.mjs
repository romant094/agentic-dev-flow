// lib/specs.mjs rule by rule (a passing and a failing case each), then the CLI end to end
// against the fixture project. Expected messages are the openspec CLI 1.5.0's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractRequirementsSection,
  listChangeIds,
  listSpecIds,
  MESSAGES,
  parseDeltaSpec,
  validateChangeDeltaSpecs,
  validateSpecContent
} from '../lib/specs.mjs'
import { git, mergeRepo } from './fixtures/spec-merge/repo.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'specs.mjs')
const fixtures = join(here, '..', '..', '..', '..', 'test', 'fixtures', 'specs')
const VALID_SPEC = readFileSync(join(fixtures, 'valid-spec.md'), 'utf8')
const VALID_DELTA = readFileSync(join(fixtures, 'valid-delta.md'), 'utf8')

const issues = (result) => result.issues.map(({ level, path, message }) => `${level} ${path} ${message}`)
const spec = (content, options) => validateSpecContent(content, options)

// A change directory holding one delta spec per entry of `files` (capability -> content).
function change(files) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-specs-'))
  for (const [capability, content] of Object.entries(files)) {
    mkdirSync(join(dir, 'specs', capability), { recursive: true })
    writeFileSync(join(dir, 'specs', capability, 'spec.md'), content)
  }
  return dir
}
const delta = (content, options) => validateChangeDeltaSpecs(change({ cap: content }), options)
const req = (name, body = 'The system SHALL do it.') => `### Requirement: ${name}\n${body}\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n`

// ---- Main specs ----

test('a well-formed main spec has no issues', () => {
  assert.deepEqual(spec(VALID_SPEC), { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } })
})

test('a main spec needs a non-empty Purpose section', () => {
  const guide = `Spec must have a Purpose section. ${MESSAGES.GUIDE_MISSING_SPEC_SECTIONS}`
  assert.deepEqual(issues(spec(VALID_SPEC.replace('## Purpose', '## Goal'))), [`ERROR file ${guide}`])
  const empty = VALID_SPEC.replace(/## Purpose\n\n.*\n/, '## Purpose\n\n')
  assert.deepEqual(issues(spec(empty)), [`ERROR file ${guide}`])
  assert.equal(spec(VALID_SPEC.replace('## Purpose', '### Purpose')).valid, true)
})

test('a main spec needs a Requirements section with a requirement', () => {
  const missing = spec(VALID_SPEC.replace('## Requirements', '## Reqs'))
  assert.deepEqual(issues(missing), [`ERROR file Spec must have a Requirements section. ${MESSAGES.GUIDE_MISSING_SPEC_SECTIONS}`])
  const empty = spec(`${VALID_SPEC.split('## Requirements')[0]}## Requirements\n`)
  assert.deepEqual(issues(empty), ['ERROR requirements Spec must have at least one requirement'])
})

test('a main requirement needs SHALL or MUST in its first line, as a substring', () => {
  const result = spec(VALID_SPEC.replace('The system SHALL store', 'The system stores'))
  assert.deepEqual(issues(result), ['ERROR requirements.0.text Requirement must contain SHALL or MUST keyword'])
  assert.equal(spec(VALID_SPEC.replace('The system SHALL store', 'The MUSTARD stores')).valid, true)
})

test('a main requirement with a blank header and no body has empty text', () => {
  const blank = VALID_SPEC.replace(/### Requirement: Widgets are stored\nThe system SHALL store every widget it builds.\n/, '###   \n')
  assert.deepEqual(issues(spec(blank)).slice(0, 2), [
    'ERROR requirements.0.text Requirement text cannot be empty',
    'ERROR requirements.0.text Requirement must contain SHALL or MUST keyword'
  ])
})

test('a main requirement needs a scenario: an error and a warning', () => {
  const result = spec(VALID_SPEC.replace(/#### Scenario: A built widget is stored\n- \*\*WHEN\*\* a widget is built\n- \*\*THEN\*\* it is stored\n/, ''))
  assert.deepEqual(issues(result), [
    'ERROR requirements.0.scenarios Requirement must have at least one scenario',
    `WARNING requirements[0].scenarios Requirement must have at least one scenario. ${MESSAGES.GUIDE_SCENARIO_FORMAT}`
  ])
  assert.equal(spec(VALID_SPEC.replace('#### Scenario: A built', '##### Scenario: A built')).valid, true)
  assert.equal(spec(VALID_SPEC.replace('#### Scenario: A built widget is stored', '- **Scenario: A built widget is stored**')).valid, false)
})

test('a brief Purpose warns, and fails only in strict mode', () => {
  const brief = VALID_SPEC.replace(/## Purpose\n\n.*\n/, '## Purpose\n\nToo short.\n')
  assert.deepEqual(issues(spec(brief)), [`WARNING overview ${MESSAGES.PURPOSE_TOO_BRIEF}`])
  assert.equal(spec(brief).valid, true)
  assert.equal(spec(brief, { strict: true }).valid, false)
})

test('a requirement text over 500 characters is INFO only', () => {
  const long = spec(VALID_SPEC.replace('every widget it builds.', `every widget${' it builds'.repeat(60)}.`))
  assert.deepEqual(issues(long), [`INFO requirements[0] ${MESSAGES.REQUIREMENT_TOO_LONG}`])
  assert.equal(long.valid, true)
  assert.equal(spec(VALID_SPEC.replace('every widget it builds.', `every widget${' x'.repeat(200)}.`)).issues.length, 0)
})

test('a delta header in a main spec is an error with its line, unless fenced', () => {
  const result = spec(`${VALID_SPEC}\n## ADDED Requirements\n`)
  assert.equal(result.valid, false)
  assert.equal(result.issues[0].line, VALID_SPEC.split('\n').length + 1)
  assert.match(result.issues[0].message, /^Main spec contains delta header "## ADDED Requirements"\./)
  assert.equal(spec(`${VALID_SPEC}\n\`\`\`\n## ADDED Requirements\n\`\`\`\n`).valid, true)
})

test('a requirement header outside ## Requirements is an error with its line', () => {
  const result = spec(`${VALID_SPEC}\n## Notes\n\n${req('Stray')}`)
  const issue = result.issues.find((i) => i.line)
  assert.deepEqual({ level: issue.level, path: issue.path, line: issue.line }, { level: 'ERROR', path: 'file', line: VALID_SPEC.split('\n').length + 3 })
  assert.match(issue.message, /^Requirement header "### Requirement: Stray" appears outside the main ## Requirements section\./)
})

test('CRLF line endings parse like LF', () => {
  assert.deepEqual(spec(VALID_SPEC.replace(/\n/g, '\r\n')), spec(VALID_SPEC))
})

// ---- Delta specs ----

test('a well-formed delta spec has no issues', () => {
  assert.deepEqual(delta(VALID_DELTA), { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } })
})

test('an ADDED or MODIFIED requirement needs SHALL or MUST as a word in its body', () => {
  const added = delta(VALID_DELTA.replace('The system SHALL archive', 'The system archives'))
  assert.deepEqual(issues(added), ['ERROR cap/spec.md ADDED "Widgets are archived" must contain SHALL or MUST'])
  const modified = delta(VALID_DELTA.replace('The system MUST report', 'The MUSTARD reports'))
  assert.deepEqual(issues(modified), ['ERROR cap/spec.md MODIFIED "Widgets are reported" must contain SHALL or MUST'])
})

test('SHALL only in the header gets the longer message', () => {
  const result = delta(`## ADDED Requirements\n\n${req('It SHALL work', 'It works.')}`)
  assert.match(result.issues[0].message, /^ADDED "It SHALL work" must contain SHALL or MUST in the requirement body, not only in the header\./)
})

test('a delta requirement needs body text; metadata lines are skipped', () => {
  const missing = delta('## ADDED Requirements\n\n### Requirement: Bare\n\n#### Scenario: s\n- x\n')
  assert.deepEqual(issues(missing), ['ERROR cap/spec.md ADDED "Bare" is missing requirement text'])
  assert.equal(delta(`## ADDED Requirements\n\n${req('Meta', '**ID**: R-1\nThe system SHALL x.')}`).valid, true)
  assert.equal(delta(`## ADDED Requirements\n\n${req('Meta', '**ID**: R-1')}`).valid, false)
})

test('a delta requirement needs a level-4 scenario header', () => {
  const none = delta('## MODIFIED Requirements\n\n### Requirement: X\nThe system SHALL x.\n')
  assert.deepEqual(issues(none), ['ERROR cap/spec.md MODIFIED "X" must include at least one scenario'])
  const level5 = delta(`## ADDED Requirements\n\n${req('X').replace('####', '#####')}`)
  assert.equal(level5.valid, false)
})

test('delta sections with no parsed entries name the sections found', () => {
  const one = delta('## ADDED Requirements\n\nNothing.\n')
  assert.equal(one.issues[0].message.startsWith('Delta sections ## ADDED Requirements were found, but no requirement entries parsed.'), true)
  const three = delta('## MODIFIED Requirements\n\n## REMOVED Requirements\n\n## RENAMED Requirements\n- FROM: `### Requirement: A`\n')
  assert.match(three.issues[0].message, /^Delta sections ## MODIFIED Requirements, ## REMOVED Requirements and ## RENAMED Requirements were found/)
  assert.equal(three.issues[1].message, `${MESSAGES.CHANGE_NO_DELTAS}. ${MESSAGES.GUIDE_NO_DELTAS}`)
})

test('a delta spec without delta headers, or a change without specs, has no deltas', () => {
  const plain = delta('# Notes\n\nNo deltas.\n')
  assert.deepEqual(plain.issues.map((i) => i.path), ['cap/spec.md', 'file'])
  assert.match(plain.issues[0].message, /^No delta sections found\./)
  const empty = validateChangeDeltaSpecs(mkdtempSync(join(tmpdir(), 'adf-specs-')))
  assert.deepEqual(issues(empty), [`ERROR file ${MESSAGES.CHANGE_NO_DELTAS}. ${MESSAGES.GUIDE_NO_DELTAS}`])
})

test('duplicates within a section are errors', () => {
  assert.deepEqual(issues(delta(`## ADDED Requirements\n\n${req('Same')}\n${req('Same ')}`)), ['ERROR cap/spec.md Duplicate requirement in ADDED: "Same"'])
  assert.deepEqual(issues(delta(`## MODIFIED Requirements\n\n${req('Same')}\n${req('Same')}`)), ['ERROR cap/spec.md Duplicate requirement in MODIFIED: "Same"'])
  assert.deepEqual(issues(delta('## REMOVED Requirements\n\n- `### Requirement: Old`\n### Requirement: Old\n')), ['ERROR cap/spec.md Duplicate requirement in REMOVED: "Old"'])
  const renamed = delta('## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n')
  assert.deepEqual(issues(renamed), ['ERROR cap/spec.md Duplicate FROM in RENAMED: "A"', 'ERROR cap/spec.md Duplicate TO in RENAMED: "B"'])
})

test('a requirement in two conflicting sections is an error', () => {
  const removed = '## REMOVED Requirements\n\n- `### Requirement: Same`\n'
  assert.deepEqual(issues(delta(`## MODIFIED Requirements\n\n${req('Same')}\n${removed}`)), ['ERROR cap/spec.md Requirement present in both MODIFIED and REMOVED: "Same"'])
  assert.deepEqual(issues(delta(`## ADDED Requirements\n\n${req('Same')}\n## MODIFIED Requirements\n\n${req('Same')}`)), ['ERROR cap/spec.md Requirement present in both MODIFIED and ADDED: "Same"'])
  assert.deepEqual(issues(delta(`## ADDED Requirements\n\n${req('Same')}\n${removed}`)), ['ERROR cap/spec.md Requirement present in both ADDED and REMOVED: "Same"'])
  const rename = '## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n'
  assert.deepEqual(issues(delta(`${rename}\n## MODIFIED Requirements\n\n${req('Old')}`)), ['ERROR cap/spec.md MODIFIED references old name from RENAMED. Use new header for "New"'])
  assert.deepEqual(issues(delta(`${rename}\n## ADDED Requirements\n\n${req('New')}`)), ['ERROR cap/spec.md RENAMED TO collides with ADDED for "New"'])
})

test('a RENAMED entry needs both FROM and TO', () => {
  assert.equal(delta('## RENAMED Requirements\n\nFROM: ### Requirement: A\nTO: ### Requirement: B\n').valid, true)
  assert.equal(delta('## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n').valid, false)
  assert.equal(delta('## RENAMED Requirements\n\n- FROM: `A`\n- TO: `B`\n').valid, false)
})

test('issues are reported per capability file', () => {
  const dir = change({ a: VALID_DELTA, b: '## ADDED Requirements\n' })
  assert.deepEqual(validateChangeDeltaSpecs(dir).issues.map((i) => i.path), ['b/spec.md'])
})

// ---- Parsers ----

test('parseDeltaSpec returns the blocks, names and pairs of each section', () => {
  const plan = parseDeltaSpec(VALID_DELTA)
  assert.deepEqual(plan.added.map((b) => b.name), ['Widgets are archived'])
  assert.equal(plan.added[0].raw.split('\n')[0], '### Requirement: Widgets are archived')
  assert.deepEqual(plan.modified.map((b) => b.name), ['Widgets are reported'])
  assert.deepEqual(plan.removed, ['Widgets are printed'])
  assert.deepEqual(plan.renamed, [{ from: 'Widgets are stored', to: 'Widgets are persisted' }])
  assert.deepEqual(plan.sectionPresence, { added: true, modified: true, removed: true, renamed: true })
})

test('extractRequirementsSection splits a main spec into parts that rebuild it', () => {
  const parts = extractRequirementsSection(VALID_SPEC)
  assert.deepEqual(parts.bodyBlocks.map((b) => b.name), ['Widgets are stored', 'Widgets are reported'])
  assert.equal(parts.headerLine, '## Requirements')
  const rebuilt = [parts.before.trimEnd(), '', parts.headerLine, '', parts.bodyBlocks.map((b) => b.raw).join('\n\n'), ''].join('\n')
  assert.equal(rebuilt, VALID_SPEC)
  assert.deepEqual(extractRequirementsSection('# T\n').bodyBlocks, [])
})

test('item discovery skips archive, changes without proposal.md, specs without spec.md', () => {
  const root = join(fixtures, 'project')
  assert.deepEqual(listChangeIds(root), ['bad-change', 'good-change'])
  assert.deepEqual(listSpecIds(root), ['bad', 'good'])
})

// ---- CLI ----

function adf(root, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root], { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

test('validate prints the openspec --json report and exits 1 on an invalid item', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-specs-e2e-'))
  cpSync(join(fixtures, 'project'), root, { recursive: true })

  const all = adf(root, 'validate', '--all')
  assert.equal(all.code, 1)
  assert.deepEqual(all.out.items.map((i) => `${i.type}/${i.id}:${i.valid}`), [
    'spec/bad:false', 'change/bad-change:false', 'spec/good:true', 'change/good-change:true'
  ])
  assert.deepEqual(all.out.summary, {
    totals: { items: 4, passed: 2, failed: 2 },
    byType: { change: { items: 2, passed: 1, failed: 1 }, spec: { items: 2, passed: 1, failed: 1 } }
  })
  assert.equal(all.out.version, '1.0')
  assert.equal(all.out.root.path, root)
  assert.deepEqual(all.out.items[0].issues, [{ level: 'ERROR', path: 'requirements.0.text', message: MESSAGES.REQUIREMENT_NO_SHALL }])
  assert.equal(typeof all.out.items[0].durationMs, 'number')
  assert.deepEqual(adf(root, 'validate').out.summary, all.out.summary)

  const one = adf(root, 'validate', '--spec', 'good')
  assert.equal(one.code, 0)
  assert.deepEqual(one.out.summary, { totals: { items: 1, passed: 1, failed: 0 }, byType: { spec: { items: 1, passed: 1, failed: 0 } } })
  assert.equal(adf(root, 'validate', '--change', 'good-change').code, 0)
  assert.equal(adf(root, 'validate', '--change', 'bad-change').code, 1)

  const unknown = adf(root, 'validate', '--change', 'no-proposal')
  assert.equal(unknown.code, 1)
  assert.deepEqual(unknown.out, { ok: false, error: "Unknown change 'no-proposal'." })
})

test('merge --dry-run previews the spec merge, writes nothing, and exits 1 on a conflict', () => {
  const main = `# widgets Specification\n\n## Purpose\nWidgets are built and stored by the system, one widget at a time.\n\n## Requirements\n${req('Build')}\n${req('Store', 'The system SHALL store it.')}`
  const { change, onDevelop } = mergeRepo({
    main: { widgets: main },
    delta: { widgets: `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store dry.')}`, 'new-cap': `## ADDED Requirements\n\n${req('Label')}` }
  })
  const clean = adf(change, 'merge', '--dry-run', '--change', 'add-x')
  assert.equal(clean.code, 0)
  assert.equal(clean.out.ok, true)
  assert.equal(clean.out.merged, false)
  assert.deepEqual(clean.out.totals, { added: 1, modified: 1, removed: 0, renamed: 0 })
  assert.deepEqual(clean.out.newCapabilities, ['new-cap'])
  assert.deepEqual(clean.out.conflicts, [])
  assert.deepEqual(adf(change, 'merge', '--dry-run').out, clean.out, 'the one active change is inferred')

  onDevelop({ 'openspec/specs/widgets/spec.md': main.replace('SHALL store it.', 'SHALL store it cold.') })
  const conflicted = adf(change, 'merge', '--dry-run', '--change', 'add-x')
  assert.equal(conflicted.code, 1)
  assert.deepEqual(conflicted.out.conflicts.map((c) => [c.capability, c.requirement, c.operation, c.side]), [['widgets', 'Store', 'MODIFIED', 'base-branch']])

  const file = join(mkdtempSync(join(tmpdir(), 'adf-resolutions-')), 'resolutions.json')
  writeFileSync(file, JSON.stringify([{ capability: 'widgets', requirement: 'Store', text: req('Store', 'The system SHALL store dry and cold.'), reason: 'both kept' }]))
  const resolved = adf(change, 'merge', '--dry-run', '--change', 'add-x', '--resolutions', file)
  assert.equal(resolved.code, 0)
  assert.deepEqual(resolved.out.capabilities.find((c) => c.capability === 'widgets').conflicts.map((c) => c.resolved), [true])
  writeFileSync(file, JSON.stringify([{ capability: 'new-cap', requirement: 'Label', text: req('Label'), reason: 'r' }]))
  const refused = adf(change, 'merge', '--dry-run', '--change', 'add-x', '--resolutions', file)
  assert.equal(refused.code, 1)
  assert.match(refused.out.error, /answer no conflict: new-cap "Label"/)
  assert.equal(git(change, 'status', '--porcelain'), '', 'the dry run writes nothing')

  const writing = adf(change, 'merge', '--change', 'add-x')
  assert.equal(writing.code, 2)
  assert.match(writing.out.error, /pass --dry-run/)
  assert.equal(adf(change, 'merge', '--dry-run', '--spec', 'widgets').code, 2)
  assert.equal(adf(change, 'validate', '--dry-run').code, 2)
})
