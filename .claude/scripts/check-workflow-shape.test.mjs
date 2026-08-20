import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { checkWorkflowShape, NON_CYCLE_COMMANDS } from './check-workflow-shape.mjs'

const realIo = {
  read: (f) => readFileSync(f, 'utf8'),
  list: (d) => readdirSync(d)
}

// A reader serving exactly the files a case needs, and nothing else.
const fake = (files, dirs = {}) => ({
  read: (f) => {
    if (!(f in files)) throw new Error(`ENOENT: ${f}`)
    return files[f]
  },
  list: (d) => dirs[d] ?? []
})

const SCHEMA = 'openspec/schemas/sdd-plus-superpowers/schema.yaml'
const TEMPLATE = 'openspec/schemas/sdd-plus-superpowers/templates/verify.md'
const COMMANDS = '.claude/commands/opsx'
const CLAUDE_MD = '.claude/CLAUDE.md'
const VERIFY_MD = '.claude/commands/opsx/verify.md'

// Eight artifacts, a linear `requires` chain from brainstorm to review, and
// `design` as the one side branch (`requires: [brainstorm]`, required by nothing) —
// this mirrors the real schema's shape closely enough for `mandatoryChain` to
// derive the same allowance (`design` alone may be skipped).
const schemaYaml = (sequence) => `
description: >
  Spec-driven workflow integrated with Superpowers skills.
  ${sequence}
  design is optional (produced from brainstorm but not required by tasks).

artifacts:
  - id: brainstorm
    generates: brainstorm.md
    requires: []
  - id: proposal
    generates: proposal.md
    requires:
      - brainstorm
  - id: design
    generates: design.md
    requires:
      - brainstorm
  - id: specs
    generates: "specs/**/*.md"
    requires:
      - proposal
  - id: tasks
    generates: tasks.md
    requires:
      - specs
  - id: plan
    generates: plan.md
    requires:
      - tasks
  - id: verify
    generates: verify.md
    requires:
      - plan
  - id: review
    generates: review.md
    requires:
      - verify
`

const FULL_SEQUENCE = 'brainstorm → proposal → specs → tasks → plan → verify → review.'

const claudeMd = ({ cycle, count, rows }) => `# CLAUDE.md

## 8. OpenSpec Change Workflow

Cycle: ${cycle}

${count} artifacts, in this order, under \`openspec/changes/<change-name>/\`:

| Artifact | Produced by | Answers |
|---|---|---|
${rows.map((r) => `| \`${r}\` | x | y |`).join('\n')}

## 9. Next Section

Unrelated prose that must not be scanned.
`

const FULL_CYCLE = '`/opsx:propose` → `/opsx:apply` → `/opsx:verify` → `/opsx:review` → `/opsx:archive`.'
const FULL_ROWS = [
  'brainstorm.md',
  'proposal.md',
  'design.md',
  'specs/**/*.md',
  'tasks.md',
  'plan.md',
  'verify.md',
  'review.md'
]

const verifyMd = (sections, checks) => `Its ${sections} sections are the ${checks} checks, in order.\n`

const templateMd = '## 1. A\n## 2. B\n## 3. C\n## 4. D\n## 5. E\n## 6. F\n## 7. G\n## 8. H\n## Overall Decision\n'

const baseDirs = {
  [COMMANDS]: ['apply.md', 'archive.md', 'propose.md', 'review.md', 'sync.md', 'verify.md']
}

function baseline(overrides = {}) {
  return {
    [SCHEMA]: schemaYaml(FULL_SEQUENCE),
    [TEMPLATE]: templateMd,
    [CLAUDE_MD]: claudeMd({ cycle: FULL_CYCLE, count: 'Eight', rows: FULL_ROWS }),
    [VERIFY_MD]: verifyMd('eight', 'eight'),
    ...overrides
  }
}

test('NON_CYCLE_COMMANDS declares sync.md as the only non-cycle command', () => {
  assert.deepEqual(NON_CYCLE_COMMANDS, ['sync.md'])
})

// --- Site 1: .claude/CLAUDE.md ---

test('a CLAUDE.md cycle line missing a command is reported', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: claudeMd({
        cycle: '`/opsx:propose` → `/opsx:apply` → `/opsx:verify` → `/opsx:archive`.',
        count: 'Eight',
        rows: FULL_ROWS
      })
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-cycle'))
})

test('a CLAUDE.md cycle line naming every cycle command is not reported', () => {
  const io = fake(baseline(), baseDirs)
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, true)
  assert.deepEqual(findings, [])
})

test('a stale CLAUDE.md artifact count is reported', () => {
  const io = fake(baseline({ [CLAUDE_MD]: claudeMd({ cycle: FULL_CYCLE, count: 'Seven', rows: FULL_ROWS }) }), baseDirs)
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-artifact-count' && f.expected === 8))
})

test('a CLAUDE.md artifact table missing a row is reported', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: claudeMd({ cycle: FULL_CYCLE, count: 'Eight', rows: FULL_ROWS.slice(0, 7) })
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-artifact-table'))
})

test('a complete, correct CLAUDE.md section is not reported', () => {
  const io = fake(baseline(), baseDirs)
  const { ok } = checkWorkflowShape(io)
  assert.equal(ok, true)
})

test('a table elsewhere in CLAUDE.md, outside the workflow section, is not scanned', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: `${claudeMd({ cycle: FULL_CYCLE, count: 'Eight', rows: FULL_ROWS })}\n| \`unrelated.md\` | x | y |\n`
    }),
    baseDirs
  )
  const { ok } = checkWorkflowShape(io)
  assert.equal(ok, true, 'text after the next ## heading is out of scope')
})

