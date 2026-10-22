// lib/replay-drive.mjs on the fixture origin of replay-fixture.mjs: the fresh mode takes the change
// through the port's propose, apply, verify, review, archive (and one resume of it) and land, every
// phase starting from what the one before it left; the mid-flight mode starts from the origin's
// own propose commit and Draft and ends with exactly one `adf:` block in the merge request. The
// origin is unchanged after both.
//
// The opt-in live run (ADF_ORIGIN set) drives the candidates named at run time, never in this
// file: ADF_REPLAY_FRESH and ADF_REPLAY_MID are comma-separated change names, ADF_AUTHOR the
// developer the candidates are found for. It asserts only that the origin is unchanged; the run
// records stay under the sandbox (its path is printed), and are copied to ADF_REPLAY_OUT when set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createSandbox } from '../lib/sandbox.mjs'
import { findCandidates } from '../lib/replay-candidates.mjs'
import { buildReplies } from '../lib/replay-replies.mjs'
import { ORDER, PLUGINS } from '../lib/replay-host.mjs'
import { draftCheck, drive, driveMidFlight, runReport, writeRunRecord } from '../lib/replay-drive.mjs'
import { originPlaceholder } from '../../../plugins/adf-gitlab/scripts/lib/forge.mjs'
import { ARCHIVED, BRANCH, CHANGE, DEV, fixtureOrigin } from './replay-fixture.mjs'

const F = fixtureOrigin()
const snapshot = (dir) => {
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' })
  return { refs: git('for-each-ref'), status: git('status', '--porcelain'), stash: git('stash', 'list'), head: git('rev-parse', 'HEAD') }
}

// The registry of the test: the real plugins by path, with fixture values in place of the
// recorded ones (as replay-host.spec.mjs).
const REGISTRY = ORDER.map((name) => ({
  name,
  path: join(PLUGINS, name),
  config: { 'adf-postgres': { prefix: 't', url: { file: '.env', key: 'DATABASE_URL' }, exec: 'local' }, 'adf-jira': { baseUrl: 'https://jira.example.invalid', allowlist: ['K'] } }[name] ?? null,
  notes: []
}))

function withRun(mode, fn) {
  const [candidate] = findCandidates(F.dir, { author: DEV.name, since: F.base })
  const sandbox = createSandbox({ origin: F.dir })
  try {
    const replies = buildReplies(sandbox, candidate)
    const record = mode === 'fresh' ? drive(sandbox, candidate, replies, { host: { registry: REGISTRY } }) : driveMidFlight(sandbox, candidate, replies, { host: { registry: REGISTRY } })
    fn(record, sandbox, candidate)
  } finally {
    sandbox.destroy()
  }
}

const gitIn = (sandbox, cwd) => (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, env: sandbox.env, encoding: 'utf8' }).trim()
const blocked = (record) => record.steps.filter((s) => s.classification.some((c) => c.kind === 'blocked'))
const injected = (record, re) => record.steps.filter((s) => s.classification.some((c) => c.kind === 'injected' && re.test(c.why)))

