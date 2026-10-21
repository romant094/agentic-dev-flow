import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeSources, isStale, profilePaths, readDiscovered, writeDiscovered } from '../lib/profile.mjs'

const facts = {
  discoveredAt: '2026-09-01T10:00:00.000+03:00',
  instance: { baseUrl: 'https://jira.example.com', version: '8.20.2', deploymentType: 'Server' },
  project: { key: 'PROJ', name: 'Example Project' },
  issueTypes: [],
  fieldMap: { 'Epic Link': 'customfield_10800' },
  workflow: {},
  unsampledStatuses: [],
  permissions: { CREATE_ISSUE: true }
}

describe('profilePaths', () => {
  it('places all three layers under .claude/jira/profile', () => {
    const paths = profilePaths('/repo')
    assert.equal(paths.discovered, '/repo/.claude/jira/profile/discovered.json')
    assert.equal(paths.conventions, '/repo/.claude/jira/profile/conventions.md')
    assert.equal(paths.local, '/repo/.claude/jira/profile/local.md')
  })

  it('places them under the configured profile directory instead', () => {
    assert.equal(profilePaths('/repo', 'tools/jira').discovered, '/repo/tools/jira/discovered.json')
  })
})

describe('discovered.json round trip', () => {
  it('returns null when no profile has been written yet', () => {
    assert.equal(readDiscovered(mkdtempSync(join(tmpdir(), 'jira-prof-'))), null)
  })

  it('writes then reads the same facts, creating directories as needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-prof-'))
    writeDiscovered(dir, facts)
    assert.deepEqual(readDiscovered(dir), facts)
  })

  it('writes readable JSON rather than one line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-prof-'))
    writeDiscovered(dir, facts)
    assert.ok(readFileSync(profilePaths(dir).discovered, 'utf8').includes('\n  "instance"'))
  })
})

describe('isStale', () => {
  it('is false inside the window', () => {
    assert.equal(isStale(facts, new Date('2026-09-05T10:00:00+03:00'), 7), false)
  })

  it('is true past the window', () => {
    assert.equal(isStale(facts, new Date('2026-09-20T10:00:00+03:00'), 7), true)
  })
})

describe('describeSources', () => {
  it('reports layer and length and never a value', () => {
    const text = describeSources([
      { key: 'JIRA_PAT', layer: 'project', length: 44 },
      { key: 'JIRA_URL', layer: 'process', length: 25 }
    ])
    assert.ok(text.includes('JIRA_PAT'))
    assert.ok(text.includes('project'))
    assert.ok(text.includes('44'))
    assert.doesNotMatch(text, /=/)
  })
})
