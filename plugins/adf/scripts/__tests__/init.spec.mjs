// What /adf:init infers and writes beyond the registry, against real git repositories: the
// whole-suite command from the CI configuration and the package scripts, the worktree copies from
// the ignored `.env*` files, the `## Worktree copies` section it writes on confirmation, the
// window marker that keeps earlier archives out of the first window, and the host instruction
// files that still name a previous flow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setBranches } from '../lib/branches.mjs'
import { copyCandidates, oldFlowMentions, suiteCandidates, writeCopies } from '../lib/init.mjs'
import { readCopies } from '../lib/provision.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { previousRetro, seedWindow, sinceLastRetro } from '../lib/window.mjs'
import { run } from '../init.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// A host on develop with the registry's branch policy and `files` committed.
function repo(files = {}) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-init-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  initRegistry(root, '1.7')
  setBranches(root, { integration: 'develop', protected: [] })
  write(root, { 'a.txt': 'a\n', ...files })
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

function archive(root, change) {
  write(root, { [`openspec/changes/archive/2026-09-01-${change}/proposal.md`]: `# ${change}\n` })
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', `archive ${change}`)
}

const GITLAB = `stages:
  - build
  - test

build:
  stage: build
  script:
    - npm ci
    - npm run build

test:
  stage: test
  script:
    - npm ci
    - npx turbo run test --force
`

const WORKFLOW = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: |
          npm run lint
          npm run test:ci
