// lib/flow-migrate.mjs: the old planning guide converted into the settings and the prose guide,
// the review prompt's path after the move, and the tracked files that still name openspec/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertGuide, legacyMentions, reviewPromptPath } from '../lib/flow-migrate.mjs'
import { DEFAULTS, settingsErrors } from '../lib/settings.mjs'

const fixture = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flow-migrate', name), 'utf8')

test('the shipped template converts to the defaults with the proof on, and the template guide', () => {
  const { settings, guide, notes } = convertGuide(fixture('planning-template.md'))
  assert.deepEqual(settings, { ...DEFAULTS, testFirstShares: [] })
  assert.deepEqual(notes, [])
  assert.deepEqual(settingsErrors(settings), [])
  assert.equal(guide, readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'host', 'guide.md'), 'utf8'))
})

test('a filled guide converts with no value lost and validates', () => {
  const { settings, guide, notes } = convertGuide(fixture('planning-filled.md'))
  assert.deepEqual(settingsErrors(settings), [])
  assert.deepEqual(notes, [])
  assert.deepEqual(settings, {
    packages: ['packages/shared', 'apps/server', 'apps/client'],
    checks: ['Install: `npm ci`', 'Build: `npm run build`', 'Test one file: `npx vitest run <file>`', 'npm run lint'],
    wholeSuiteCommand: 'npm test -- --force',
    affectedTestsCommand: 'npx vitest related --run --passWithNoTests {files}',
    failedTestsCommand: 'npx vitest run {tests}',
    freshRunProof: 'Cached:    0 cached',
    testFirstShares: ['.env', 'node_modules'],
    worktreeCopies: ['.env', 'apps/server/.env.local'],
    worktreePreparation: [{ command: 'npm run build --workspace @x/shared', inputs: ['packages/shared/src', 'packages/shared/tsconfig.json'] }],
    formatCommand: 'npx biome format --write {files}'
  })
  // The prose under the new template's headings, and the team's own section after them.
  assert.match(guide, /^# Planning Guide\n/)
  assert.match(guide, /## Where to look\n\n1\. `\.claude\/memory\/` first[\s\S]*bench\.local:8080` for the SNMP agent\.\n\n## Checks that need the developer\n\nA hardware pass/)
  assert.match(guide, /## Release notes\n\nThe team's own section: kept as it is\.\n$/)
  assert.doesNotMatch(guide, /## Whole-suite command|## Packages/)
})

test('a section absent is the default; test-first shares absent is null, empty is a list', () => {
  assert.deepEqual(convertGuide('# Guide\n\n## Whole-suite command\n\n`make test`\n').settings, { ...DEFAULTS, wholeSuiteCommand: 'make test' })
  assert.deepEqual(convertGuide('# Guide\n\n## Test-first shares\n\n<!-- none -->\n').settings.testFirstShares, [])
})

test('a value the settings cannot take is kept in guide.md with a note, never dropped', () => {
  const text = '# Guide\n\n## Whole-suite command\n\nnpm test\nnpm run e2e\n\n## Worktree copies\n\n- `.env`\n- `../shared/.env`\n\n## Worktree preparation\n\n- `npm run build`\n'
  const { settings, guide, notes } = convertGuide(text)
  assert.equal(settings.wholeSuiteCommand, null)
  assert.deepEqual(settings.worktreeCopies, ['.env'])
  assert.deepEqual(settings.worktreePreparation, [])
  assert.equal(notes.length, 3)
  assert.match(notes[0], /## Whole-suite command: it holds 2 lines, not one; left out of wholeSuiteCommand and kept in guide\.md/)
  assert.match(guide, /## Whole-suite command \(not converted\)\n\nnpm test\nnpm run e2e/)
  assert.match(guide, /## Worktree copies \(not converted\)\n\n- `\.\.\/shared\/\.env`/)
  assert.match(guide, /## Worktree preparation \(not converted\)\n\n- `npm run build`/)
})

test('review.prompt under the legacy root moves with the directory; any other path stays', () => {
  assert.equal(reviewPromptPath('openspec/review-prompt.md'), 'adf/review-prompt.md')
  assert.equal(reviewPromptPath('openspec/team/review.md'), 'adf/team/review.md')
  assert.equal(reviewPromptPath('ci/review.md'), 'ci/review.md')
  assert.equal(reviewPromptPath(undefined), undefined)
})

test('legacyMentions lists the tracked files outside the flow directory that name openspec/', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-mentions-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  const files = {
    'CLAUDE.md': '# Rules\n\nSpecs live in openspec/specs/.\nNothing here.\nSee openspec/changes/.\n',
    '.gitignore': 'openspec/changes/*/scratch\n',
    'adf/changes/archive/2026-01-01-x/proposal.md': 'once in openspec/changes/x\n',
    'src/a.js': 'const openspec = 1\n',
    'untracked.md': 'openspec/\n'
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git('add', 'CLAUDE.md', '.gitignore', 'adf', 'src')
  assert.deepEqual(legacyMentions(root), [{ file: '.gitignore', lines: [1] }, { file: 'CLAUDE.md', lines: [3, 5] }])
})
