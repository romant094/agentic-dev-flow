// lib/reply-render.mjs and `reply.mjs render`: the Markdown a person reads of any reply, from its
// JSON and, when the attempts log recorded it, from its computed result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordReply } from '../lib/attempts.mjs'
import { fence, render, RENDERED_ROLES, roleOf } from '../lib/reply-render.mjs'
import { run, UsageError } from '../reply.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'reply.mjs')
const CHANGE = 'add-x'

const FINDING = { severity: 'important', kind: 'quality', category: 'tests', file: 'src/a.mjs', line: 4, title: 'no test for the error path', body: 'Add one.' }
const PATCH = 'diff --git a/.claude/skills/s/SKILL.md b/.claude/skills/s/SKILL.md\n--- a/.claude/skills/s/SKILL.md\n+++ b/.claude/skills/s/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n'

// One reply per role, each its schema's minimal valid shape.
const REPLIES = {
  impl: { role: 'impl', outcome: 'blocked', commits: [], concerns: [{ text: 'the API is missing', file: 'src/api.mjs' }], blocker: 'the endpoint does not exist', summary: 'stopped' },
  review: { role: 'review', summary: 'one gap', findings: [FINDING], unverifiable: [] },
  're-review': { role: 're-review', summary: 'fixed', previous: [{ id: 'F1', status: 'addressed', file: 'src/a.mjs', line: 4 }], findings: [], outOfScope: [] },
  sweep: { role: 'sweep', findings: [{ introduced: 'src/b.mjs:3', existing: 'src/util.mjs:10', why: 'the same parser' }] },
  investigate: { role: 'investigate', answer: 'it is cached', evidence: [{ file: 'src/c.mjs', line: 2 }] },
  'verify-c4': { role: 'verify-c4', case: 'both', findings: [], proseEdits: [], removalAccounting: [], exercised: [], summary: 'coherent' },
  'verify-c8': { role: 'verify-c8', candidates: [{ file: '.claude/skills/s/SKILL.md', line: 1, class: 'CONFIRMED', fact: 'it says old', why: 'the diff made it new', patch: PATCH }], summary: 'one stale line' }
}
const NAMED = {
  'ai-review r1': { summary: 'one issue', findings: [{ id: 'F1', severity: 'HIGH', category: 'security', file: 'src/a.mjs', line: 1, title: 'injection', body: 'escape it' }] },
  'ai-fix F1 r1': { finding: 'F1', outcome: 'fixed', sha: 'abcdef1234', failureMode: 'unescaped input' },
  'spec-merge greeting': [{ capability: 'greeting', requirement: 'Greeting', text: '### Requirement: Greeting\nThe system SHALL greet.', reason: 'both sides kept' }],
  ingest: { nothingLearned: true, pages: [], stale: [], invariant: '', likelyMistake: '' }
}

test('every role renders, its name or role as the heading', () => {
  for (const [role, reply] of Object.entries(REPLIES)) assert.match(render(reply), new RegExp(`^## ${role}\\n\\n`), role)
  for (const [name, reply] of Object.entries(NAMED)) assert.match(render(reply, { name }), new RegExp(`^## ${name}\\n\\n`), name)
  const covered = new Set([...Object.keys(REPLIES), ...Object.keys(NAMED).map((n) => roleOf(NAMED[n], n))])
  assert.deepEqual(RENDERED_ROLES.filter((r) => !covered.has(r)), ['fix', 'final-review', 'merge-review'], 'the rest share a renderer')
  assert.throws(() => render({ summary: 'x' }), /names no role; pass the dispatch name/)
  assert.throws(() => render({}, { name: 'T3 implement' }), /not a dispatch name/)
  assert.equal(roleOf([], undefined), 'spec-merge')
})

