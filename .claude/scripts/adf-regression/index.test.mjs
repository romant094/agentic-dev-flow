import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRegressionSet } from './index.mjs'

// `index.mjs` resolves each sibling script with a specifier relative to its own module
// URL, not to whatever `list` was told to scan. To exercise a real check() without ever
// writing a fixture into this directory (a fixture left here becomes a real regression
// check that /opsx:verify would run), every fixture lives in a temp directory outside the
// repository, and the filename handed to `list`/`runRegressionSet` is the relative path
// that reaches it from here.
const regressionDir = dirname(fileURLToPath(import.meta.url))

async function withFixtures(files, run) {
  const dir = await mkdtemp(join(tmpdir(), 'adf-regression-fixtures-'))
  try {
    const relNames = []
    for (const [name, source] of Object.entries(files)) {
      const fullPath = join(dir, name)
      await writeFile(fullPath, source)
      relNames.push(relative(regressionDir, fullPath))
    }
    await run(relNames)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('an empty directory returns no items, which is a PASS rather than a skipped check', async () => {
  const results = await runRegressionSet({ read: async () => '', list: async () => [] })
  assert.deepEqual(results, [])
})

test('excludes index.mjs itself from the set it runs', async () => {
  const results = await runRegressionSet({ read: async () => '', list: async () => ['index.mjs'] })
  assert.equal(
    results.find((r) => r.name === 'index.mjs'),
    undefined
  )
  assert.deepEqual(results, [])
})

test('excludes *.test.mjs files from the set it runs, so its own test suite is never a check', async () => {
  // No fixture backs this name; if it were attempted, import would throw and the file
  // would show up as a failed item instead of being absent from the results entirely.
  const results = await runRegressionSet({ read: async () => '', list: async () => ['sneaky.test.mjs'] })
  assert.deepEqual(results, [])
})

test('reports a passing script with its meta intact', async () => {
  await withFixtures(
    {
      'good.mjs': `
        export const meta = { incident: 'INC-1', lastFired: '2026-01-01' }
        export async function check() { return { ok: true, detail: 'all clear' } }
      `
    },
    async ([goodName]) => {
      const results = await runRegressionSet({ read: async () => '', list: async () => [goodName] })
      assert.deepEqual(results, [
        { name: goodName, ok: true, detail: 'all clear', incident: 'INC-1', lastFired: '2026-01-01' }
      ])
    }
  )
})

test('isolates a script whose check() throws: it fails with its error, a sibling still runs and still passes', async () => {
  await withFixtures(
    {
      'broken.mjs': `
        export const meta = { incident: 'INC-2', lastFired: null }
        export async function check() { throw new Error('boom') }
      `,
      'sibling.mjs': `
        export const meta = { incident: 'INC-3', lastFired: null }
        export async function check() { return { ok: true, detail: 'sibling is fine' } }
      `
    },
    async ([brokenName, siblingName]) => {
      const results = await runRegressionSet({ read: async () => '', list: async () => [brokenName, siblingName] })

      const broken = results.find((r) => r.name === brokenName)
      assert.equal(broken.ok, false)
      assert.match(broken.detail, /script failed to run: boom/)
      assert.equal(broken.incident, null)
      assert.equal(broken.lastFired, null)

      const sibling = results.find((r) => r.name === siblingName)
      assert.deepEqual(sibling, {
        name: siblingName,
        ok: true,
        detail: 'sibling is fine',
        incident: 'INC-3',
        lastFired: null
      })
    }
  )
})

test('does not crash on a script with missing meta', async () => {
  await withFixtures(
    {
      'no-meta.mjs': `
        export async function check() { return { ok: true, detail: 'no meta exported' } }
      `
    },
    async ([name]) => {
      const results = await runRegressionSet({ read: async () => '', list: async () => [name] })
      assert.deepEqual(results, [{ name, ok: true, detail: 'no meta exported', incident: null, lastFired: null }])
    }
  )
})

test('does not crash on a script with a malformed meta export', async () => {
  await withFixtures(
    {
      'bad-meta.mjs': `
        export const meta = 'not an object'
        export async function check() { return { ok: true, detail: 'still ran' } }
      `
    },
    async ([name]) => {
      const results = await runRegressionSet({ read: async () => '', list: async () => [name] })
      assert.equal(results.length, 1)
      assert.equal(results[0].ok, true)
      assert.equal(results[0].detail, 'still ran')
    }
  )
})