test('fresh: the change goes through every phase of the port, each from what the last one left, and a resumed archive gives the same result', { timeout: 300_000 }, () => {
  const before = snapshot(F.dir)
  withRun('fresh', (r, sandbox) => {
    assert.deepEqual(Object.keys(r.phases), ['host', 'propose', 'apply', 'verify', 'review', 'archive', 'land'])
    for (const [phase, state] of Object.entries(r.phases)) assert.equal(state.reached, true, `${phase}: ${JSON.stringify(state.stopped)}\n${runReport(r)}`)
    assert.deepEqual(blocked(r).map((s) => s.n), [], runReport(r))
    assert.deepEqual(r.resume, { next: null, same: true, complete: true })

    // Each step carries the command, its exit, its JSON and its refusal.
    const scripts = r.steps.filter((s) => s.command)
    assert.ok(scripts.every((s) => typeof s.exit === 'number' && 'refusal' in s && s.command.startsWith('node ')))
    assert.ok(scripts.every((s) => !s.command.includes(sandbox.root) && s.cwd.startsWith('<S>/')), 'paths are shown as <S>')
    const commands = scripts.map((s) => s.command.split(' ').slice(1, 3).join(' '))
    for (const c of ['preflight.mjs --phase', 'scope.mjs gather', 'workspace.mjs suggest', 'propose.mjs create', 'propose.mjs commit', 'forge.mjs open', 'plan.mjs schedule', 'workspace.mjs group-add', 'guard.mjs snapshot', 'suite.mjs covering', 'tasks.mjs tick', 'workspace.mjs group-merge', 'workspace.mjs group-finish', 'suite.mjs run', 'verify.mjs run', 'verify.mjs assemble', 'review.mjs start', 'review.mjs fix', 'review.mjs assemble', 'archive.mjs placements', 'archive.mjs merge', 'ingest.mjs stale', 'archive.mjs ingest', 'archive.mjs mr', 'archive.mjs remove', 'land.mjs check']) {
      assert.ok(commands.includes(c), `no ${c}`)
    }

    // What the phases left: the branch with its commits by phase, the archive, the main spec.
    const main = join(sandbox.root, r.as, 'main')
    const git = gitIn(sandbox, main)
    const subjects = git('log', '--first-parent', '--format=%s', `origin/develop..${BRANCH}`).split('\n').reverse()
    assert.equal(subjects[0], `docs(openspec): propose ${CHANGE}`)
    for (const s of [`Merge branch '${BRANCH}--group-1' into ${BRANCH}`, `Merge branch '${BRANCH}--group-2' into ${BRANCH}`, `docs(openspec): verify ${CHANGE}`, 'fix(x): two in the empty case', `docs(openspec): review ${CHANGE}`, `docs(specs): archive ${CHANGE}`, `docs(memory): ingest what ${CHANGE} taught`, `chore(metrics): record ${CHANGE}`]) {
      assert.ok(subjects.includes(s), `${s} not in\n${subjects.join('\n')}`)
    }
    assert.ok(subjects.indexOf(`docs(openspec): verify ${CHANGE}`) < subjects.indexOf(`docs(openspec): review ${CHANGE}`))
    const archived = git('ls-tree', '-r', '--name-only', BRANCH, '--', 'openspec/changes/archive/').split('\n')
    assert.ok(archived.some((f) => /\/\d{4}-\d{2}-\d{2}-add-thing\/ledger\.jsonl$/.test(f)), archived.join('\n'))
    assert.ok(!archived.some((f) => f.includes(ARCHIVED)), 'the archive date is the replay\'s clock')
    assert.match(git('show', `${BRANCH}:openspec/specs/cap/spec.md`), /The system SHALL do the thing twice\./)
    assert.match(git('show', `${BRANCH}:.claude/memory/concepts/a.md`), /most plausibly get wrong/)
    assert.ok(!existsSync(join(main, '.claude', 'worktrees', CHANGE)), 'archive removed the worktree')

    // The merge request: a Draft at propose, finalized at archive with one block, merged at land.
    const mr = JSON.parse(readFileSync(sandbox.forge, 'utf8'))[r.as].mrs
    assert.equal(mr.length, 1)
    assert.equal(mr[0].source_branch, BRANCH)
    assert.equal(mr[0].state, 'merged')
    assert.equal(draftCheck(mr[0].description, CHANGE).ok, true, mr[0].description)
    const glab = sandbox.calls('glab').map((c) => c.argv.slice(0, 2).join(' '))
    assert.ok(glab.indexOf('mr create') < glab.indexOf('mr update'))
    assert.ok(sandbox.calls('glab').find((c) => c.argv[1] === 'create').argv.includes('--draft'))
    assert.ok(sandbox.calls('glab').find((c) => c.argv[1] === 'update').argv.includes('--ready'))

    // The land phase: the tracker was skipped at propose, so land is skipped.
    const check = r.steps.find((s) => s.command?.startsWith('node land.mjs check'))
    assert.equal(check.result.state, 'skipped')

    // What the replay had to supply is marked.
    assert.ok(injected(r, /category and title are injected/).length === 1, 'ai-review r1 has no category or title in the record')
    assert.ok(injected(r, /origin's merge request body is not in git/).length === 1)
    assert.deepEqual(r.differences.map((d) => d.phase), ['propose'], JSON.stringify(r.differences))
    assert.match(r.differences[0].what, /suggest proposes feat\/add-thing; the developer's answer is the origin's feat\/K-1\/add-thing/)

    const file = writeRunRecord(sandbox, r)
    assert.equal(basename(file), `${r.as}.json`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps.length, r.steps.length)
  })
  assert.deepEqual(snapshot(F.dir), before)
})

test('mid-flight: the origin\'s propose commit and Draft continued by the port; finalize leaves one adf: block and no placeholder', { timeout: 300_000 }, () => {
  const before = snapshot(F.dir)
  withRun('mid', (r, sandbox) => {
    assert.deepEqual(Object.keys(r.phases), ['host', 'apply', 'verify', 'review', 'archive'])
    for (const [phase, state] of Object.entries(r.phases)) assert.equal(state.reached, true, `${phase}: ${JSON.stringify(state.stopped)}\n${runReport(r)}`)
    assert.equal(r.proposeCommit, F.propose)
    assert.match(r.pin, /^schema: sdd-plus-superpowers$/m)
    const git = gitIn(sandbox, join(sandbox.root, r.as, 'main'))
    git('merge-base', '--is-ancestor', F.propose, BRANCH)
    assert.match(git('show', `${BRANCH}:openspec/changes/archive/${git('ls-tree', '--name-only', `${BRANCH}:openspec/changes/archive/`).split('\n').find((d) => d.endsWith(CHANGE))}/.openspec.yaml`), /sdd-plus-superpowers/)

    // The port refuses an origin change with no .adf.json: recorded, then worked around.
    const probe = r.steps.find((s) => s.phase === 'apply' && s.command?.startsWith('node preflight.mjs'))
    assert.match(probe.refusal, /\.adf\.json/)
    assert.ok(probe.classification.some((c) => c.kind === 'blocked'))
    assert.ok(r.differences.some((d) => /no \.adf\.json/.test(d.what)))
    assert.ok(injected(r, /cannot continue an origin change without \.adf\.json/).length === 1)

    // The Draft as the origin opened it, finalized by the port.
    assert.deepEqual({ ...r.draft, description: undefined }, { iid: 1, draft: false, adfBlocks: 1, opsxBlocks: 0, placeholder: false, ok: true, description: undefined })
    assert.ok(!r.draft.description.includes(originPlaceholder(CHANGE)))
    assert.equal(r.resume.same, true)
  })
  assert.deepEqual(snapshot(F.dir), before)
})

test('draftCheck: one adf: block, no opsx: block and no placeholder', () => {
  const block = (m) => `<!-- ${m}:${CHANGE} -->\nx\n<!-- /${m}:${CHANGE} -->`
  assert.equal(draftCheck(block('adf'), CHANGE).ok, true)
  assert.equal(draftCheck(`${block('adf')}\n${block('adf')}`, CHANGE).ok, false)
  assert.equal(draftCheck(`${block('opsx')}\n${block('adf')}`, CHANGE).ok, false)
  assert.equal(draftCheck(`${originPlaceholder(CHANGE)}\n\n${block('adf')}`, CHANGE).placeholder, true)
  assert.equal(draftCheck('', CHANGE).adfBlocks, 0)
})

// ---------------------------------------------------------------- live

const LIVE = process.env.ADF_ORIGIN
const names = (key) => (process.env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
test('live: the named candidates driven fresh and mid-flight; the origin unchanged', { skip: !LIVE && 'ADF_ORIGIN is not set', timeout: 3_600_000 }, (t) => {
  const fresh = names('ADF_REPLAY_FRESH')
  const mid = names('ADF_REPLAY_MID')
  assert.ok(fresh.length + mid.length > 0, 'name the candidates in ADF_REPLAY_FRESH and ADF_REPLAY_MID')
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', LIVE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim()
  const before = snapshot(LIVE)
  const since = git('log', '--first-parent', 'origin/develop', '-1', '--format=%H', '--', 'openspec/schemas', '.claude/commands/opsx', '.claude/scripts')
  const found = findCandidates(LIVE, { author: process.env.ADF_AUTHOR ?? git('config', 'user.name'), since, names: [...new Set([...fresh, ...mid])] })
  const sandbox = createSandbox({ origin: LIVE })
  t.diagnostic(`sandbox ${sandbox.root} (kept for the comparison)`)
  const out = process.env.ADF_REPLAY_OUT
  if (out) mkdirSync(out, { recursive: true })
  for (const [mode, list] of [['fresh', fresh], ['mid', mid]]) {
    for (const name of list) {
      const candidate = found.find((c) => c.name === name || c.dir === name)
      const replies = buildReplies(sandbox, candidate)
      const record = mode === 'fresh' ? drive(sandbox, candidate, replies) : driveMidFlight(sandbox, candidate, replies)
      const file = writeRunRecord(sandbox, record)
      if (out) copyFileSync(file, join(out, basename(file)))
      t.diagnostic(runReport(record))
    }
  }
  assert.deepEqual(snapshot(LIVE), before)
})
