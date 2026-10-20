// The core's plugin.json names the repository its findings and ADF debt are filed in, and the
// retrospective's `file` step reads `owner/name` from it; the host a retrospective files from is
// its `origin` remote's `owner/name`, else its root directory's name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreRepository, hostSlug, slugOf } from '../lib/roles.mjs'

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json')

test('the core manifest names its repository, read as owner/name', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(manifest.repository, 'https://github.com/romant094/agentic-dev-flow')
  assert.equal(coreRepository(), 'romant094/agentic-dev-flow')
  assert.equal(coreRepository({ repository: 'git@github.com:o/r.git' }), 'o/r')
  assert.throws(() => coreRepository({ name: 'adf' }), /the core's plugin\.json names no repository URL \(repository: null\)/)
  assert.throws(() => coreRepository({ repository: 'adf' }), /names no repository URL/)
})

test('slugOf reads the owner/name path of an https or ssh remote, and nothing else', () => {
  for (const [url, slug] of [
    ['https://github.com/o/r', 'o/r'],
    ['https://github.com/o/r.git', 'o/r'],
    ['https://user@gitlab.example.com/group/sub/r.git/', 'group/sub/r'],
    ['http://h/o/r', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['github.com:o/r', 'o/r'],
    ['ssh://git@gitlab.example.com:2222/o/r.git', 'o/r'],
    ['/tmp/remote.git', null],
    ['file:///tmp/o/r.git', null],
    ['https://github.com/r', null],
    ['', null],
    [undefined, null]
  ]) {
    assert.equal(slugOf(url), slug, String(url))
  }
})

test('hostSlug: the origin remote slug over ssh or https, else the root directory name', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-host-slug-')))
  const root = join(top, 'my-host')
  execFileSync('git', ['init', '-q', root])
  assert.equal(hostSlug(root), 'my-host', 'no origin')
  execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.example.com:team/app.git'], { cwd: root })
  assert.equal(hostSlug(root), 'team/app')
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/team/web.git'], { cwd: root })
  assert.equal(hostSlug(root), 'team/web')
  execFileSync('git', ['remote', 'set-url', 'origin', join(top, 'remote.git')], { cwd: root })
  assert.equal(hostSlug(root), 'my-host', 'a local path is no slug')
  assert.equal(hostSlug(join(top, 'not-a-repo')), 'not-a-repo')
})
