// subagent-driven-development resolves its scratch workspace from the plan file's basename,
// and every change's plan is `plan.md` — so every change resolves to `.superpowers/sdd/plan/`.
// A controller reading a previous change's ledger as its own progress skips completed work.
//
// The rule that prevents it: create `.superpowers/sdd/<change-name>/` before the first
// dispatch and pass explicit output paths to task-brief and review-package. This check does
// not re-decide that rule — it stops the rule from depending on whether an agent read it.
//
// Paths here are relative to the host project's root; the caller's `read` and `list` resolve
// them.

export const ROOT = '.superpowers/sdd'
export const LEGACY = 'plan'

// A ledger's first line names the plan it belongs to.
export const planOf = (text) => {
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
    // closed on. Swallowing every error would switch the guard off on exactly the
    // misconfigured runner where it matters.
    if (e.code === 'ENOENT') return { ok: true, foreign: null }
    return { ok: false, foreign: { path, plan: null, unreadable: e.code ?? 'unknown' } }
  }

  // A ledger whose first line does not name a plan is the foreign ledger this check exists
  // for — one written by a version of the skill with a different header. Fail closed: an
  // unidentifiable ledger is exactly what must not be read as this change's own progress.
  const plan = planOf(ledger)
  if (!plan) return { ok: false, foreign: { path, plan: null } }
  if (plan.includes(`/${changeName}/`)) return { ok: true, foreign: null }

  return { ok: false, foreign: { path, plan } }
}

// The refusal for a foreign ledger, one sentence per line.
export function stopMessage(changeName, foreign) {
  return [
    foreign.plan
      ? `STOP: ${foreign.path} holds a ledger belonging to ${foreign.plan}.`
      : `STOP: ${foreign.path} holds a ledger whose owning plan its first line does not name.`,
    'Reading it as this change progress would skip work that was never done here.',
    `Move it aside, then use ${ROOT}/${changeName}/ for this change,`,
    'passing explicit output paths to task-brief and review-package.'
  ]
}
