// tdd-proof.mjs: the new test fails on the parent with the commit's tests, and passes on the
// commit, in a throwaway worktree that is removed afterwards and never touches the source tree.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { isTestFile } from '../lib/tdd-proof.mjs'
import { run } from '../tdd-proof.mjs'
import { commitIn, git, host } from './git-host.mjs'

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
