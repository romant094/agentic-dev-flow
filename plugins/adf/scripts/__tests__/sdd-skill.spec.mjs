// sdd.mjs brief and package: the skill's two scripts, called with the change's own output paths.
// And the concept guard: the installed skill still decides on the concepts the computed reply
// results carry, so a Superpowers update that renames one fails here, not in a live apply.
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROLES } from '../lib/reply.mjs'
import { run } from '../sdd.mjs'
import { commitIn, host, superpowersHome } from './git-host.mjs'

const PLAN = '# Plan\n\n### Task 1: one\n\nbody\n'

test('brief writes the task brief into the change workspace through bash', () => {
  const { change } = host({ 'plan.md': PLAN })
  const home = superpowersHome()
  const out = run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', home])
  assert.equal(out.ok, true, out.error)
  assert.equal(out.file, join(change, '.superpowers/sdd/add-x/task-1-brief.md'))
  assert.match(readFileSync(out.file, 'utf8'), /^brief 1 of .*openspec\/changes\/add-x\/plan\.md/)
  assert.deepEqual(out.stray, [])
})

test('output the script left on the shared default path is moved into the change workspace', () => {
  const { change } = host({ 'plan.md': PLAN })
  const out = run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', superpowersHome({ leak: true })])
  assert.equal(out.ok, true)
  assert.deepEqual(out.stray, [{ from: '.superpowers/sdd/plan/leak.md', to: '.superpowers/sdd/add-x/leak.md' }])
  assert.equal(existsSync(join(change, '.superpowers/sdd/plan')), false)
  assert.equal(readFileSync(join(change, '.superpowers/sdd/add-x/leak.md'), 'utf8'), 'leaked\n')
})

test('package resolves both refs to commit ids and names the file by their first seven characters', () => {
  const { change } = host({ 'plan.md': PLAN })
  const home = superpowersHome()
  const base = commitIn(change, 'b.txt', 'b\n')
  const head = commitIn(change, 'c.txt', 'c\n')
  const out = run(['package', '--change', 'add-x', '--base', 'HEAD~1', '--head', 'HEAD', '--root', change, '--home', home])
  assert.equal(out.ok, true, out.error)
  assert.deepEqual([out.base, out.head], [base, head])
  assert.equal(out.file, join(change, `.superpowers/sdd/add-x/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`))
  assert.match(readFileSync(out.file, 'utf8'), /c\.txt/)
  const wrong = run(['package', '--change', 'add-x', '--base', 'HEAD', '--head', 'HEAD~1', '--root', change, '--home', home])
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /review-package exited 3/)
  assert.throws(() => run(['package', '--change', 'add-x', '--base', 'nope', '--head', 'HEAD', '--root', change, '--home', home]), /does not resolve/)
})

test('brief and package refuse without their arguments, a plan, or the skill', () => {
  const { change } = host()
  const home = superpowersHome()
  assert.throws(() => run(['brief', '--change', 'add-x', '--root', change, '--home', home]), /--task/)
  assert.throws(() => run(['package', '--change', 'add-x', '--base', 'HEAD', '--root', change]), /--head/)
  assert.throws(() => run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', home]), /plan\.md does not exist/)
  const empty = superpowersHome()
  const { change: other } = host({ 'plan.md': PLAN })
  assert.throws(() => run(['brief', '--change', 'add-x', '--task', '1', '--root', other, '--home', join(empty, 'none')]), /not installed/)
})

// ---------------------------------------------------------------- the concept guard

const SP_CACHE = join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers')
const SKILL_PATH = join('skills', 'subagent-driven-development', 'SKILL.md')

// The highest installed version's SKILL.md, or null when Superpowers is not installed here.
function installedSkill() {
  if (!existsSync(SP_CACHE)) return null
  const version = (v) => v.split('.').map((n) => Number.parseInt(n, 10))
  const newer = (a, b) => {
    const [x, y] = [version(a), version(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
    return 0
  }
  const found = readdirSync(SP_CACHE)
    .filter((v) => /^\d+(\.\d+)*$/.test(v) && existsSync(join(SP_CACHE, v, SKILL_PATH)))
    .sort(newer)
  return found.length ? { version: found[0], file: join(SP_CACHE, found[0], SKILL_PATH) } : null
}

const SKILL = installedSkill()
const NO_SKILL = SKILL ? false : `Superpowers subagent-driven-development is not installed under ${SP_CACHE}: the concept guard has nothing to read`

test('the installed skill still names the four implementer statuses that the impl result computes', { skip: NO_SKILL }, () => {
  const text = readFileSync(SKILL.file, 'utf8')
  const statuses = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']
  for (const status of statuses) assert.match(text, new RegExp(`\\*\\*${status}:\\*\\*`), `${SKILL.version}: no **${status}:** handling`)
  // lib/reply.mjs computes `status` from these four literals and from no other.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'reply.mjs'), 'utf8')
  for (const status of statuses) assert.ok(source.includes(`'${status}'`), `lib/reply.mjs computes no ${status}`)
})

test('the installed skill still needs both review verdicts, which the review result computes as spec and quality', { skip: NO_SKILL }, () => {
  const text = readFileSync(SKILL.file, 'utf8')
  assert.match(text, /spec compliance AND task quality are both\s+required/, `${SKILL.version}: the two verdicts are no longer both required`)
  assert.match(text, /Spec ✅ and quality approved\?/, `${SKILL.version}: the review decision no longer reads both verdicts`)
  assert.match(text, /Spec ❌/)
  assert.match(text, /Task quality: Approved/)
  const ctx = { parts: { role: 'review', task: 1 }, history: [] }
  const finding = (over) => ({ severity: 'important', kind: 'quality', category: 'quality', file: 'a.mjs', line: 1, title: 't', body: 'b', ...over })
  const clean = ROLES.review.compute({ role: 'review', summary: 's', findings: [], unverifiable: [] }, ctx)
  assert.deepEqual([clean.spec, clean.quality, clean.result], ['pass', 'approved', 'clean'])
  const failed = ROLES.review.compute({ role: 'review', summary: 's', findings: [finding({ kind: 'spec', category: 'missing' })], unverifiable: [] }, ctx)
  assert.deepEqual([failed.spec, failed.quality, failed.result, failed.open], ['fail', 'needs-fixes', 'fix', ['F1']])
})

test('the installed skill still verdicts each finding ADDRESSED or NOT ADDRESSED, which the re-review result carries', { skip: NO_SKILL }, () => {
  const text = readFileSync(SKILL.file, 'utf8')
  assert.match(text, /each finding ADDRESSED or NOT ADDRESSED/, `${SKILL.version}: the re-review no longer verdicts each finding`)
  const history = [{ findings: [{ id: 'F1' }, { id: 'F2' }], open: ['F1', 'F2'], toRule: [], unverifiable: [] }]
  const result = ROLES['re-review'].compute(
    {
      role: 're-review',
      summary: 's',
      previous: [
        { id: 'F1', status: 'addressed', file: 'a.mjs', line: 1 },
        { id: 'F2', status: 'not-addressed', file: 'a.mjs', line: 2 }
      ],
      findings: [],
      outOfScope: []
    },
    { parts: { role: 're-review', task: 1, round: 1 }, history, rulings: new Map() }
  )
  assert.deepEqual([result.addressed, result.open, result.result], [['F1'], ['F2'], 'fix'])
})
