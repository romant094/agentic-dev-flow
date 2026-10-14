import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..')

// Creating a symbolic link needs a privilege on Windows; the letter-case half of the guard is
// the system's own resolution there.
test('a CLI started through a symbolic link still runs', { skip: process.platform === 'win32' }, () => {
  const link = join(mkdtempSync(join(tmpdir(), 'adf-link-')), 'scripts')
  symlinkSync(scripts, link, 'dir')
  const out = spawnSync('node', [join(link, 'forge.mjs'), 'nope'], { encoding: 'utf8', cwd: tmpdir() }).stdout.trim()
  assert.ok(out.startsWith('{'), `no output through the link: "${out}"`)
})

test('importing a CLI module does not run it', async () => {
  const { run } = await import('../forge.mjs')
  assert.equal(typeof run, 'function')
})
