import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvError, parseEnvFile, resolveEnv } from '../lib/env.mjs'

function scratch() {
  return mkdtempSync(join(tmpdir(), 'jira-env-'))
}

function writeEnv(dir, body) {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', '.env'), body, 'utf8')
}

describe('parseEnvFile', () => {
  it('skips comments and blank lines and strips surrounding quotes', () => {
    const parsed = parseEnvFile(['# a comment', '', 'JIRA_URL=https://jira.example.com', 'JIRA_PAT="quoted"', "X='single'"].join('\n'))
    assert.deepEqual(parsed, { JIRA_URL: 'https://jira.example.com', JIRA_PAT: 'quoted', X: 'single' })
  })

  it('keeps = characters inside a value', () => {
    assert.deepEqual(parseEnvFile('JIRA_PAT=ab=cd='), { JIRA_PAT: 'ab=cd=' })
  })
})

describe('resolveEnv precedence', () => {
  it('lets the process environment win over the project file', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=https://from-file\nJIRA_PAT=filepat\nJIRA_ALLOWED_PROJECTS=PROJ')
    const { env, sources } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: { JIRA_URL: 'https://from-process' } })
    assert.equal(env.url, 'https://from-process')
    assert.equal(sources.find((s) => s.key === 'JIRA_URL')?.layer, 'process')
    assert.equal(sources.find((s) => s.key === 'JIRA_PAT')?.layer, 'project')
  })

  it('lets the project file win over the home file', () => {
    const project = scratch()
    const home = scratch()
    writeEnv(project, 'JIRA_URL=https://project\nJIRA_PAT=p\nJIRA_ALLOWED_PROJECTS=PROJ')
    writeEnv(home, 'JIRA_URL=https://home\nJIRA_PAT=h\nJIRA_ALLOWED_PROJECTS=OTHER')
    const { env } = resolveEnv({ projectDir: project, homeDir: home, processEnv: {} })
    assert.equal(env.url, 'https://project')
    assert.deepEqual(env.allowedProjects, ['PROJ'])
  })

  it('falls back to the home file for keys the project file omits', () => {
    const project = scratch()
    const home = scratch()
    writeEnv(project, 'JIRA_URL=https://project\nJIRA_PAT=p\nJIRA_ALLOWED_PROJECTS=PROJ')
    writeEnv(home, 'JIRA_PM=pm.login')
    const { env, sources } = resolveEnv({ projectDir: project, homeDir: home, processEnv: {} })
    assert.equal(env.pm, 'pm.login')
    assert.equal(sources.find((s) => s.key === 'JIRA_PM')?.layer, 'home')
  })

  it('resolves the QA from JIRA_QA', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=u\nJIRA_PAT=p\nJIRA_ALLOWED_PROJECTS=PROJ\nJIRA_QA=qa.login')
    const { env } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {} })
    assert.equal(env.qa, 'qa.login')
  })

  it('splits and trims the allowlist', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=u\nJIRA_PAT=p\nJIRA_ALLOWED_PROJECTS= PROJ , OTHER ')
    const { env } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {} })
    assert.deepEqual(env.allowedProjects, ['PROJ', 'OTHER'])
  })
})

describe('resolveEnv validation', () => {
  it('names a missing required variable without disclosing any value', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=https://jira.example.com\nJIRA_ALLOWED_PROJECTS=PROJ')
    assert.throws(() => resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {} }), /JIRA_PAT/)
  })

  it('refuses an empty allowlist so a typo cannot reach every project', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=u\nJIRA_PAT=secret-value\nJIRA_ALLOWED_PROJECTS=')
    assert.throws(() => resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {} }), /JIRA_ALLOWED_PROJECTS/)
  })

  it('reports lengths rather than values in sources', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=https://jira.example.com\nJIRA_PAT=secret-value\nJIRA_ALLOWED_PROJECTS=PROJ')
    const { sources } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {} })
    const pat = sources.find((s) => s.key === 'JIRA_PAT')
    assert.equal(pat?.length, 'secret-value'.length)
    assert.ok(!JSON.stringify(sources).includes('secret-value'))
  })
})

describe('resolveEnv with the registry config', () => {
  it('takes the URL and the allowlist from the config over the env file', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_URL=https://from-file\nJIRA_PAT=p\nJIRA_ALLOWED_PROJECTS=OTHER')
    const { env, sources } = resolveEnv({
      projectDir: project,
      homeDir: scratch(),
      processEnv: {},
      config: { baseUrl: 'https://jira.example.com/', allowlist: ['PROJ'] }
    })
    assert.equal(env.url, 'https://jira.example.com')
    assert.deepEqual(env.allowedProjects, ['PROJ'])
    assert.equal(sources.find((s) => s.key === 'baseUrl')?.layer, 'config')
    assert.equal(sources.find((s) => s.key === 'JIRA_URL'), undefined)
  })

  it('needs only the token in the env file when the config holds the rest', () => {
    const project = scratch()
    writeEnv(project, 'JIRA_PAT=p')
    const { env } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {}, config: { baseUrl: 'https://j.example', allowlist: ['PROJ'] } })
    assert.equal(env.pat, 'p')
  })

  it('reads the env file the config names instead of .claude/.env', () => {
    const project = scratch()
    writeFileSync(join(project, 'jira.env'), 'JIRA_PAT=named\nJIRA_QA=qa.login')
    const { env, files } = resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {}, envFile: 'jira.env', config: { baseUrl: 'https://j.example', allowlist: ['PROJ'] } })
    assert.equal(env.qa, 'qa.login')
    assert.equal(files.project.found, true)
  })

  it('names the missing token in an EnvError, and the file it looked in', () => {
    const project = scratch()
    try {
      resolveEnv({ projectDir: project, homeDir: scratch(), processEnv: {}, config: { baseUrl: 'https://j.example', allowlist: ['PROJ'] } })
      assert.fail('should throw')
    } catch (error) {
      assert.ok(error instanceof EnvError)
      assert.deepEqual(error.missing, ['JIRA_PAT'])
      assert.match(error.message, /\.claude\/\.env/)
    }
  })
})
