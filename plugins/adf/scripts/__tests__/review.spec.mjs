// lib/review.mjs and review.mjs start/input/response/render: the filter, the range, the slices
// and their coverage proof, the reviewer's input, the reply checks, the verdict and the text,
// against real temporary git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry, validateRegistry, writeRegistry } from '../lib/registry.mjs'
import {
  checkFindings,
  checkFix,
  computeVerdict,
  coreBlock,
  coverageProof,
  DEFAULT_EXCLUDE,
  filterPaths,
  FINDINGS_SCHEMA_PATH,
  FIX_SCHEMA_PATH,
  parseRange,
  proposeSlices,
  readSchema,
  renderFindings,
  reviewConfig,
  unknownKeywords,
  validateJson
} from '../lib/review.mjs'
import { run as review } from '../review.mjs'
import { commitIn, host } from './git-host.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'review.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// A bare repository with no registry and no change: what a CI checkout may be.
function repo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-review-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  for (const [file, text] of Object.entries({ 'a.txt': 'a\n', ...files })) write(root, file, text)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

function write(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

function commitAll(root, files, message = 'work') {
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  git(root, 'add', '--', ...Object.keys(files))
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

const setReview = (root, settings) => writeRegistry(root, { ...readRegistry(root), review: settings })

// Runs the CLI as a process with no Claude Code variable in its environment.
function cli(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')))
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' })
  return { status: r.status, out: JSON.parse(r.stdout) }
}

const finding = (id, severity, extra = {}) => ({ id, severity, category: 'Bugs', file: 'src/a.ts', line: 3, title: `title ${id}`, body: `body ${id}`, ...extra })
const reply = (...findings) => JSON.stringify({ summary: 'One change reviewed.', findings })

// ---------------------------------------------------------------- filter

test('the default filter excludes prose, locks, build output, generated files and snapshots at any depth', () => {
  const paths = [
    'src/a.ts',
    'src/generated.ts',
    'generated.ts',
    'src/api.generated.ts',
    '__snapshots__/a.test.ts.snap',
    'apps/x/__snapshots__/b.snap',
    'README.md',
    'docs/guide/page.md',
    'package-lock.json',
    'apps/x/package-lock.json',
    'yarn.lock',
    'apps/pnpm-lock.yaml',
    'dist/a.js',
    'apps/x/dist/b.js',
    'coverage/lcov.info',
    'apps/coverage/x.json',
    'lib/a.min.js',
    'lib/a.min.css',
    'lib/a.js.map',
    'openspec/changes/add-x/.adf.json',
    'src/regenerated.ts',
    'distill/a.ts',
    'src/markdown.ts',
    '.gitlab-ci.yml'
  ]
  const { kept, excluded } = filterPaths(paths)
  assert.deepEqual(kept, ['src/a.ts', 'src/regenerated.ts', 'distill/a.ts', 'src/markdown.ts', '.gitlab-ci.yml'])
  assert.equal(excluded.length, paths.length - kept.length)
  assert.deepEqual(excluded.find((e) => e.file === 'src/generated.ts'), { file: 'src/generated.ts', pattern: '**/generated.*' })
  assert.deepEqual(excluded.find((e) => e.file === '__snapshots__/a.test.ts.snap'), { file: '__snapshots__/a.test.ts.snap', pattern: '**/__snapshots__/**' })
  assert.deepEqual(excluded.find((e) => e.file === 'README.md'), { file: 'README.md', pattern: '**/*.md' })
})

test('the registry adds exclude globs and takes files back with include globs', () => {
  const config = { exclude: [...DEFAULT_EXCLUDE, '.gitlab-ci.yml', 'vendor/**'], include: ['docs/api/**/*.md'] }
  const { kept, excluded } = filterPaths(['.gitlab-ci.yml', 'vendor/x.js', 'docs/api/v1/a.md', 'docs/b.md', 'src/a.ts'], config)
  assert.deepEqual(kept, ['docs/api/v1/a.md', 'src/a.ts'])
  assert.deepEqual(excluded.map((e) => e.file), ['.gitlab-ci.yml', 'vendor/x.js', 'docs/b.md'])
})

test('the registry accepts an optional review object and refuses a malformed one', () => {
  const base = { contract: '1.2', extensions: [] }
  assert.deepEqual(validateRegistry({ ...base, review: { prompt: '.claude/review-prompt.md', exclude: ['vendor/**'], include: ['docs/**/*.md'], maxBytes: 200000, blockOn: ['CRITICAL'] } }), [])
  assert.deepEqual(validateRegistry({ ...base, review: [] }), ['review must be an object'])
  assert.deepEqual(validateRegistry({ ...base, review: { prompt: '/abs/p.md' } }), ['review.prompt must be a path relative to the project root'])
  assert.deepEqual(validateRegistry({ ...base, review: { exclude: '*.md' } }), ['review.exclude must be a list of glob patterns relative to the project root'])
  assert.deepEqual(validateRegistry({ ...base, review: { include: ['../x/**'] } }), ['review.include must be a list of glob patterns relative to the project root'])
  assert.deepEqual(validateRegistry({ ...base, review: { maxBytes: 0 } }), ['review.maxBytes must be a positive integer'])
  assert.match(validateRegistry({ ...base, review: { blockOn: ['HIGH', 'HIGH'] } })[0], /review.blockOn must list distinct severities/)
  assert.match(validateRegistry({ ...base, review: { blockOn: [] } })[0], /review.blockOn/)
  assert.match(validateRegistry({ ...base, review: { model: 'x' } })[0], /review.model is not a review setting/)
})

test('the review settings default when the root has no registry, and merge with it when it has one', () => {
  assert.deepEqual(reviewConfig(repo()), { prompt: null, exclude: DEFAULT_EXCLUDE, include: [], maxBytes: 400000, blockOn: ['CRITICAL', 'HIGH'] })
  const { change } = host()
  setReview(change, { exclude: ['vendor/**'], maxBytes: 10, blockOn: ['CRITICAL'] })
  const config = reviewConfig(change)
  assert.deepEqual([config.exclude.at(-1), config.exclude.length, config.maxBytes, config.blockOn], ['vendor/**', DEFAULT_EXCLUDE.length + 1, 10, ['CRITICAL']])
  setReview(change, { maxBytes: -1 })
  assert.throws(() => reviewConfig(change), /maxBytes/)
})

// ---------------------------------------------------------------- range and start

test('start reads the change base merge base to HEAD, filters it and counts what it excluded', () => {
  const { root, change } = host({ 'plan.md': '# Plan\n\n### Task 1: A\n\n**Files:**\n- Create: `src/a.ts`\n' })
  commitIn(root, 'later.ts', 'export const later = 1\n')
  commitAll(change, { 'src/a.ts': 'export const a = 1\n', 'src/generated.ts': 'x\n', 'README.md': '# R\n' })
  const out = review(['start', '--change', 'add-x', '--root', change])
  assert.equal(out.ok, true)
  assert.equal(out.range.base, git(change, 'merge-base', 'develop', 'HEAD'))
  assert.equal(out.range.head, git(change, 'rev-parse', 'HEAD'))
  assert.deepEqual([out.range.from, out.range.baseRef], ['change', 'develop'])
  assert.deepEqual(out.kept.map((f) => f.file), ['src/a.ts'])
  assert.deepEqual(out.excluded.map((e) => e.file).sort(), ['README.md', 'openspec/changes/add-x/.adf.json', 'openspec/changes/add-x/plan.md', 'openspec/changes/add-x/tasks.md', 'src/generated.ts'])
  assert.deepEqual(out.counts, { changed: 6, kept: 1, excluded: 5 })
  assert.equal(out.bytes, out.kept[0].bytes)
  assert.ok(out.bytes > 0)
  assert.deepEqual([out.empty, out.over, out.slices, out.proof, out.warnings], [false, false, null, null, []])
  assert.deepEqual(out.plan, { paths: 1, touched: ['src/a.ts'], untouched: [] })
  assert.ok(!out.kept.some((f) => f.file === 'later.ts'), 'a commit on the base after the fork is not in the range')
})

test('start warns when the range touches none of the plan Files paths, and reports an empty diff', () => {
  const { change } = host({ 'plan.md': '# Plan\n\n### Task 1: A\n\n**Files:**\n- Create: `src/a.ts`\n' })
  commitAll(change, { 'docs/notes.md': 'only prose\n' })
  const out = review(['start', '--change', 'add-x', '--root', change])
  assert.equal(out.empty, true)
  assert.equal(out.bytes, 0)
  assert.equal(out.plan.touched.length, 0)
  assert.match(out.warnings[0], /touches none of the plan's 1 \*\*Files:\*\* path/)
})

test('start takes --range with no change and no registry, and refuses a range it cannot read', () => {
  const root = repo()
  const a = git(root, 'rev-parse', 'HEAD')
  commitAll(root, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' })
  const out = review(['start', '--range', `${a}..HEAD`, '--root', root])
  assert.deepEqual([out.range.from, out.change, out.plan, out.counts.kept], ['range', null, null, 2])
  assert.deepEqual(parseRange('v1.2..HEAD'), { from: 'v1.2', to: 'HEAD' })
  assert.equal(parseRange('a...b'), null)
  assert.equal(parseRange('..b'), null)
  assert.throws(() => review(['start', '--range', 'a...b', '--root', root]), /is not a range/)
  assert.throws(() => review(['start', '--range', 'nope..HEAD', '--root', root]), /nope is not a commit/)
  assert.throws(() => review(['start', '--root', root]), /--change, --range, or both/)
  assert.throws(() => review(['start', '--range', `${a}..HEAD`, '--round', '1', '--root', root]), /--round does not belong to start/)
})

test('start measures each kept file, a name with a space or a non-ASCII letter included', () => {
  const root = repo()
  const a = git(root, 'rev-parse', 'HEAD')
  commitAll(root, { 'src/a b.ts': 'x\n', 'src/\u00fc.ts': 'y\n', 'src/c.ts': 'z\n' })
  const out = review(['start', '--range', `${a}..HEAD`, '--root', root])
  assert.deepEqual(out.kept.map((f) => f.file).sort(), ['src/a b.ts', 'src/c.ts', 'src/\u00fc.ts'])
  assert.ok(out.kept.every((f) => f.bytes > 0))
  assert.equal(out.bytes, out.kept.reduce((sum, f) => sum + f.bytes, 0))
})

// ---------------------------------------------------------------- slices

test('slices group the diff by directory under the limit, and the proof covers every file and byte once', () => {
  const files = [
    { file: 'apps/client/a.ts', bytes: 40 },
    { file: 'apps/client/b.ts', bytes: 40 },
    { file: 'apps/server/c.ts', bytes: 30 },
    { file: 'apps/server/deep/d.ts', bytes: 50 },
    { file: 'packages/x.ts', bytes: 20 },
    { file: 'top.ts', bytes: 10 },
    { file: 'huge.ts', bytes: 150 }
  ]
  assert.equal(proposeSlices(files, 1000), null)
  const slices = proposeSlices(files, 100)
  assert.deepEqual(
    slices.map((s) => [s.index, s.dir, s.files, s.bytes, s.oversize]),
    [
      [1, 'apps/client/', ['apps/client/a.ts', 'apps/client/b.ts'], 80, false],
      [2, 'apps/server/', ['apps/server/c.ts', 'apps/server/deep/d.ts'], 80, false],
      [3, './', ['huge.ts'], 150, true],
      [4, './', ['packages/x.ts', 'top.ts'], 30, false]
    ]
  )
  const proof = coverageProof(files, slices)
  assert.deepEqual([proof.ok, proof.files, proof.sliceFiles, proof.bytes, proof.sliceBytes], [true, 7, 7, 340, 340])
  const broken = coverageProof(files, [{ files: ['apps/client/a.ts', 'apps/client/a.ts', 'stray.ts'], bytes: 80 }])
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.repeated, ['apps/client/a.ts'])
  assert.deepEqual(broken.strays, ['stray.ts'])
  assert.equal(broken.missing.length, 6)
})

test('start over review.maxBytes proposes slices with a passing proof', () => {
  const { change } = host()
  setReview(change, { maxBytes: 300 })
  commitAll(change, { 'apps/client/a.ts': 'a\n'.repeat(60), 'apps/server/b.ts': 'b\n'.repeat(60), 'lib/c.ts': 'c\n' })
  const out = review(['start', '--change', 'add-x', '--root', change])
  assert.equal(out.over, true)
  assert.ok(out.slices.length >= 2)
  assert.equal(out.proof.ok, true)
  assert.equal(out.proof.bytes, out.bytes)
})

// ---------------------------------------------------------------- input

test('input writes the host prompt, the core block and the filtered diff; it needs no change and no Claude Code session', () => {
  const root = repo({ 'prompt.md': 'Look for bugs.\n' })
  const a = git(root, 'rev-parse', 'HEAD')
  commitAll(root, { 'src/a.ts': 'export const answer = 42\n', 'docs/x.md': 'prose line\n' })
  const { status, out } = cli(root, 'input', '--round', '1', '--range', `${a}..HEAD`, '--prompt', 'prompt.md', '--out', 'in.txt')
  assert.equal(status, 0)
  assert.deepEqual([out.ok, out.round, out.slice, out.files], [true, 1, null, 1])
  const text = readFileSync(join(root, 'in.txt'), 'utf8')
  assert.ok(text.startsWith('Look for bugs.\n'))
  assert.match(text, /## Reply format/)
  assert.match(text, /"\$defs"/)
  assert.match(text, /`ADF IGNORE <key> -- <reason>`/)
  assert.match(text, /Here is the diff:\n\ndiff --git a\/src\/a\.ts b\/src\/a\.ts/)
  assert.match(text, /\+export const answer = 42/)
  assert.doesNotMatch(text, /prose line/)
  assert.equal(out.payloadBytes, Buffer.byteLength(text))
  assert.equal(cli(root, 'input', '--round', '1', '--range', `${a}..HEAD`, '--out', 'in.txt').out.error, 'no review prompt: set review.prompt in the registry, or pass --prompt <file>')
})

test('input without a change: round 2 and later read only the fix range after --since', () => {
  const root = repo({ 'p.md': 'Criteria.\n' })
  const a = git(root, 'rev-parse', 'HEAD')
  commitAll(root, { 'src/a.ts': 'first version\n' })
  const before = git(root, 'rev-parse', 'HEAD')
  commitAll(root, { 'src/b.ts': 'the fix\n' }, 'fix F1')
  const args = (...more) => ['input', '--range', `${a}..HEAD`, '--prompt', 'p.md', '--out', join(root, 'r2.txt'), '--root', root, ...more]
  assert.throws(() => review(args('--round', '2'), { cwd: root }), /pass --since/)
  assert.throws(() => review(args('--round', '1', '--since', before), { cwd: root }), /--since belongs to round 2/)
  assert.throws(() => review(['input', '--round', '1', '--range', `${a}..HEAD`, '--prompt', 'p.md', '--root', root], { cwd: root }), /needs --out/)
  const out = review(args('--round', '2', '--since', before), { cwd: root })
  assert.deepEqual([out.ok, out.files, out.range.since, out.range.base], [true, 1, before, before])
  const text = readFileSync(join(root, 'r2.txt'), 'utf8')
  assert.match(text, /This is review round 2/)
  assert.match(text, /\+the fix/)
  assert.doesNotMatch(text, /first version/)
})

test('input without a change over review.maxBytes needs --slice and sends that slice only; an empty diff is refused', () => {
  const { change } = host()
  write(change, 'p.md', 'Criteria.\n')
  setReview(change, { prompt: 'p.md', maxBytes: 300 })
  const base = git(change, 'rev-parse', 'HEAD')
  const args = (...more) => ['input', '--round', '1', '--range', `${base}..HEAD`, '--root', change, ...more]
  const empty = review(args('--out', join(change, 'x.txt')))
  assert.equal(empty.ok, false)
  assert.match(empty.error, /is empty: there is nothing to review/)
  commitAll(change, { 'apps/client/a.ts': 'a\n'.repeat(60), 'apps/server/b.ts': 'b\n'.repeat(60) })
  const refused = review(args('--out', join(change, 'x.txt')))
  assert.equal(refused.ok, false)
  assert.match(refused.error, /pass --slice <n>, 1-2/)
  const out = review(args('--slice', '2', '--out', join(change, 's2.txt')))
  assert.deepEqual([out.ok, out.slice, out.files], [true, { index: 2, of: 2, dir: 'apps/server/' }, 1])
  const text = readFileSync(join(change, 's2.txt'), 'utf8')
  assert.match(text, /This is slice 2 of 2: the files under apps\/server\//)
  assert.doesNotMatch(text, /apps\/client\/a\.ts/)
  assert.equal(review(args('--slice', '3', '--out', join(change, 's.txt'))).ok, false)
})

test('the core block names the blocking severities and the marker grammar, and no model', () => {
  const block = coreBlock({ blockOn: ['CRITICAL'] })
  assert.match(block, /A finding of severity CRITICAL blocks the merge; HIGH, MEDIUM, LOW is recorded and does not block/)
  assert.match(block, /`ADF IGNORE-START <key> -- <reason>` and `ADF IGNORE-END`/)
  assert.match(block, /`ADF DUP <existing> -- <reason>`/)
  assert.doesNotMatch(block, /claude|opus|sonnet|haiku|gpt/i)
})

// ---------------------------------------------------------------- replies, verdict, text

test('the schemas use only the keywords the validator implements', () => {
  assert.deepEqual(unknownKeywords(readSchema(FINDINGS_SCHEMA_PATH)), [])
  assert.deepEqual(unknownKeywords(readSchema(FIX_SCHEMA_PATH)), [])
  assert.deepEqual(unknownKeywords({ type: 'string', maxLength: 3 }), ['$.maxLength'])
  assert.deepEqual(validateJson({ type: ['integer', 'null'], minimum: 1 }, 0), ['$: must be at least 1'])
})

test('a findings reply is checked against the schema, ids distinct', () => {
  assert.equal(checkFindings(reply(finding('F1', 'HIGH'), finding('F2', 'LOW', { line: null, key: 'CWE-79', suggestion: 's' }))).valid, true)
  assert.equal(checkFindings(reply()).valid, true)
  const fenced = checkFindings(`\`\`\`json\n${reply()}\n\`\`\``)
  assert.deepEqual([fenced.valid, fenced.fenced], [true, true])
  assert.match(checkFindings('The review found nothing.').errors[0], /^not JSON/)
  const bad = checkFindings(reply({ ...finding('F1', 'SEVERE'), verdict: 'APPROVE', line: 0 }, finding('X2', 'LOW'), { ...finding('F3', 'LOW'), body: '' }))
  assert.deepEqual(bad.errors, [
    '$.findings[0].severity: must be one of CRITICAL, HIGH, MEDIUM, LOW',
    '$.findings[0].line: must be at least 1',
    '$.findings[0]: verdict is not allowed',
    '$.findings[1].id: "X2" does not match ^F[1-9][0-9]*$',
    '$.findings[2].body: must not be empty'
  ])
  assert.deepEqual(checkFindings(JSON.stringify({ findings: [], verdict: 'APPROVE' })).errors, ['$: summary is required', '$: verdict is not allowed'])
  assert.deepEqual(checkFindings(reply(finding('F1', 'LOW'), finding('F1', 'HIGH'))).errors, ['$.findings: F1 appears more than once'])
  const missing = { ...finding('F1', 'LOW') }
  delete missing.line
  assert.deepEqual(checkFindings(reply(missing)).errors, ['$.findings[0]: line is required'])
})

test('a fix reply needs the sha when fixed and the argument when a false positive', () => {
  const fix = (r) => checkFix(JSON.stringify(r))
  assert.equal(fix({ finding: 'F1', outcome: 'fixed', sha: 'abc1234', failureMode: 'a null map crashed the page' }).valid, true)
  assert.equal(fix({ finding: 'F2', outcome: 'false-positive', failureMode: 'none', argument: 'the value is checked above' }).valid, true)
  assert.deepEqual(fix({ finding: 'F1', outcome: 'fixed', failureMode: 'x' }).errors, ['$: sha is required'])
  assert.deepEqual(fix({ finding: 'F1', outcome: 'false-positive', failureMode: 'x' }).errors, ['$: argument is required'])
  assert.deepEqual(fix({ finding: 'F1', outcome: 'skipped', failureMode: 'x', sha: 'XYZ' }).errors, ['$.outcome: must be one of fixed, false-positive', '$.sha: "XYZ" does not match ^[0-9a-f]{7,40}$'])
})

test('the verdict blocks while a finding of a blocking severity is open', () => {
  const findings = [finding('F1', 'CRITICAL'), finding('F2', 'HIGH'), finding('F3', 'MEDIUM')]
  assert.deepEqual(computeVerdict(findings), { verdict: 'BLOCKED', blocking: ['F1', 'F2'], counts: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0 }, blockOn: ['CRITICAL', 'HIGH'] })
  assert.equal(computeVerdict(findings, { dispositions: { F1: 'fixed', F2: 'accepted' } }).verdict, 'PASS')
  assert.deepEqual(computeVerdict(findings, { dispositions: { F1: 'dismissed', F2: 'recorded' } }).blocking, ['F2'])
  assert.equal(computeVerdict([finding('F1', 'HIGH')], { blockOn: ['CRITICAL'] }).verdict, 'PASS')
  assert.equal(computeVerdict([]).verdict, 'PASS')
})

test('response checks the reply and computes the verdict over the registry blockOn; exit 1 on invalid or BLOCKED', () => {
  const root = repo()
  write(root, 'high.json', reply(finding('F1', 'HIGH'), finding('F2', 'LOW')))
  write(root, 'bad.json', '{"summary": "x"}')
  write(root, 'fix.json', JSON.stringify({ finding: 'F1', outcome: 'fixed', sha: 'abc1234', failureMode: 'x' }))
  const blocked = cli(root, 'response', '--file', 'high.json')
  assert.equal(blocked.status, 1)
  assert.deepEqual([blocked.out.valid, blocked.out.verdict, blocked.out.blocking, blocked.out.counts.LOW], [true, 'BLOCKED', ['F1'], 1])
  const bad = cli(root, 'response', '--file', 'bad.json')
  assert.deepEqual([bad.status, bad.out.valid, bad.out.errors], [1, false, ['$: findings is required']])
  assert.deepEqual([cli(root, 'response', '--file', 'fix.json', '--kind', 'fix').status, cli(root, 'response', '--file', 'high.json', '--kind', 'other').status], [0, 2])
  const { change } = host()
  setReview(change, { blockOn: ['CRITICAL'] })
  write(change, 'high.json', reply(finding('F1', 'HIGH')))
  const passed = review(['response', '--file', 'high.json', '--root', change], { cwd: change })
  assert.deepEqual([passed.ok, passed.verdict, passed.blockOn], [true, 'PASS', ['CRITICAL']])
})

test('render writes the summary, verdict, counts, table and bodies as markdown', () => {
  const text = renderFindings(JSON.parse(reply(finding('F1', 'HIGH', { title: 'a | b', key: 'CWE-79', suggestion: 'escape it' }), finding('F2', 'LOW', { line: null }))))
  assert.match(text, /^## Summary\n\nOne change reviewed\.\n/)
  assert.match(text, /\*\*Verdict:\*\* BLOCKED \(open blocking findings: F1\); blocks on CRITICAL, HIGH/)
  assert.match(text, /\| HIGH \| 1 \|\n\| MEDIUM \| 0 \|\n\| LOW \| 1 \|/)
  assert.match(text, /\| F1 \| HIGH \| Bugs \| `src\/a\.ts:3` \| a \\\| b \|/)
  assert.match(text, /\| F2 \| LOW \| Bugs \| `src\/a\.ts` \| title F2 \|/)
  assert.match(text, /### F1: a \| b\n\nHIGH, Bugs, `src\/a\.ts:3`, key CWE-79\n\nbody F1\n\nSuggestion: escape it/)
  assert.match(renderFindings(JSON.parse(reply(finding('F1', 'HIGH'))), { dispositions: { F1: 'fixed' } }), /\| F1 \| HIGH \| Bugs \| `src\/a\.ts:3` \| title F1 \| fixed \|/)
  assert.match(renderFindings({ summary: 'Clean.', findings: [] }), /\*\*Verdict:\*\* PASS; blocks on CRITICAL, HIGH[\s\S]*No findings\./)
  const root = repo()
  write(root, 'r.json', reply(finding('F1', 'MEDIUM')))
  const out = cli(root, 'render', '--file', 'r.json', '--out', 'review.md')
  assert.deepEqual([out.status, out.out.verdict, out.out.out], [0, 'PASS', join(root, 'review.md')])
  assert.match(readFileSync(join(root, 'review.md'), 'utf8'), /### F1: title F1/)
  assert.equal(cli(root, 'render', '--file', 'r.json').out.markdown.startsWith('## Summary'), true)
})
