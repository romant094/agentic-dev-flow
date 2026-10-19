// The ingest at archive (lib/ingest.mjs, ingest.mjs): the stale list from a real repository's
// diff and delta specs, and the reply check against the schema and the tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkIngestReply, findChangeDir, ingestLogInput, INGEST_SCHEMA_PATH, linkTargets, pageReasons, touchedPaths } from '../lib/ingest.mjs'
import { readSchema, unknownKeywords } from '../lib/review.mjs'
import { run } from '../ingest.mjs'
import { commitFiles, git } from './fixtures/spec-merge/repo.mjs'
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

const STALE = [{ path: `${MEM}/a.md`, reasons: ['x'] }, { path: `${MEM}/b.md`, reasons: ['y'] }, { path: `${MEM}/c.md`, reasons: ['z'] }]
const reply = (over = {}) => ({
  nothingLearned: false,
  pages: [{ path: `${MEM}/a.md`, why: 'corrected the entry point' }, { path: `${MEM}/b.md`, why: 'the page described a deleted module' }, { path: `${MEM}/new.md`, why: 'the invariant' }],
  stale: [{ path: `${MEM}/a.md`, outcome: 'updated' }, { path: `${MEM}/b.md`, outcome: 'removed' }, { path: `${MEM}/c.md`, outcome: 'still-true', argument: 'it names the module, not its parser' }],
  invariant: 'The cache is written before the index.',
  likelyMistake: 'Reading the index before the cache.',
  log: { title: 'what add-x taught', bullets: ['entities/a.md: entry point', 'new.md: the invariant'] },
  ...over
})
const tree = {
  stale: STALE,
  changedFiles: [`${MEM}/a.md`, `${MEM}/b.md`, `${MEM}/new.md`, 'src/x.mjs'],
  knowledgePaths: [`${MEM}/**`],
  logPaths: [`${MEM}/log.md`],
  exists: (p) => p !== `${MEM}/b.md`
}
const errorsOf = (r, t = tree) => checkIngestReply(r, t).errors.join('\n')

test('a reply lists exactly the changed pages and answers every stale entry once', () => {
  const ok = checkIngestReply(JSON.stringify(reply()), tree)
  assert.deepEqual({ valid: ok.valid, errors: ok.errors }, { valid: true, errors: [] })
  assert.deepEqual(ingestLogInput(ok.reply), { type: 'ingest', title: 'what add-x taught', bullets: ['entities/a.md: entry point', 'new.md: the invariant'] })
  assert.match(errorsOf(reply({ pages: reply().pages.slice(1) })), /a\.md changed, but the reply does not list it/)
  assert.match(errorsOf(reply({ pages: [...reply().pages, { path: `${MEM}/z.md`, why: 'w' }] })), /z\.md is listed, but it is not a changed file/)
  assert.match(errorsOf(reply({ pages: [...reply().pages, reply().pages[0]] })), /listed twice/)
  assert.match(errorsOf(reply({ stale: reply().stale.slice(0, 2) })), /c\.md is stale and has no answer/)
  assert.match(errorsOf(reply({ stale: [...reply().stale, reply().stale[0]] })), /answered twice/)
  assert.match(errorsOf(reply({ stale: [...reply().stale, { path: `${MEM}/q.md`, outcome: 'updated' }] })), /q\.md is not on the stale list/)
  assert.match(errorsOf(reply({ stale: [reply().stale[0], reply().stale[1], { path: `${MEM}/c.md`, outcome: 'still-true' }] })), /argument is required/)
  assert.match(errorsOf(reply({ stale: [reply().stale[0], { path: `${MEM}/b.md`, outcome: 'updated' }, reply().stale[2]] })), /b\.md is answered updated, but the file is gone/)
  assert.match(errorsOf(reply(), { ...tree, exists: () => true }), /answered removed, but the file still exists/)
  assert.match(errorsOf(reply({ stale: [reply().stale[0], reply().stale[1], { path: `${MEM}/c.md`, outcome: 'updated' }] })), /c\.md is answered updated, but the file did not change/)
  assert.match(errorsOf(reply(), { ...tree, changedFiles: [...tree.changedFiles, `${MEM}/log.md`] }), /write no log entry yourself/)
  assert.match(errorsOf(reply({ invariant: ' ' })), /invariant/)
  assert.match(errorsOf(reply({ log: null })), /log/)
  assert.match(errorsOf(reply({ log: { title: 'a | b', bullets: ['x'] } })), /title/)
  assert.match(errorsOf(reply({ log: { title: 't', bullets: [] } })), /at least one bullet/)
  assert.match(errorsOf(reply({ log: { title: 't', bullets: ['a\n\nb'] } })), /blank line/)
  assert.match(checkIngestReply('nope', tree).errors.join(''), /not JSON/)
})

test('nothingLearned: no page and no log, and every stale entry still answered still-true', () => {
  const quiet = { ...tree, changedFiles: ['src/x.mjs'], exists: () => true }
  const stillTrue = STALE.map((s) => ({ path: s.path, outcome: 'still-true', argument: 'it holds' }))
  const ok = checkIngestReply(reply({ nothingLearned: true, pages: [], stale: stillTrue, invariant: '', likelyMistake: '', log: null }), quiet)
  assert.deepEqual(ok.errors, [])
  assert.equal(ingestLogInput(ok.reply), null)
  assert.match(errorsOf(reply({ nothingLearned: true, pages: [], stale: [], log: null }), quiet), /has no answer/)
  assert.match(errorsOf(reply({ nothingLearned: true, pages: [], stale: stillTrue }), quiet), /there is no log entry/)
  assert.match(errorsOf(reply({ nothingLearned: true, stale: stillTrue, log: null })), /no page may change/)
  const updated = [{ ...stillTrue[0], outcome: 'updated' }, ...stillTrue.slice(1)]
  assert.match(errorsOf(reply({ nothingLearned: true, pages: [], stale: updated, log: null }), quiet), /nothingLearned is true; with no page changed every answer is still-true/)
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

  writeFileSync(join(change, MEM, 'entities', 'a.md'), '# A\n\nThe entry point is gone.\n')
  rmSync(join(change, MEM, 'entities', 'b.md'))
  const answer = {
    nothingLearned: false,
    pages: [{ path: `${MEM}/entities/a.md`, why: 'a.mjs is gone' }, { path: `${MEM}/entities/b.md`, why: 'b.mjs moved; the page only pointed at it' }],
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
  writeFileSync(file, JSON.stringify({ ...answer, pages: answer.pages.slice(0, 1) }))
  assert.equal(run(['check', '--change', 'add-x', '--reply', file, '--root', change]).ok, false)
  assert.throws(() => run(['check', '--change', 'add-x', '--root', change]), /usage/)
  assert.throws(() => run(['stale', '--change', 'add-x', '--reply', file, '--root', change], { knowledge }), /takes no --reply/)
})
