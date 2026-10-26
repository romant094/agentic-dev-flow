// The ingest at archive (lib/ingest.mjs, ingest.mjs): the stale list from a real repository's
// diff and delta specs, and the reply check against the schema and the tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkIngestReply, findChangeDir, ingestLogInput, INGEST_SCHEMA_PATH, linkTargets, pageReasons, touchedPaths } from '../lib/ingest.mjs'
import { readSchema, unknownKeywords } from '../lib/review.mjs'
import { run } from '../ingest.mjs'
import { commitFiles, git } from './fixtures/spec-merge/repo.mjs'
import { pagePatch } from './fixtures/page-patch.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n'
const MEM = '.claude/memory'
const KNOWLEDGE = { state: 'done', plugin: 'memory', index: `${MEM}/index.md`, instructions: { ingest: '/plugin/instructions/ingest.md' }, paths: [`${MEM}/**`], log: [`${MEM}/log.md`, `${MEM}/log-archive/**`] }
const REQ = 'Store widgets in the cold room'

// develop holds the code and the knowledge base; the change add-x, on its own worktree,
// deletes a.mjs, renames b.mjs, rewrites c.mjs, edits one line of d.mjs and modifies a
// requirement of widgets.
function repo() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-ingest-')))
  const root = join(top, 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  commitFiles(root, {
    '.gitignore': '.superpowers/\n',
    'src/a.mjs': lines(4, 'a'),
    'src/b.mjs': lines(4, 'b'),
    'src/c.mjs': lines(10),
    'src/d.mjs': lines(10),
    'src/a.mjsx': 'other\n',
    [`${MEM}/index.md`]: '# Index\n',
    [`${MEM}/log.md`]: '# Log\n\n## [2026-10-01 10:00] task | t | T\n- touched src/a.mjs\n',
    [`${MEM}/entities/a.md`]: '# A\n\nThe entry point is `src/a.mjs`.\n',
    [`${MEM}/entities/b.md`]: '# B\n\nSee [b](../../../src/b.mjs#L2).\n',
    [`${MEM}/entities/c.md`]: '# C\n\nsrc/c.mjs holds the parser.\n',
    [`${MEM}/entities/d.md`]: '# D\n\nsrc/d.mjs and src/a.mjsx are fine.\n',
    [`${MEM}/concepts/spec.md`]: '# Spec\n\nRead openspec/specs/widgets/spec.md.\n',
    [`${MEM}/concepts/req.md`]: `# Req\n\nThe rule "${REQ}" holds.\n`,
    [`${MEM}/concepts/other.md`]: '# Other\n\nNothing here; `widgets-x` is another capability.\n'
  }, 'init')
  const change = join(top, 'wt')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/add-x', change)
  git(change, 'rm', '-q', 'src/a.mjs')
  git(change, 'mv', 'src/b.mjs', 'src/b2.mjs')
  commitFiles(change, {
    'src/c.mjs': lines(4) + lines(6, 'new'),
    'src/d.mjs': lines(10).replace('line 3', 'line three'),
    'openspec/changes/add-x/.adf.json': '{"base":"develop"}\n',
    'openspec/changes/add-x/proposal.md': '# add-x\n',
    'openspec/changes/add-x/specs/widgets/spec.md': `## MODIFIED Requirements\n\n### Requirement: ${REQ}\nThe system SHALL store.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n`
  }, 'change')
  return { root, change }
}

test('the schema uses only keywords the validator implements', () => {
  assert.deepEqual(unknownKeywords(readSchema(INGEST_SCHEMA_PATH)), [])
})

