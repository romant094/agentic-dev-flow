// lib/replay-candidates.mjs on a fixture origin shaped like the real one: GitLab squash merges
// on develop, one change whose local branch survives (with develop merged into it once), an
// anomaly without plan.md, another author's change, and a change before the flow cut.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findCandidates, parseMergeMessage, table } from '../lib/replay-candidates.mjs'

const DEV = { name: 'Dev One', email: 'dev@example.com' }
const OTHER = { name: 'Other Dev', email: 'other@example.com' }
const REGULAR = ['brainstorm.md', 'proposal.md', 'tasks.md', 'plan.md', 'verify.md', 'review.md', 'ledger.jsonl']

function fixture() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-candidates-'))), 'origin')
  execFileSync('git', ['init', '-q', '-b', 'develop', dir])
  let clock = Date.parse('2026-10-01T10:00:00Z')
  const git = (who, ...args) => {
    clock += 60_000
    const at = new Date(clock).toISOString()
    const env = { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  const commit = (who, files, message) => {
    write(files)
    git(who, 'add', '-A')
    git(who, 'commit', '-q', '-m', message)
    return git(who, 'rev-parse', 'HEAD')
  }
  const archived = (date, name, artifacts, tasks = 3) =>
    Object.fromEntries(
      artifacts.map((a) => [`openspec/changes/archive/${date}-${name}/${a}`, a === 'tasks.md' ? `## 1. Work\n\n${Array.from({ length: tasks }, (_, i) => `- [x] 1.${i + 1} t`).join('\n')}\n` : `${a}\n`])
    )
  // GitLab's squash merge: one squash commit on develop's tip, merged with --no-ff.
  const squashMerge = (who, branch, mr, files, title) => {
    const parent = git(who, 'rev-parse', 'HEAD')
    git(who, 'checkout', '-q', '-b', 'squash-tmp')
    commit(who, files, title)
    git(who, 'checkout', '-q', 'develop')
    git(who, 'merge', '-q', '--no-ff', '-m', `Merge branch '${branch}' into 'develop'\n\n${title}\n\nSee merge request group/repo!${mr}`, 'squash-tmp')
    git(who, 'branch', '-q', '-D', 'squash-tmp')
    return { merge: git(who, 'rev-parse', 'HEAD'), parent }
  }

  commit(DEV, { 'a.txt': 'a\n' }, 'init')
  const old = squashMerge(DEV, 'feat/K-0/old-change', 10, archived('2026-10-01', 'old-change', REGULAR), 'feat: old change')
  commit(DEV, { 'openspec/schemas/flow.yaml': 'v2\n' }, 'chore(flow): the final flow')
  const cut = git(DEV, 'rev-parse', 'HEAD')

  // A change whose branch is kept: forks at `fork`, develop moves on and is merged in once.
  const fork = git(DEV, 'rev-parse', 'HEAD')
  git(DEV, 'checkout', '-q', '-b', 'feat/K-2/kept')
  commit(DEV, { 'openspec/changes/kept/proposal.md': 'p\n' }, 'docs: propose kept')
  git(DEV, 'checkout', '-q', 'develop')
  const squashed = squashMerge(DEV, 'feat/K-1/squashed', 11, archived('2026-10-03', 'squashed', REGULAR, 4), 'feat: squashed')
  git(DEV, 'checkout', '-q', 'feat/K-2/kept')
  git(DEV, 'merge', '-q', '--no-ff', '-m', 'Merge develop into kept', 'develop')
  commit(DEV, { 'src/kept.ts': 'k\n' }, 'feat: kept')
  git(DEV, 'rm', '-q', '-r', 'openspec/changes/kept')
  commit(DEV, archived('2026-10-04', 'kept', REGULAR, 6), 'chore: archive kept')
  git(DEV, 'checkout', '-q', 'develop')
  commit(DEV, { 'b.txt': 'b\n' }, 'unrelated')
  const kept = squashMerge(DEV, 'feat/K-2/kept', 12, { ...archived('2026-10-04', 'kept', REGULAR, 6), 'src/kept.ts': 'k\n' }, 'feat: kept')

  const anomaly = squashMerge(DEV, 'chore/K-3/close-anomaly', 13, archived('2026-10-05', 'anomaly', REGULAR.filter((a) => a !== 'plan.md')), 'chore: close anomaly')
  const other = squashMerge(OTHER, 'feat/K-4/other', 14, archived('2026-10-06', 'other', REGULAR), 'feat: other')
  // Two changes in one merge request, one of them stale (no ledger).
  const pair = squashMerge(DEV, 'feat/K-5/pair', 15, { ...archived('2026-10-07', 'pair-a', REGULAR, 2), ...archived('2026-10-07', 'pair-b', ['proposal.md', 'tasks.md']) }, 'feat: pair')
  git(DEV, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
  return { dir, cut, fork, old, squashed, kept, anomaly, other, pair }
}

const F = fixture()
const brief = (list) => list.map((c) => [c.name, c.tasks, c.mergeRequest, c.branch, c.base.commit, c.base.exact, c.history, c.named, c.regular])

test('regular changes by the author on or after the cut: squashed from m^1, the kept branch from its exact fork', () => {
  const found = findCandidates(F.dir, { author: DEV.name, since: F.cut })
  assert.deepEqual(brief(found), [
    ['squashed', 4, 11, 'feat/K-1/squashed', F.squashed.parent, false, 'no-branch', false, true],
    ['kept', 6, 12, 'feat/K-2/kept', F.fork, true, 'branch', false, true],
    ['pair-a', 2, 15, 'feat/K-5/pair', F.pair.parent, false, 'no-branch', false, true]
  ])
  const kept = found[1]
  assert.equal(kept.merge, F.kept.merge)
  assert.notEqual(kept.base.commit, F.kept.parent, 'the exact base is older than m^1')
  assert.deepEqual(kept.author, { name: DEV.name, email: DEV.email, commit: execFileSync('git', ['-C', F.dir, 'rev-parse', `${F.kept.merge}^2`], { encoding: 'utf8' }).trim() })
  assert.deepEqual(kept.artifacts, [...REGULAR].sort())
  assert.equal(kept.dir, '2026-10-04-kept')
})

test('the anomaly without plan.md, the stale change, the other author and the change before the cut are left out', () => {
  const names = findCandidates(F.dir, { author: DEV.name, since: F.cut }).map((c) => c.name)
  for (const out of ['anomaly', 'pair-b', 'other', 'old-change']) assert.ok(!names.includes(out), out)
  assert.deepEqual(
    findCandidates(F.dir, { author: OTHER.email, since: F.cut }).map((c) => c.name),
    ['other'],
    'the author matches by email too'
  )
})

test('since may be a date; named changes are taken whatever the rules say, and an unknown name is an error', () => {
  const cutDate = execFileSync('git', ['-C', F.dir, 'show', '-s', '--format=%cI', F.cut], { encoding: 'utf8' }).trim()
  const byDate = findCandidates(F.dir, { author: DEV.name, since: cutDate })
  assert.deepEqual(byDate.map((c) => c.name), ['squashed', 'kept', 'pair-a'])
  const named = findCandidates(F.dir, { author: DEV.name, since: F.cut, names: ['old-change', '2026-10-05-anomaly'] })
  assert.deepEqual(named.map((c) => [c.name, c.named, c.regular]), [
    ['old-change', true, true],
    ['squashed', false, true],
    ['kept', false, true],
    ['anomaly', true, false],
    ['pair-a', false, true]
  ])
  assert.deepEqual([named[0].base, named[0].history, named[0].mergeRequest], [{ commit: F.old.parent, exact: false }, 'no-branch', 10])
  assert.throws(() => findCandidates(F.dir, { author: DEV.name, since: F.cut, names: ['missing'] }), /no archived change named missing/)
  assert.throws(() => findCandidates(F.dir, { author: DEV.name, since: 'not a date' }), /neither a commit nor a date/)
  assert.throws(() => findCandidates(F.dir, { author: '', since: F.cut }), /author is required/)
})

test('a local branch that does not fork from develop before the merge falls back to m^1 with a note', () => {
  const git = (...args) => execFileSync('git', ['-C', F.dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('branch', 'feat/K-1/squashed', 'refs/remotes/origin/develop')
  git('checkout', '-q', '--orphan', 'feat/K-5/pair')
  try {
    writeFileSync(join(F.dir, 'z.txt'), 'z\n')
    git('add', 'z.txt')
    git('-c', 'user.name=Z', '-c', 'user.email=z@example.com', 'commit', '-q', '-m', 'unrelated root')
    const found = findCandidates(F.dir, { author: DEV.name, since: F.cut })
    const pair = found.find((c) => c.name === 'pair-a')
    assert.deepEqual([pair.base, pair.history], [{ commit: F.pair.parent, exact: false }, 'no-branch'])
    assert.match(pair.note, /does not fork from origin\/develop before the merge/)
    // A same-name branch at develop's tip has no commit of its own.
    const squashed = found.find((c) => c.name === 'squashed')
    assert.deepEqual([squashed.base, squashed.history], [{ commit: F.squashed.parent, exact: false }, 'no-branch'])
    assert.match(squashed.note, /has no commit origin\/develop lacks/)
  } finally {
    git('checkout', '-q', '-f', 'develop')
    git('branch', '-q', '-D', 'feat/K-1/squashed', 'feat/K-5/pair')
    rmSync(join(F.dir, 'z.txt'), { force: true })
  }
})

test('the merge message gives the branch and the merge request; the table names every candidate', () => {
  assert.deepEqual(parseMergeMessage("Merge branch 'fix/a-b' into 'develop'\n\nfix: x\n\nSee merge request g/sub/repo!496\n"), { branch: 'fix/a-b', mergeRequest: 496 })
  assert.deepEqual(parseMergeMessage('fix: a direct commit'), { branch: null, mergeRequest: null })
  const text = table(findCandidates(F.dir, { author: DEV.name, since: F.cut }))
  assert.match(text, /^change\s+tasks\s+merge\s+MR\s+branch\s+base\s+history\s+flags$/m)
  assert.match(text, /^2026-10-04-kept\s+6\s+\w{8}\s+!12\s+feat\/K-2\/kept\s+\w{8} exact\s+branch\s+-$/m)
})