// --- Site 2: schema.yaml description sequence ---

test('a schema description sequence missing a required artifact is reported', () => {
  const io = fake(
    baseline({
      [SCHEMA]: schemaYaml('brainstorm → proposal → specs → tasks → verify → review.')
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  const finding = findings.find((f) => f.site === 'schema-description-sequence')
  assert.ok(finding, 'plan is required by verify, so its absence must be reported')
})

test('a schema description sequence omitting design (required by nothing) is clean', () => {
  const io = fake(
    baseline({
      [SCHEMA]: schemaYaml('brainstorm → proposal → specs → tasks → plan → verify → review.')
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, true, 'design is not on the mandatory chain, so its omission is not a finding')
  assert.deepEqual(findings, [])
})

// --- Site 3: .claude/commands/opsx/verify.md ---

test('a stale verify.md section count is reported', () => {
  const io = fake(baseline({ [VERIFY_MD]: verifyMd('seven', 'seven') }), baseDirs)
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'verify-md-sections' && f.expected === 8))
  assert.ok(findings.some((f) => f.site === 'verify-md-checks' && f.expected === 8))
})

test('a correct verify.md section count is not reported', () => {
  const io = fake(baseline(), baseDirs)
  const { ok } = checkWorkflowShape(io)
  assert.equal(ok, true)
})

// --- Missing anchors ---
//
// Every declaration site finds its anchor by pattern. A site that returns nothing when its
// anchor is absent switches itself off, and the most likely person to move an anchor is the
// one changing the shape — the exact case the check exists for.

const FULL_CLAUDE_MD = claudeMd({ cycle: FULL_CYCLE, count: 'Eight', rows: FULL_ROWS })

test('a renamed CLAUDE.md workflow section heading is reported', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: FULL_CLAUDE_MD.replace('## 8. OpenSpec Change Workflow', '## 8. Change Workflow')
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-section-missing'))
})

test('a CLAUDE.md workflow section with no Cycle line is reported', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: FULL_CLAUDE_MD.replace(`Cycle: ${FULL_CYCLE}`, `The cycle runs ${FULL_CYCLE}`)
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-cycle-missing'))
})

test('a CLAUDE.md workflow section with no artifact-count phrase is reported', () => {
  const io = fake(
    baseline({
      [CLAUDE_MD]: FULL_CLAUDE_MD.replace('Eight artifacts, in this order', 'The artifacts, in order')
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'claude-md-artifact-count-missing'))
})

test('a schema.yaml with no description block is reported', () => {
  const io = fake(
    baseline({
      [SCHEMA]: schemaYaml(FULL_SEQUENCE).replaceAll('description:', 'summary:')
    }),
    baseDirs
  )
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'schema-description-missing'))
})

test('a verify.md with no sections-and-checks sentence is reported', () => {
  const io = fake(baseline({ [VERIFY_MD]: 'Its sections correspond to the checks, in order.\n' }), baseDirs)
  const { ok, findings } = checkWorkflowShape(io)
  assert.equal(ok, false)
  assert.ok(findings.some((f) => f.site === 'verify-md-sections-missing'))
})

// --- Real repository ---

test('the real repository is clean', () => {
  const { ok, findings } = checkWorkflowShape(realIo)
  assert.deepEqual(
    findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ''} [${f.site}] expected ${f.expected}, got ${f.actual}`),
    []
  )
  assert.equal(ok, true)
})
