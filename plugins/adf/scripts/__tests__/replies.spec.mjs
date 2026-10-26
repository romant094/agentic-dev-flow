// The reply schemas of the apply and verify roles under schema/: each uses only the keywords
// lib/json-schema.mjs implements, accepts a valid reply and refuses an invalid one with the
// error that names the broken field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReply, readSchema, unknownKeywords, validateJson } from '../lib/json-schema.mjs'

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
const schemaOf = (name) => readSchema(join(SCHEMA_DIR, `${name}.schema.json`))

const finding = { severity: 'important', kind: 'quality', category: 'tests', file: 'src/a.mjs', line: 12, title: 'Unchecked error', body: 'The error of readFile is dropped.' }
const PATCH = 'diff --git a/.claude/skills/x/SKILL.md b/.claude/skills/x/SKILL.md\n--- a/.claude/skills/x/SKILL.md\n+++ b/.claude/skills/x/SKILL.md\n@@ -3 +3 @@\n-old\n+new\n'

// name: [valid reply, invalid reply, an error the invalid reply must produce]
const CASES = {
  impl: [
    { role: 'impl', outcome: 'done', commits: ['abc1234'], testRuns: ['tests/task-1-20261019T1200.json'], concerns: [{ text: 'The timeout is a guess.', file: 'src/a.mjs' }], summary: 'Added the parser.' },
    { role: 'impl', outcome: 'done', commits: ['abc1234'], concerns: [], summary: 'Added the parser.', status: 'DONE' },
    ['$: testRuns is required', '$: status is not allowed']
  ],
  'task-review': [
    { role: 'review', summary: 'One quality finding.', findings: [finding, { ...finding, severity: 'minor', kind: 'spec', category: 'missing', line: null, planMandated: true }], unverifiable: [{ requirement: 'R2', check: 'Run it on hardware.' }] },
    { role: 'review', summary: 'Fails.', verdict: 'fail', findings: [{ ...finding, severity: 'HIGH', category: 'style' }, (({ category, ...rest }) => rest)(finding)], unverifiable: [] },
    ['$: verdict is not allowed', '$.findings[0].severity: must be one of critical, important, minor', '$.findings[0].category: must be one of missing, extra', '$.findings[1]: category is required']
  ],
  're-review': [
    { role: 're-review', summary: 'F1 addressed.', previous: [{ id: 'F1', status: 'addressed', file: 'src/a.mjs', line: 12 }], findings: [], outOfScope: [{ file: 'src/b.mjs', line: null, title: 'Old naming' }] },
    { role: 're-review', summary: 'F1 open.', previous: [{ id: '1', status: 'open', file: 'src/a.mjs', line: 12 }], findings: [] },
    ['$: outOfScope is required', '$.previous[0].id: "1" does not match ^[FS][1-9][0-9]*$', '$.previous[0].status: must be one of addressed, not-addressed']
  ],
  sweep: [
    { role: 'sweep', findings: [{ introduced: 'src/new.mjs:4 parseDate', existing: 'src/util.mjs:20 parseDate', why: 'Same parsing.' }], dispositions: [{ requirement: 'Old export', disposition: 'Removed with its callers.' }] },
    { role: 'sweep', verdict: 'CLEAN', findings: [{ introduced: 'src/new.mjs:4', existing: '' }] },
    ['$: verdict is not allowed', '$.findings[0]: why is required', '$.findings[0].existing: must not be empty']
  ],
  investigate: [
    { role: 'investigate', answer: 'The retry key is the reply content.', evidence: [{ file: 'scripts/lib/review-state.mjs', line: 40 }, { file: 'README.md' }] },
    { role: 'investigate', answer: '', evidence: [{ line: 0 }] },
    ['$.answer: must not be empty', '$.evidence[0]: file is required', '$.evidence[0].line: must be at least 1']
  ],
  'verify-c4': [
    {
      role: 'verify-c4',
      case: 'both',
      findings: [{ kind: 'doc-drift', where: [{ file: 'docs/a.md', line: 3 }, { file: 'docs/b.md', line: null }], text: 'The two pages disagree.' }],
      proseEdits: [{ capability: 'review', commit: 'abc1234', reason: null }],
      removalAccounting: [{ requirement: 'Old flag', op: 'REMOVED', disposition: null, holds: true, oldPathReachable: false }],
      exercised: [{ mechanism: 'retry', path: 'scripts/lib/attempts.mjs', exercisedBy: null }],
      summary: 'One drift.'
    },
    { role: 'verify-c4', case: 'both', verdict: 'pass', findings: [{ kind: 'drift', where: [], text: 'x' }], proseEdits: [], removalAccounting: [{ requirement: 'Old flag', op: 'MODIFIED', disposition: null, holds: 'yes', oldPathReachable: false }], exercised: [], summary: 'x' },
    ['$: verdict is not allowed', '$.findings[0].kind: must be one of', '$.findings[0].where: must hold at least 1 item', '$.removalAccounting[0].op: must be one of REMOVED, RENAMED', '$.removalAccounting[0].holds: expected boolean']
  ],
  'verify-c8': [
    { role: 'verify-c8', candidates: [{ file: '.claude/skills/x/SKILL.md', line: 3, class: 'CONFIRMED', fact: 'The path moved.', why: 'The diff renamed it.', patch: PATCH }, { file: '.claude/skills/x/README.md', line: 8, class: 'none', fact: 'Unrelated.', why: 'Another term.' }], summary: 'One stale line.' },
    { role: 'verify-c8', candidates: [{ file: '.claude/skills/x/SKILL.md', line: 3, class: 'CONFIRMED', fact: 'The path moved.', why: 'The diff renamed it.' }, { file: '.claude/skills/x/SKILL.md', line: 5, class: 'PLAUSIBLE', fact: 'f', why: 'w', patch: '--- a/x\n+++ b/x\n' }], summary: 'x' },
    ['$.candidates[0]: patch is required', '$.candidates[1].patch: "--- a/x\n+++ b/x\n" does not match ^diff --git ']
  ]
}

