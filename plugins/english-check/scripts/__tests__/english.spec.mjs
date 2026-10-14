import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import {
  DEFAULT_CONFIG,
  findForeign,
  globToRegExp,
  inScope,
  parseCommits,
  resolveConfig,
  splitCommands
} from '../lib/english.mjs'

// Foreign text is written with escapes so this file passes its own check in a host that
// includes it. RU is a Cyrillic word, ZH two ideographs.
const RU = '\u043f\u0440\u0438\u0432\u0435\u0442'
const ZH = '\u4e2d\u6587'

// Ported from the origin's check-english.spec.mjs: the character tests unchanged, the path
// cases as configuration tests (the origin's scope was a fixed list of its own paths).

test('flags Cyrillic', () => {
  assert.deepEqual(findForeign(`ok\n${RU}\nfine`), [{ line: 2, text: RU }])
})

test('flags CJK', () => {
  assert.equal(findForeign(`ok\n${ZH}\n`).length, 1)
})

test('leaves English prose alone, including typography', () => {
  assert.deepEqual(findForeign('An em dash \u2014 an arrow \u2192 a quote \u201cx\u201d'), [])
})

test('reports every offending line, not just the first', () => {
  assert.equal(findForeign(`${RU}\n${ZH}`).length, 2)
})

test('flags CJK punctuation and fullwidth forms, the two other ranges', () => {
  assert.equal(findForeign('a\u3001b').length, 1)
  assert.equal(findForeign('\uff21').length, 1)
})

test('kana, Hangul, Greek, the Cyrillic supplement and Latin diacritics pass, as in the origin', () => {
  assert.deepEqual(findForeign('\u3042 \ud55c \u03b1 \u0500 caf\u00e9'), [])
})

test('the line text is echoed whole and line numbers are 1-based', () => {
  assert.deepEqual(findForeign(`a\nb\nsee ${RU} here`), [{ line: 3, text: `see ${RU} here` }])
})

test('a filled-in change plan.md is excluded', () => {
  assert.equal(inScope('openspec/changes/integrate-superpowers-workflow/plan.md'), false)
})

test('a change plan stays exempt after it is archived', () => {
  assert.equal(inScope('openspec/changes/integrate-superpowers-workflow/plan.md'), false)
  assert.equal(inScope('openspec/changes/archive/2026-08-03-integrate-superpowers-workflow/plan.md'), false)
})

test('an archived artifact other than the plan stays in scope', () => {
  assert.equal(inScope('openspec/changes/archive/2026-08-03-integrate-superpowers-workflow/proposal.md'), true)
})

test('the default scope is the change artifacts and the specs', () => {
  assert.equal(inScope('openspec/changes/x/proposal.md'), true)
  assert.equal(inScope('openspec/changes/x/specs/cap/spec.md'), true)
  assert.equal(inScope('openspec/specs/cap/spec.md'), true)
  assert.equal(inScope('openspec/changes/x/.adf.json'), true)
  assert.equal(inScope('.claude/memory/index.md'), false)
  assert.equal(inScope('src/app.ts'), false)
})

test('a path outside the extension list is out of scope', () => {
  assert.equal(inScope('openspec/changes/x/diagram.png'), false)
  assert.equal(inScope('openspec/changes/x/notes'), false)
  assert.equal(inScope('openspec/changes/x/a.yml'), true)
})

test('a path is normalised before it is matched', () => {
  assert.equal(inScope('./openspec/changes/x/proposal.md'), true)
  assert.equal(inScope('openspec/changes/x/../y/plan.md'), false)
})

test('a configured include brings an opsx command file into scope', () => {
  const config = resolveConfig({ include: ['.claude/commands/opsx/**/*.md'] })
  assert.equal(inScope('.claude/commands/opsx/apply.md', config), true)
  assert.equal(inScope('openspec/changes/x/proposal.md', config), false)
})

test('a wiki memory page is out of scope unless included', () => {
  assert.equal(inScope('.claude/memory/index.md'), false)
  assert.equal(inScope('.claude/memory/index.md', resolveConfig({ include: ['.claude/**'] })), true)
})

test('one skill can be included while the other skills stay out', () => {
  const config = resolveConfig({ include: ['.claude/skills/openspec-sync-specs/**/*.md'] })
  assert.equal(inScope('.claude/skills/device-verification/README.md', config), false)
  assert.equal(inScope('.claude/skills/openspec-sync-specs/README.md', config), true)
})

