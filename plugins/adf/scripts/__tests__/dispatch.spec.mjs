// dispatch.mjs: the fixed name, level, worktree, reply file and prompt of every dispatch, and the
// attempt count behind the one-retry rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schedule } from '../lib/plan.mjs'
import { dispatchName, MAX_ROUNDS, normalize, parseGraph, parseName, planDispatch, renderPrompt, roundOf, verbatimBlocks } from '../lib/dispatch.mjs'
import { PLUGIN_ROOT, PROMPTS_DIR, run } from '../dispatch.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { recordDispatch, recordReply } from '../lib/attempts.mjs'
import { readLedger as readMetricsLedger, readReplies } from '../lib/metrics-records.mjs'
import { ROLES as REPLY_ROLES } from '../lib/reply.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dispatch.mjs')
const CHANGE = 'add-x'
const MAIN = '/main'

const task = (n, level, extra = '') => `### Task ${n}: thing ${n}

> Implements \`tasks.md\` 1.${n}.

**Files:**
- Modify: \`src/t${n}.mjs\` — the change
- Test: \`test/t${n}.spec.mjs\` — its test

**Interfaces:** none

**Level:** ${level}

**Behaviour and acceptance:** it works.

${extra}- [ ] **Step 9: Commit** — feat: t${n}
`

const plan = (rows, tasks) => `# Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
${rows.map(([g, t, w]) => `| ${g} | ${t} | x | ${w} |`).join('\n')}

---

${tasks.join('\n---\n\n')}`

const PLAN = plan(
  [
    ['A', '1, 2', 1],
    ['B', '3', 1],
    ['C', '4', 2]
  ],
  [task(1, 'mechanical'), task(2, 'integration', '- [ ] **Step 1: RED** — a failing test\n'), task(3, 'architecture'), task(4, 'mechanical')]
)

function host(planText = PLAN) {
  const root = mkdtempSync(join(tmpdir(), 'adf-dispatch-'))
  const dir = join(root, 'openspec', 'changes', CHANGE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plan.md'), planText)
  writeFileSync(join(dir, '.adf.json'), JSON.stringify({ base: 'develop' }))
  return root
}

const call = (root, ...args) => run([...args, '--change', CHANGE, '--root', root], { main: MAIN })
const cli = (root, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' })
  return { status: r.status, out: JSON.parse(r.stdout) }
}
const tree = (root, planText = PLAN) => ({ root, main: MAIN, planText, exists: existsSync })

test('names take the fixed form for every role', () => {
  assert.equal(dispatchName({ role: 'impl', task: 3 }), 'T3 impl')
  assert.equal(dispatchName({ role: 'fix', task: 3, round: 2 }), 'T3 fix r2')
  assert.equal(dispatchName({ role: 're-review', task: 12, round: 1 }), 'T12 re-review r1')
  assert.equal(dispatchName({ role: 'final-review' }), 'final-review')
  assert.equal(dispatchName({ role: 'sweep' }), 'sweep')
  assert.equal(dispatchName({ role: 'merge-review', group: 'B' }), 'merge-review B')
  assert.equal(dispatchName({ role: 'fix', group: 'B' }), 'fix B')
  assert.equal(dispatchName({ role: 'fix' }), 'fix')
  assert.equal(dispatchName({ role: 're-review', group: 'B' }), 're-review B')
  assert.equal(dispatchName({ role: 'investigate', topic: 'auth' }), 'investigate auth')
  assert.equal(dispatchName({ role: 'fix', group: 'B', round: 2 }), 'fix B r2')
  assert.equal(dispatchName({ role: 're-review', group: 'B', round: 1 }), 're-review B r1')
  assert.equal(dispatchName({ role: 'fix', round: 3 }), 'fix r3')
  for (const c of ['c4', 'c8']) assert.equal(dispatchName({ role: 'verify', check: c }), `verify ${c}`)
})

test('a name out of the form is refused', () => {
  const bad = [
    [{ role: 'implement', task: 1 }, /unknown role/],
    [{ role: 'investigate', topic: 'two words' }, /one word/],
    [{ role: 'investigate', topic: 'a-b' }, /one word/],
    [{ role: 'investigate' }, /needs --topic/],
    [{ role: 'impl' }, /needs --task/],
    [{ role: 'final-review', task: 2 }, /serves no single task/],
    [{ role: 'merge-review' }, /needs --group/],
    [{ role: 'merge-review', group: 'b' }, /not a group letter/],
    [{ role: 'sweep', group: 'A' }, /takes no --group/],
    [{ role: 'fix', task: 1, round: 0 }, /positive integer/],
    [{ role: 'merge-review', group: 'A', round: 2 }, /belongs to a task dispatch, to a fix or re-review, or to a re-sweep/],
    [{ role: 'final-review', round: 1 }, /belongs to a task dispatch/],
    [{ role: 'verify', check: 'c5' }, /needs --check/],
    [{ role: 'verify', check: 'assemble' }, /needs --check/],
    [{ role: 'verify', check: 'c6' }, /needs --check/],
    [{ role: 'impl', task: 1, group: 'A' }, /from the plan/]
  ]
  for (const [inputs, message] of bad) assert.throws(() => dispatchName(inputs), message, JSON.stringify(inputs))
})

test('parseName reads back every fixed-form name and refuses the rest', () => {
  for (const name of ['T3 impl', 'T3 fix r2', 'final-review', 'sweep', 'merge-review B', 'fix B', 'fix B r2', 're-review B r1', 'fix r3', 'fix', 're-review', 'investigate auth', 'verify c8']) {
    const parts = parseName(name)
    assert.ok(parts, name)
    assert.equal(dispatchName(parts), name)
  }
  for (const name of ['T3 implement', 'T0 impl', 'investigate two words', 'merge-review', 'merge-review B r2', 'verify c5', 'verify c6', 'verify assemble', 'review', 'Task 3 impl']) assert.equal(parseName(name), null, name)
})

test('the graph numbers groups by row and reads their tasks and wave', () => {
  assert.deepEqual(parseGraph(PLAN), [
    { letter: 'A', number: 1, tasks: [1, 2], wave: 1 },
    { letter: 'B', number: 2, tasks: [3], wave: 1 },
    { letter: 'C', number: 3, tasks: [4], wave: 2 }
  ])
  assert.deepEqual(parseGraph(plan([['A', '1-3', 1]], [])).at(0).tasks, [1, 2, 3])
})

test('a labelled group cell is a group to dispatch as it is to plan.mjs schedule: one parser', () => {
  const labelled = plan(
    [
      ['A: contracts, storage, core', '1, 2', 1],
      ['**Group B** — the client', '3', 1],
      ['C', '4', 2]
    ],
    [task(1, 'mechanical'), task(2, 'integration'), task(3, 'architecture'), task(4, 'mechanical')]
  )
  assert.deepEqual(parseGraph(labelled), parseGraph(PLAN))
  assert.deepEqual(
    schedule(labelled, { state: () => ({}) }).groups.map((g) => [g.n, g.letter, g.tasks, g.wave]),
    parseGraph(labelled).map((g) => [g.number, g.letter, g.tasks, g.wave])
  )
  const root = host(labelled)
  assert.equal(planDispatch({ change: CHANGE, role: 'impl', task: 1 }, tree(root, labelled)).group, 'A')
  assert.equal(planDispatch({ change: CHANGE, role: 'merge-review', group: 'B' }, tree(root, labelled)).name, 'merge-review B')
})

test('the level follows the task, the review floor and the round-2 step up', () => {
  const root = host()
  const agent = (inputs) => planDispatch({ change: CHANGE, ...inputs }, tree(root)).agent
  assert.equal(agent({ role: 'impl', task: 1 }), 'adf:mechanical')
  assert.equal(agent({ role: 'impl', task: 3 }), 'adf:architecture')
  assert.equal(agent({ role: 'review', task: 1 }), 'adf:integration')
  assert.equal(agent({ role: 're-review', task: 3, round: 1 }), 'adf:architecture')
  assert.equal(agent({ role: 'fix', task: 1, round: 1 }), 'adf:mechanical')
  assert.equal(agent({ role: 'fix', task: 1, round: 2 }), 'adf:integration')
  assert.equal(agent({ role: 'fix', task: 3, round: 3 }), 'adf:architecture')
  assert.equal(agent({ role: 'merge-review', group: 'B' }), 'adf:architecture')
  assert.equal(agent({ role: 'fix', group: 'B', round: 1 }), 'adf:integration')
  assert.equal(agent({ role: 'fix', group: 'B', round: 2 }), 'adf:architecture')
  assert.equal(agent({ role: 're-review', group: 'B', round: 2 }), 'adf:integration')
  assert.equal(agent({ role: 'final-review' }), 'adf:architecture')
  assert.equal(agent({ role: 'sweep' }), 'adf:integration')
  assert.equal(agent({ role: 'verify', check: 'c4' }), 'adf:architecture')
  assert.equal(agent({ role: 'verify', check: 'c8' }), 'adf:integration')
})

test('a task runs in its group worktree, or in the change worktree when wave 1 has one group', () => {
  const root = host()
  const p = planDispatch({ change: CHANGE, role: 'impl', task: 3 }, tree(root))
  assert.equal(p.worktree, join(MAIN, '.claude', 'worktrees', `${CHANGE}--group-2`))
  assert.equal(p.group, 'B')
  assert.equal(planDispatch({ change: CHANGE, role: 'merge-review', group: 'B' }, tree(root)).worktree, root)
  const single = plan([['A', '1', 1], ['B', '2', 2]], [task(1, 'mechanical'), task(2, 'mechanical')])
  assert.equal(planDispatch({ change: CHANGE, role: 'impl', task: 2 }, tree(root, single)).worktree, root)
})

test('a task outside the plan, without a level or outside the graph is refused', () => {
  const root = host()
  assert.throws(() => planDispatch({ change: CHANGE, role: 'impl', task: 9 }, tree(root)), /Task 9 is not in the plan/)
  const noLevel = plan([['A', '1', 1]], [task(1, 'fast')])
  assert.throws(() => planDispatch({ change: CHANGE, role: 'impl', task: 1 }, tree(root, noLevel)), /no \*\*Level/)
  const outside = plan([['A', '1', 1]], [task(1, 'mechanical'), task(2, 'mechanical')])
  assert.throws(() => planDispatch({ change: CHANGE, role: 'impl', task: 2 }, tree(root, outside)), /in no group/)
  assert.throws(() => planDispatch({ change: CHANGE, role: 'merge-review', group: 'D' }, tree(root)), /group D is not/)
})

test('the reply file sits in the change worktree and is never overwritten', () => {
  const root = host()
  const first = call(root, 'plan', '--role', 'fix', '--task', '3', '--round', '2')
  assert.equal(first.replyFile, join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'T3-fix-r2.json'))
  mkdirSync(dirname(first.replyFile), { recursive: true })
  writeFileSync(first.replyFile, '{}')
  assert.equal(call(root, 'plan', '--role', 'fix', '--task', '3', '--round', '2').replyFile, first.replyFile.replace(/\.json$/, '-2.json'))
  const v = call(root, 'plan', '--role', 'verify', '--check', 'c8')
  assert.equal(v.replyFile, join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'verify-c8.json'))
  assert.equal(v.sectionFile, join(root, '.superpowers', 'sdd', CHANGE, 'verify', 'c8.json'))
})