for (const [name, [valid, invalid, expected]] of Object.entries(CASES)) {
  test(`${name}.schema.json uses only the keywords validateJson implements`, () => {
    assert.deepEqual(unknownKeywords(schemaOf(name)), [])
  })

  test(`${name}.schema.json accepts a valid reply`, () => {
    const parsed = parseReply(JSON.stringify(valid))
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(validateJson(schemaOf(name), parsed.reply), [])
  })

  test(`${name}.schema.json refuses an invalid reply and names the broken fields`, () => {
    const errors = validateJson(schemaOf(name), invalid)
    for (const e of expected) assert.ok(errors.some((got) => got.startsWith(e)), `missing "${e}" in ${JSON.stringify(errors)}`)
  })
}

test('impl.schema.json requires a blocker when the outcome is not done', () => {
  const schema = schemaOf('impl')
  for (const outcome of ['blocked', 'needs-context']) {
    assert.deepEqual(validateJson(schema, { role: 'fix', outcome, commits: [], concerns: [], summary: 'Stopped.' }), ['$: blocker is required'])
  }
})

test('impl.schema.json requires a test-run record when the outcome is done; the commit rule is the plan\'s (reply.spec)', () => {
  const schema = schemaOf('impl')
  const done = { role: 'impl', outcome: 'done', commits: [], testRuns: [], concerns: [], summary: 'Done.' }
  assert.deepEqual(validateJson(schema, done), ['$.testRuns: must hold at least 1 item'])
  assert.deepEqual(validateJson(schema, { ...done, outcome: 'blocked', blocker: 'No access.' }), [])
})

test('minItems counts the items of an array and is a known keyword', () => {
  const schema = { type: 'array', minItems: 2 }
  assert.deepEqual(unknownKeywords(schema), [])
  assert.deepEqual(validateJson(schema, [1]), ['$: must hold at least 2 items'])
  assert.deepEqual(validateJson(schema, [1, 2]), [])
  assert.deepEqual(validateJson({ type: 'string', minItems: 1 }, ''), [])
})

test('every reply schema requires its role', () => {
  for (const name of Object.keys(CASES)) {
    const { role, ...rest } = CASES[name][0]
    assert.ok(validateJson(schemaOf(name), rest).includes('$: role is required'), name)
  }
})
