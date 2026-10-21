import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMain } from '../lib/main.mjs'

test('isMain is true only for the script node was started with', () => {
  assert.equal(isMain(pathToFileURL(process.argv[1]).href), true)
  assert.equal(isMain(new URL('../lib/main.mjs', import.meta.url).href), false)
  assert.equal(isMain(pathToFileURL(join(tmpdir(), 'no-such-script.mjs')).href), false)
})