test('an implementer prompt carries every fixed field and clause, with paths absolute', () => {
  const root = host()
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Implement Task 3.\n{{not a field}} stays as written.')
  const { prompt } = call(root, 'prompt', '--role', 'impl', '--task', '3', '--question-file', q)
  const wt = join(MAIN, '.claude', 'worktrees', `${CHANGE}--group-2`)
  assert.match(prompt, /You are dispatched as `T3 impl`, at the architecture capability level/)
  assert.ok(prompt.includes(`Worktree: ${wt}`))
  assert.ok(prompt.includes(`Modify: ${join(wt, 'src/t3.mjs')}`))
  assert.ok(prompt.includes(`Task brief: ${join(root, '.superpowers', 'sdd', CHANGE, 'task-3-brief.md')}`))
  assert.ok(prompt.includes('Implement Task 3.\n{{not a field}} stays as written.'))
  assert.ok(prompt.includes('never edit a checkbox in `tasks.md`: the flow ticks it;'))
  assert.ok(prompt.includes(`node "${PLUGIN_ROOT}/scripts/ledger.mjs" debt --change ${CHANGE}`))
  assert.ok(prompt.includes(`--task 3 --root ${root}`))
  assert.ok(prompt.includes(`\`git -C ${wt}\``))
  assert.ok(prompt.includes(`node "${PLUGIN_ROOT}/scripts/commit.mjs" --root ${wt} --only <path>`))
  assert.match(prompt, /which tests cover a file\s+is your call/)
  assert.ok(prompt.includes(`JSON Schema, \`${PLUGIN_ROOT}/schema/impl.schema.json\`.`))
  assert.ok(prompt.includes(`node "${PLUGIN_ROOT}/scripts/suite.mjs" covering --change ${CHANGE} --name "T3 impl" --command "<the command>" --worktree ${wt} --root ${root}`))
  assert.match(prompt, /in the reply's\s+`testRuns`/)
  assert.ok(prompt.includes(join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'T3-impl.json')))
  assert.doesNotMatch(prompt, /\$\{CLAUDE_PLUGIN_ROOT\}|<change>|<root>|<worktree>|<!--/)
})

