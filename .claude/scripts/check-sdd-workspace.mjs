#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// subagent-driven-development resolves its scratch workspace from the plan file's
// basename, and every change's plan here is `plan.md` — so every change resolves to
// `.superpowers/sdd/plan/`. A controller reading a previous change's ledger as its own
// progress skips completed work; this has recurred three times.
//
// The rule that prevents it is recorded in .claude/memory/concepts/opsx-workflow.md:
// create `.superpowers/sdd/<change-name>/` before the first dispatch and pass explicit
// output paths to task-brief and review-package. This script does not re-decide that
// rule — it stops the rule from depending on whether an agent read the memory.

const ROOT = '.superpowers/sdd'
const LEGACY = 'plan'

// A ledger's first line names the plan it belongs to.
const planOf = (text) => {
  const m = /^#\s*SDD ledger\s*[—-]\s*plan:\s*(\S+)/m.exec(text)
  return m ? m[1] : null
}

export function checkSddWorkspace({ changeName, read, list }) {
  let entries
  try {
    entries = list(ROOT)
  } catch {
    return { ok: true, foreign: null }
  }
  if (!entries.includes(LEGACY)) return { ok: true, foreign: null }

  const path = `${ROOT}/${LEGACY}`
  let ledger
  try {
    ledger = read(`${path}/progress.md`)
  } catch (e) {
    // Only "the file is not there" means there is no ledger. Any other read error — a
    // permission problem, an I/O fault, a directory where the file should be — leaves a
    // ledger that may exist and cannot be identified, which is the case this check fails
    // closed on. Swallowing every error made the guard switch itself off on exactly the
    // misconfigured runner where it matters.
    if (e.code === 'ENOENT') return { ok: true, foreign: null }
    return { ok: false, foreign: { path, plan: null, unreadable: e.code ?? 'unknown' } }
  }

  // A ledger whose first line does not name a plan is the foreign ledger this check
  // exists for — one written by a version of the skill with a different header. Fail
  // closed: an unidentifiable ledger is exactly what must not be read as this change's
  // own progress.
  const plan = planOf(ledger)
  if (!plan) return { ok: false, foreign: { path, plan: null } }
  if (plan.includes(`/${changeName}/`)) return { ok: true, foreign: null }

  return { ok: false, foreign: { path, plan } }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const changeName = process.argv[2]
  if (!changeName) {
    console.error('usage: check-sdd-workspace.mjs <change-name>')
    process.exit(2)
  }
  const { ok, foreign } = checkSddWorkspace({
    changeName,
    read: (f) => readFileSync(f, 'utf8'),
    list: (d) => readdirSync(d)
  })
  if (!ok) {
    console.error(
      foreign.plan
        ? `STOP: ${foreign.path} holds a ledger belonging to ${foreign.plan}.`
        : `STOP: ${foreign.path} holds a ledger whose owning plan its first line does not name.`
    )
    console.error('Reading it as this change progress would skip work that was never done here.')
    console.error(`Move it aside, then use .superpowers/sdd/${changeName}/ for this change,`)
    console.error('passing explicit output paths to task-brief and review-package.')
    process.exit(1)
  }
}