test('an exclusion wins over an inclusion', () => {
  const config = resolveConfig({
    include: ['.claude/scripts/**/*.mjs'],
    exclude: ['.claude/scripts/__tests__/check-english.spec.mjs']
  })
  assert.equal(inScope('.claude/scripts/__tests__/check-english.spec.mjs', config), false)
  assert.equal(inScope('.claude/scripts/__tests__/ledger.spec.mjs', config), true)
})

test('a key the configuration does not set keeps its default', () => {
  const config = resolveConfig({ include: ['docs/**'] })
  assert.deepEqual(config.exclude, DEFAULT_CONFIG.exclude)
  assert.deepEqual(config.extensions, DEFAULT_CONFIG.extensions)
  assert.deepEqual(resolveConfig({ extensions: ['.md'] }).extensions, ['md'])
})

test('a malformed configuration is an error, not a silent default', () => {
  assert.throws(() => resolveConfig({ include: 'docs/**' }), /include must be a list of strings/)
  assert.throws(() => resolveConfig([]), /must be an object/)
})

test('globs: ** spans directories, * and ? stay in one segment', () => {
  assert.equal(globToRegExp('a/**/b').test('a/b'), true)
  assert.equal(globToRegExp('a/**/b').test('a/x/y/b'), true)
  assert.equal(globToRegExp('a/**').test('a/x/y'), true)
  assert.equal(globToRegExp('a/*.md').test('a/x.md'), true)
  assert.equal(globToRegExp('a/*.md').test('a/x/y.md'), false)
  assert.equal(globToRegExp('a/?.md').test('a/x.md'), true)
  assert.equal(globToRegExp('a/?.md').test('a/xy.md'), false)
  assert.equal(globToRegExp('a.md').test('aXmd'), false)
})

test('splitting a command line honours quotes and operators', () => {
  assert.deepEqual(splitCommands(`git add . && git commit -m "a; b && c"; echo 'x|y' | cat`), [
    ['git', 'add', '.'],
    ['git', 'commit', '-m', 'a; b && c'],
    ['echo', 'x|y'],
    ['cat']
  ])
})

const cwd = '/repo'

test('commit detection: plain, env prefix, -C, cd, chains', () => {
  assert.deepEqual(parseCommits('git commit -m x', cwd), [{ dir: cwd, wide: false }])
  assert.deepEqual(parseCommits('LEFTHOOK=0 git commit -m x', cwd), [{ dir: cwd, wide: false }])
  assert.deepEqual(parseCommits('env A=1 /usr/bin/git commit', cwd), [{ dir: cwd, wide: false }])
  assert.deepEqual(parseCommits('git -C sub commit -m x', cwd), [{ dir: resolve(cwd, 'sub'), wide: false }])
  assert.deepEqual(parseCommits('git -c user.name=x -C /other commit', cwd), [{ dir: '/other', wide: false }])
  assert.deepEqual(parseCommits('cd wt && git commit -m x', cwd), [{ dir: resolve(cwd, 'wt'), wide: false }])
  assert.equal(parseCommits('git status; git commit -m x || true', cwd).length, 1)
})

test('a command that does not commit yields nothing', () => {
  assert.deepEqual(parseCommits('ls -la', cwd), [])
  assert.deepEqual(parseCommits('git log --grep commit', cwd), [])
  assert.deepEqual(parseCommits('echo "git commit"', cwd), [])
  assert.deepEqual(parseCommits('git status # git commit', cwd), [])
})

test('-a, --all, -am and a git add on the same line widen the commit', () => {
  assert.equal(parseCommits('git commit -a -m x', cwd)[0].wide, true)
  assert.equal(parseCommits('git commit --all -m x', cwd)[0].wide, true)
  assert.equal(parseCommits('git commit -am x', cwd)[0].wide, true)
  assert.equal(parseCommits('git add f && git commit -m x', cwd)[0].wide, true)
  assert.equal(parseCommits('git -C sub add f && git -C sub commit -m x', cwd)[0].wide, true)
})

test('a commit message or a value flag does not widen the commit', () => {
  assert.equal(parseCommits('git commit -m -a', cwd)[0].wide, false)
  assert.equal(parseCommits('git commit -ma', cwd)[0].wide, false)
  assert.equal(parseCommits('git commit -m "add all"', cwd)[0].wide, false)
})