test('touchedPaths reads deletions, renames and rewrites at the 50% share', () => {
  const nameStatus = ['D', 'x/gone.mjs', 'R087', 'x/old.mjs', 'x/new.mjs', 'M', 'x/half.mjs', 'M', 'x/little.mjs', 'M', 'x/bin.png', 'A', 'x/added.mjs', ''].join('\0')
  const numstat = ['3\t5\tx/half.mjs', '1\t1\tx/little.mjs', '-\t-\tx/bin.png', ''].join('\0')
  const base = { 'x/half.mjs': 10, 'x/little.mjs': 10 }
  assert.deepEqual(touchedPaths(nameStatus, numstat, (p) => base[p] ?? 0), [
    { path: 'x/bin.png', kind: 'rewrote', share: 1 },
    { path: 'x/gone.mjs', kind: 'deleted' },
    { path: 'x/half.mjs', kind: 'rewrote', share: 0.5 },
    { path: 'x/old.mjs', kind: 'renamed', to: 'x/new.mjs' }
  ])
})

test('pageReasons finds a path by its full name or a resolving link, never by a longer name', () => {
  const touched = [{ path: 'src/a.mjs', kind: 'deleted' }]
  assert.deepEqual(pageReasons('see src/a.mjs.', 'm/p.md', { touched }), ['names src/a.mjs, which the change deleted'])
  assert.deepEqual(pageReasons('see [it](../src/a.mjs)', 'm/p.md', { touched }), ['names src/a.mjs, which the change deleted'])
  assert.deepEqual(pageReasons('see src/a.mjsx and lib/src/a.mjs/x', 'm/p.md', { touched }), [])
  assert.deepEqual(linkTargets('[a](<../x y.md>) [b](https://e.com) [c](#top) [d](./z.md#h)', 'm/p.md'), ['x y.md', 'm/z.md'])
})

test('staleList lists every page naming a deleted, renamed or rewritten path or a touched capability or requirement', async () => {
  const { staleList } = await import('../lib/ingest.mjs')
  const { change } = repo()
  const stale = staleList(change, 'add-x', { knowledgePaths: [`${MEM}/**`], logPaths: [`${MEM}/log.md`] })
  assert.deepEqual(stale, [
    { path: `${MEM}/concepts/req.md`, reasons: [`names the requirement "${REQ}" of widgets, which the change modified`] },
    { path: `${MEM}/concepts/spec.md`, reasons: ['names the capability widgets, whose requirements the change touched (MODIFIED)'] },
    { path: `${MEM}/entities/a.md`, reasons: ['names src/a.mjs, which the change deleted'] },
    { path: `${MEM}/entities/b.md`, reasons: ['names src/b.mjs, which the change renamed to src/b2.mjs'] },
    { path: `${MEM}/entities/c.md`, reasons: ['names src/c.mjs, which the change rewrote (60% of its lines)'] }
  ])
})

// A knowledge base of its own: a.md, b.md and c.md beside the log, committed.
function kb() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-kb-')))
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  commitFiles(root, { [`${MEM}/a.md`]: '# A\n\nThe entry point is src/a.mjs.\n', [`${MEM}/b.md`]: '# B\n', [`${MEM}/c.md`]: '# C\n', [`${MEM}/log.md`]: '# Log\n', 'src/x.mjs': 'x\n' }, 'init')
  return root
}

const STALE = [{ path: `${MEM}/a.md`, reasons: ['x'] }, { path: `${MEM}/b.md`, reasons: ['y'] }, { path: `${MEM}/c.md`, reasons: ['z'] }]
const pagesOf = (root) => [
  { path: `${MEM}/a.md`, why: 'corrected the entry point', patch: pagePatch(root, `${MEM}/a.md`, '# A\n\nThe entry point is gone.\n') },
  { path: `${MEM}/b.md`, why: 'the page described a deleted module', patch: pagePatch(root, `${MEM}/b.md`, null) },
  { path: `${MEM}/new.md`, why: 'the invariant', patch: pagePatch(root, `${MEM}/new.md`, '# New\n\nThe cache is written before the index.\n') }
]
const replyFor = (root, over = {}) => ({
  nothingLearned: false,
  pages: pagesOf(root),
  stale: [{ path: `${MEM}/a.md`, outcome: 'updated' }, { path: `${MEM}/b.md`, outcome: 'removed' }, { path: `${MEM}/c.md`, outcome: 'still-true', argument: 'it names the module, not its parser' }],
  invariant: 'The cache is written before the index.',
  likelyMistake: 'Reading the index before the cache.',
  log: { title: 'what add-x taught', bullets: ['entities/a.md: entry point', 'new.md: the invariant'] },
  ...over
})
const treeOf = (root) => ({ root, stale: STALE, changedFiles: ['src/x.mjs'], knowledgePaths: [`${MEM}/**`], logPaths: [`${MEM}/log.md`] })

