// lib/plan-symbols-repo.mjs: the plan symbol check bound to a repository on disk, which the
// plan-symbols CLI and preflight share (a library imports libraries only).
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runPlanSymbols, USAGE } from '../lib/plan-symbols-repo.mjs'
import { run } from '../plan-symbols.mjs'
import { host } from './git-host.mjs'

test('the CLI is the library runner: findings, a missing plan, a usage error', async () => {
  assert.equal(run, runPlanSymbols)
  const { change } = host({ 'plan.md': '# Plan\n\n### Task 1: x\n\n**Files:**\n- Modify: `src/none.ts`\n' })
  const found = await runPlanSymbols(['add-x', '--root', change])
  assert.equal(found.code, 1)
  assert.equal(found.result.findings.length > 0, true)
  assert.deepEqual(await runPlanSymbols(['other', '--root', change]), { code: 2, result: { ok: false, findings: [], error: 'openspec/changes/other/plan.md does not exist' } })
  assert.deepEqual(await runPlanSymbols([]), { code: 2, result: { ok: false, findings: [], error: USAGE } })
})
