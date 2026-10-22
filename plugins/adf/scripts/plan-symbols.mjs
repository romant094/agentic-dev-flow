#!/usr/bin/env node
// CLI over lib/plan-symbols-repo.mjs: checks that what a change's plan.md names exists in the
// host repository. Prints one JSON object on stdout, { ok, findings, error? }.
//
//   plan-symbols.mjs <change-name> [--root <dir>] [--phase propose|apply]
//
// --root names the host repository (default: `git rev-parse --show-toplevel` of the cwd); the
// plan is <root>/openspec/changes/<change-name>/plan.md. --phase apply skips ticked tasks and
// exempts what the branch already did since its base, read from the change's metadata.
//
// Exit codes: 0 no findings, 1 findings, 2 usage error, no plan.md, or the check could not run.
import { isMain } from './lib/main.mjs'
import { runPlanSymbols } from './lib/plan-symbols-repo.mjs'

export const run = runPlanSymbols

if (isMain(import.meta.url)) {
  const { code, result } = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = code
}
