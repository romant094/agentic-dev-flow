// End to end through the CLI, against a copy of the fixture host and the fixture plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createReviewPrompt } from '../lib/host-files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REVIEW_TEMPLATE = join(here, '..', '..', 'host', 'review-prompt.md')
const cli = join(here, '..', 'extensions.mjs')
const fixtures = join(here, '..', '..', '..', '..', 'test', 'fixtures')

function host() {
  const root = mkdtempSync(join(tmpdir(), 'adf-e2e-'))
  cpSync(join(fixtures, 'host'), root, { recursive: true })
  cpSync(join(fixtures, 'plugins'), join(root, 'plugins'), { recursive: true })
  return root
}

// An empty Claude Code home: no marketplace known, so init declares the plugin only.
const home = mkdtempSync(join(tmpdir(), 'adf-home-'))

function adf(root, ...args) {
  try {
    const argv = [cli, ...args, '--root', root, '--home', home]
    return { code: 0, out: JSON.parse(execFileSync('node', argv, { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

test('init, add, check, remove on a fresh host', () => {
  const root = host()
  assert.equal(adf(root, 'check').code, 1)
  const init = adf(root, 'init').out
  assert.equal(init.created, true)
  assert.equal(init.contract, '1.7')
  assert.deepEqual(init.settings.added, ['enabledPlugins.adf@agentic-dev-flow'])
  assert.deepEqual(init.planningGuide, { path: 'openspec/planning.md', created: true })
  assert.deepEqual(init.reviewPrompt, { path: 'openspec/review-prompt.md', created: true, registered: true })
  assert.equal(readFileSync(join(root, 'openspec', 'review-prompt.md'), 'utf8'), readFileSync(REVIEW_TEMPLATE, 'utf8'))
  assert.match(init.report, /Review prompt: created at openspec\/review-prompt\.md; the team tunes its criteria; review\.prompt set in the registry/)
  assert.equal(init.branches, null)
  // init runs the gate and the check itself (I1) and renders the report (I2).
  assert.equal(init.superpowers.ok, false)
  assert.deepEqual(init.check.errors, ['no branches are set; run /adf:init'])
  assert.match(init.report, /Branch policy: not set/)
  assert.match(init.report, /Superpowers: not available/)
  assert.equal(adf(root, 'check').code, 1)
  const set = adf(root, 'branches', '--integration', 'develop', '--protected', 'main, develop').out
  assert.deepEqual({ integration: set.integration, protected: set.protected }, { integration: 'develop', protected: ['develop', 'main'] })
  assert.deepEqual(set.check, { ok: true, errors: [], warnings: [], plugins: [] })
  assert.match(set.report, /^Branch policy: integration develop; protected develop, main\n/)
  const again = adf(root, 'init').out
  assert.equal(again.created, false)
  assert.deepEqual(again.settings.added, [])
  assert.equal(again.planningGuide.created, false)
  assert.deepEqual(again.reviewPrompt, { path: 'openspec/review-prompt.md', created: false, registered: false })
  assert.deepEqual(again.branches.protected, ['develop', 'main'])

  const added = adf(root, 'add', 'plugins/sample', '--config', '{"greeting":"hi"}')
  assert.equal(added.code, 0)
  const { check, report, ...enabled } = added.out
  assert.deepEqual(enabled, { name: 'sample', points: [], hostFiles: { copied: [], kept: [] }, settings: { added: [], notes: [] } })
  assert.deepEqual(check.plugins, [{ name: 'sample', path: 'plugins/sample', points: [] }])
  assert.match(report, /^Enabled: sample \(no points\)\n[\s\S]*Registry check: ok/)

  const checked = adf(root, 'check')
  assert.equal(checked.code, 0)
  assert.deepEqual(checked.out.plugins, [{ name: 'sample', path: 'plugins/sample', points: [] }])

  const registry = JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions, [{ path: 'plugins/sample', points: [], config: { greeting: 'hi' } }])

  const removed = adf(root, 'remove', 'sample')
  assert.equal(removed.code, 0)
  assert.match(removed.out.report, /^Removed: plugins\/sample\nEnabled plugins: none\nRegistry check: ok/)
  assert.deepEqual(adf(root, 'check').out.plugins, [])
})

test('a refusal is JSON with exit code 1', () => {
  const root = host()
  const result = adf(root, 'add', 'plugins/sample')
  assert.equal(result.code, 1)
  assert.match(result.out.error, /adf:init/)
})

// A forge plugin installed by Claude Code into its cache, recorded for this host only.
function installedForge(root, name = 'forge-a') {
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const records = {}
  for (const n of [name, 'forge-b']) {
    const dir = join(home, 'plugins', 'cache', 'mk', n, '1.0.0')
    mkdirSync(join(dir, 'templates'), { recursive: true })
    writeFileSync(join(dir, 'templates', 'mr.md'), `## What\n`)
    writeFileSync(
      join(dir, 'adf-extension.json'),
      JSON.stringify({
        name: n,
        contract: '1.2',
        provides: { forge: { script: 'scripts/forge.mjs', operations: ['check', 'open', 'push', 'finalize'] } },
        hostFiles: [{ from: 'templates/mr.md', to: '.forge/mr.md' }]
      })
    )
    records[`${n}@mk`] = [{ scope: 'project', projectPath: root, installPath: dir }]
  }
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: records }))
  return home
}

function adfAt(root, home, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root, '--home', home], { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

test('an installed plugin is enabled by id, its host files copied once, and a role has one provider', () => {
  const root = host()
  const forgeHome = installedForge(root)
  adfAt(root, forgeHome, 'init')
  adfAt(root, forgeHome, 'branches', '--integration', 'develop')
  const added = adfAt(root, forgeHome, 'add', 'forge-a@mk')
  assert.equal(added.code, 0)
  assert.deepEqual({ ...added.out, check: undefined, report: undefined }, { name: 'forge-a', points: ['forge'], hostFiles: { copied: ['.forge/mr.md'], kept: [] }, settings: { added: [], notes: [] }, check: undefined, report: undefined })
  assert.equal(added.out.check.ok, true)
  assert.equal(existsSync(join(root, '.forge', 'mr.md')), true)
  const registry = JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions, [{ plugin: 'forge-a@mk', points: ['forge'] }])
  assert.deepEqual(adfAt(root, forgeHome, 'check').out.plugins, [{ name: 'forge-a', plugin: 'forge-a@mk', points: ['forge'] }])
  assert.match(adfAt(root, forgeHome, 'add', 'forge-b@mk').out.error, /role forge is already provided by forge-a/)
  assert.match(adfAt(root, forgeHome, 'add', 'missing@mk').out.error, /not installed for this project/)
  assert.equal(adfAt(root, forgeHome, 'remove', 'forge-a').code, 0)
  assert.deepEqual(adfAt(root, forgeHome, 'add', 'forge-a@mk').out.hostFiles, { copied: [], kept: ['.forge/mr.md'] })
})

test('the review prompt goes to the registry\'s review.prompt, and an existing one is never overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-review-prompt-'))
  const registry = (review) => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'adf-extensions.json'), JSON.stringify({ contract: '1.2', extensions: [], ...(review ? { review } : {}) }))
  }
  registry({ prompt: 'ci/review.md', blockOn: ['CRITICAL'] })
  assert.deepEqual(createReviewPrompt(root), { path: 'ci/review.md', created: true, registered: false })
  assert.equal(readFileSync(join(root, 'ci', 'review.md'), 'utf8'), readFileSync(REVIEW_TEMPLATE, 'utf8'))
  writeFileSync(join(root, 'ci', 'review.md'), 'ours')
  assert.deepEqual(createReviewPrompt(root), { path: 'ci/review.md', created: false, registered: false })
  assert.equal(readFileSync(join(root, 'ci', 'review.md'), 'utf8'), 'ours')

  // No key: the default path is registered beside the other review settings, and a file the
  // host already keeps there stays as it is.
  registry({ maxBytes: 1000 })
  mkdirSync(join(root, 'openspec'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'review-prompt.md'), 'theirs')
  assert.deepEqual(createReviewPrompt(root), { path: 'openspec/review-prompt.md', created: false, registered: true })
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8')).review, { maxBytes: 1000, prompt: 'openspec/review-prompt.md' })
  assert.equal(readFileSync(join(root, 'openspec', 'review-prompt.md'), 'utf8'), 'theirs')

  registry({ prompt: '../outside.md' })
  assert.deepEqual(createReviewPrompt(root), { path: '../outside.md', created: false, registered: false, invalid: true })
  assert.equal(existsSync(join(root, '..', 'outside.md')), false)
})

