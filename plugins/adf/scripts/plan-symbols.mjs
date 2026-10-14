#!/usr/bin/env node
// CLI over lib/plan-symbols.mjs: checks that what a change's plan.md names exists in the host
// repository. Prints one JSON object on stdout, { ok, findings, error? }.
//
//   plan-symbols.mjs <change-name> [--root <dir>] [--phase propose|apply]
//
// --root names the host repository (default: `git rev-parse --show-toplevel` of the cwd); the
// plan is <root>/openspec/changes/<change-name>/plan.md. --phase apply skips ticked tasks and
// exempts what the branch already did since its base, read from the change's .adf.json.
//
// Exit codes: 0 no findings, 1 findings, 2 usage error, no plan.md, or the check could not run.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { META_FILE } from './lib/changes.mjs'
import { baseRef, checkPlanSymbols, parseArgs, parseNameStatus } from './lib/plan-symbols.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: plan-symbols.mjs <change-name> [--root <dir>] [--phase propose|apply]  (outside a git repository, --root is required)'

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export async function run(argv) {
  const fail = (error) => ({ code: 2, result: { ok: false, findings: [], error } })
  const parsed = parseArgs(argv, () => git(['rev-parse', '--show-toplevel']).trim())
  if (!parsed) return fail(USAGE)
  const { changeName, phase, root } = parsed
  if (!existsSync(root)) return fail(`repository ${root} does not exist`)
  const dir = `openspec/changes/${changeName}`
  if (!existsSync(resolve(root, dir, 'plan.md'))) return fail(`${dir}/plan.md does not exist`)

  const inRoot = (args) => git(['-C', root, ...args])
  let ref
  if (phase === 'apply') {
    let meta = null
    try {
      meta = JSON.parse(readFileSync(resolve(root, dir, META_FILE), 'utf8'))
    } catch {
      // no or unreadable metadata: baseRef reports the missing base
    }
    try {
      ref = baseRef(meta, (name) => {
        try {
          inRoot(['rev-parse', '--verify', '--quiet', name])
          return true
        } catch {
          return false
        }
      })
    } catch (error) {
      return fail(error.message)
    }
  }

  const at = (f) => resolve(root, f)
  try {
    const findings = await checkPlanSymbols({
      changeName,
      phase,
      read: (f) => readFileSync(at(f), 'utf8'),
      exists: (f) => existsSync(at(f)),
      lineCount: (f) => {
        const text = readFileSync(at(f), 'utf8')
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
      },
      grep: async (symbol) => {
        try {
          // The plans name every symbol they consume, so the change records are excluded.
          return (
            inRoot(['grep', '-w', '-l', '-F', '-e', symbol, '--', '.', ':!openspec/changes', ':!.superpowers']).trim() !== ''
          )
        } catch (e) {
          if (e.status === 1) return false
          throw e
        }
      },
      branchChanges: async () => {
        const base = inRoot(['merge-base', ref, 'HEAD']).trim()
        return parseNameStatus(inRoot(['diff', '--name-status', `${base}..HEAD`]))
      }
    })
    return { code: findings.length ? 1 : 0, result: { ok: findings.length === 0, findings } }
  } catch (error) {
    return fail(error.message.trim())
  }
}

if (isMain(import.meta.url)) {
  const { code, result } = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = code
}