`

test('the suite candidates come from the CI configuration first, then the package scripts', () => {
  const root = repo({
    '.gitlab-ci.yml': GITLAB,
    '.github/workflows/ci.yml': WORKFLOW,
    'package.json': JSON.stringify({ scripts: { test: 'turbo run test', 'test:ci': 'turbo run test --force', build: 'tsc' } })
  })
  const found = suiteCandidates(root)
  assert.deepEqual(
    found.map((c) => [c.command, c.source]),
    [
      ['npx turbo run test --force', '.gitlab-ci.yml:15'],
      ['npm run test:ci', '.github/workflows/ci.yml:11'],
      ['npm test', 'package.json']
    ]
  )
  assert.ok(found.every((c) => typeof c.why === 'string' && c.why.length > 0))
})

test('the suite candidates follow the lockfile and skip npm\'s placeholder test script', () => {
  assert.deepEqual(suiteCandidates(repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), [])
  const pnpm = repo({ 'pnpm-lock.yaml': '', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  assert.deepEqual(suiteCandidates(pnpm).map((c) => c.command), ['pnpm test'])
  assert.deepEqual(suiteCandidates(repo()), [])
})

test('the copy candidates are the ignored .env files of the main checkout, never the tracked or the dependencies', () => {
  const root = repo({ '.gitignore': '.env\n.env.*\n!.env.example\nnode_modules/\n.claude/worktrees/\n', '.env.example': 'X=\n' })
  write(root, { '.env': 'X=1\n', 'apps/server/.env.local': 'Y=1\n', 'node_modules/x/.env': 'Z=1\n', '.claude/worktrees/c/.env': 'W=1\n', 'notes.txt': 'n\n' })
  assert.deepEqual(copyCandidates(root), ['.env', 'apps/server/.env.local'])
  writeCopies(root, ['.env'])
  assert.deepEqual(copyCandidates(root), ['apps/server/.env.local'])
})

test('the copy scan collapses an ignored directory: none of its files is listed, a nested .env in a tracked directory is', () => {
  const root = repo({ '.gitignore': '.env*\nnode_modules/\nvendor/\n', 'apps/server/index.js': '\n' })
  write(root, { 'apps/server/.env': 'X=1\n', 'vendor/.env': 'V=1\n' })
  for (let i = 0; i < 300; i++) write(root, { [`node_modules/p${i}/.env`]: 'Z=1\n' })
  assert.deepEqual(copyCandidates(root), ['apps/server/.env'])
  const listed = git(root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory').split('\n')
  assert.ok(listed.includes('node_modules/') && listed.includes('vendor/'))
  assert.ok(!listed.some((p) => p.startsWith('node_modules/p')))
})

test('the copies are written into their section, kept on a second write, the template comment kept', () => {
  const root = repo({ 'openspec/planning.md': '# Guide\n\n## Worktree copies\n\n<!-- the paths -->\n\n## Worktree preparation\n\n- `npm run build` from `lib`\n' })
  writeCopies(root, ['.env'])
  const again = writeCopies(root, ['apps/server/.env', '.env'])
  assert.deepEqual(again.copies, ['.env', 'apps/server/.env'])
  assert.deepEqual(readCopies(root), ['.env', 'apps/server/.env'])
  const text = readFileSync(join(root, 'openspec/planning.md'), 'utf8')
  assert.match(text, /## Worktree copies\n\n<!-- the paths -->\n\n- `\.env`\n- `apps\/server\/\.env`\n\n## Worktree preparation/)
  assert.throws(() => writeCopies(root, ['../outside']), /not a path inside the project/)
  const bare = repo()
  writeCopies(bare, ['.env'])
  assert.deepEqual(readCopies(bare), ['.env'])
})

test('the seed marks the integration tip, so earlier archives leave the first window and the lint is not due', () => {
  const root = repo()
  for (const c of ['a', 'b', 'c', 'd']) archive(root, c)
  assert.equal(sinceLastRetro(root).lintDue, true)
  const seed = seedWindow(root, { date: '2026-11-02' })
  assert.equal(seed.seeded, true)
  assert.equal(seed.path, '.adf/retro/2026-11-02-window.json')
  assert.equal(seed.archivedBefore, 4)
  assert.equal(seed.cutoff.mergeSha, git(root, 'rev-parse', 'develop'))
  // Uncommitted, it moves nothing yet, and a second run sees it.
  assert.equal(seedWindow(root, { date: '2026-11-03' }).seeded, false)
  git(root, 'add', '-f', '.adf/retro')
  git(root, 'commit', '-q', '-m', 'adf setup')
  assert.equal(previousRetro(root).path, '.adf/retro/2026-11-02-window.json')
  assert.deepEqual({ count: sinceLastRetro(root).count, lintDue: sinceLastRetro(root).lintDue }, { count: 0, lintDue: false })
  archive(root, 'e')
  assert.deepEqual(sinceLastRetro(root).changes, ['e'])
  assert.match(seedWindow(root, { date: '2026-11-04' }).reason, /already anchors/)
})

test('no seed where nothing was archived', () => {
  const seed = seedWindow(repo(), { date: '2026-11-02' })
  assert.equal(seed.seeded, false)
  assert.match(seed.reason, /no change archived/)
})

test('the scan names the instruction files and lines that name a previous flow, and changes nothing', () => {
  const claude = '# Rules\n\nRun `/opsx:propose` first.\nSee openspec/schemas/sdd/schema.yaml.\nUse /adf:propose and /adf-jira:setup.\nThe API is at http://localhost:8080/api/v1.\n'
  const root = repo({
    'CLAUDE.md': '# Root\n\nNothing old here.\n',
    '.claude/CLAUDE.md': claude,
    'AGENTS.md': 'Never run `openspec update`.\nRun /gug:audit to check the guide.\n',
    'docs/notes.md': '/opsx:apply is not an instruction file\n'
  })
  const found = oldFlowMentions(root)
  assert.deepEqual(
    found.map((m) => `${m.file}:${m.line}`),
    ['.claude/CLAUDE.md:3', '.claude/CLAUDE.md:4', 'AGENTS.md:1', 'AGENTS.md:2']
  )
  assert.equal(found[0].text, 'Run `/opsx:propose` first.')
  assert.equal(readFileSync(join(root, '.claude/CLAUDE.md'), 'utf8'), claude)
})

test('the CLI: suggest, copies, seed and scan', () => {
  const root = repo({ '.gitignore': '.env\n', 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'AGENTS.md': 'Run /opsx:verify.\n' })
  write(root, { '.env': 'X=1\n' })
  const suggest = run(['suggest', '--root', root])
  assert.deepEqual(suggest.suite, { current: null, candidates: [{ command: 'npm test', source: 'package.json', why: 'package.json script "test": node --test' }] })
  assert.deepEqual(suggest.copies, { current: [], candidates: ['.env'] })
  assert.deepEqual(run(['copies', '--path', '.env', '--root', root]).copies, ['.env'])
  assert.equal(run(['seed', '--root', root, '--date', '2026-11-02']).seeded, false)
  const scan = run(['scan', '--root', root])
  assert.equal(scan.mentions.length, 1)
  assert.match(scan.report, /AGENTS\.md:1/)
  assert.equal(existsSync(join(root, '.adf/retro')), false)
  assert.throws(() => run(['copies', '--root', root]), /needs at least one --path/)
  assert.throws(() => run(['nope', '--root', root]), /usage/)
})

test('suggest prints trustHooks true in codex and false in claude-code', () => {
  const root = repo()
  assert.equal(run(['suggest', '--root', root], { runtime: 'codex' }).trustHooks, true)
  assert.equal(run(['suggest', '--root', root], { runtime: 'claude-code' }).trustHooks, false)
})
