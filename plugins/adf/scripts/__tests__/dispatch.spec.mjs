// dispatch.mjs: the fixed name, level, worktree, reply file and prompt of every dispatch, and the
// attempt count behind the one-retry rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchName, normalize, parseGraph, parseName, planDispatch, verbatimBlocks } from '../lib/dispatch.mjs'
import { PLUGIN_ROOT, PROMPTS_DIR, run } from '../dispatch.mjs'

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
  for (const c of ['c4', 'c6', 'c8', 'assemble']) assert.equal(dispatchName({ role: 'verify', check: c }), `verify ${c}`)
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
    [{ role: 'fix', group: 'A', round: 2 }, /belongs to a task/],
    [{ role: 'verify', check: 'c5' }, /needs --check/],
    [{ role: 'impl', task: 1, group: 'A' }, /from the plan/]
  ]
  for (const [inputs, message] of bad) assert.throws(() => dispatchName(inputs), message, JSON.stringify(inputs))
})

test('parseName reads back every fixed-form name and refuses the rest', () => {
  for (const name of ['T3 impl', 'T3 fix r2', 'final-review', 'sweep', 'merge-review B', 'fix B', 'fix', 're-review', 'investigate auth', 'verify c6']) {
    const parts = parseName(name)
    assert.ok(parts, name)
    assert.equal(dispatchName(parts), name)
  }
  for (const name of ['T3 implement', 'T0 impl', 'investigate two words', 'merge-review', 'verify c5', 'review', 'Task 3 impl']) assert.equal(parseName(name), null, name)
})

test('the graph numbers groups by row and reads their tasks and wave', () => {
  assert.deepEqual(parseGraph(PLAN), [
    { letter: 'A', number: 1, tasks: [1, 2], wave: 1 },
    { letter: 'B', number: 2, tasks: [3], wave: 1 },
    { letter: 'C', number: 3, tasks: [4], wave: 2 }
  ])
  assert.deepEqual(parseGraph(plan([['A', '1-3', 1]], [])).at(0).tasks, [1, 2, 3])
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
  assert.equal(agent({ role: 'final-review' }), 'adf:architecture')
  assert.equal(agent({ role: 'sweep' }), 'adf:integration')
  assert.equal(agent({ role: 'verify', check: 'c4' }), 'adf:architecture')
  assert.equal(agent({ role: 'verify', check: 'c8' }), 'adf:integration')
  assert.equal(agent({ role: 'verify', check: 'c6' }), 'adf:integration')
  assert.equal(agent({ role: 'verify', check: 'assemble' }), 'adf:mechanical')
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
  const v = call(root, 'plan', '--role', 'verify', '--check', 'c6')
  assert.deepEqual(v.sectionFiles, ['test-record-agent.txt', 'test-record.json'].map((f) => join(root, '.superpowers', 'sdd', CHANGE, 'verify', f)))
  assert.equal(v.replyFile, undefined)
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
  assert.ok(prompt.includes(`${PLUGIN_ROOT}/scripts/lib/reply.mjs`))
  assert.ok(prompt.includes(join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'T3-impl.json')))
  assert.doesNotMatch(prompt, /\$\{CLAUDE_PLUGIN_ROOT\}|<change>|<root>|<worktree>|<!--/)
})