test('a reply carries every page edit as a patch, checked without a write, and answers every stale entry once', () => {
  const root = kb()
  const tree = treeOf(root)
  const reply = (over) => replyFor(root, over)
  const errorsOf = (r, t = tree) => checkIngestReply(r, t).errors.join('\n')
  const ok = checkIngestReply(JSON.stringify(reply()), tree)
  assert.deepEqual({ valid: ok.valid, errors: ok.errors }, { valid: true, errors: [] })
  assert.deepEqual(ingestLogInput(ok.reply), { type: 'ingest', title: 'what add-x taught', bullets: ['entities/a.md: entry point', 'new.md: the invariant'] })
  assert.equal(git(root, 'status', '--porcelain'), '', 'the check writes nothing')
  // A plain unified diff, as `diff -u` with labels writes it, is a patch too.
  const plain = [{ ...reply().pages[1], patch: `--- a/${MEM}/b.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# B\n` }, ...reply().pages.filter((p) => !p.path.endsWith('b.md'))]
  assert.deepEqual(checkIngestReply(reply({ pages: plain }), tree).errors, [])
  assert.match(errorsOf(reply({ pages: [...reply().pages, reply().pages[0]] })), /listed twice/)
  assert.match(errorsOf(reply({ pages: [{ path: `${MEM}/a.md`, why: 'w' }, ...reply().pages.slice(1)] })), /patch/)
  assert.match(errorsOf(reply({ stale: reply().stale.slice(0, 2) })), /c\.md is stale and has no answer/)
  assert.match(errorsOf(reply({ stale: [...reply().stale, reply().stale[0]] })), /answered twice/)
  assert.match(errorsOf(reply({ stale: [...reply().stale, { path: `${MEM}/q.md`, outcome: 'updated' }] })), /q\.md is not on the stale list/)
  assert.match(errorsOf(reply({ stale: [reply().stale[0], reply().stale[1], { path: `${MEM}/c.md`, outcome: 'still-true' }] })), /argument is required/)
  // The stale answers are checked against the tree as the edits leave it.
  assert.match(errorsOf(reply({ stale: [reply().stale[0], { path: `${MEM}/b.md`, outcome: 'updated' }, reply().stale[2]] })), /b\.md is answered updated, but the reply deletes it; answer removed/)
  assert.match(errorsOf(reply({ pages: reply().pages.filter((p) => !p.path.endsWith('b.md')) })), /b\.md is answered removed, but the reply does not delete it/)
  assert.match(errorsOf(reply({ stale: [reply().stale[0], reply().stale[1], { path: `${MEM}/c.md`, outcome: 'updated' }] })), /c\.md is answered updated, but the reply carries no edit of it/)
  assert.match(errorsOf(reply(), { ...tree, changedFiles: [...tree.changedFiles, `${MEM}/log.md`] }), /write no log entry yourself/)
  assert.match(errorsOf(reply({ invariant: ' ' })), /invariant/)
  assert.match(errorsOf(reply({ log: null })), /log/)
  assert.match(errorsOf(reply({ log: { title: 'a | b', bullets: ['x'] } })), /title/)
  assert.match(errorsOf(reply({ log: { title: 't', bullets: [] } })), /at least one bullet/)
  assert.match(errorsOf(reply({ log: { title: 't', bullets: ['a\n\nb'] } })), /blank line/)
  assert.match(checkIngestReply('nope', tree).errors.join(''), /not JSON/)
})

