// tdd-proof.mjs: the new test fails on the parent with the commit's tests, and passes on the
// commit, in a throwaway worktree that is removed afterwards and never touches the source tree.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { run as dispatch } from '../dispatch.mjs'
import { recordReply } from '../lib/attempts.mjs'
import { isTestFile, sharesIn, taskProof } from '../lib/tdd-proof.mjs'
import { run } from '../tdd-proof.mjs'
import { commitIn, git, host, superpowersHome } from './git-host.mjs'

const TEST = "import { f } from '../src/f.mjs'\nif (f() !== 2) { console.error('f() is', f()); process.exit(1) }\n"

function twoCommits(testText = TEST) {
  const { root, change } = host()
  commitIn(change, 'src/f.mjs', 'export const f = () => 1\n')
  writeFileSync(join(change, 'src/f.mjs'), 'export const f = () => 2\n')
  mkdirSync(join(change, 'test'), { recursive: true })
  writeFileSync(join(change, 'test/f.test.mjs'), testText)
  git(change, 'add', 'src/f.mjs', 'test/f.test.mjs')
  git(change, 'commit', '-q', '-m', 'feat: f is 2')
  return { root, change, sha: git(change, 'rev-parse', 'HEAD') }
}

const args = (change, sha, extra = []) => ['--worktree', change, '--commit', sha, '--test', 'node test/f.test.mjs', '--change', 'add-x', ...extra]

