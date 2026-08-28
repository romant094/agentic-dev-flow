// .claude/scripts/adf-regression/index.mjs
// One script per confirmed flow defect. A defect caught by a script is caught
// deterministically and costs no agent context; a defect caught by prose is caught only if
// an agent reads and honours the paragraph — which is precisely what failed for the
// execution graph requirement that already existed and produced nothing.
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const regressionDir = dirname(fileURLToPath(import.meta.url))

export async function runRegressionSet({ read, list }) {
  // Excludes index.mjs itself and any `*.test.mjs` file, so this directory's own test
  // suite (which must live alongside index.mjs, like every other script's test file in
  // this repository) is never picked up as a regression check.
  const files = (await list(regressionDir))
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'index.mjs')
    .sort()
  const results = []
  for (const file of files) {
    try {
      const mod = await import(`./${file}`)
      const meta = mod.meta ?? {}
      const { ok, detail } = await mod.check({ read, list })
      results.push({
        name: file,
        ok,
        detail,
        incident: meta.incident ?? null,
        lastFired: meta.lastFired ?? null
      })
    } catch (err) {
      results.push({
        name: file,
        ok: false,
        detail: `script failed to run: ${err.message}`,
        incident: null,
        lastFired: null
      })
    }
  }
  return results
}
