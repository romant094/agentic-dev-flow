import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCheckout, normalizeConfig, readRegistryConfig } from '../lib/config.mjs'
import { describeProfile } from '../profile.mjs'
import { findCore } from '../core-debt.mjs'

describe('normalizeConfig', () => {
  it('fills the defaults', () => {
    const { config, errors } = normalizeConfig({ baseUrl: 'https://jira.example.com', allowlist: ['PROJ'] })
    assert.deepEqual(errors, [])
    assert.equal(config.profileDir, join('.claude', 'jira', 'profile'))
    assert.deepEqual(config.statuses, { start: 'In Progress', handoff: null, excluded: [] })
    assert.deepEqual(config.fields, [])
  })

  it('names every invalid or unknown key', () => {
    const { errors } = normalizeConfig({
      baseUrl: 'jira.example.com',
      allowlist: ['proj'],
      profileDir: '../outside',
      debtEpic: 'PROJ',
      commentTemplate: '/abs.md',
      correctionTemplate: '../c.md',
      statuses: { handoff: '', done: 'x' },
      token: 'x'
    })
    assert.deepEqual(errors, [
      'config.token is not a key of adf-jira',
      'config.baseUrl is not an http or https URL',
      'config.allowlist is not a list of project keys',
      'config.profileDir is not a path inside the project',
      'config.debtEpic is not an issue key',
      'config.commentTemplate is not a path inside the project',
      'config.correctionTemplate is not a path inside the project',
      'config.statuses.done is not a key of adf-jira',
      'config.statuses.handoff is not a status name'
    ])
  })
})

function host(registry) {
  const root = mkdtempSync(join(tmpdir(), 'adf-jira-host-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  if (registry) writeFileSync(join(root, '.claude', 'adf-extensions.json'), JSON.stringify(registry))
  return root
}

describe('readRegistryConfig', () => {
  it('reads the config of an installed entry by plugin name', () => {
    const root = host({ extensions: [{ plugin: 'adf-gitlab@m', config: { host: 'g' } }, { plugin: 'adf-jira@m', config: { debtEpic: 'PROJ-1' } }] })
    assert.deepEqual(readRegistryConfig(root), { debtEpic: 'PROJ-1' })
  })

  it('reads the config of a path entry whose declaration names the plugin', () => {
    const root = host({ extensions: [{ path: 'plugins/jira', config: { allowlist: ['PROJ'] } }] })
    mkdirSync(join(root, 'plugins', 'jira'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'jira', 'adf-extension.json'), JSON.stringify({ name: 'adf-jira' }))
    assert.deepEqual(readRegistryConfig(root), { allowlist: ['PROJ'] })
  })

  it('is empty with no registry', () => {
    assert.deepEqual(readRegistryConfig(host()), {})
  })
})

describe('mainCheckout', () => {
  it('is the parent of the git common directory, else the directory itself', () => {
    assert.equal(mainCheckout('/repo/.claude/worktrees/x', () => '/repo/.git'), '/repo')
    assert.equal(mainCheckout('/plain', () => null), '/plain')
  })
})

describe('profile.mjs', () => {
  it('describes the profile and the config, with what git ignores', () => {
    const root = host({ extensions: [{ plugin: 'adf-jira@m', config: { baseUrl: 'https://j.example', allowlist: ['PROJ'], debtEpic: 'PROJ-9' } }] })
    const out = describeProfile({ cwd: root, run: () => null, ignored: (_dir, path) => path.endsWith('local.md'), home: root, processEnv: {} })
    assert.equal(out.config.debtEpic, 'PROJ-9')
    assert.equal(out.profile.discovered, join(root, '.claude', 'jira', 'profile', 'discovered.json'))
    assert.deepEqual(out.profile.ignored, { discovered: false, local: true })
    assert.equal(out.profile.discoveredAt, null)
    assert.ok(!('envFile' in out.config))
  })

  it('prints JIRA_GIT_AUTHOR from the env file as gitAuthor, and no other env value', () => {
    const root = host({ extensions: [{ plugin: 'adf-jira@m', config: { baseUrl: 'https://j.example', allowlist: ['PROJ'] } }] })
    const home = mkdtempSync(join(tmpdir(), 'adf-jira-home-'))
    writeFileSync(join(root, '.claude', '.env'), 'JIRA_PAT=secret-token\nJIRA_QA=qa.login\nJIRA_GIT_AUTHOR="Dev Person"\n')
    const out = describeProfile({ cwd: root, run: () => null, ignored: () => true, home, processEnv: {} })
    assert.equal(out.gitAuthor, 'Dev Person')
    const text = JSON.stringify(out)
    assert.ok(!text.includes('secret-token'))
    assert.ok(!text.includes('qa.login'))
  })

  it('prints gitAuthor null when JIRA_GIT_AUTHOR is unset', () => {
    const root = host()
    const home = mkdtempSync(join(tmpdir(), 'adf-jira-home-'))
    assert.equal(describeProfile({ cwd: root, run: () => null, ignored: () => true, home, processEnv: {} }).gitAuthor, null)
  })
})

describe('findCore', () => {
  it('takes the core beside this plugin in a checkout', () => {
    const exists = (p) => p === join('/m', 'plugins', 'adf', 'scripts', 'debt.mjs')
    assert.equal(findCore({ pluginRoot: '/m/plugins/adf-jira', home: '/none', exists }), join('/m/plugins/adf-jira', '..', 'adf'))
  })

  it('takes the core of the same marketplace from the install records, the project install first', () => {
    const home = mkdtempSync(join(tmpdir(), 'adf-jira-records-'))
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'adf-jira@mk': [{ scope: 'user', installPath: '/cache/mk/adf-jira/0.1.0' }],
          'adf@other': [{ scope: 'user', installPath: '/cache/other/adf/9.9.9' }],
          'adf@mk': [
            { scope: 'user', installPath: '/cache/mk/adf/0.13.0' },
            { scope: 'project', projectPath: '/work/host', installPath: '/cache/mk/adf/0.14.0' }
          ]
        }
      })
    )
    const cores = ['/cache/mk/adf/0.13.0', '/cache/mk/adf/0.14.0', '/cache/other/adf/9.9.9'].map((c) => join(c, 'scripts', 'debt.mjs'))
    const exists = (p) => cores.includes(p)
    assert.equal(findCore({ pluginRoot: '/cache/mk/adf-jira/0.1.0', home, projectDir: '/work/host', exists }), '/cache/mk/adf/0.14.0')
    assert.equal(findCore({ pluginRoot: '/cache/mk/adf-jira/0.1.0', home, projectDir: '/elsewhere', exists }), '/cache/mk/adf/0.13.0')
  })
})
