// What a phase checks before its first step of work, in one call: the Superpowers gate, where
// the phase runs, the branch it would commit to, the change's artifact state, and for apply the
// SDD workspace and the plan symbol check; then the phase's session record. Each check calls the
// library the separate script used to be run for, so a check behaves as it did in that script.
//
// A guard reads git and fails closed: a failed read is a refusal. A failed `rev-parse` once gave
// an empty branch name, and the protected-branch guard passed on it.
//
// propose runs in the main checkout before the change has a worktree: it checks the gate, that
// the root is the main checkout, and the workspace policy inputs (`workspace.mjs suggest`), and
// refuses on uncommitted tracked work. The base and the branch name are the developer's answers;
// the session is recorded in the change worktree, by `propose.mjs create` for a new change and by
// `changes.mjs next` for one continued (lib/ledger.mjs recordSessionOnce), not here: in the main
// checkout the developer has not yet chosen to continue the change.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { applyInstructions, artifactInstructions, changeDir, CHANGES_DIR, META_FILE } from './changes.mjs'
import { checkCommitPlace, Refusal } from './commit.mjs'
import { mainCheckout } from './installed.mjs'
import { appendRecord } from './ledger.mjs'
import { loadSchema } from './schema.mjs'
import { checkSuperpowers } from './superpowers.mjs'
import { runPlanSymbols as planSymbols } from './plan-symbols-repo.mjs'
import { initSdd } from './sdd.mjs'
import { gitIn, suggest } from './workspace.mjs'

export const PHASES = ['propose', 'apply', 'verify', 'review']
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

function readBase(root, change) {
  try {
    const base = JSON.parse(readFileSync(join(changeDir(root, change), META_FILE), 'utf8')).base
    return typeof base === 'string' && base.trim() ? base : null
  } catch {
    return null
  }
}

// Review reads the code verify verified: the verify record's `Verdict:` line is not FAIL, the
// record is committed, and no commit after the one that last wrote it touches a path outside the
// change directory. The record's verdict is its last `Verdict:` line, the one assemble writes.
export const VERDICT_LINE = /^Verdict: (PASS WITH WARNINGS|PASS|FAIL)[ \t]*$/gm

function verifiedCode(root, change, git) {
  const record = `${CHANGES_DIR}/${change}/verify.md`
  const verdict = [...readFileSync(join(root, record), 'utf8').matchAll(VERDICT_LINE)].at(-1)?.[1] ?? null
  if (!verdict) return { refusal: `${record} has no Verdict: line; run /adf:verify ${change} again.` }
  if (verdict === 'FAIL') return { verify: { verdict }, refusal: `${record} says Verdict: FAIL; fix what it names and run /adf:verify ${change} before the review.` }
  let commit
  let after
  try {
    commit = git('log', '-1', '--format=%H', '--', record)
    after = commit ? git('log', '--no-renames', '--name-only', '--format=%x1e%H', `${commit}..HEAD`) : ''
  } catch (error) {
    return { refusal: `git failed to read the history of ${record} (${String(error.stderr || error.message).trim()}); check the worktree and run again.` }
  }
  if (!commit) return { verify: { verdict }, refusal: `${record} is not committed; run /adf:verify ${change} to assemble and commit it.` }
  const prefix = `${CHANGES_DIR}/${change}/`
  const outside = []
  for (const chunk of after.split('\x1e').map((c) => c.trim()).filter(Boolean)) {
    const [sha, ...files] = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (files.some((f) => !f.startsWith(prefix))) outside.push(sha.slice(0, 7))
  }
  if (outside.length > 0) {
    return { verify: { verdict, commit }, refusal: `commit(s) ${outside.join(', ')} after the verify record touch files outside ${prefix}: the code changed since it was verified; run /adf:verify ${change} again.` }
  }
  return { verify: { verdict, commit } }
}