test('an escalation, a review, the sweep and the c8 edits read as the developer needs them', () => {
  const impl = render(REPLIES.impl, { name: 'T3 impl' })
  assert.match(impl, /\*\*Status:\*\* blocked\n\nstopped\n\n\*\*Blocker:\*\*\n\nthe endpoint does not exist/)
  assert.match(impl, /\*\*Concerns:\*\*\n\n- src\/api\.mjs: the API is missing/)
  const status = render(REPLIES.impl, { name: 'T3 impl', result: { status: 'BLOCKED', commits: [], tests: { result: null, counts: null, runs: [] }, concerns: [{ text: 'scope', file: 'x', source: 'script' }] } })
  assert.match(status, /\*\*Status:\*\* BLOCKED/)
  assert.match(status, /- x: scope \(found by script\)/)
  const review = render(REPLIES.review, { name: 'T3 review', result: { spec: 'pass', quality: 'needs-fixes', result: 'fix', findings: [{ id: 'F2', ...FINDING }] } })
  assert.match(review, /\*\*Spec:\*\* pass; \*\*quality:\*\* needs-fixes; \*\*next:\*\* fix/)
  assert.match(review, /- \*\*F2\*\* \[important, quality\/tests\] src\/a\.mjs:4: no test for the error path\n {2}Add one\./)
  assert.match(render(REPLIES.sweep), /\*\*Duplicates:\*\*\n\n- src\/b\.mjs:3 duplicates src\/util\.mjs:10: the same parser/)
  const c8 = render(REPLIES['verify-c8'], { name: 'verify c8' })
  assert.match(c8, /\*\*CONFIRMED:\*\*\n\n- \.claude\/skills\/s\/SKILL\.md:1: it says old \(the diff made it new\)\n\n```diff\ndiff --git a\/\.claude/)
  assert.match(c8, /\*\*PLAUSIBLE:\*\*\n\nnone/)
  assert.equal(fence('a ``` b'), '````\na ``` b\n````')
})

test('reply.mjs render prints the Markdown of a reply file, with its computed result when --change names its log', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-render-'))
  mkdirSync(join(root, 'replies'), { recursive: true })
  const file = join(root, 'replies', 'T3-review.json')
  writeFileSync(file, `\`\`\`json\n${JSON.stringify(REPLIES.review)}\n\`\`\``)
  let out = run(['render', '--file', file])
  assert.deepEqual([out.ok, out.role, out.name], [true, 'review', null])
  assert.match(out.markdown, /^## review\n\none gap\n\n\*\*Findings:\*\*\n\n- \[important/)
  recordReply(root, CHANGE, { name: 'T3 review', file, result: { spec: 'pass', quality: 'needs-fixes', result: 'fix', findings: [{ id: 'F7', ...FINDING }] } })
  out = run(['render', '--file', 'replies/T3-review.json', '--change', CHANGE, '--root', root])
  assert.equal(out.name, 'T3 review')
  assert.match(out.markdown, /^## T3 review\n/)
  assert.match(out.markdown, /- \*\*F7\*\* /)
  writeFileSync(join(root, 'fix.json'), JSON.stringify(NAMED['ai-fix F1 r1']))
  assert.throws(() => run(['render', '--file', join(root, 'fix.json')]), UsageError)
  assert.match(run(['render', '--file', join(root, 'fix.json'), '--name', 'ai-fix F1 r1']).markdown, /\*\*F1:\*\* fixed in `abcdef1`/)
  writeFileSync(join(root, 'bad.json'), 'prose, not JSON')
  assert.equal(run(['render', '--file', join(root, 'bad.json')]).ok, false)
  writeFileSync(join(root, 'odd.json'), JSON.stringify({ role: 'review' }))
  assert.match(run(['render', '--file', join(root, 'odd.json')]).error, /does not have its role's shape/)
  const proc = spawnSync(process.execPath, [CLI, 'render', '--file', file], { encoding: 'utf8' })
  assert.equal(proc.status, 0)
  assert.equal(JSON.parse(proc.stdout).role, 'review')
  assert.equal(spawnSync(process.execPath, [CLI, 'render'], { encoding: 'utf8' }).status, 2)
})