test('a test that fails without the code and passes with it is a proof; the tree is untouched', () => {
  const { root, change, sha } = twoCommits()
  const out = run(args(change, sha))
  assert.equal(out.proof, true, JSON.stringify(out))
  assert.deepEqual([out.parentFails, out.commitPasses, out.parentExit, out.commitExit, out.testFiles], [true, true, 1, 0, ['test/f.test.mjs']])
  assert.equal(out.removed, true)
  assert.equal(existsSync(join(root, '.claude/worktrees', `add-x--tdd-${sha.slice(0, 7)}`)), false)
  assert.match(readFileSync(out.outputFiles.parent, 'utf8'), /f\(\) is 1/)
  assert.equal(out.outputFiles.commit, join(change, `.superpowers/sdd/add-x/tdd/${sha.slice(0, 7)}-commit.txt`))
  assert.equal(git(change, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(git(change, 'rev-parse', 'HEAD'), sha)
})

test('a test command that names the worktree or the main checkout by absolute path is refused before any worktree is made', () => {
  const { root, change, sha } = twoCommits()
  for (const test of [`node ${change}/test/f.test.mjs`, `node test/f.test.mjs --root=${root}`]) {
    assert.throws(() => run(['--worktree', change, '--commit', sha, '--test', test, '--change', 'add-x']), /worktree-relative/, test)
  }
  assert.equal(existsSync(join(root, '.claude/worktrees', `add-x--tdd-${sha.slice(0, 7)}`)), false)
})

test('a test that passes on the parent is no proof', () => {
  const { change, sha } = twoCommits("import { f } from '../src/f.mjs'\nif (typeof f !== 'function') process.exit(1)\n")
  const out = run(args(change, sha))
  assert.deepEqual([out.ok, out.proof, out.parentFails, out.commitPasses], [false, false, false, true])
})

test('--share links an untracked dependency into both runs and unlinks it before the removal', () => {
  const { change } = twoCommits()
  mkdirSync(join(change, 'deps'), { recursive: true })
  writeFileSync(join(change, 'deps/two.mjs'), 'export default 2\n')
  commitIn(change, 'src/g.mjs', "import two from '../deps/two.mjs'\nexport const g = () => two\n")
  writeFileSync(join(change, 'test/g.test.mjs'), "import { g } from '../src/g.mjs'\nif (g() !== 2) process.exit(1)\n")
  writeFileSync(join(change, 'src/g.mjs'), "import two from '../deps/two.mjs'\nexport const g = () => two + 0\n")
  const g = (() => {
    git(change, 'add', 'src/g.mjs', 'test/g.test.mjs')
    git(change, 'commit', '-q', '-m', 'feat: g')
    return git(change, 'rev-parse', 'HEAD')
  })()
  const cmd = ['--worktree', change, '--commit', g, '--test', 'node test/g.test.mjs', '--change', 'add-x']
  const bare = run(cmd)
  assert.deepEqual([bare.commitPasses, bare.proof], [false, false], 'without the dependency the commit itself does not pass: no proof, never a false one')
  const shared = run([...cmd, '--share', 'deps'])
  assert.deepEqual([shared.shared, shared.commitPasses, shared.removed], [['deps'], true, true])
})

test('refusals: no test file, a root commit, a leftover worktree; an untracked leftover blocks removal', () => {
  const { root, change } = host()
  const plain = commitIn(change, 'src/x.mjs', 'x\n')
  assert.throws(() => run(['--worktree', change, '--commit', plain, '--test', 'true', '--change', 'add-x']), /no test file/)
  const first = git(root, 'rev-list', '--max-parents=0', 'HEAD')
  assert.throws(() => run(['--worktree', change, '--commit', first, '--test', 'true', '--change', 'add-x']), /no parent/)
  assert.throws(() => run(['--worktree', change, '--commit', plain]), /usage/)
  const dirty = commitIn(change, 'test/w.test.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync('out.txt', 'x')\nprocess.exit(1)\n")
  const out = run(['--worktree', change, '--commit', dirty, '--test', 'node test/w.test.mjs', '--change', 'add-x'])
  assert.equal(out.removed, false)
  assert.match(out.removeError, /left for the developer/)
  assert.throws(() => run(['--worktree', change, '--commit', dirty, '--test', 'true', '--change', 'add-x']), /leftover/)
  assert.deepEqual(['src/a.test.ts', '__tests__/x.mjs', 'pkg/tests/y.py', 'test_z.py', 'src/a.ts'].map(isTestFile), [true, true, true, true, false])
})

// ---------------------------------------------------------------- run by the orchestrator's script

const PLAN = `# Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1 | x | 1 |

---

### Task 1: f is 2

> Implements \`tasks.md\` 1.1.

**Files:**
- Modify: \`src/f.mjs\` — the value
- Test: \`test/f.test.mjs\` — its test

**Level:** integration

- [ ] **Step 1: RED** — a failing test
- [ ] **Step 2: GREEN** — the code
`

// A test-first task done: its commit, the accepted T1 impl reply naming it and its covering run,
// and the planning guide's shares section when `shares` is given.
function doneTask(testText, shares) {
  const { root, change } = host({ 'plan.md': PLAN, 'tasks.md': '- [ ] 1.1 f is 2\n' })
  const parent = commitIn(change, 'src/f.mjs', 'export const f = () => 1\n')
  writeFileSync(join(change, 'src/f.mjs'), 'export const f = () => 2\n')
  mkdirSync(join(change, 'test'), { recursive: true })
  writeFileSync(join(change, 'test/f.test.mjs'), testText)
  git(change, 'add', 'src/f.mjs', 'test/f.test.mjs')
  git(change, 'commit', '-q', '-m', 'feat: f is 2')
  const sha = git(change, 'rev-parse', 'HEAD')
  if (shares !== undefined) {
    mkdirSync(join(change, 'openspec'), { recursive: true })
    writeFileSync(join(change, 'openspec', 'planning.md'), `# Planning\n\n## Test-first shares\n\n<!-- untracked paths the tests need -->\n${shares}\n## Whole-suite command\n\n\`npm test\`\n`)
  }
  const result = { status: 'DONE', commits: [{ sha, subject: 'feat: f is 2', files: ['src/f.mjs', 'test/f.test.mjs'] }], range: { base: parent, head: sha }, tests: { result: 'pass', runs: [{ command: 'node test/f.test.mjs' }] } }
  recordReply(change, 'add-x', { name: 'T1 impl', file: 'impl.json', result })
  const q = join(change, 'q.txt')
  writeFileSync(q, 'Review it.')
  const home = superpowersHome()
  const prompt = () => dispatch(['prompt', '--change', 'add-x', '--role', 'review', '--task', '1', '--question-file', q, '--base', parent, '--head', sha, '--home', home, '--root', change], { main: root }).prompt
  const review = (findings = []) => {
    writeFileSync(join(change, 'review.json'), JSON.stringify({ role: 'review', summary: 'Reviewed.', findings, unverifiable: [] }))
    return dispatch(['reply', '--change', 'add-x', '--name', 'T1 review', '--file', 'review.json', '--root', change], { main: root }).result
  }
  return { root, change, sha, prompt, review }
}

test('the shares section lists one path per line; its absence is null', () => {
  assert.deepEqual(sharesIn('## Test-first shares\n\n<!-- c -->\n- `node_modules`\n* .venv\nvendor/lib\n\n## Next\n- x\n'), ['node_modules', '.venv', 'vendor/lib'])
  assert.deepEqual(sharesIn('## Test-first shares\n'), [])
  assert.equal(sharesIn('## Whole-suite command\n\n`npm test`\n'), null)
})

test('a done test-first task is proved before its review, and the review prompt carries the result', () => {
  const { root, change, sha, prompt, review } = doneTask(TEST, '- `node_modules`\n')
  const text = prompt()
  const file = join(change, '.superpowers/sdd/add-x/tdd/T1.json')
  assert.ok(text.includes('- Test-first proof:\n  - proof: true\n  - parentFails: true\n  - commitPasses: true'), text)
  assert.ok(text.includes(`  - commit: ${sha}`) && text.includes(`  - record: ${file}`))
  assert.match(text, /its proof has already run/)
  assert.doesNotMatch(text, /scripts\/tdd-proof\.mjs" --worktree/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).proof, true)
  // Kept while the commit, the command and the shares stay the same.
  assert.equal(taskProof(change, 'add-x', 1, { planText: PLAN, main: root, prove: () => assert.fail('ran again') }).cached, true)
  const result = review()
  assert.deepEqual([result.open, result.result, result.tddProof.proof], [[], 'clean', true])
})

test('a proof kept under other shares runs again; the same shares in another order keep it', () => {
  const { root, change } = doneTask(TEST, '- `node_modules`\n- `.venv`\n')
  const proof = () => taskProof(change, 'add-x', 1, { planText: PLAN, main: root, prove: (worktree, { commit }) => ({ proof: true, commit }) })
  assert.equal(proof().cached, false)
  const planning = join(change, 'openspec', 'planning.md')
  writeFileSync(planning, readFileSync(planning, 'utf8').replace('- `node_modules`\n- `.venv`\n', '- `.venv`\n- `node_modules`\n'))
  assert.equal(proof().cached, true)
  writeFileSync(planning, readFileSync(planning, 'utf8').replace('- `.venv`\n', ''))
  const again = proof()
  assert.deepEqual([again.cached, again.share], [false, ['node_modules']])
})

test('a test that passes without the code adds the critical tests finding to the review result', () => {
  const { prompt, review } = doneTask("import { f } from '../src/f.mjs'\nif (typeof f !== 'function') process.exit(1)\n", '')
  assert.match(prompt(), /  - proof: false\n  - parentFails: false\n  - commitPasses: true/)
  const minor = { severity: 'minor', kind: 'quality', category: 'quality', file: 'src/f.mjs', line: 1, title: 'Naming', body: 'Call it two.' }
  const result = review([minor])
  assert.deepEqual([result.quality, result.open, result.deferred, result.result], ['needs-fixes', ['F2'], ['F1'], 'fix'])
  const added = result.findings.at(-1)
  assert.deepEqual([added.id, added.severity, added.kind, added.category, added.file, added.source], ['F2', 'critical', 'quality', 'tests', 'test/f.test.mjs', 'tdd-proof'])
  assert.match(added.body, /parent [0-9a-f]{7}, where they passed/)
})

test('without the shares section the reviewer runs the proof, and the prompt says why', () => {
  const { change, prompt, review } = doneTask(TEST)
  const text = prompt()
  assert.match(text, /- Test-first proof: not run by the flow: openspec\/planning\.md has no ## Test-first shares section/)
  assert.match(text, /the review proves the new test can fail/)
  assert.equal(existsSync(join(change, '.superpowers/sdd/add-x/tdd/T1.json')), false)
  assert.equal(review().tddProof, undefined)
})