async function changePhase(out, { phase, change, root, env, schema, git }) {
  const stop = (refusal) => ({ ...out, ok: false, refusal })
  let place
  try {
    place = checkCommitPlace(root, { git })
  } catch (error) {
    if (error instanceof Refusal) return stop(`${error.message}.`)
    throw error
  }
  Object.assign(out, { main: place.main, root: place.root, branch: place.branch, protected: place.protected })
  root = place.root
  if (!existsSync(changeDir(root, change))) {
    return stop(`${root} holds no change "${change}"; select the change and its root from changes.mjs find.`)
  }
  out.base = readBase(root, change)

  const apply = applyInstructions(root, change, schema)
  out.progress = apply.progress
  if (phase === 'apply') {
    out.state = apply.state
    if (apply.state === 'blocked') return stop(`${apply.instruction} Run /adf:propose ${change} to continue its artifacts up to the plan.`)
    if (apply.state === 'all_done') return stop('Every task is complete; run /adf:verify next.')
    const { code, result } = await planSymbols([change, '--root', root, '--phase', 'apply'])
    out.planFindings = result.findings
    if (code === 1) return stop(`The plan names ${result.findings.length} thing(s) the tree does not hold; correct plan.md from planFindings, then run apply again.`)
    if (code !== 0) return stop(`The plan symbol check could not run (${result.error}); fix that, then run apply again.`)
    out.sdd = initSdd(root, change)
    if (!out.sdd.ok) return stop(out.sdd.error)
  } else {
    const missing = artifactInstructions(root, change, phase, schema).dependencies.filter((d) => !d.done).map((d) => d.id)
    out.state = missing.length > 0 ? 'blocked' : 'ready'
    if (missing.length > 0) return stop(`${phase} needs ${missing.join(', ')} done first; run ${missing.includes('verify') ? `/adf:verify ${change}` : `/adf:propose ${change}`} to write it.`)
    if (phase === 'review') {
      const verified = verifiedCode(root, change, git)
      out.verify = verified.verify ?? null
      if (verified.refusal) return stop(verified.refusal)
    }
  }

  // The session record is the ledger's, not a guard: a runtime without a session id still runs
  // the phase, and the result says why nothing was recorded.
  try {
    const { record, path } = appendRecord(root, change, 'session', { phase }, { env })
    out.ledger = { recorded: true, id: record.id, path }
  } catch (error) {
    out.ledger = { recorded: false, error: error.message }
  }
  return { ...out, ok: true }
}

function proposePhase(out, { change, root, git }) {
  const stop = (refusal) => ({ ...out, ok: false, refusal })
  let top
  try {
    top = git('rev-parse', '--show-toplevel')
  } catch (error) {
    return stop(`git failed to read the top level of ${root} (${String(error.stderr || error.message).trim()}); run propose in the project's git checkout.`)
  }
  if (!top || realpathSync(top) !== realpathSync(root)) {
    return stop(`${root} is not the top level of its working tree (${top || 'none'}); pass the checkout's top level as the root.`)
  }
  out.root = realpathSync(top)
  if (out.main !== out.root) {
    return stop(`${out.root} is not the main checkout; run propose from ${out.main}, where change worktrees are made.`)
  }
  let s
  try {
    s = suggest(out.root, change, { git })
  } catch (error) {
    return stop(`${error.message}.`)
  }
  Object.assign(out, {
    branch: s.current,
    protected: s.protected,
    workspace: { integration: s.integration, bases: s.bases, type: s.type, branch: s.branch, path: s.path, exists: existsSync(s.path), dirty: s.dirty }
  })
  if (s.dirty.length > 0) {
    return stop(`${s.dirty.length} tracked file(s) have uncommitted changes; show git status to the developer and let them deal with it, never stash or commit for them.`)
  }
  return { ...out, ok: true }
}

export async function preflight({ phase, change, root, env = process.env, home, schema = loadSchema(), git = gitIn(root) }) {
  const out = { ok: false, phase, change, main: null, root, branch: null, protected: null, base: null, state: null, progress: null, sdd: null, ledger: null }
  if (!PHASES.includes(phase)) return { ...out, refusal: `phase "${phase}" is not one of ${PHASES.join(', ')}.` }
  if (!NAME.test(change ?? '')) return { ...out, refusal: `change name "${change}" is not kebab-case; pass the resolved change name, never a placeholder.` }

  if (!existsSync(root)) return { ...out, refusal: `${root} does not exist; pass the change's worktree as the root.` }

  // Claude Code records a project-scope install for the checkout it was installed in, the main
  // checkout, so the gate is read there whatever worktree the phase runs in.
  out.main = realpathSync(mainCheckout(root))
  const gate = checkSuperpowers(out.main, home ? { home } : {})
  if (!gate.ok) return { ...out, refusal: `${gate.reason}; install it with \`${gate.install}\` and run again, and create or modify nothing until then.` }

  return phase === 'propose' ? proposePhase(out, { change, root, git }) : changePhase(out, { phase, change, root, env, schema, git })
}