test('a review proves the test can fail only for a test-first task; its question is required', () => {
  const root = host()
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Review it.')
  const proof = /the review proves the new test can fail/
  const tdd = call(root, 'prompt', '--role', 'review', '--task', '2', '--question-file', q, '--base', 'c'.repeat(40), '--head', 'd'.repeat(40)).prompt
  assert.match(tdd, proof)
  assert.ok(tdd.includes(`scripts/tdd-proof.mjs" --worktree ${join(MAIN, '.claude', 'worktrees', `${CHANGE}--group-1`)} --commit ${'d'.repeat(40)} --test`))
  assert.match(call(root, 'prompt', '--role', 'review', '--task', '2', '--question-file', q).prompt, /--commit <the task's commit>/)
  const plain = call(root, 'prompt', '--role', 'review', '--task', '1', '--question-file', q, '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)).prompt
  assert.doesNotMatch(plain, proof)
  assert.ok(plain.includes(`review-aaaaaaa..bbbbbbb.diff`))
  assert.match(plain, /A reviewer that accepts a compromise records it/)
  assert.match(plain, /so do not\s+re-run them to confirm it/)
  assert.match(plain, /state no verdict: the script assigns the ids/)
  assert.doesNotMatch(plain, /`previous`/)
  // A re-review carries its own skeleton after the reviewer rules: the open set and outOfScope.
  const reReview = call(root, 'prompt', '--role', 're-review', '--task', '1', '--round', '1', '--question-file', q).prompt
  assert.match(reReview, /You review; you do not fix/)
  assert.match(reReview, /Answer each of them\s+once in `previous`/)
  assert.match(reReview, /`outOfScope`/)
  const refused = cli(root, 'prompt', '--change', CHANGE, '--role', 'review', '--task', '1')
  assert.equal(refused.status, 1)
  assert.match(refused.out.error, /needs --question-file/)
})

test('the sweep prompt names the base, the range and the fixed question; a merge review names the group files', () => {
  const root = host()
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'develop')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
  const sweep = call(root, 'prompt', '--role', 'sweep').prompt
  assert.ok(sweep.includes('Base: develop'))
  assert.match(sweep, /Range: [0-9a-f]{40}\.\.[0-9a-f]{40}/)
  assert.ok(sweep.includes("against the change's base, `develop`"))
  assert.match(sweep, /whose behaviour the tree already has/)
  assert.doesNotMatch(sweep, /A second question/)
  const specs = join(root, 'openspec', 'changes', CHANGE, 'specs', 'cap')
  mkdirSync(specs, { recursive: true })
  writeFileSync(join(specs, 'spec.md'), '## REMOVED Requirements\n\n### Requirement: Old thing\n\n**Reason**: gone\n')
  const second = call(root, 'prompt', '--role', 'sweep').prompt
  assert.match(second, /A second question/)
  assert.ok(second.includes('REMOVED Old thing (specs/cap/spec.md): no Code Disposition'))
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Check the merge.')
  const merge = call(root, 'prompt', '--role', 'merge-review', '--group', 'A', '--question-file', q).prompt
  assert.ok(merge.includes(join(root, 'src/t1.mjs')) && merge.includes(join(root, 'src/t2.mjs')))
  assert.ok(!merge.includes('src/t3.mjs'))
  assert.match(merge, /agree in\s+meaning/)
  const fix = call(root, 'prompt', '--role', 'fix', '--group', 'A', '--round', '2', '--question-file', q)
  assert.equal(fix.name, 'fix A r2')
  assert.ok(fix.prompt.includes(`--reason <why> --root ${root}`))
  assert.doesNotMatch(fix.prompt, /<n>/)
})

test('a verify prompt reads base and range from run.json and names its reply file and the lists it answers', () => {
  const root = host()
  assert.match(cli(root, 'prompt', '--change', CHANGE, '--role', 'verify', '--check', 'c4').out.error, /run verify\.mjs run first/)
  const verify = join(root, '.superpowers', 'sdd', CHANGE, 'verify')
  mkdirSync(verify, { recursive: true })
  writeFileSync(join(verify, 'run.json'), JSON.stringify({ base: 'origin/develop', head: 'abc123' }))
  mkdirSync(join(root, '.claude', 'skills', 'deploy'), { recursive: true })
  writeFileSync(join(root, '.claude', 'skills', 'deploy', 'SKILL.md'), 'x')
  // The c4 prompt lists the range's hand edits of capability specs, read from git.
  assert.match(cli(root, 'prompt', '--change', CHANGE, '--role', 'verify', '--check', 'c4').out.error, /git/)
  for (const args of [['init', '-q', '-b', 'develop'], ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']]) spawnSync('git', args, { cwd: root })
  const c4 = call(root, 'prompt', '--role', 'verify', '--check', 'c4').prompt
  assert.ok(c4.includes('Range: origin/develop..abc123'))
  assert.ok(c4.includes(`Reply file: ${join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'verify-c4.json')}`))
  assert.ok(c4.includes(`Reply schema: ${join(PLUGIN_ROOT, 'schema', 'verify-c4.schema.json')}`))
  assert.match(c4, /- Prose edits: none\n- Removed or renamed: none\n/)
  assert.ok(c4.includes(`write it as one JSON\nobject under \`${PLUGIN_ROOT}/schema/verify-c4.schema.json\``))
  assert.match(c4, /Every design decision traces to a requirement/)
  assert.ok(c4.includes(`git runs as \`git -C ${root}\``))
  const c8 = call(root, 'prompt', '--role', 'verify', '--check', 'c8').prompt
  assert.ok(c8.includes(`Files in scope:\n  - ${join(verify, 'c8-candidates.txt')}`))
  assert.ok(!c8.includes(join(root, '.claude', 'skills', 'deploy', 'SKILL.md')))
  assert.ok(c8.includes(join(verify, 'c8-candidates.txt')))
  assert.match(c4, /`proseEdits`/)
  for (const p of [c4, c8]) assert.doesNotMatch(p, /\{\{\w+\}\}|<verify>|<id>|<root>|<change>/)
})

test('attempts per name: each dispatch is counted; next follows the refused replies, not the count', () => {
  const root = host()
  const attempt = (name) => call(root, 'attempt', '--name', name)
  assert.deepEqual([1, 2, 3].map(() => attempt('T3 impl')).map((a) => [a.attempt, a.next]), [[1, 'dispatch'], [2, 'dispatch'], [3, 'dispatch']])
  recordReply(root, CHANGE, { name: 'T3 impl', file: join(root, 'r.json'), errors: ['bad'] })
  assert.deepEqual([attempt('T3 impl').attempt, attempt('T3 impl').next], [4, 'retry'])
  recordReply(root, CHANGE, { name: 'T3 impl', file: join(root, 'r.json'), errors: ['bad'] })
  assert.equal(attempt('T3 impl').next, 'stop')
  assert.deepEqual(attempt('T3 fix r1'), { ok: true, name: 'T3 fix r1', attempt: 1, next: 'dispatch', file: join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl') })
  const bad = cli(root, 'attempt', '--change', CHANGE, '--name', 'T3 implement')
  assert.equal(bad.status, 1)
})

// The limit's stop names the way out the developer owns: the reset, asked for first. A role that
// restarts its own count names none.
test('a stop on the limit names the developer reset and says the developer is asked first', () => {
  const root = host()
  const attempt = (name) => call(root, 'attempt', '--name', name)
  const reply = (name) => recordReply(root, CHANGE, { name, file: join(root, 'r.json'), errors: ['write denied'] })
  const command = `dispatch.mjs reset --change ${CHANGE} --name "T3 impl" --reason "<the developer's reason>"`
  assert.equal(attempt('T3 impl').reset, undefined)
  assert.equal(reply('T3 impl').reset, undefined)
  attempt('T3 impl')
  const stopped = reply('T3 impl')
  assert.equal(stopped.next, 'stop')
  assert.equal(stopped.reset.command, command)
  assert.match(stopped.reset.note, /ask the developer first/)
  const third = attempt('T3 impl')
  assert.deepEqual([third.next, third.reset.command], ['stop', command])
  assert.match(third.reset.note, /ask the developer first/)
  for (const name of ['ai-fix F1 r1', 'verify c4']) {
    for (const n of [1, 2]) {
      attempt(name)
      assert.equal(reply(name).reset, undefined, `${name} ${n}`)
    }
    const out = attempt(name)
    assert.deepEqual([out.next, out.reset], ['stop', undefined], name)
  }
})

// A dispatch stopped because the environment refused it (a permission denial, a missing tool)
// gets a way out once the environment is fixed: a developer reset, held for the developer's yes.
test('a developer reset restarts the count of a stopped dispatch; the preview changes nothing; history and metrics keep every attempt', () => {
  const root = host()
  const log = join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl')
  const ledger = join(root, '.superpowers', 'sdd', CHANGE, 'ledger.jsonl')
  const attempt = () => call(root, 'attempt', '--name', 'ingest')
  const reply = (errors) => recordReply(root, CHANGE, { name: 'ingest', file: join(root, 'r.json'), errors })
  assert.equal(attempt().next, 'dispatch')
  assert.equal(reply(['knowledge base write denied']).next, 'retry')
  assert.equal(attempt().next, 'retry')
  assert.equal(reply(['knowledge base write denied']).next, 'stop')
  // The limit stops the name, and nothing it replies is recorded.
  assert.equal(attempt().next, 'stop')
  assert.throws(() => reply([]), /stopped after 2 invalid replies/)

  const reset = (...extra) => call(root, 'reset', '--name', 'ingest', '--reason', 'the permission is granted now', ...extra)
  // Only a stopped name is reset, and only with the developer's reason.
  call(root, 'attempt', '--name', 'T3 impl')
  assert.throws(() => call(root, 'reset', '--name', 'T3 impl', '--reason', 'x'), /T3 impl has not stopped/)
  assert.equal(cli(root, 'reset', '--change', CHANGE, '--name', 'ingest').status, 2)

  const before = readFileSync(log, 'utf8')
  const preview = reset()
  assert.equal(preview.ok, true)
  assert.equal(preview.state, 'pending')
  assert.equal(preview.held, true)
  assert.match(preview.plan, /^reset-[0-9a-f]{12}$/)
  assert.deepEqual(preview.covers, { events: 5, dispatches: 3, invalid: 2, valid: 0 })
  assert.match(preview.preview.join('\n'), /ingest: 3 dispatches and 2 invalid replies stop counting/)
  assert.match(preview.waiting, new RegExp(`--yes ${preview.plan}`))
  // The preview writes nothing, and asking again gives the same plan.
  assert.equal(readFileSync(log, 'utf8'), before)
  assert.equal(existsSync(ledger), false)
  assert.equal(reset().plan, preview.plan)

  // A wrong plan id is refused, and so is a plan the log has moved past.
  const wrong = cli(root, 'reset', '--change', CHANGE, '--name', 'ingest', '--reason', 'the permission is granted now', '--yes', 'reset-000000000000')
  assert.equal(wrong.status, 1)
  assert.match(wrong.out.error, /does not match/)
  assert.equal(existsSync(ledger), false)
  attempt()
  assert.throws(() => reset('--yes', preview.plan), /does not match/)
  assert.equal(existsSync(ledger), false)

  const plan = reset().plan
  const applied = reset('--yes', plan)
  assert.equal(applied.ok, true)
  assert.equal(applied.state, 'done')
  assert.equal(applied.next, 'dispatch')
  const records = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(records.length, 1)
  const { at, sessionId, ...record } = records[0]
  assert.equal(typeof at, 'string')
  assert.deepEqual(record, {
    id: 'attempt-reset-1',
    kind: 'attempt-reset',
    by: 'developer',
    name: 'ingest',
    reason: 'the permission is granted now',
    plan,
    covers: { events: 6, dispatches: 4, invalid: 2, valid: 0 },
    skip: 6
  })
  assert.deepEqual(applied.record, records[0])
  // Every earlier attempt stays in the log.
  assert.ok(readFileSync(log, 'utf8').startsWith(before))
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 7)

  // After the reset the name dispatches again, and the limit counts from the reset.
  assert.deepEqual(attempt(), { ok: true, name: 'ingest', attempt: 1, next: 'dispatch', file: log })
  assert.equal(reply(['still refused']).next, 'retry')
  assert.equal(attempt().next, 'retry')
  assert.equal(reply([]).next, 'proceed')
  // Nothing to reset now: the name has not stopped since.
  assert.throws(() => reset(), /ingest has not stopped/)

  // The metrics count every attempt once, before and after the reset; the ledger counts the record.
  const replies = readReplies(root, CHANGE).value.ingest
  assert.deepEqual(replies, { dispatches: 6, valid: 1, invalid: 3, retries: 2, stops: 1 })
  assert.equal(readMetricsLedger(root, CHANGE).value.counts['attempt-reset'], 1)
  // The ledger CLI does not write a reset: only the held command does.
  assert.throws(() => appendRecord(root, CHANGE, 'attempt-reset', { name: 'ingest', reason: 'x' }), /unknown kind/)
})

test('a reset is refused for a dispatch whose run restarts on its own', () => {
  const root = host()
  for (const name of ['ai-review r1', 'ai-fix F1 r1', 'verify c4']) {
    assert.throws(() => call(root, 'reset', '--name', name, '--reason', 'x'), /restarts its own count/, name)
  }
  assert.throws(() => call(root, 'reset', '--name', 'T3 implement', '--reason', 'x'), /not a dispatch name/)
})

test('a fix loop counts its rounds by the re-reviews attempted and trips the breaker at the cap', () => {
  const lines = (...names) => names.map((name) => JSON.stringify({ name })).join('\n')
  assert.deepEqual(roundOf('', { task: 3 }), { subject: 'T3', completed: 0, max: MAX_ROUNDS, next: 'fix', round: 1, fix: 'T3 fix r1', reReview: 'T3 re-review r1' })
  // A fix without its re-review is the round still running; another subject's rounds do not count.
  const text = lines('T3 review', 'T3 fix r1', 'T3 re-review r1', 'T3 re-review r1', 'T3 fix r2', 'T4 re-review r4', 're-review B r2', 'not json')
  assert.deepEqual([roundOf(text, { task: 3 }).completed, roundOf(text, { task: 3 }).round, roundOf(text, { task: 3 }).fix], [1, 2, 'T3 fix r2'])
  assert.deepEqual([roundOf(text, { group: 'B' }).reReview, roundOf(text, {}).fix], ['re-review B r3', 'fix r1'])
  const full = lines(...[1, 2, 3, 4, 5].map((k) => `T3 re-review r${k}`), ...[1, 2, 3, 4, 5].map((k) => `re-review B r${k}`), ...[1, 2, 3, 4, 5].map((k) => `re-review r${k}`))
  assert.deepEqual(roundOf(full, { task: 3 }), { subject: 'T3', completed: 5, max: 5, next: 'adjudicate' })
  assert.equal(roundOf(full, { group: 'B' }).next, 'escalate-to-developer')
  assert.equal(roundOf(full, {}).next, 'escalate-to-developer')
  assert.throws(() => roundOf('', { task: 3, group: 'B' }), /not both/)
  const root = host()
  for (const name of ['fix A r1', 're-review A r1']) call(root, 'attempt', '--name', name)
  assert.deepEqual(call(root, 'round', '--group', 'A'), { ok: true, subject: 'A', completed: 1, max: 5, next: 'fix', round: 2, fix: 'fix A r2', reReview: 're-review A r2' })
  assert.equal(cli(root, 'round', '--change', CHANGE, '--role', 'fix').status, 2)
})

test('a fix round that returns BLOCKED with no commit goes to adjudication before the breaker', () => {
  const event = (name, extra = {}) => JSON.stringify({ name, ...extra })
  const blocked = (name, commits = []) => event(name, { event: 'valid', result: { status: 'BLOCKED', next: 'blocked', commits, range: null, blocker: 'nothing to fix' } })
  const text = [event('T7 review'), event('T7 fix r1'), blocked('T7 fix r1')].join('\n')
  assert.deepEqual(roundOf(text, { task: 7 }), {
    subject: 'T7',
    completed: 0,
    max: MAX_ROUNDS,
    next: 'adjudicate',
    blockedFix: 'T7 fix r1',
    reason: 'T7 fix r1 returned BLOCKED with no commit: nothing is left to re-review, so the open findings are ruled now'
  })
  // A group's or the final review's loop goes to the developer, as at the breaker.
  assert.equal(roundOf([event('fix B r2'), blocked('fix B r2'), event('re-review B r1')].join('\n'), { group: 'B' }).next, 'escalate-to-developer')
  assert.equal(roundOf(blocked('fix r1'), {}).next, 'escalate-to-developer')
  // Without that condition the loop runs on to the breaker: a blocked fix with a commit, a done
  // fix, an earlier round's blocked fix, another subject's.
  assert.equal(roundOf(blocked('T7 fix r1', [{ sha: 'a'.repeat(40) }]), { task: 7 }).next, 'fix')
  assert.equal(roundOf(event('T7 fix r1', { event: 'valid', result: { status: 'DONE', commits: [] } }), { task: 7 }).next, 'fix')
  assert.deepEqual(Object.values(roundOf([blocked('T7 fix r1'), event('T7 re-review r1')].join('\n'), { task: 7 })).slice(3, 5), ['fix', 2])
  assert.equal(roundOf(blocked('T8 fix r1'), { task: 7 }).next, 'fix')
})

test('a re-review over a fix range names the files no task covers, owned by the task under review', () => {
  const root = host()
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'develop')
  const commit = (file) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), `${file}\n`)
    git('add', file)
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', file)
    return git('rev-parse', 'HEAD')
  }
  const base = commit('src/t1.mjs')
  commit('src/t3.mjs')
  const head = commit('src/extra.mjs')
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Check the fix.')
  const task = call(root, 'prompt', '--role', 're-review', '--task', '1', '--round', '1', '--base', base, '--head', head, '--question-file', q)
  assert.deepEqual(task.unplanned, [{ file: 'src/extra.mjs', verb: 'Create', owner: 1 }])
  const group = call(root, 'prompt', '--role', 're-review', '--group', 'B', '--round', '1', '--base', base, '--head', head, '--question-file', q)
  assert.deepEqual(group.unplanned, [{ file: 'src/extra.mjs', verb: 'Create', owner: null }])
  assert.equal(call(root, 'prompt', '--role', 're-review', '--task', '1', '--question-file', q).unplanned, undefined)
  assert.equal(cli(root, 'prompt', '--change', CHANGE, '--role', 're-review', '--task', '1', '--base', 'nope', '--head', head, '--question-file', q).status, 1)
})