test('the memory plugin enables as the one knowledge provider and copies its skeleton', () => {
  const root = host()
  adf(root, 'init')
  adf(root, 'branches', '--integration', 'develop')
  const memory = join(here, '..', '..', '..', 'adf-memory')
  const added = adf(root, 'add', memory)
  assert.equal(added.code, 0)
  assert.deepEqual(added.out.points, ['knowledge'])
  assert.deepEqual(added.out.hostFiles.copied, ['.claude/memory/index.md', '.claude/memory/log.md', '.claude/memory/system.md'])
  assert.equal(added.out.check.ok, true)
  // The knowledge base is writable in the main checkout and in every change worktree.
  const rules = ['Edit(/.claude/memory/**)', 'Write(/.claude/memory/**)', 'Edit(/.claude/worktrees/*/.claude/memory/**)', 'Write(/.claude/worktrees/*/.claude/memory/**)']
  const settingsFile = join(root, '.claude', 'settings.json')
  assert.deepEqual(added.out.settings.added, rules.map((rule) => `permissions.allow ${rule}`))
  assert.match(added.out.report, /Settings added: permissions\.allow Edit\(\/\.claude\/memory\/\*\*\), /)
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).permissions.allow, rules)
  assert.deepEqual(adf(root, 'init').out.settings.added, [])
  // A host set up before the rules existed, with its own main-checkout rule: init adds the
  // rules once.
  const old = JSON.parse(readFileSync(settingsFile, 'utf8'))
  old.permissions.allow = ['Edit(.claude/memory/**)']
  writeFileSync(settingsFile, JSON.stringify(old, null, '\t'))
  assert.deepEqual(adf(root, 'init').out.settings.added, rules.map((rule) => `permissions.allow ${rule}`))
  assert.deepEqual(adf(root, 'init').out.settings.added, [])
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).permissions.allow, ['Edit(.claude/memory/**)', ...rules])
  // A second knowledge provider is refused: a role has at most one.
  const other = join(root, 'plugins', 'other-memory')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'adf-extension.json'), JSON.stringify({ name: 'other-memory', contract: '1.3', provides: { knowledge: { script: 's.mjs', operations: ['context', 'log', 'check'] } } }))
  assert.match(adf(root, 'add', 'plugins/other-memory').out.error, /role knowledge is already provided by adf-memory/)
})