test('a page the agent wrote itself is refused: every edit comes in the reply', () => {
  const root = kb()
  writeFileSync(join(root, MEM, 'c.md'), '# C\n\nwritten by hand\n')
  const out = checkIngestReply(replyFor(root), { ...treeOf(root), changedFiles: ['src/x.mjs', `${MEM}/c.md`] })
  assert.match(out.errors.join('\n'), /\.claude\/memory\/c\.md is changed in the tree: write no page yourself; return its edit as a page's patch in the reply/)
})

test('an edit outside the knowledge base, through a symbolic link, of the log, or that does not apply is refused', () => {
  const root = kb()
  const tree = treeOf(root)
  const stale = STALE.map((s) => ({ path: s.path, outcome: 'still-true', argument: 'it holds' }))
  const one = (page) => checkIngestReply(replyFor(root, { pages: [page], stale }), tree).errors.join('\n')
  const fresh = (path) => pagePatch(root, path, '# P\n')
  assert.match(one({ path: 'src/y.md', why: 'w', patch: fresh('src/y.md') }), /src\/y\.md is outside the knowledge base \(\.claude\/memory\/\*\*\)/)
  assert.match(one({ path: `${MEM}/../src/y.md`, why: 'w', patch: fresh('src/y.md') }), /is not a relative path inside the repository/)
  assert.match(one({ path: `/${MEM}/y.md`, why: 'w', patch: fresh(`${MEM}/y.md`) }), /is not a relative path inside the repository/)
  assert.match(one({ path: `${MEM}/log.md`, why: 'w', patch: pagePatch(root, `${MEM}/log.md`, '# Log\n\nmine\n') }), /is the log, which the script writes/)
  assert.match(one({ path: `${MEM}/y.md`, why: 'w', patch: fresh('src/y.md') }), /must edit \.claude\/memory\/y\.md and nothing else; it touches src\/y\.md/)
  assert.match(one({ path: `${MEM}/y.md`, why: 'w', patch: 'not a patch\n' }), /git apply cannot read it/)
  const stalePatch = pagePatch(root, `${MEM}/a.md`, '# A\n\nnew\n').replace('The entry point is src/a.mjs.', 'Some other text.')
  assert.match(one({ path: `${MEM}/a.md`, why: 'w', patch: stalePatch }), /does not apply to \.claude\/memory\/a\.md as the tree holds it/)
  mkdirSync(join(root, 'outside'))
  symlinkSync(join(root, 'outside'), join(root, MEM, 'link'))
  const linked = `diff --git a/${MEM}/link/y.md b/${MEM}/link/y.md\nnew file mode 100644\n--- /dev/null\n+++ b/${MEM}/link/y.md\n@@ -0,0 +1 @@\n+# Y\n`
  assert.match(one({ path: `${MEM}/link/y.md`, why: 'w', patch: linked }), /\.claude\/memory\/link is a symbolic link/)
  const makesLink = `diff --git a/${MEM}/z.md b/${MEM}/z.md\nnew file mode 120000\n--- /dev/null\n+++ b/${MEM}/z.md\n@@ -0,0 +1 @@\n+../../outside\n\\ No newline at end of file\n`
  assert.match(one({ path: `${MEM}/z.md`, why: 'w', patch: makesLink }), /makes a symbolic link/)
  assert.equal(git(root, 'status', '--porcelain'), '?? .claude/memory/link', 'nothing applied')
})

test('nothingLearned: no page and no log, and every stale entry still answered still-true', () => {
  const root = kb()
  const quiet = treeOf(root)
  const errorsOf = (r) => checkIngestReply(r, quiet).errors.join('\n')
  const stillTrue = STALE.map((s) => ({ path: s.path, outcome: 'still-true', argument: 'it holds' }))
  const ok = checkIngestReply({ nothingLearned: true, pages: [], stale: stillTrue, invariant: '', likelyMistake: '', log: null }, quiet)
  assert.deepEqual(ok.errors, [])
  assert.equal(ingestLogInput(ok.reply), null)
  assert.match(errorsOf(replyFor(root, { nothingLearned: true, pages: [], stale: [], log: null })), /has no answer/)
  assert.match(errorsOf(replyFor(root, { nothingLearned: true, pages: [], stale: stillTrue })), /there is no log entry/)
  assert.match(errorsOf(replyFor(root, { nothingLearned: true, stale: stillTrue, log: null })), /no page may change/)
  const updated = [{ ...stillTrue[0], outcome: 'updated' }, ...stillTrue.slice(1)]
  assert.match(errorsOf(replyFor(root, { nothingLearned: true, pages: [], stale: updated, log: null })), /nothingLearned is true; with no page changed every answer is still-true/)
})


test('ingest.mjs stale writes the dispatch input, and check reads the tree; no provider skips', () => {
  const { change } = repo()
  const knowledge = () => KNOWLEDGE
  const none = run(['stale', '--change', 'add-x', '--root', change], { knowledge: () => ({ state: 'none', point: 'knowledge' }) })
  assert.equal(none.state, 'none')
  assert.match(none.report, /archive skips the ingest/)
  // The change is archived before the ingest.
  mkdirSync(join(change, 'openspec/changes/archive'))
  git(change, 'mv', 'openspec/changes/add-x', 'openspec/changes/archive/2026-10-19-add-x')
  git(change, 'commit', '-q', '-m', 'archive')
  assert.match(findChangeDir(change, 'add-x'), /archive\/2026-10-19-add-x$/)
  const stale = run(['stale', '--change', 'add-x', '--root', change], { knowledge })
  assert.equal(stale.ok, true)
  assert.equal(stale.changeDir, 'openspec/changes/archive/2026-10-19-add-x')
  assert.deepEqual(stale.stale.map((s) => s.path), [`${MEM}/concepts/req.md`, `${MEM}/concepts/spec.md`, `${MEM}/entities/a.md`, `${MEM}/entities/b.md`, `${MEM}/entities/c.md`])
  assert.deepEqual(stale.knowledge, { index: KNOWLEDGE.index, instruction: '/plugin/instructions/ingest.md', paths: KNOWLEDGE.paths, log: KNOWLEDGE.log })

  const answer = {
    nothingLearned: false,
    pages: [
      { path: `${MEM}/entities/a.md`, why: 'a.mjs is gone', patch: pagePatch(change, `${MEM}/entities/a.md`, '# A\n\nThe entry point is gone.\n') },
      { path: `${MEM}/entities/b.md`, why: 'b.mjs moved; the page only pointed at it', patch: pagePatch(change, `${MEM}/entities/b.md`, null) }
    ],
    stale: [
      { path: `${MEM}/entities/a.md`, outcome: 'updated' },
      { path: `${MEM}/entities/b.md`, outcome: 'removed' },
      ...[`${MEM}/concepts/req.md`, `${MEM}/concepts/spec.md`, `${MEM}/entities/c.md`].map((path) => ({ path, outcome: 'still-true', argument: 'still holds' }))
    ],
    invariant: 'i',
    likelyMistake: 'm',
    log: { title: 'add-x', bullets: ['a.md updated'] }
  }
  const file = join(change, '..', 'reply.json')
  writeFileSync(file, JSON.stringify(answer))
  const checked = run(['check', '--change', 'add-x', '--reply', file, '--root', change])
  assert.deepEqual({ ok: checked.ok, errors: checked.errors, log: checked.log }, { ok: true, errors: [], log: { type: 'ingest', title: 'add-x', bullets: ['a.md updated'] } })
  assert.equal(git(change, 'status', '--porcelain'), '', 'check applies nothing')
  writeFileSync(file, JSON.stringify({ ...answer, pages: answer.pages.slice(0, 1) }))
  assert.equal(run(['check', '--change', 'add-x', '--reply', file, '--root', change]).ok, false)
  assert.throws(() => run(['check', '--change', 'add-x', '--root', change]), /usage/)
  assert.throws(() => run(['stale', '--change', 'add-x', '--reply', file, '--root', change], { knowledge }), /takes no --reply/)
})