test('the CLI separates a usage error from a refusal', () => {
  const root = host()
  assert.equal(cli(root, 'plan', '--change', CHANGE).status, 2)
  assert.equal(cli(root, 'launch', '--change', CHANGE, '--role', 'impl').status, 2)
  assert.equal(cli(root, 'plan', '--change', CHANGE, '--role', 'impl', '--task').status, 2)
  assert.equal(cli(root, 'plan', '--change', CHANGE, '--role', 'implement', '--task', '1').status, 1)
  assert.equal(cli(root, 'plan', '--change', 'nope', '--role', 'sweep').status, 1)
  const ok = cli(root, 'plan', '--change', CHANGE, '--role', 'investigate', '--topic', 'auth')
  assert.equal(ok.status, 0)
  assert.equal(ok.out.name, 'investigate auth')
  assert.equal(ok.out.worktree, root)
})

// A skeleton under schema/prompts/ is the one full statement of what an agent is told; the
// instruction points at it. A block marked verbatim is the exception, a copy of its instruction
// checked word for word: a reworded instruction that leaves its copy behind would send agents the
// old rule.
test('every verbatim block of a prompt skeleton is in its instruction, word for word', () => {
  const pluginRoot = join(PROMPTS_DIR, '..', '..')
  for (const f of readdirSync(PROMPTS_DIR)) {
    for (const { source, text } of verbatimBlocks(readFileSync(join(PROMPTS_DIR, f), 'utf8'))) {
      const instruction = normalize(readFileSync(join(pluginRoot, source), 'utf8'))
      assert.ok(instruction.includes(normalize(text)), `${f}: a verbatim block is not in ${source}: ${text.slice(0, 80)}`)
    }
  }
})

