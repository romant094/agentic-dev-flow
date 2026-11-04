// The guide review in scripts/guide-review.mjs: review packages from a release diff, and the check of each reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectPages, buildPackages, checkReply, run } from '../../../../scripts/guide-review.mjs'

const pages = [
  { path: 'docs/guide/README.md', text: '', sources: [] },
  { path: 'docs/guide/cycle/propose.md', text: '', sources: ['plugins/adf/skills/propose/**'] },
  { path: 'docs/guide/cycle/apply.md', text: '', sources: ['plugins/adf/skills/apply/**'] },
  { path: 'docs/guide/concepts/flow.md', text: '', sources: ['plugins/adf/scripts/lib/*.mjs'] },
]

test('a page is selected by a touched source', () => {
  const out = selectPages({ pages, changed: ['plugins/adf/skills/propose/SKILL.md'] })
  assert.deepEqual(out.map((p) => p.path), ['docs/guide/cycle/propose.md'])
})

test('a page is selected when it changes itself', () => {
  const out = selectPages({ pages, changed: ['docs/guide/README.md'] })
  assert.deepEqual(out.map((p) => p.path), ['docs/guide/README.md'])
})

test('packages are split by section', () => {
  const files = ['plugins/adf/skills/propose/SKILL.md', 'plugins/adf/skills/apply/SKILL.md', 'plugins/adf/scripts/lib/a.mjs']
  const changed = [files[0], files[2], 'docs/guide/README.md']
  const pkgs = buildPackages({ pages, changed, from: 'v1', files, prompt: 'scripts/guide-review/prompt.md' })
  assert.deepEqual(pkgs.map((p) => p.section).sort(), ['concepts', 'cycle', 'getting-started'])
  const cycle = pkgs.find((p) => p.section === 'cycle')
  assert.equal(cycle.from, 'v1')
  assert.equal(cycle.prompt, 'scripts/guide-review/prompt.md')
  assert.deepEqual(cycle.pages, [{ path: 'docs/guide/cycle/propose.md', sources: [files[0]], touched: [files[0]] }])
  assert.deepEqual(pkgs.find((p) => p.section === 'getting-started').pages.map((p) => p.path), ['docs/guide/README.md'])
})

function fakeGit(known = ['v1']) {
  return (args) => {
    if (args[0] === 'rev-parse') {
      if (known.includes(args[3].replace(/\^\{commit\}$/, ''))) return 'abc\n'
      throw new Error('unknown revision')
    }
    if (args[0] === 'diff') return 'plugins/adf/skills/propose/SKILL.md\n'
    if (args[0] === 'ls-files') return 'plugins/adf/skills/propose/SKILL.md\n'
    throw new Error(`unexpected ${args.join(' ')}`)
  }
}

test('an unknown tag is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'gr-'))
  const result = run(['input', '--from', 'nope', '--out', join(root, 'o')], { root, git: fakeGit(), readPages: () => pages })
  assert.equal(result.ok, false)
  assert.match(result.error, /nope/)
})

test('input writes one package file per section into a new directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'gr-'))
  const out = join(root, 'a', 'b')
  const result = run(['input', '--from', 'v1', '--out', out], { root, git: fakeGit(), readPages: () => pages })
  assert.deepEqual(result.packages, [{ section: 'cycle', file: join(out, 'cycle.json'), pages: 1 }])
  const pkg = JSON.parse(readFileSync(join(out, 'cycle.json'), 'utf8'))
  assert.equal(pkg.pages[0].path, 'docs/guide/cycle/propose.md')
})

const pkg = {
  section: 'cycle',
  from: 'v1',
  prompt: 'p.md',
  pages: [{ path: 'docs/guide/cycle/propose.md', sources: ['plugins/adf/skills/propose/SKILL.md'], touched: [] }],
}
const finding = (over = {}) => ({
  page: 'docs/guide/cycle/propose.md',
  claim: 'It takes two flags.',
  source: { path: 'plugins/adf/skills/propose/SKILL.md', line: 3 },
  fix: 'Say three flags.',
  ...over,
})
const ctx = { pkg, exists: () => true, lineCount: () => 10 }

test('a valid empty reply passes', () => {
  assert.deepEqual(checkReply({ reply: { findings: [] }, ...ctx }), { ok: true, errors: [], findings: [] })
})

test('a valid reply with findings passes and lists them', () => {
  const r = checkReply({ reply: { findings: [finding()] }, ...ctx })
  assert.equal(r.ok, true)
  assert.equal(r.findings.length, 1)
})

test('a reply outside the package is refused', () => {
  const a = checkReply({ reply: { findings: [finding({ page: 'docs/guide/other.md' })] }, ...ctx })
  assert.equal(a.ok, false)
  assert.match(a.errors[0], /other\.md/)
  const b = checkReply({ reply: { findings: [finding({ source: { path: 'x/y.mjs', line: 1 } })] }, ...ctx })
  assert.equal(b.ok, false)
  assert.match(b.errors[0], /x\/y\.mjs/)
})

test('a source line past the end is refused', () => {
  const r = checkReply({ reply: { findings: [finding({ source: { path: 'plugins/adf/skills/propose/SKILL.md', line: 11 } })] }, ...ctx })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /line 11/)
})

test('a missing source file is refused', () => {
  const r = checkReply({ reply: { findings: [finding()] }, ...ctx, exists: () => false })
  assert.equal(r.ok, false)
})

test('extra fields are refused', () => {
  assert.equal(checkReply({ reply: { findings: [], note: 'x' }, ...ctx }).ok, false)
  assert.equal(checkReply({ reply: { findings: [finding({ extra: 1 })] }, ...ctx }).ok, false)
  assert.equal(checkReply({ reply: { findings: [finding({ source: { path: 'plugins/adf/skills/propose/SKILL.md', line: 1, col: 2 } })] }, ...ctx }).ok, false)
})

test('check reads the files and exits on the reply', () => {
  const root = mkdtempSync(join(tmpdir(), 'gr-'))
  mkdirSync(join(root, 'plugins/adf/skills/propose'), { recursive: true })
  writeFileSync(join(root, 'plugins/adf/skills/propose/SKILL.md'), 'a\nb\nc\n')
  writeFileSync(join(root, 'pkg.json'), JSON.stringify(pkg))
  writeFileSync(join(root, 'ok.json'), JSON.stringify({ findings: [finding()] }))
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ findings: [finding({ source: { path: 'plugins/adf/skills/propose/SKILL.md', line: 4 } })] }))
  assert.equal(run(['check', '--package', join(root, 'pkg.json'), '--reply', join(root, 'ok.json')], { root }).ok, true)
  assert.equal(run(['check', '--package', join(root, 'pkg.json'), '--reply', join(root, 'bad.json')], { root }).ok, false)
})

test('a usage error throws', () => {
  assert.throws(() => run(['input'], {}), /usage/)
})
