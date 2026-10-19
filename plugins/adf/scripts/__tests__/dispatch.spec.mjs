// dispatch.mjs: the fixed name, level, worktree, reply file and prompt of every dispatch, and the
// attempt count behind the one-retry rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchName, MAX_ROUNDS, normalize, parseGraph, parseName, planDispatch, roundOf, verbatimBlocks } from '../lib/dispatch.mjs'
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
    [{ role: 'merge-review', group: 'A', round: 2 }, /belongs to a task dispatch, or to a fix or re-review/],
    [{ role: 'sweep', round: 1 }, /belongs to a task dispatch/],
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
  assert.deepEqual(v.sectionFiles, ['c8-agent.txt', 'c8.json'].map((f) => join(root, '.superpowers', 'sdd', CHANGE, 'verify', f)))
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
  assert.ok(prompt.includes(`node "${PLUGIN_ROOT}/scripts/commit.mjs" --root ${wt} --only <path>`))
  assert.match(prompt, /which tests cover a file\s+is your call/)
  assert.ok(prompt.includes(`${PLUGIN_ROOT}/scripts/lib/reply.mjs`))
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
  assert.match(plain, /do not re-run them to\s+confirm it/)
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
  assert.ok(c8.includes(`Files in scope:\n  - ${join(verify, 'c8-candidates.txt')}`))
  assert.ok(!c8.includes(join(root, '.claude', 'skills', 'deploy', 'SKILL.md')))
  assert.ok(c8.includes(join(verify, 'c8-candidates.txt')))
  assert.match(c4, /`proseEdits`/)
  for (const p of [c4, c8]) assert.doesNotMatch(p, /\{\{\w+\}\}|<verify>|<id>|<root>|<change>/)
})

test('attempts per name: the first dispatches, the second retries, the third stops', () => {
  const root = host()
  const attempt = (name) => call(root, 'attempt', '--name', name)
  assert.deepEqual([1, 2, 3, 4].map(() => attempt('T3 impl').next), ['dispatch', 'retry', 'stop', 'stop'])
  assert.deepEqual(attempt('T3 fix r1'), { ok: true, name: 'T3 fix r1', attempt: 1, next: 'dispatch', file: join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl') })
  const bad = cli(root, 'attempt', '--change', CHANGE, '--name', 'T3 implement')
  assert.equal(bad.status, 1)
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
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F2 r1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1 s1').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-review r1 s2').next, 'dispatch')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r1').next, 'retry')
  assert.equal(call(root, 'attempt', '--name', 'ai-fix F1 r2').next, 'dispatch')
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
  assert.throws(() => call(root, 'reply', '--name', 'verify c4', '--file', bad), /verify\.mjs verdict/)
  assert.throws(() => call(root, 'reply', '--name', 'T3 implement', '--file', bad), /fixed form/)
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
  assert.equal(call(old, 'attempt', '--name', 'T3 impl').next, 'retry')
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
    knowledge: { index: '.claude/memory/index.md', instruction: '/plugins/memory/instructions/ingest.md', paths: ['.claude/memory/**'], log: ['.claude/memory/log.md'] },
    stale: [{ path: '.claude/memory/entities/a.md', reasons: ['names src/a.mjs, which the change deleted'] }]
  }))
  const out = run(['prompt', '--change', CHANGE, '--role', 'ingest', '--root', root], { main: MAIN })
  assert.equal(out.name, 'ingest')
  for (const text of [
    join(archived, 'proposal.md'),
    join(archived, 'specs', 'widgets', 'spec.md'),
    '/plugins/memory/instructions/ingest.md',
    join(root, '.claude/memory/index.md'),
    `${join(root, '.claude/memory/entities/a.md')}: names src/a.mjs, which the change deleted`,
    'What invariant does this change rely on that no single file shows?',
    'What would a future implementer most plausibly get wrong here?',
    join(PLUGIN_ROOT, 'schema', 'ingest.schema.json'),
    out.replyFile
  ]) assert.ok(out.prompt.includes(text), text)
  assert.equal(run(['attempt', '--change', CHANGE, '--name', 'ingest', '--root', root], { main: MAIN }).next, 'dispatch')
  assert.equal(run(['attempt', '--change', CHANGE, '--name', 'ingest', '--root', root], { main: MAIN }).next, 'retry')
  assert.equal(run(['attempt', '--change', CHANGE, '--name', 'ingest', '--root', root], { main: MAIN }).next, 'stop')
})