// The apply skeletons carry no verbatim block, and the apply instruction and command restate
// none of their sentences: a rule an agent is told lives in its skeleton alone.
test('the apply instruction and command restate no sentence of an apply prompt skeleton', () => {
  const pluginRoot = join(PROMPTS_DIR, '..', '..')
  const surfaces = ['schema/instructions/apply.md', 'commands/apply.md'].map((p) => normalize(readFileSync(join(pluginRoot, p), 'utf8')))
  const skeletons = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('verify'))
  assert.ok(skeletons.length >= 8, skeletons.join(', '))
  const restated = []
  for (const f of skeletons) {
    const text = readFileSync(join(PROMPTS_DIR, f), 'utf8')
    assert.deepEqual(verbatimBlocks(text), [], `${f} carries a verbatim block`)
    const prose = text
      .split('\n')
      .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
      .join('\n')
    for (const sentence of normalize(prose).split(/(?<=[.;:])\s+/)) {
      if (sentence.length < 40 || /\{\{|<\w/.test(sentence)) continue
      if (surfaces.some((s) => s.includes(sentence))) restated.push(`${f}: ${sentence}`)
    }
  }
  assert.deepEqual(restated, [])
})

// Each apply role's prompt names the schema file its checker (lib/reply.mjs) reads, so a role
// moved to another schema cannot leave the agent reading the old shape.
test('each apply role prompt names the schema its checker reads', () => {
  const skeletons = Object.fromEntries(readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md')).map((f) => [f.slice(0, -3), readFileSync(join(PROMPTS_DIR, f), 'utf8')]))
  assert.match(skeletons.reply, /\{\{schema\}\}/)
  assert.doesNotMatch(skeletons.reply, /[a-z-]+\.schema\.json/)
  for (const [role, { schema }] of Object.entries(REPLY_ROLES)) {
    assert.ok(existsSync(join(PLUGIN_ROOT, 'schema', schema)), `no schema/${schema}`)
    const plan = { name: role, role, agent: 'adf:integration', replyFile: 'r.json' }
    const prompt = renderPrompt({ plan, change: 'c', skeletons, fields: [], question: 'q', tokens: {} })
    assert.ok(prompt.includes(`JSON Schema, \`\${CLAUDE_PLUGIN_ROOT}/schema/${schema}\`.`), `the ${role} prompt does not name ${schema}`)
  }
})

// The orchestrator's own rules never reach an agent: a prompt is what the agent does.
test('no apply prompt skeleton speaks to the orchestrator', () => {
  for (const f of readdirSync(PROMPTS_DIR).filter((n) => n.endsWith('.md') && !n.startsWith('verify'))) {
    const sent = readFileSync(join(PROMPTS_DIR, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
      .join('\n')
    assert.doesNotMatch(sent, /\bdispatch text\b|\bthe orchestrator\b|\ban implementer prompt\b|\bthe prompt (names|tells|says)\b/i, f)
  }
})

// ---------------------------------------------------------------- the review stage

test('the review stage names one reviewer per round or slice and one fixer per finding', () => {
  assert.equal(dispatchName({ role: 'ai-review', round: 1 }), 'ai-review r1')
  assert.equal(dispatchName({ role: 'ai-review', round: 2, slice: 3 }), 'ai-review r2 s3')
  assert.equal(dispatchName({ role: 'ai-fix', finding: 'F12', round: 1 }), 'ai-fix F12 r1')
  for (const name of ['ai-review r1', 'ai-review r2 s3', 'ai-fix F12 r1']) assert.equal(dispatchName(parseName(name)), name)
  assert.deepEqual(parseName('ai-fix F4 r2'), { role: 'ai-fix', finding: 'F4', round: 2 })
  assert.deepEqual(parseName('ai-review r3 s1'), { role: 'ai-review', round: 3, slice: 1 })
  for (const name of ['ai-review', 'ai-review r0', 'ai-review s1 r1', 'ai-fix F1', 'ai-fix r1', 'ai-fix F0 r1', 'ai-fix 1 r1']) assert.equal(parseName(name), null, name)
  const bad = [
    [{ role: 'ai-review' }, /needs --round/],
    [{ role: 'ai-fix', finding: 'F1' }, /needs --round/],
    [{ role: 'ai-fix', round: 1 }, /needs --finding F<n>/],
    [{ role: 'ai-fix', finding: '3', round: 1 }, /needs --finding F<n>/],
    [{ role: 'ai-review', round: 1, finding: 'F1' }, /--finding belongs to ai-fix/],
    [{ role: 'ai-fix', finding: 'F1', round: 1, slice: 1 }, /--slice belongs to ai-review/],
    [{ role: 'ai-review', round: 1, slice: 0 }, /positive integer/],
    [{ role: 'ai-review', round: 1, task: 2 }, /takes no --task or --group/],
    [{ role: 'ai-fix', finding: 'F1', round: 1, group: 'A' }, /takes no --task or --group/],
    [{ role: 'fix', task: 1, slice: 1 }, /--slice belongs to ai-review/]
  ]
  for (const [inputs, message] of bad) assert.throws(() => dispatchName(inputs), message, JSON.stringify(inputs))
})

test('the reviewer runs at architecture every round; the fixer at integration, one level up from round 2', () => {
  const root = host('no plan needed')
  const sdd = join(root, '.superpowers', 'sdd', CHANGE)
  const r1 = call(root, 'plan', '--role', 'ai-review', '--round', '1')
  assert.deepEqual(
    { name: r1.name, agent: r1.agent, worktree: r1.worktree, round: r1.round, inputFile: r1.inputFile, replyFile: r1.replyFile },
    { name: 'ai-review r1', agent: 'adf:architecture', worktree: root, round: 1, inputFile: join(sdd, 'review', 'input-r1.md'), replyFile: join(sdd, 'replies', 'ai-review-r1.json') }
  )
  const s2 = call(root, 'plan', '--role', 'ai-review', '--round', '3', '--slice', '2')
  assert.equal(s2.agent, 'adf:architecture')
  assert.equal(s2.slice, 2)
  assert.equal(s2.inputFile, join(sdd, 'review', 'input-r3-s2.md'))
  const f1 = call(root, 'plan', '--role', 'ai-fix', '--finding', 'F2', '--round', '1')
  assert.deepEqual({ name: f1.name, agent: f1.agent, finding: f1.finding }, { name: 'ai-fix F2 r1', agent: 'adf:integration', finding: 'F2' })
  assert.equal(call(root, 'plan', '--role', 'ai-fix', '--finding', 'F2', '--round', '2').agent, 'adf:architecture')
  // Two fixes of one round have names and reply files of their own.
  assert.notEqual(call(root, 'plan', '--role', 'ai-fix', '--finding', 'F3', '--round', '1').replyFile, f1.replyFile)
  assert.throws(() => call(root, 'plan', '--role', 'ai-fix', '--finding', 'F2', '--round', '1', '--question-file', 'x.md'), /belong to prompt/)
})

test('a retry counts only for the same review dispatch name', () => {
  const root = host()
  const refuse = (name) => recordReply(root, CHANGE, { name, file: join(root, 'r.json'), errors: ['bad'] })
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F2 r1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1 s1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1 s2').next, 'dispatch')
  refuse('ai-fix F1 r1')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r1').next, 'retry')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r2').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F2 r1').next, 'dispatch')
  refuse('ai-fix F1 r1')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r1').next, 'stop')
  // A review dispatch closes no apply fix round.
  assert.equal(call(root, 'round').completed, 0)
})

// lib/attempts.mjs through `dispatch.mjs reply`: one events log, keyed by the dispatch name.
// Valid with no commit and no test run, so it reads no git: the role table is lib/reply.mjs's.
const IMPL_OK = { role: 'impl', outcome: 'needs-context', commits: [], concerns: [], blocker: 'Which grammar?', summary: 'Stopped before the parser.' }
const writeReply = (root, name, value) => {
  const file = join(root, 'replies', `${name}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const events = (root) => readFileSync(join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('two invalid replies of one dispatch give retry, then stop; a stopped dispatch records nothing more', () => {
  const root = host()
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'dispatch')
  const bad = writeReply(root, 'bad', { role: 'impl', status: 'DONE' })
  const first = call(root, 'reply', '--name', 'T3 impl', '--file', bad)
  assert.deepEqual([first.ok, first.valid, first.next, first.mode, first.invalid], [false, false, 'retry', 'resume', 1])
  assert.ok(first.errors.some((e) => /commits is required/.test(e)))
  // The retry resumes the agent; the attempt count reads only the dispatch events.
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'retry')
  const second = call(root, 'reply', '--name', 'T3 impl', '--file', join(root, 'replies', 'absent.json'))
  assert.deepEqual([second.valid, second.next, second.mode, second.invalid], [false, 'stop', null, 2])
  assert.match(second.errors[0], /no reply file/)
  assert.throws(() => call(root, 'reply', '--name', 'T3 impl', '--file', writeReply(root, 'good', IMPL_OK)), /stopped after 2 invalid replies/)
  assert.deepEqual(events(root).map((e) => e.event), ['dispatch', 'invalid', 'dispatch', 'invalid'])
  assert.deepEqual(Object.keys(events(root)[1]).sort(), ['at', 'errors', 'event', 'file', 'mode', 'name', 'next'])
  // Without resume the retry is a fresh dispatch; a valid reply proceeds.
  const fresh = call(root, 'reply', '--name', 'T4 impl', '--file', bad, '--resume', 'no')
  assert.deepEqual([fresh.next, fresh.mode], ['retry', 'fresh'])
  const good = call(root, 'reply', '--name', 'T4 impl', '--file', writeReply(root, 'good', IMPL_OK))
  assert.deepEqual([good.ok, good.valid, good.errors, good.next, good.mode, good.invalid], [true, true, [], 'proceed', null, 1])
  assert.deepEqual([good.result.status, good.result.next], ['NEEDS_CONTEXT', 'provide-context'])
  assert.equal(events(root).at(-1).event, 'valid')
  assert.deepEqual(events(root).at(-1).result, good.result)
  const exit = cli(root, 'reply', '--change', CHANGE, '--name', 'T5 impl', '--file', bad)
  assert.equal(exit.status, 1)
  assert.equal(exit.out.next, 'retry')
  assert.equal(cli(root, 'reply', '--change', CHANGE, '--name', 'T5 impl', '--file', bad, '--resume', 'maybe').status, 2)
  assert.throws(() => call(root, 'reply', '--name', 'verify c4', '--file', bad), /run verify\.mjs run first/)
  assert.throws(() => call(root, 'reply', '--name', 'T3 implement', '--file', bad), /fixed form/)
})

// A valid NEEDS_CONTEXT reply after one schema retry once used up the limit by dispatch count, so
// the re-dispatch carrying the answer stopped.
test('a re-dispatch with the answer to NEEDS_CONTEXT after a schema retry is not stopped', () => {
  const root = host()
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'dispatch')
  assert.equal(call(root, 'reply', '--name', 'T3 impl', '--file', writeReply(root, 'bad', { role: 'impl', status: 'DONE' })).next, 'retry')
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'T3 impl', '--file', writeReply(root, 'good', IMPL_OK)).result.status, 'NEEDS_CONTEXT')
  // The valid reply ends the refusal streak: the answer is a dispatch, and the limit counts anew.
  const answer = call(root, 'attempt', '--name', 'T3 impl')
  assert.deepEqual([answer.attempt, answer.next], [3, 'dispatch'])
  assert.equal(call(root, 'reply', '--name', 'T3 impl', '--file', join(root, 'replies', 'bad.json')).next, 'retry')
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'T3 impl', '--file', join(root, 'replies', 'bad.json')).next, 'stop')
  assert.equal(call(root, 'attempt', '--name', 'T3 impl').next, 'stop')
})

// Verify and the review stage restart their own count; `attempt` counts from the run's start as
// `reply` does.
test('a third verify session dispatches verify c4 again', () => {
  const root = host()
  const verify = join(root, '.superpowers', 'sdd', CHANGE, 'verify')
  mkdirSync(verify, { recursive: true })
  for (const day of ['01', '02']) {
    const started = `2020-01-${day}T00:00:00.000Z`
    writeFileSync(join(verify, 'run.json'), JSON.stringify({ at: started, started }))
    for (const minute of ['01', '02']) {
      const now = `2020-01-${day}T00:${minute}:00.000Z`
      recordDispatch(root, CHANGE, 'verify c4', { now })
      recordReply(root, CHANGE, { name: 'verify c4', file: join(root, 'r.json'), errors: ['bad'], since: started, now })
    }
    assert.equal(recordDispatch(root, CHANGE, 'verify c4', { now: `2020-01-${day}T00:03:00.000Z` }).next, 'stop', day)
  }
  writeFileSync(join(verify, 'run.json'), JSON.stringify({ at: '2020-01-03T00:00:00.000Z', started: '2020-01-03T00:00:00.000Z' }))
  assert.equal(call(root, 'attempt', '--name', 'verify c4').next, 'dispatch')
})

test('a review dispatch counts from the review run\'s start', () => {
  const root = host()
  const now = '2020-01-01T00:00:00.000Z'
  for (const n of [1, 2]) {
    recordDispatch(root, CHANGE, 'ai-review r1', { now })
    recordReply(root, CHANGE, { name: 'ai-review r1', file: join(root, 'r.json'), errors: [`bad ${n}`], now })
  }
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1').next, 'stop')
  const review = join(root, '.superpowers', 'sdd', CHANGE, 'review')
  mkdirSync(review, { recursive: true })
  writeFileSync(join(review, 'start.json'), JSON.stringify({ at: '2020-01-02T00:00:00.000Z' }))
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1').next, 'dispatch')
})

test('a legacy attempts log gives the same rounds as the events log', () => {
  const names = ['T3 impl', 'T3 review', 'T3 fix r1', 'T3 re-review r1', 'T3 fix r2', 'T3 re-review r2', 'fix B r1', 're-review B r1', 'fix r1']
  const legacy = names.map((name) => JSON.stringify({ name, at: '2026-10-01T00:00:00.000Z' })).join('\n')
  const root = host()
  for (const name of names) {
    call(root, 'attempt', '--name', name)
    const role = parseName(name).role
    call(root, 'reply', '--name', name, '--file', writeReply(root, name.replace(/ /g, '-'), { role, verdict: 'pass', findings: [] }))
  }
  const current = readFileSync(join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl'), 'utf8')
  for (const subject of [{ task: 3 }, { group: 'B' }, {}]) assert.deepEqual(roundOf(current, subject), roundOf(legacy, subject), JSON.stringify(subject))
  assert.equal(roundOf(legacy, { task: 3 }).round, 3)
  // A legacy line counts as a dispatch for attempt and for the reply's standing.
  const old = host()
  mkdirSync(join(old, '.superpowers', 'sdd', CHANGE), { recursive: true })
  writeFileSync(join(old, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl'), `${legacy}\n`)
  const legacyAttempt = call(old, 'attempt', '--name', 'T3 impl')
  assert.deepEqual([legacyAttempt.attempt, legacyAttempt.next], [2, 'dispatch'])
  assert.equal(call(old, 'round', '--task', '3').round, 3)
})

test('distinct dispatch names never share an invalid count', () => {
  const root = host()
  // Two fixers whose replies both lack a valid finding: each keeps its own count.
  const noFinding = writeReply(root, 'no-finding', { outcome: 'fixed' })
  assert.equal(call(root, 'reply', '--name', 'ai-fix F1 r1', '--file', noFinding).next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'ai-fix F2 r1', '--file', noFinding).next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'ai-fix F1 r2', '--file', noFinding).next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'ai-review r1 s1', '--file', noFinding).next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'T3 fix r1', '--file', noFinding).next, 'retry')
  assert.equal(call(root, 'reply', '--name', 'ai-fix F1 r1', '--file', noFinding).next, 'stop')
  assert.equal(call(root, 'reply', '--name', 'ai-fix F2 r1', '--file', noFinding).next, 'stop')
  assert.deepEqual(
    events(root).map((e) => [e.name, e.next]),
    [['ai-fix F1 r1', 'retry'], ['ai-fix F2 r1', 'retry'], ['ai-fix F1 r2', 'retry'], ['ai-review r1 s1', 'retry'], ['T3 fix r1', 'retry'], ['ai-fix F1 r1', 'stop'], ['ai-fix F2 r1', 'stop']]
  )
  // A fixer's reply is checked against the finding its name carries, never keyed by its content.
  const f2 = writeReply(root, 'f2', { finding: 'F2', outcome: 'fixed', sha: 'abc1234', failureMode: 'off by one' })
  assert.deepEqual(call(root, 'reply', '--name', 'ai-fix F3 r1', '--file', f2).errors, ['$.finding: F2 is not F3, the finding this dispatch was sent to fix'])
  assert.equal(call(root, 'reply', '--name', 'ai-fix F2 r2', '--file', f2).next, 'proceed')
})

test('the reviewer prompt names its one input and its JSON reply, and from round 2 distrusts the last round', () => {
  const root = host()
  const plan1 = call(root, 'plan', '--role', 'ai-review', '--round', '1')
  assert.throws(() => call(root, 'prompt', '--role', 'ai-review', '--round', '1'), /run review\.mjs input --out/)
  mkdirSync(dirname(plan1.inputFile), { recursive: true })
  writeFileSync(plan1.inputFile, 'criteria\n\nHere is the diff:\n')
  const { prompt } = call(root, 'prompt', '--role', 'ai-review', '--round', '1')
  assert.match(prompt, /You are dispatched as `ai-review r1`, at the architecture capability level/)
  assert.ok(prompt.includes(`- Input file: ${plan1.inputFile}`))
  assert.ok(prompt.includes(`- Reply file: ${plan1.replyFile}`))
  assert.ok(prompt.includes(`Its whole input is \`${plan1.inputFile}\``))
  assert.ok(prompt.includes(`Write it to \`${plan1.replyFile}\``))
  assert.match(prompt, /use no other tool/)
  // No worktree, plan or reply.mjs: the reviewer reads the input file alone, and its reply is
  // the JSON review.mjs response checks.
  assert.doesNotMatch(prompt, /Worktree:|Plan:|reply\.mjs|git -C|previous round's verdict/)
  assert.doesNotMatch(prompt, /\{\{|\$\{CLAUDE_PLUGIN_ROOT\}|<!--/)

  const plan2 = call(root, 'plan', '--role', 'ai-review', '--round', '2', '--slice', '1')
  mkdirSync(dirname(plan2.inputFile), { recursive: true })
  writeFileSync(plan2.inputFile, 'x')
  const second = call(root, 'prompt', '--role', 'ai-review', '--round', '2', '--slice', '1').prompt
  assert.ok(second.includes('- Slice: 1'))
  assert.match(second, /A previous round's verdict, a fix commit's message and a\s+fixer's claim/)
  assert.throws(() => call(root, 'prompt', '--role', 'ai-review', '--round', '1', '--base', 'a', '--head', 'b'), /do not belong to ai-review/)
  assert.throws(() => call(root, 'prompt', '--role', 'ai-review', '--round', '1', '--findings', 'x'), /unknown flag --findings/)
})

test('the fixer prompt reads its finding from the round findings file, only for the fix plan next entry', () => {
  const root = host()
  const review = join(root, '.superpowers', 'sdd', CHANGE, 'review')
  const roundFile = (k, name, value) => {
    mkdirSync(join(review, `r${k}`), { recursive: true })
    writeFileSync(join(review, `r${k}`, name), JSON.stringify(value))
    return join(review, `r${k}`, name)
  }
  const entry = (finding, extra = {}) => ({ finding, name: `ai-fix ${finding} r1`, ...extra })
  const stored = {
    summary: 's',
    findings: [
      { id: 'F1', severity: 'HIGH', category: 'correctness', file: 'src/a.mjs', line: 7, title: 'off by one', body: 'b' },
      { id: 'F2', severity: 'CRITICAL', category: 'security', file: 'src/b.mjs', line: null, title: 'injection', body: 'b' }
    ]
  }
  const fix = (finding, round = '1') => call(root, 'prompt', '--role', 'ai-fix', '--finding', finding, '--round', round)
  assert.throws(() => fix('F1'), /round 1's findings are not stored/)
  const findings = roundFile(1, 'findings.json', stored)
  assert.throws(() => fix('F1'), /round 1 has no fix plan: run review\.mjs fixplan/)
  roundFile(1, 'fixplan.json', { round: 1, next: entry('F1'), fixes: [entry('F1'), entry('F2')] })
  assert.throws(() => fix('F9'), /F9 is not a finding of round 1/)
  assert.throws(() => fix('F2'), /F2 is not the next fix of round 1 \(F1\)/)
  assert.throws(() => call(root, 'prompt', '--role', 'ai-fix', '--finding', 'F1', '--round', '1', '--findings', findings), /unknown flag --findings/)
  const out = fix('F1')
  assert.equal(out.agent, 'adf:integration')
  const { prompt } = out
  assert.match(prompt, /You are dispatched as `ai-fix F1 r1`, at the integration capability level/)
  assert.ok(prompt.includes('- Finding: F1 (HIGH): off by one'))
  assert.ok(prompt.includes(`- Findings file: ${findings}`))
  assert.ok(prompt.includes(`  - ${join(root, 'src/a.mjs')}:7`))
  assert.ok(prompt.includes(`node "${PLUGIN_ROOT}/scripts/commit.mjs" --root ${root} --only <path>`))
  assert.ok(prompt.includes(`valid under \`${join(PLUGIN_ROOT, 'schema', 'review-fix.schema.json')}\``))
  assert.ok(prompt.includes(`Write it to\n\`${out.replyFile}\``) || prompt.includes(`Write it to \`${out.replyFile}\``))
  assert.match(prompt, /`failureMode` states the failure/)
  assert.match(prompt, /`git -C /)
  assert.doesNotMatch(prompt, /reply\.mjs|\{\{|\$\{CLAUDE_PLUGIN_ROOT\}|<worktree>|<!--|Rejected false-positive argument/)
  roundFile(2, 'findings.json', stored)
  const rejected = { argument: 'src/b.mjs:1 escapes it', decision: 'the escape does not cover the header', ruling: 'ruling-1' }
  roundFile(2, 'fixplan.json', { round: 2, next: entry('F2', { rejected }), fixes: [entry('F2', { rejected })] })
  const f2 = fix('F2', '2')
  assert.equal(f2.agent, 'adf:architecture')
  assert.ok(f2.prompt.includes(`  - ${join(root, 'src/b.mjs')}\n`))
  assert.ok(f2.prompt.includes('- Rejected false-positive argument: src/b.mjs:1 escapes it'))
  assert.ok(f2.prompt.includes("- Developer's decision: the escape does not cover the header"))
  assert.match(f2.prompt, /the developer has ruled that the finding holds/)
})

// ---------------------------------------------------------------- archive

test('archive names one spec-merge per capability and one ingest, both at architecture', () => {
  assert.equal(dispatchName({ role: 'spec-merge', capability: 'widgets' }), 'spec-merge widgets')
  assert.equal(dispatchName({ role: 'ingest' }), 'ingest')
  assert.deepEqual(parseName('spec-merge new-cap'), { role: 'spec-merge', capability: 'new-cap' })
  assert.deepEqual(parseName('ingest'), { role: 'ingest' })
  for (const name of ['spec-merge', 'spec-merge Widgets', 'spec-merge a b', 'ingest r1']) assert.equal(parseName(name), null, name)
  const bad = [
    [{ role: 'spec-merge' }, /needs --capability/],
    [{ role: 'spec-merge', capability: 'Bad_Name' }, /needs --capability/],
    [{ role: 'spec-merge', capability: 'a', round: 1 }, /takes only --capability/],
    [{ role: 'ingest', task: 1 }, /takes no task/],
    [{ role: 'ingest', capability: 'a' }, /--capability belongs to spec-merge/],
    [{ role: 'sweep', capability: 'a' }, /--capability belongs to spec-merge/]
  ]
  for (const [inputs, message] of bad) assert.throws(() => dispatchName(inputs), message, JSON.stringify(inputs))
  const root = host('no plan needed')
  const replies = join(root, '.superpowers', 'sdd', CHANGE, 'replies')
  const merge = call(root, 'plan', '--role', 'spec-merge', '--capability', 'widgets')
  assert.deepEqual(
    { name: merge.name, agent: merge.agent, worktree: merge.worktree, capability: merge.capability, replyFile: merge.replyFile },
    { name: 'spec-merge widgets', agent: 'adf:architecture', worktree: root, capability: 'widgets', replyFile: join(replies, 'spec-merge-widgets.json') }
  )
  const ingest = call(root, 'plan', '--role', 'ingest')
  assert.deepEqual({ name: ingest.name, agent: ingest.agent, replyFile: ingest.replyFile }, { name: 'ingest', agent: 'adf:architecture', replyFile: join(replies, 'ingest.json') })
})

test('the spec-merge prompt names the three texts of each conflict by path, the schema and the reply file', async () => {
  const { mergeRepo } = await import('./fixtures/spec-merge/repo.mjs')
  const req = (name, body) => `### Requirement: ${name}\n${body}\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n`
  const main = `# widgets Specification\n\n## Purpose\nWidgets are built, stored and shipped by the system, one at a time.\n\n## Requirements\n${req('Store', 'The system SHALL store.')}`
  const { change, onDevelop } = mergeRepo({ main: { widgets: main }, delta: { widgets: `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry.')}` } })
  onDevelop({ 'openspec/specs/widgets/spec.md': main.replace('SHALL store.', 'SHALL store widgets cold.') })
  const out = run(['prompt', '--change', CHANGE, '--role', 'spec-merge', '--capability', 'widgets', '--root', change], { main: change })
  const dir = join(change, '.superpowers', 'sdd', CHANGE, 'spec-merge', 'widgets')
  for (const [which, text] of [['base', 'SHALL store.'], ['current', 'SHALL store widgets cold.'], ['delta', 'SHALL store widgets dry.']]) {
    assert.ok(out.prompt.includes(`${which}: ${join(dir, `1-${which}.md`)}`), which)
    assert.ok(readFileSync(join(dir, `1-${which}.md`), 'utf8').includes(text), which)
  }
  assert.match(out.prompt, /requirement: Store \(MODIFIED\), side: base-branch/)
  assert.ok(out.prompt.includes(join(PLUGIN_ROOT, 'schema', 'spec-merge-resolution.schema.json')))
  assert.ok(out.prompt.includes(out.replyFile))
  assert.match(out.prompt, /read-only/)
  assert.throws(() => run(['prompt', '--change', CHANGE, '--role', 'spec-merge', '--capability', 'other', '--root', change], { main: change }), /no unresolved conflict/)
})

test('the ingest prompt reads its input file and runs on the archived change; without the file it is refused', () => {
  const root = host('no plan needed')
  const archived = join(root, 'openspec', 'changes', 'archive', `2026-10-19-${CHANGE}`)
  mkdirSync(join(archived, 'specs', 'widgets'), { recursive: true })
  writeFileSync(join(archived, 'proposal.md'), '# x\n')
  writeFileSync(join(archived, 'specs', 'widgets', 'spec.md'), '## ADDED Requirements\n')
  execFileSync('rm', ['-r', join(root, 'openspec', 'changes', CHANGE)])
  assert.throws(() => run(['prompt', '--change', CHANGE, '--role', 'ingest', '--root', root], { main: MAIN }), /run ingest\.mjs stale/)
  assert.throws(() => run(['prompt', '--change', CHANGE, '--role', 'sweep', '--root', root], { main: MAIN }), /no change/)
  const input = join(root, '.superpowers', 'sdd', CHANGE, 'ingest', 'input.json')
  mkdirSync(dirname(input), { recursive: true })
  writeFileSync(input, JSON.stringify({
    change: CHANGE,
    changeDir: `openspec/changes/archive/2026-10-19-${CHANGE}`,
    base: 'abc1234',
    knowledge: { index: '.claude/memory/index.md', instruction: '/plugins/adf-memory/instructions/ingest.md', paths: ['.claude/memory/**'], log: ['.claude/memory/log.md'] },
    stale: [{ path: '.claude/memory/entities/a.md', reasons: ['names src/a.mjs, which the change deleted'] }]
  }))
  const out = run(['prompt', '--change', CHANGE, '--role', 'ingest', '--root', root], { main: MAIN })
  assert.equal(out.name, 'ingest')
  for (const text of [
    join(archived, 'proposal.md'),
    join(archived, 'specs', 'widgets', 'spec.md'),
    '/plugins/adf-memory/instructions/ingest.md',
    join(root, '.claude/memory/index.md'),
    `${join(root, '.claude/memory/entities/a.md')}: names src/a.mjs, which the change deleted`,
    'What invariant does this change rely on that no single file shows?',
    'What would a future implementer most plausibly get wrong here?',
    join(PLUGIN_ROOT, 'schema', 'ingest.schema.json'),
    out.replyFile
  ]) assert.ok(out.prompt.includes(text), text)
  const attempt = () => run(['attempt', '--change', CHANGE, '--name', 'ingest', '--root', root], { main: MAIN })
  assert.deepEqual([attempt(), attempt()].map((a) => [a.attempt, a.next]), [[1, 'dispatch'], [2, 'dispatch']])
})

// ---------------------------------------------------------------- the retrospective

test('the retro is named by its id, at architecture, with its state under .superpowers/retro/<id>/', () => {
  assert.equal(dispatchName({ role: 'retro', id: '2026-10-19-window' }), 'retro 2026-10-19-window')
  assert.equal(dispatchName({ role: 'retro', id: '2026-10-19-my-change' }), 'retro 2026-10-19-my-change')
  assert.deepEqual(parseName('retro 2026-10-19-window'), { role: 'retro', id: '2026-10-19-window' })
  assert.deepEqual(parseName('retro 2026-10-19-period'), { role: 'retro', id: '2026-10-19-period' })
  assert.deepEqual(parseName('retro 2026-10-19-my-change'), { role: 'retro', id: '2026-10-19-my-change' })
  for (const name of ['retro', 'retro 2026-10-19', 'retro 2026-10-window', 'retro 2026-10-19-window r1', 'retro 2026-10-19-Window', 'retro 2026-10-19-']) assert.equal(parseName(name), null, name)
  const bad = [
    [{ role: 'retro' }, /needs an id <YYYY-MM-DD>-<window \| period \| change name>/],
    [{ role: 'retro', id: '2026-10-19' }, /needs an id/],
    [{ role: 'retro', id: '19.10.2026-window' }, /needs an id/],
    [{ role: 'retro', id: '2026-10-19-window', round: 1 }, /takes only an id/],
    [{ role: 'ingest', id: '2026-10-19-window' }, /an id belongs to retro/]
  ]
  for (const [inputs, message] of bad) assert.throws(() => dispatchName(inputs), message, JSON.stringify(inputs))
  const root = '/host'
  const id = '2026-10-19-window'
  const dir = join(root, '.superpowers', 'retro', id)
  const taken = new Set([join(dir, 'replies', `retro-${id}.json`)])
  const plan = planDispatch({ role: 'retro', id }, { root, main: root, planText: null, exists: (p) => taken.has(p) })
  assert.deepEqual(plan, {
    name: `retro ${id}`,
    role: 'retro',
    agent: 'adf:architecture',
    worktree: root,
    id,
    inputFile: join(dir, 'input.json'),
    replyFile: join(dir, 'replies', `retro-${id}-2.json`)
  })
})

test('the retro prompt serves the retrospective, reads its input file, is read-only and names its schema', () => {
  const skeletons = Object.fromEntries(readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md')).map((f) => [f.slice(0, -3), readFileSync(join(PROMPTS_DIR, f), 'utf8')]))
  const plan = planDispatch({ role: 'retro', id: '2026-10-19-window' }, { root: '/host', main: '/host', planText: null, exists: () => false })
  const prompt = renderPrompt({ plan, skeletons, fields: [['Dispatch name', plan.name]], tokens: { '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT } })
  assert.match(prompt, /^You are dispatched as `retro 2026-10-19-window`, at the architecture capability level, for the retrospective 2026-10-19-window\./)
  assert.ok(prompt.includes(`Read the input file, \`${plan.inputFile}\`.`))
  assert.ok(prompt.includes(`JSON Schema, \`${join(PLUGIN_ROOT, 'schema', 'retro.schema.json')}\`.`))
  assert.ok(prompt.includes(plan.replyFile))
  assert.match(prompt, /This dispatch is read-only/)
  assert.match(prompt, /None beyond the rules below\./, 'the question is optional')
  for (const cls of ['late-caught', 're-derivation', 'premature-done']) assert.ok(prompt.includes(`\`${cls}\``), cls)
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/)
})

// ---------------------------------------------------------------- loop state by script

const LOOP_FINDING = { severity: 'important', kind: 'quality', category: 'quality', file: 'src/t1.mjs', line: 3, title: 'Unchecked error', body: 'The error is dropped.\nIt reaches the caller.' }
const loopReview = (findings, unverifiable = []) => ({ role: 'review', summary: 'Reviewed.', findings, unverifiable })
const loopReReview = (previous, outOfScope = []) => ({ role: 're-review', summary: 'Checked.', previous: previous.map(([id, status]) => ({ id, status, file: 'src/t1.mjs', line: 3 })), findings: [], outOfScope })

test('the fix and re-review prompts render the open findings, honour the rulings and refuse when none is open', () => {
  const root = host()
  const reviewed = call(root, 'reply', '--name', 'T1 review', '--file', writeReply(root, 'T1-review', loopReview([LOOP_FINDING, { ...LOOP_FINDING, title: 'Plan says so', planMandated: true }, { ...LOOP_FINDING, severity: 'minor', title: 'Naming' }])))
  assert.deepEqual([reviewed.result.open, reviewed.result.toRule, reviewed.result.deferred], [['F1'], ['F2'], ['F3']])
  // No question file: the findings are the question.
  const fix = call(root, 'prompt', '--role', 'fix', '--task', '1', '--round', '1').prompt
  assert.ok(fix.includes('- Open findings:\n  - F1 (important, quality) src/t1.mjs:3: Unchecked error\n    The error is dropped.\n    It reaches the caller.'), fix)
  assert.doesNotMatch(fix, /F2 \(|F3 \(/)
  assert.match(fix, /None beyond the rules below\./)
  const rule = (finding, as) => appendRecord(root, CHANGE, 'ruling', { subject: 'T1', finding, as, decision: 'the plan is wrong here' })
  rule('F2', 'fix')
  rule('F1', 'accepted')
  const ruled = call(root, 'prompt', '--role', 're-review', '--task', '1', '--round', '1').prompt
  assert.ok(ruled.includes('  - F2 (important, quality) src/t1.mjs:3: Plan says so\n    The error is dropped.\n    It reaches the caller.\n    Ruled fix: the plan is wrong here'), ruled)
  assert.doesNotMatch(ruled, /F1 \(/)
  // The re-review answers the open set the rulings leave: F2, not F1.
  const wrong = call(root, 'reply', '--name', 'T1 re-review r1', '--file', writeReply(root, 'rr-wrong', loopReReview([['F1', 'addressed']])))
  assert.deepEqual(wrong.errors, ['$.previous[0].id: F1 is not an open finding of T1', '$.previous: the open finding F2 of T1 is not answered'])
  const done = call(root, 'reply', '--name', 'T1 re-review r1', '--file', writeReply(root, 'rr-done', loopReReview([['F2', 'addressed']], [{ file: 'src/old.mjs', line: null, title: 'Old naming' }])))
  assert.deepEqual([done.valid, done.result.open, done.result.result], [true, [], 'clean'])
  assert.throws(() => call(root, 'prompt', '--role', 'fix', '--task', '1', '--round', '2'), /T1 has no open finding to fix/)
  // A subject with no accepted review still needs the question.
  assert.throws(() => call(root, 'prompt', '--role', 'fix', '--task', '3', '--round', '1'), /needs --question-file/)
  // A plan-mandated finding alone is ruled first, not fixed.
  call(root, 'reply', '--name', 'merge-review A', '--file', writeReply(root, 'mr', { ...loopReview([{ ...LOOP_FINDING, planMandated: true }]), role: 'merge-review' }))
  assert.throws(() => call(root, 'prompt', '--role', 'fix', '--group', 'A', '--round', '1'), /A has no open finding to fix; A is not clean \(to rule F1\)/)
})

test('the deferred minors and out-of-scope items are collected into deferred.json and fed to the final review', () => {
  const root = host()
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Review the branch.')
  call(root, 'reply', '--name', 'T1 review', '--file', writeReply(root, 'T1-review', loopReview([LOOP_FINDING, { ...LOOP_FINDING, severity: 'minor', title: 'Naming', body: 'Call it parse.' }])))
  const file = join(root, '.superpowers', 'sdd', CHANGE, 'deferred.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((i) => [i.subject, i.id, i.source, i.title]), [['T1', 'F2', 'minor', 'Naming']])
  call(root, 'reply', '--name', 'T1 re-review r1', '--file', writeReply(root, 'rr', loopReReview([['F1', 'addressed']], [{ file: 'src/old.mjs', line: 7, title: 'Old naming' }])))
  const items = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(items.map((i) => [i.subject, i.dispatch, i.source]), [['T1', 'T1 review', 'minor'], ['T1', 'T1 re-review r1', 'out-of-scope']])
  const final = call(root, 'prompt', '--role', 'final-review', '--question-file', q).prompt
  assert.ok(final.includes('- Deferred:\n  - T1 F2 (minor, quality) src/t1.mjs:3: Naming\n    Call it parse.\n  - T1 out of scope src/old.mjs:7: Old naming'), final)
  assert.ok(final.includes(`- Deferred file: ${file}`))
  assert.match(call(host(), 'prompt', '--role', 'final-review', '--question-file', q).prompt, /- Deferred: none/)
})

test('scope-check <KEY> is a fixed-form name: parsed with its key, refused with a space, a colon or no key', async () => {
  const { scopeCheckName, SCOPE_ROLES } = await import('../lib/dispatch.mjs')
  assert.deepEqual(parseName('scope-check PROJ-12'), { role: 'scope-check', key: 'PROJ-12' })
  assert.deepEqual(parseName('scope-check #41'), { role: 'scope-check', key: '#41' })
  for (const name of ['scope-check', 'scope-check two words', 'scope-check A:B']) assert.equal(parseName(name), null, name)
  assert.equal(scopeCheckName('PROJ-12'), 'scope-check PROJ-12')
  assert.throws(() => scopeCheckName('a b'), /is not a scope key/)
  assert.deepEqual(SCOPE_ROLES['scope-check'], { level: 'integration', schema: 'scope-check.schema.json' })
})

test('land-comment <KEY> is a fixed-form name: parsed with its key, refused with a space, a colon or no key', async () => {
  const { landCommentName, LAND_ROLES } = await import('../lib/dispatch.mjs')
  assert.deepEqual(parseName('land-comment PROJ-12'), { role: 'land-comment', key: 'PROJ-12' })
  for (const name of ['land-comment', 'land-comment two words', 'land-comment A:B']) assert.equal(parseName(name), null, name)
  assert.equal(landCommentName('PROJ-12'), 'land-comment PROJ-12')
  assert.throws(() => landCommentName('a b'), /is not a scope key/)
  assert.deepEqual(LAND_ROLES['land-comment'], { level: 'integration', schema: 'land-comment.schema.json' })
})