test('a review proves the test can fail only for a test-first task; its question is required', () => {
  const root = host()
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Review it.')
  const proof = /the review proves the new test can fail/
  assert.match(call(root, 'prompt', '--role', 'review', '--task', '2', '--question-file', q).prompt, proof)
  const plain = call(root, 'prompt', '--role', 'review', '--task', '1', '--question-file', q, '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)).prompt
  assert.doesNotMatch(plain, proof)
  assert.ok(plain.includes(`review-aaaaaaa..bbbbbbb.diff`))
  assert.match(plain, /A reviewer that accepts a compromise records it the same way\./)
  const refused = cli(root, 'prompt', '--change', CHANGE, '--role', 'review', '--task', '1')
  assert.equal(refused.status, 1)
  assert.match(refused.out.error, /needs --question-file/)
})

test('the sweep prompt names the base and the fixed question; a merge review names the group files', () => {
  const root = host()
  const sweep = call(root, 'prompt', '--role', 'sweep').prompt
  assert.ok(sweep.includes('Base: develop'))
  assert.ok(sweep.includes("against the change's base, `develop`"))
  assert.match(sweep, /\*\*One question:\*\* does the branch add a symbol/)
  const q = join(root, 'q.txt')
  writeFileSync(q, 'Check the merge.')
  const merge = call(root, 'prompt', '--role', 'merge-review', '--group', 'A', '--question-file', q).prompt
  assert.ok(merge.includes(join(root, 'src/t1.mjs')) && merge.includes(join(root, 'src/t2.mjs')))
  assert.ok(!merge.includes('src/t3.mjs'))
})

test('a verify prompt reads base and range from run.json and names its two files', () => {
  const root = host()
  assert.match(cli(root, 'prompt', '--change', CHANGE, '--role', 'verify', '--check', 'c4').out.error, /run verify\.mjs run first/)
  const verify = join(root, '.superpowers', 'sdd', CHANGE, 'verify')
  mkdirSync(verify, { recursive: true })
  writeFileSync(join(verify, 'run.json'), JSON.stringify({ base: 'origin/develop', head: 'abc123' }))
  mkdirSync(join(root, '.claude', 'skills', 'deploy'), { recursive: true })
  writeFileSync(join(root, '.claude', 'skills', 'deploy', 'SKILL.md'), 'x')
  const c4 = call(root, 'prompt', '--role', 'verify', '--check', 'c4').prompt
  assert.ok(c4.includes('Range: origin/develop..abc123'))
  assert.ok(c4.includes(`Output file: ${join(verify, 'c4-agent.txt')}`))
  assert.ok(c4.includes(`Section file: ${join(verify, 'c4.json')}`))
  assert.match(c4, /Every design decision traces to a requirement/)
  assert.ok(c4.includes(`git runs as \`git -C ${root}\``))
  const c8 = call(root, 'prompt', '--role', 'verify', '--check', 'c8').prompt
  assert.ok(c8.includes(join(root, '.claude', 'skills', 'deploy', 'SKILL.md')))
  const assemble = call(root, 'prompt', '--role', 'verify', '--check', 'assemble').prompt
  assert.ok(assemble.includes(`It writes \`${join(root, 'openspec', 'changes', CHANGE, 'verify.md')}\``))
  for (const p of [c4, c8, assemble]) assert.doesNotMatch(p, /\{\{\w+\}\}|<verify>|<id>|<root>|<change>/)
})

test('attempts per name: the first dispatches, the second retries, the third stops', () => {
  const root = host()
  const attempt = (name) => call(root, 'attempt', '--name', name)
  assert.deepEqual([1, 2, 3, 4].map(() => attempt('T3 impl').next), ['dispatch', 'retry', 'stop', 'stop'])
  assert.deepEqual(attempt('T3 fix r1'), { ok: true, name: 'T3 fix r1', attempt: 1, next: 'dispatch', file: join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl') })
  const bad = cli(root, 'attempt', '--change', CHANGE, '--name', 'T3 implement')
  assert.equal(bad.status, 1)
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

// The skeletons copy the instruction's clauses; a reworded instruction that leaves its copy
// behind would send agents the old rule.
test('every verbatim block of a prompt skeleton is in its instruction, word for word', () => {
  const pluginRoot = join(PROMPTS_DIR, '..', '..')
  let blocks = 0
  for (const f of readdirSync(PROMPTS_DIR)) {
    for (const { source, text } of verbatimBlocks(readFileSync(join(PROMPTS_DIR, f), 'utf8'))) {
      blocks++
      const instruction = normalize(readFileSync(join(pluginRoot, source), 'utf8'))
      assert.ok(instruction.includes(normalize(text)), `${f}: a verbatim block is not in ${source}: ${text.slice(0, 80)}`)
    }
  }
  assert.ok(blocks >= 10)
  assert.ok(!normalize(readFileSync(join(pluginRoot, 'schema/instructions/apply.md'), 'utf8')).includes(normalize('- dispatch a subagent of its own;')))
})
