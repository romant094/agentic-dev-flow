// Dev tool: the phase drivers of a replay (iteration 14, steps 5 and 6). A driver runs the port's
// cycle on one origin change in a sandbox candidate, following the commands' own steps: every
// script call is the one the command names, with the same arguments, run with `sandbox.env` and
// its cwd inside the sandbox; every place an agent writes is filled with the reply step 4 built
// (lib/replay-replies.mjs), and the agent's work in the tree (a commit, a page, a body) is done
// from the origin's records.
//
//   drive(sandbox, candidate, replies, { phases, as, host })            fresh mode
//       host setup (lib/replay-host.mjs), then propose, apply, verify, review, archive (with one
//       resume of the finished archive) and land; the port's writers make the branch, the
//       worktree and every commit
//   driveMidFlight(sandbox, candidate, replies, { as, host })
//       starts from the origin's own propose commit on the kept branch (the change directory as
//       the origin committed it, its schema pin `sdd-plus-superpowers` kept), the Draft in the
//       fake glab in the origin's layout (the bare placeholder sentence), then the port's apply
//       to archive; it checks that finalize leaves exactly one `adf:` block and no placeholder
//
// `candidate` is a findCandidates record (lib/replay-candidates.mjs); `replies` the buildReplies
// result for it in the same sandbox. Each phase starts by resolving the change as the command
// does (`changes.mjs find`) and reads only what the phase before it left in the tree, the fake
// glab, the fake Jira and the ledger, plus its own replies.
//
// The run record: { candidate, mode, as, steps, phases, differences, shaMap, ... }. Each step is
// { n, phase, step, command, cwd, exit, result, refusal, classification }; `command` and `cwd`
// show the sandbox as <S> and this repository as <adf>; strings over 4000 characters in a result
// are cut. `classification` holds hints for the comparison (step 7): `injected` when the step
// used a synthesized or a missing reply, or a workaround the driver made; `blocked` when it could
// not continue as the command says. A phase that cannot continue at all is `stopped`, with the
// step and the reason, and no later phase runs. `differences` lists what the driver found the
// port doing otherwise than the origin, each with its evidence.
//
// Nothing here writes outside the sandbox: assertIsolated runs before every phase.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertIsolated, REPO } from './sandbox.mjs'
import { RECORDED_GUIDE, setupHost } from './replay-host.mjs'
import { c8Reply, completeImpl, ingestStaleAnswers, specMergeReply } from './replay-replies.mjs'
import { markerFor, originMarkerFor, originPlaceholder } from '../../../plugins/adf-gitlab/scripts/lib/forge.mjs'
import { parseGraph, taskBody } from '../../../plugins/adf/scripts/lib/dispatch.mjs'
import { parsePlanTasks } from '../../../plugins/adf/scripts/lib/plan-symbols.mjs'
import { isTestFile } from '../../../plugins/adf/scripts/lib/tdd-proof.mjs'

export const PHASES = ['propose', 'apply', 'verify', 'review', 'archive', 'land']
export const MID_FLIGHT_PHASES = ['apply', 'verify', 'review', 'archive']
const CORE = join(REPO, 'plugins', 'adf', 'scripts')
export const SUITE = 'adf-replay-suite'
const ENV_KEY = 'DATABASE_URL'
export const TRACKER_SKIP = 'replay: the origin had no scope step, so the change works without the tracker'
const LONG = 4000

class Stop extends Error {
  constructor(step, reason) {
    super(reason)
    this.step = step
  }
}

// ---------------------------------------------------------------- the environment

// The fake whole-suite command: one passing count line and the fresh-run proof line the recorded
// guide names, each call logged like the other fakes. With a commit id it is a task's covering
// command: it passes only when HEAD is that commit, so the test-first proof's parent run fails
// and its commit run passes, as the origin's task commits proved.
function installSuite(sandbox) {
  const file = join(sandbox.bin, SUITE)
  if (existsSync(file)) return file
  const log = join(sandbox.log, `${SUITE}.jsonl`)
  writeFileSync(file, [
    '#!/bin/sh',
    `printf '{"argv":["%s"],"cwd":"%s"}\\n' "$1" "$PWD" >> '${log}'`,
    'echo "replay suite: a script-level replay runs no test"',
    'if [ -n "$1" ] && [ "$(git rev-parse HEAD 2>/dev/null)" != "$1" ]; then',
    '  echo "not ok 1 - replay: HEAD is not the task commit $1"', "  echo '# tests 1'", "  echo '# pass 0'", "  echo '# fail 1'", '  exit 1',
    'fi',
    "echo 'ok 1 - replay'", "echo '# tests 1'", "echo '# pass 1'", "echo '# fail 0'",
    `echo '${RECORDED_GUIDE.proof.value}'`,
    ''
  ].join('\n'), { mode: 0o755 })
  return file
}

// The Superpowers skill's task-brief and review-package in the sandbox's Superpowers stub, as the
// apply specs' fixture writes them (plugins/adf/scripts/__tests__/git-host.mjs): sdd.mjs and
// group-merge call them, and the stub replay-host installs holds no skill.
function installSkillScripts(sandbox) {
  const installed = JSON.parse(readFileSync(join(sandbox.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), 'utf8'))
  const install = installed.plugins['superpowers@claude-plugins-official'][0].installPath
  const scripts = join(install, 'skills', 'subagent-driven-development', 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'task-brief'), '#!/usr/bin/env bash\nset -eu\necho "brief $2 of $1" > "$3"\necho "wrote $3"\n', { mode: 0o755 })
  writeFileSync(join(scripts, 'review-package'), '#!/usr/bin/env bash\nset -eu\ngit merge-base --is-ancestor "$2" "$3" || { echo "HEAD is not a descendant of BASE" >&2; exit 3; }\ngit diff "$2..$3" > "$4"\necho "wrote $4"\n', { mode: 0o755 })
  return scripts
}

// ---------------------------------------------------------------- the record

const cut = (value) => {
  if (typeof value === 'string') return value.length > LONG ? `<${value.length} characters, cut>` : value
  if (Array.isArray(value)) return value.map(cut)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]))
  return value
}

function refusalOf(json, exit, stderr) {
  if (!json) return exit === 0 ? null : (stderr || 'no JSON on stdout').trim().split('\n').slice(-8).join('\n')
  const failed = exit !== 0 || json.ok === false || json.state === 'refused' || json.state === 'failed'
  if (!failed) return null
  const checks = Array.isArray(json.checks) ? json.checks.filter((c) => c.verdict === 'fail' || c.verdict === 'not-run').map((c) => `${c.id}: ${c.summary}`) : []
  return json.refusal ?? json.error ?? json.detail?.refusal ?? (json.refusals ? JSON.stringify(json.refusals) : null) ?? (checks.length ? [json.line, ...checks].filter(Boolean).join('; ') : null) ?? (json.errors ? JSON.stringify(json.errors) : null) ?? `exit ${exit}`
}

function recorder(sandbox, record) {
  const show = (text) => String(text).split(sandbox.root).join('<S>').split(REPO).join('<adf>')
  const add = (entry) => {
    const step = { n: record.steps.length + 1, ...entry, classification: entry.classification ?? [] }
    record.steps.push(step)
    return step
  }
  // One port script, as the command runs it: node <script> <args>, in `cwd`, with sandbox.env.
  const script = (phase, file, args, { cwd, session, plugin = null } = {}) => {
    const path = plugin ? join(REPO, 'plugins', plugin, 'scripts', file) : join(CORE, file)
    const env = { ...sandbox.env, CLAUDE_CODE_SESSION_ID: session }
    const run = spawnSync(process.execPath, [path, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 })
    let json = null
    try {
      json = JSON.parse(run.stdout)
    } catch {}
    const step = add({ phase, step: `${file} ${args.find((a) => !a.startsWith('--')) ?? ''}`.trim(), command: show(`node ${plugin ? `${plugin}/` : ''}${file} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`), cwd: show(cwd), exit: run.status, result: cut(json), refusal: refusalOf(json, run.status, run.stderr) })
    return { ...step, json: json ?? {}, ok: run.status === 0 && json !== null && json.ok !== false && json.state !== 'refused' }
  }
  // The work an agent (or the developer) does in the tree, by git or by writing files.
  const agent = (phase, name, actions, classification = []) => add({ phase, step: `agent: ${name}`, command: null, cwd: null, exit: 0, result: { actions: actions.map(show) }, refusal: null, classification })
  const hint = (step, kind, why) => {
    step.classification.push({ kind, why })
    return step
  }
  return { script, agent, hint, show }
}

// ---------------------------------------------------------------- git in the sandbox

function gitOf(sandbox) {
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, env: sandbox.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trimEnd()
  run.orNull = (cwd, ...args) => {
    try {
      return run(cwd, ...args)
    } catch {
      return null
    }
  }
  return run
}

// The files a commit changed: [{ status, file }].
function commitFiles(git, cwd, sha) {
  return (git.orNull(cwd, 'diff-tree', '--no-commit-id', '-r', '--name-status', '--no-renames', '--root', sha) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, file] = l.split('\t')
      return { status, file }
    })
}

// Writes each file as `rev` holds it at `at(file)` (deleted when `rev` lacks it) into `cwd`;
// returns the paths.
function writeFrom(git, cwd, rev, files, at = (file) => file) {
  const written = []
  for (const file of files) {
    const text = git.orNull(cwd, 'cat-file', '-p', `${rev}:${at(file)}`)
    const path = join(cwd, file)
    if (text === null) {
      if (existsSync(path)) {
        rmSync(path, { force: true })
        written.push(file)
      }
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, execFileSync('git', ['cat-file', '-p', `${rev}:${at(file)}`], { cwd, encoding: 'buffer', maxBuffer: 1 << 28 }))
    written.push(file)
  }
  return written
}

// Where the origin's merge holds a path: the change directory is in the archive there.
const atMerge = (ctx) => (file) => (file.startsWith(`openspec/changes/${ctx.name}/`) ? `openspec/changes/archive/${ctx.candidate.dir}/${file.slice(`openspec/changes/${ctx.name}/`.length)}` : file)

// An origin commit made again in `cwd`: cherry-picked, or, when the pick conflicts, its files as
// the commit holds them, committed with its subject. Returns { sha, how, actions }.
function replayCommit(git, cwd, origin) {
  const subject = git(cwd, 'show', '-s', '--format=%s', origin)
  const body = git(cwd, 'show', '-s', '--format=%B', origin)
  if (git.orNull(cwd, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', origin) !== null) {
    return { sha: git(cwd, 'rev-parse', 'HEAD'), how: 'cherry-pick', actions: [`git cherry-pick ${origin}`] }
  }
  git.orNull(cwd, 'cherry-pick', '--abort')
  const files = commitFiles(git, cwd, origin).map((f) => f.file)
  const written = writeFrom(git, cwd, origin, files)
  if (written.length) git(cwd, 'add', '-A', '--', ...written)
  git(cwd, 'commit', '-q', '--allow-empty', '-m', body || subject)
  return { sha: git(cwd, 'rev-parse', 'HEAD'), how: 'tree', actions: [`git cherry-pick ${origin} (conflicted; aborted)`, `wrote ${files.length} file(s) as ${origin.slice(0, 8)} holds them`, `git commit -m ${JSON.stringify(subject)}`] }
}

// ---------------------------------------------------------------- the replies

const items = (replies, phase) => replies.phases[phase] ?? []
const itemOf = (replies, phase, name) => items(replies, phase).find((i) => i.name === name) ?? null

// The origin's squash commit subject as the summary `<scope>: <description>`, or the title.
function originTitle(git, cwd, candidate) {
  const subject = git.orNull(cwd, 'show', '-s', '--format=%s', `${candidate.merge}^2`) ?? git.orNull(cwd, 'show', '-s', '--format=%s', candidate.merge) ?? candidate.name
  const m = /^[a-z]+(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
  return { subject, summary: m ? (m[1] ? `${m[1]}: ${m[2]}` : m[2]) : subject }
}

// ---------------------------------------------------------------- the driver

function context(sandbox, candidate, replies, { as, mode }) {
  const record = {
    candidate: { name: candidate.name, dir: candidate.dir, branch: candidate.branch, base: candidate.base, merge: candidate.merge, history: candidate.history, mergeRequest: candidate.mergeRequest ?? null },
    mode,
    as,
    startedAt: new Date().toISOString(),
    steps: [],
    phases: {},
    differences: [],
    shaMap: {},
    environment: []
  }
  const rec = recorder(sandbox, record)
  const git = gitOf(sandbox)
  const ctx = { sandbox, candidate, replies, record, rec, git, name: candidate.name, as, mode, debtIds: {} }
  ctx.session = (phase) => `replay-${as}-${phase}`
  ctx.run = (phase, file, args, opts = {}) => rec.script(phase, file, args, { cwd: opts.cwd ?? ctx.root ?? ctx.main, session: ctx.session(phase), ...opts })
  ctx.difference = (phase, what, evidence) => record.differences.push({ phase, what, evidence })
  return ctx
}

function setUp(ctx, { host = {}, refs = {} } = {}) {
  const { sandbox, candidate, rec } = ctx
  const c = sandbox.addCandidate(ctx.as, { base: candidate.base.commit, refs })
  ctx.sc = c
  ctx.main = c.main
  installSuite(sandbox)
  ctx.record.environment.push({ path: `<S>/bin/${SUITE}`, why: 'the fake whole-suite and covering command: a passing count line and the fresh-run proof line, a covering run passing at its task commit only; no test runs in a script-level replay' })
  const guide = { ...RECORDED_GUIDE, wholeSuite: { value: SUITE, source: 'replay: a fake suite command in the sandbox bin; the recorded value is npm test -- --force' } }
  const result = setupHost(sandbox, c, { change: candidate.name, guide, ...host })
  const step = rec.agent('host', 'setupHost (lib/replay-host.mjs)', [`setupHost ${ctx.as}: ok ${result.ok}, ${result.edits.length} edit(s), commit ${result.commit}`])
  step.result = cut({ ok: result.ok, commit: result.commit, pushed: result.pushed, refusals: result.refusals, unclaimed: result.unclaimed, checks: result.checks, notes: result.notes })
  if (!result.ok) rec.hint(step, 'blocked', 'the host checks did not all pass after the setup; the replay goes on and records what follows')
  const scripts = installSkillScripts(sandbox)
  ctx.record.environment.push({ path: rec.show(scripts), why: 'stand-ins of the Superpowers skill\'s task-brief and review-package, as plugins/adf/scripts/__tests__/git-host.mjs writes them; the replay host\'s Superpowers is a stub' })
  // The developer's untracked env file, which the clone does not carry: adf-postgres reads its
  // database URL from the main checkout's copy. Dummy values; the real one is never read.
  const envFile = join(c.main, '.env')
  if (!existsSync(envFile)) {
    writeFileSync(envFile, `${ENV_KEY}="postgresql://replay:replay@localhost:5432/replay?schema=public"\n`)
    ctx.record.environment.push({ path: rec.show(envFile), why: `a dummy ${ENV_KEY} in the main checkout's untracked .env, which adf-postgres reads (provision and teardown); the clone carries no .env` })
  }
  // The developer's installed dependencies, which the clone does not carry either: adf-prisma
  // copies the generated client from the main checkout. A stub; nothing is installed, and nothing
  // links to the origin's node_modules.
  for (const dir of ['node_modules/@prisma/client', 'node_modules/.prisma/client']) {
    const path = join(c.main, dir)
    if (existsSync(path)) continue
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), `${JSON.stringify({ name: dir.replace(/^node_modules\//, ''), version: '0.0.0-replay', private: true })}\n`)
    ctx.record.environment.push({ path: rec.show(path), why: 'a stub of the generated Prisma client in the main checkout\'s node_modules, which adf-prisma copies into a worktree; the clone carries no node_modules and none is installed' })
  }
  ctx.record.phases.host = { reached: true, ok: result.ok }
  return result
}

// Runs the phases in order; a Stop ends the phase and every later one.
function runPhases(ctx, list, fns) {
  for (const phase of list) {
    assertIsolated(ctx.sandbox, ctx.sc)
    ctx.record.phases[phase] = { reached: false, stopped: null }
    try {
      fns[phase](ctx)
      ctx.record.phases[phase].reached = true
    } catch (error) {
      if (!(error instanceof Stop)) {
        ctx.record.phases[phase].stopped = { step: 'driver', reason: `${error.message}\n${String(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` }
      } else ctx.record.phases[phase].stopped = { step: error.step, reason: error.message }
      const last = ctx.record.steps.at(-1)
      if (last) ctx.rec.hint(last, 'blocked', `the ${phase} phase stopped here: ${error.message}`)
      for (const later of list.slice(list.indexOf(phase) + 1)) ctx.record.phases[later] = { reached: false, stopped: { step: null, reason: `not run: ${phase} stopped` } }
      break
    }
  }
  ctx.record.finishedAt = new Date().toISOString()
  return ctx.record
}

// The command's step 1 of every phase after propose: find the change in every checkout.
function resolveChange(ctx, phase) {
  const found = ctx.run(phase, 'changes.mjs', ['find'], { cwd: ctx.main })
  const entry = (found.json.changes ?? []).find((c) => c.name === ctx.name && !c.main)
  if (!entry) throw new Stop(found.n, `changes.mjs find lists no worktree holding ${ctx.name}`)
  ctx.root = entry.root
  return entry
}

function preflight(ctx, phase) {
  const out = ctx.run(phase, 'preflight.mjs', ['--phase', phase, '--change', ctx.name, '--root', ctx.root])
  if (!out.ok) {
    ctx.rec.hint(out, 'blocked', `preflight --phase ${phase} refused: ${out.refusal}`)
    ctx.rec.hint(out, 'injected', 'the driver continues past the refusal to record what the later steps do')
    ctx.difference(phase, `preflight --phase ${phase} refuses the origin's change`, out.refusal)
  }
  return out
}

const changeDir = (ctx, root = ctx.root) => join(root, 'openspec', 'changes', ctx.name)
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}
const question = (ctx, name, text) => {
  const file = join(ctx.sandbox.env.TMPDIR, 'questions', ctx.as, `${name.replace(/\s+/g, '-')}.md`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${text}\n`)
  return file
}

// ---------------------------------------------------------------- propose

const ARTIFACT_FILES = {
  brainstorm: (names) => names.filter((n) => n === 'brainstorm.md'),
  proposal: (names) => names.filter((n) => n === 'proposal.md'),
  design: (names) => names.filter((n) => n === 'design.md'),
  specs: (names) => names.filter((n) => n.startsWith('specs/')),
  tasks: (names) => names.filter((n) => n === 'tasks.md'),
  plan: (names) => names.filter((n) => n === 'plan.md')
}

function writeArtifact(ctx, id, scope) {
  const arts = items(ctx.replies, 'propose').filter((i) => i.kind === 'artifact')
  const files = ARTIFACT_FILES[id]?.(arts.map((a) => a.name)) ?? []
  const written = []
  for (const file of files) {
    const item = arts.find((a) => a.name === file)
    const path = join(changeDir(ctx), file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, item.text)
    written.push(file)
  }
  const step = ctx.rec.agent('propose', `write ${id}`, written.map((f) => `wrote openspec/changes/${ctx.name}/${f} from the origin`))
  if (arts.some((a) => files.includes(a.name) && a.injected)) ctx.rec.hint(step, 'injected', arts.filter((a) => files.includes(a.name) && a.injected).flatMap((a) => a.injected.map((x) => `${a.name}: ${x.why}`)).join('; '))
  if (id === 'proposal' && scope) ctx.run('propose', 'scope.mjs', ['render', '--change', ctx.name, '--root', ctx.root])
  return written
}

// The task numbers plan-lint names as in no group, when that is all a `done plan` refused.
function unassigned(json) {
  const failed = (json.gates ?? []).filter((g) => !g.ok)
  const findings = failed.flatMap((g) => g.findings ?? [])
  if (failed.length !== 1 || failed[0].gate !== 'plan-lint' || findings.length === 0 || !findings.every((f) => f.kind === 'graph-task-unassigned')) return null
  return findings.map((f) => Number(/Task (\d+)/.exec(f.message)?.[1])).filter(Boolean)
}

// The plan with `tasks` added to one group: of the last wave, the one whose Files cell shares
// the most paths with the tasks' Files blocks (the last such row on a tie), its Files cell
// widened by the paths it lacks. A group of their own would pair with the groups whose files
// they share at a floor the graph does not state.
function assignLoose(planText, tasks) {
  const lines = planText.split('\n')
  const at = lines.findIndex((l) => /^##\s+Execution Graph\s*$/.test(l))
  const rows = parseGraph(planText)
  const files = [...new Set(parsePlanTasks(planText).filter((t) => tasks.includes(t.number)).flatMap((t) => t.files.map((f) => f.path)))]
  const wave = Math.max(...rows.map((r) => r.wave))
  let best = null
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const cells = lines[i].trim().startsWith('|') ? lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : null
    const row = cells && rows.find((r) => r.letter === cells[0].replace(/[`*]/g, '').trim() && r.wave === wave)
    if (!row || cells.length < 4) continue
    const shared = files.filter((f) => cells[2].includes(f)).length
    if (!best || shared >= best.shared) best = { i, cells, row, shared }
  }
  const { i, cells, row } = best
  cells[1] = [...row.tasks, ...tasks].join(', ')
  const missing = files.filter((f) => !cells[2].includes(f))
  if (missing.length) cells[2] = `${cells[2]}, ${missing.map((f) => `\`${f}\``).join(', ')}`
  lines[i] = `| ${cells.join(' | ')} |`
  return { text: lines.join('\n'), letter: row.letter }
}

function propose(ctx) {
  const { name, main } = ctx
  ctx.root = null
  const pre = ctx.run('propose', 'preflight.mjs', ['--phase', 'propose', '--change', name], { cwd: main })
  if (!pre.ok) throw new Stop(pre.n, `preflight refused: ${pre.refusal}`)

  // 3. The scope: the origin had no scope step; a degraded tracker is skipped with a reason.
  let gather = ctx.run('propose', 'scope.mjs', ['gather', '--change', name], { cwd: main })
  if (gather.json.tracker?.state === 'degraded') {
    ctx.rec.hint(gather, 'injected', 'the developer\'s answer to a degraded tracker is the replay\'s: work without it for this change')
    gather = ctx.run('propose', 'scope.mjs', ['gather', '--change', name, '--skip-tracker', TRACKER_SKIP], { cwd: main })
  }
  if (gather.json.ok === false) throw new Stop(gather.n, `scope gather refused: ${gather.refusal}`)
  if (!gather.json.empty && (gather.json.items ?? []).length) {
    const sel = ctx.run('propose', 'scope.mjs', ['select', '--change', name, '--rest', 'replay: the origin took no scope item'], { cwd: main })
    ctx.rec.hint(sel, 'injected', `the developer's selection is the replay's: every gathered item excluded (${(gather.json.items ?? []).map((i) => i.key).join(', ')}), since the origin had no scope step`)
  }

  // 6. The base and the branch: the developer answers with the origin's branch name.
  const suggest = ctx.run('propose', 'workspace.mjs', ['suggest', '--change', name], { cwd: main })
  const branch = ctx.candidate.branch ?? suggest.json.branch
  if (!branch) throw new Stop(suggest.n, 'no branch: suggest gives none and the origin names none')
  if (suggest.json.branch !== branch) ctx.difference('propose', `workspace.mjs suggest proposes ${suggest.json.branch ?? 'no branch (a type is asked)'}; the developer's answer is the origin's ${branch}`, `step ${suggest.n}`)

  // 7. The branch, the worktree and the change.
  const create = ctx.run('propose', 'propose.mjs', ['create', '--change', name, '--branch', branch, '--base', 'integration'], { cwd: main })
  if (!create.ok) throw new Stop(create.n, `propose.mjs create refused: ${create.refusal}`)
  ctx.root = create.json.root
  const scope = Boolean(create.json.scope)

  // 8. The artifacts, as changes.mjs next hands them out.
  const order = []
  let blocked = null
  for (let i = 0; i < 20; i++) {
    const next = ctx.run('propose', 'changes.mjs', ['next', '--change', name, '--root', ctx.root])
    if (next.json.done === true) break
    if (next.json.ok === false) {
      blocked = next
      break
    }
    const id = next.json.artifact
    const written = writeArtifact(ctx, id, scope)
    order.push(id)
    if (written.length === 0) {
      if (next.json.optional) {
        ctx.run('propose', 'changes.mjs', ['skip', id, '--change', name, '--root', ctx.root])
        continue
      }
      throw new Stop(next.n, `the origin's records hold no ${id}`)
    }
    let done = ctx.run('propose', 'changes.mjs', ['done', id, '--change', name, '--root', ctx.root])
    const loose = id === 'plan' && !done.ok ? unassigned(done.json) : null
    if (loose) {
      // A workaround: tasks the origin ran on the change branch after the groups are in no group,
      // which the port refuses (D8). They are put in a wave-2 group of their own.
      ctx.rec.hint(done, 'blocked', `plan-lint refuses Tasks ${loose.join(', ')} in no group`)
      ctx.difference('propose', `plan-lint refuses the origin's plan: Tasks ${loose.join(', ')} are in no group of the Execution Graph (graph-task-unassigned, D8)`, done.refusal)
      const path = join(changeDir(ctx), 'plan.md')
      const { text, letter } = assignLoose(readFileSync(path, 'utf8'), loose)
      writeFileSync(path, text)
      ctx.rec.hint(ctx.rec.agent('propose', 'the plan\'s unassigned tasks', [`added Tasks ${loose.join(', ')} to group ${letter} of the Execution Graph`]), 'injected', 'a workaround so the port schedules the tasks the origin ran after the groups')
      done = ctx.run('propose', 'changes.mjs', ['done', id, '--change', name, '--root', ctx.root])
    }
    if (!done.ok) {
      blocked = done
      break
    }
  }
  if (blocked) {
    // A gate refuses the origin's own artifact: the developer would edit it, which the replay
    // cannot. Every remaining artifact is written and its gates run, for the record, and the
    // change is committed by the driver, bypassing the gates.
    ctx.rec.hint(blocked, 'blocked', `a gate refuses the origin's artifact: ${blocked.refusal}`)
    ctx.difference('propose', `the port's gates refuse the origin's ${blocked.json.blockedBy ?? blocked.json.artifact ?? 'artifact'}`, blocked.refusal)
    for (const id of Object.keys(ARTIFACT_FILES).filter((x) => !order.includes(x))) {
      if (writeArtifact(ctx, id, scope).length) ctx.run('propose', 'changes.mjs', ['done', id, '--change', name, '--root', ctx.root])
      else if (id === 'design') ctx.run('propose', 'changes.mjs', ['skip', id, '--change', name, '--root', ctx.root])
    }
    const commit = ctx.run('propose', 'propose.mjs', ['commit', '--change', name, '--root', ctx.root])
    if (!commit.ok) {
      ctx.git(ctx.root, 'add', '--', `openspec/changes/${name}`)
      ctx.git(ctx.root, 'commit', '-q', '-m', `docs(openspec): propose ${name}`)
      ctx.rec.hint(ctx.rec.agent('propose', 'commit the change past its gates', [`git add openspec/changes/${name}`, `git commit -m "docs(openspec): propose ${name}"`]), 'injected', 'propose.mjs commit refuses while a gate fails; the driver commits the change directory itself to go on')
    }
  } else {
    // 9. Commit.
    const commit = ctx.run('propose', 'propose.mjs', ['commit', '--change', name, '--root', ctx.root])
    if (!commit.ok) throw new Stop(commit.n, `propose.mjs commit refused: ${commit.refusal}`)
  }

  // 10. The merge request.
  const { summary } = originTitle(ctx.git, ctx.root, ctx.candidate)
  ctx.summary = summary
  const open = ctx.run('propose', 'forge.mjs', ['open', '--change', name, '--root', ctx.root, '--summary', summary])
  ctx.rec.hint(open, 'injected', `the summary is the origin's squash commit subject: "${summary}"`)
  if (open.json.state !== 'done') ctx.difference('propose', `forge open is ${open.json.state}`, open.refusal ?? open.json.report)
  // 11. Report.
  ctx.run('propose', 'changes.mjs', ['status', '--change', name, '--root', ctx.root, '--report'])
}

// ---------------------------------------------------------------- apply

// The commits an impl reply names, made again in the dispatch's worktree. `task` is the plan
// task; its reply is the step-4 item, or missing.
function implWork(ctx, task, worktree, planText) {
  const item = itemOf(ctx.replies, 'apply', `T${task} impl`)
  const actions = []
  const classification = []
  const shas = []
  if (item && !item.missing) {
    for (const origin of item.reply.commits) {
      const made = replayCommit(ctx.git, worktree, origin)
      ctx.record.shaMap[origin] = made.sha
      shas.push(made.sha)
      actions.push(...made.actions)
      if (made.how === 'tree') classification.push({ kind: 'injected', why: `the cherry-pick of ${origin.slice(0, 8)} conflicted; its files were written as the origin commit holds them` })
    }
    return { item, shas, actions, classification }
  }
  // No reply: the task's files as the origin's final tree holds them, or an empty commit.
  const why = item?.missing ?? `no T${task} impl item`
  const body = taskBody(planText, task) ?? ''
  const message = /\*\*Step\s+\d+:\s*Commit\*\*\s*[—–-]+\s*`([^`]+)`/.exec(body)?.[1] ?? `chore(replay): Task ${task}`
  const files = (parsePlanTasks(planText).find((t) => t.number === task)?.files ?? []).flatMap((f) => [f.path, f.to].filter(Boolean))
  const written = writeFrom(ctx.git, worktree, ctx.candidate.merge, files.filter((f) => !f.includes('*')), atMerge(ctx))
  if (written.length) ctx.git(worktree, 'add', '-A', '--', ...written)
  ctx.git(worktree, 'commit', '-q', '--allow-empty', '-m', message)
  shas.push(ctx.git(worktree, 'rev-parse', 'HEAD'))
  actions.push(`wrote ${written.length} file(s) of Task ${task}'s Files block as ${ctx.candidate.merge.slice(0, 8)} holds them`, `git commit --allow-empty`)
  classification.push({ kind: 'injected', why: `no impl reply (${why}); the driver made the commit` })
  return { item, shas, actions, classification }
}

// One round of dispatches under the tree guard: `work(name)` is each dispatch's agent work and
// reply; the replies are recorded after the compare.
function round(ctx, entries) {
  if (entries.length === 0) return []
  const args = entries.flatMap((e) => ['--dispatch', e.name])
  ctx.run('apply', 'guard.mjs', ['snapshot', '--change', ctx.name, ...args, '--root', ctx.root])
  const done = entries.map((e) => ({ ...e, ...e.work() }))
  const cmp = ctx.run('apply', 'guard.mjs', ['compare', '--change', ctx.name, '--root', ctx.root])
  if (!cmp.json.ok) ctx.rec.hint(cmp, 'blocked', `the guard found a change outside the dispatch targets: ${JSON.stringify(cmp.json.changed)}`)
  return done.map((e) => ({ ...e, reply: e.replyFile ? ctx.run('apply', 'dispatch.mjs', ['reply', '--change', ctx.name, '--name', e.name, '--file', e.replyFile, '--root', ctx.root]) : null }))
}

function dispatchPrompt(ctx, phase, args) {
  return ctx.run(phase, 'dispatch.mjs', ['prompt', '--change', ctx.name, ...args, '--root', ctx.root])
}

// A clean review reply of `role`, injected when step 4 has none.
function reviewReply(ctx, name, role) {
  const item = itemOf(ctx.replies, 'apply', name)
  if (item && !item.missing) return { reply: item.reply, injected: null }
  return { reply: { role, summary: `replay: no finding (${item?.missing ?? 'no reply item'})`, findings: [], unverifiable: [] }, injected: `no ${name} reply (${item?.missing ?? 'no item'}); a clean one is injected` }
}

function implAndReview(ctx, tasks, planText) {
  // impl round
  const impls = round(ctx, tasks.map(({ task }) => ({
    name: `T${task} impl`,
    task,
    work() {
      ctx.run('apply', 'sdd.mjs', ['brief', '--change', ctx.name, '--task', String(task), '--root', ctx.root])
      ctx.run('apply', 'dispatch.mjs', ['attempt', '--change', ctx.name, '--name', `T${task} impl`, '--root', ctx.root])
      const prompt = dispatchPrompt(ctx, 'apply', ['--role', 'impl', '--task', String(task)])
      if (!prompt.ok) {
        ctx.rec.hint(prompt, 'blocked', `no impl prompt for Task ${task}: ${prompt.refusal}`)
        ctx.difference('apply', `dispatch.mjs prompt refuses Task ${task}`, prompt.refusal)
        return { replyFile: null }
      }
      const worktree = prompt.json.worktree
      const work = implWork(ctx, task, worktree, planText)
      // A task that commits nothing (its Commit step says none) is covered at the worktree's HEAD.
      const at = work.shas.at(-1) ?? ctx.git(worktree, 'rev-parse', 'HEAD')
      const cover = ctx.run('apply', 'suite.mjs', ['covering', '--change', ctx.name, '--name', `T${task} impl`, '--command', `${SUITE} ${at}`, '--worktree', worktree, '--root', ctx.root])
      ctx.rec.hint(cover, 'injected', `the covering command is the sandbox's fake ${SUITE}, passing at the task's commit only`)
      const testRuns = cover.ok ? [cover.json.file] : []
      const reply = work.item && !work.item.missing ? { ...completeImpl(work.item, testRuns), commits: work.shas } : { role: 'impl', outcome: 'done', commits: work.shas, testRuns, concerns: [], summary: `replay: Task ${task}` }
      writeJson(prompt.json.replyFile, reply)
      const step = ctx.rec.agent('apply', `T${task} impl`, [...work.actions, `wrote the reply ${prompt.json.replyFile}`], work.classification)
      if (work.item?.injected) ctx.rec.hint(step, 'injected', work.item.injected.map((x) => `${x.field}: ${x.why}`).join('; '))
      return { replyFile: prompt.json.replyFile }
    }
  })))
  // review round
  const reviews = round(ctx, impls.filter((i) => i.reply?.json?.valid).map((i) => ({
    name: `T${i.task} review`,
    task: i.task,
    work() {
      const range = i.reply.json.result?.range
      if (range) ctx.run('apply', 'sdd.mjs', ['package', '--change', ctx.name, '--base', range.base, '--head', range.head, '--root', ctx.root])
      ctx.run('apply', 'dispatch.mjs', ['attempt', '--change', ctx.name, '--name', `T${i.task} review`, '--root', ctx.root])
      const q = question(ctx, `T${i.task} review`, `Review Task ${i.task}'s commit against its plan text.`)
      const prompt = dispatchPrompt(ctx, 'apply', ['--role', 'review', '--task', String(i.task), '--question-file', q, ...(range ? ['--base', range.base, '--head', range.head] : [])])
      if (!prompt.ok) return { replyFile: null }
      const { reply, injected } = reviewReply(ctx, `T${i.task} review`, 'review')
      writeJson(prompt.json.replyFile, reply)
      const step = ctx.rec.agent('apply', `T${i.task} review`, [`wrote the reply ${prompt.json.replyFile}`])
      if (injected) ctx.rec.hint(step, 'injected', injected)
      return { replyFile: prompt.json.replyFile }
    }
  })))
  for (const i of impls.filter((x) => !x.reply?.json?.valid)) ctx.rec.hint(i.reply ?? ctx.record.steps.at(-1), 'blocked', `T${i.task} impl has no accepted reply`)
  // ticks, outside any round
  for (const r of reviews) {
    if (r.reply?.json?.result?.result !== 'clean') ctx.rec.hint(r.reply ?? ctx.record.steps.at(-1), 'blocked', `T${r.task} review is not clean: ${JSON.stringify(r.reply?.json?.result ?? r.reply?.json?.errors)}`)
    const tick = ctx.run('apply', 'tasks.mjs', ['tick', '--plan-task', String(r.task), '--change', ctx.name, '--root', ctx.root, '--commit'])
    if (!tick.ok) ctx.difference('apply', `tasks.mjs tick refuses Task ${r.task}`, tick.refusal)
  }
}

// The orchestrator's ledger writes of one phase, from the origin's ledger, in its order.
function ledgerWrites(ctx, phase, filter = () => true) {
  for (const w of items(ctx.replies, phase).filter((i) => i.kind === 'ledger' && !i.missing && i.check?.valid && filter(i))) {
    const fields = { ...w.record.fields }
    if (w.record.kind === 'resolve' && fields.debt && ctx.debtIds[fields.debt]) fields.debt = ctx.debtIds[fields.debt]
    const args = Object.entries(fields).flatMap(([k, v]) => [`--${k}`, v])
    const out = ctx.run(phase, 'ledger.mjs', [w.record.kind, '--change', ctx.name, ...args, '--root', ctx.root])
    ctx.rec.hint(out, 'injected', `the origin's ledger record ${w.source?.[0]?.id ?? w.name}${w.renamed ? ` (${w.renamed})` : ''}${w.derived ? ` (${w.derived})` : ''}`)
    const originId = w.source?.[0]?.id
    if (out.ok && originId && w.record.kind === 'debt') ctx.debtIds[originId] = out.json.record.id
  }
}

function apply(ctx) {
  resolveChange(ctx, 'apply')
  const { name } = ctx
  preflight(ctx, 'apply')
  const prov = ctx.run('apply', 'workspace.mjs', ['provision', '--change', name, '--root', ctx.root])
  if (!prov.ok) throw new Stop(prov.n, `workspace provision refused: ${prov.refusal}`)
  ctx.run('apply', 'changes.mjs', ['instructions', 'apply', '--change', name, '--root', ctx.root])
  ctx.run('apply', 'apply-status.mjs', ['--change', name, '--root', ctx.root])
  const sched = ctx.run('apply', 'plan.mjs', ['schedule', '--change', name, '--root', ctx.root])
  if (!sched.ok) throw new Stop(sched.n, `plan schedule refused: ${sched.refusal}`)
  const planText = readFileSync(join(changeDir(ctx), 'plan.md'), 'utf8')
  const groups = sched.json.groups ?? []

  if (sched.json.single) {
    const tasks = groups.flatMap((g) => g.tasks)
    for (const task of tasks) implAndReview(ctx, [{ task }], planText)
    ctx.run('apply', 'forge.mjs', ['push', '--change', name, '--root', ctx.root])
  } else {
    const started = new Set()
    for (let guard = 0; guard < 10; guard++) {
      const status = ctx.run('apply', 'apply-status.mjs', ['--change', name, '--root', ctx.root])
      const startable = (status.json.startable ?? []).filter((g) => !started.has(g.n ?? g))
      if (startable.length === 0) break
      const groups = startable.map((g) => (typeof g === 'object' ? g : status.json.groups.find((x) => x.n === g)))
      for (const g of groups) {
        started.add(g.n)
        const add = ctx.run('apply', 'workspace.mjs', ['group-add', '--change', name, '--group', String(g.n), '--root', ctx.root])
        if (!add.ok && !add.json.root) throw new Stop(add.n, `group-add ${g.n} refused: ${add.refusal}`)
      }
      // Rounds: one dispatch per running group at a time.
      const queues = groups.map((g) => [...g.tasks])
      while (queues.some((q) => q.length)) implAndReview(ctx, queues.filter((q) => q.length).map((q) => ({ task: q.shift() })), planText)
      for (const g of groups) mergeGroup(ctx, g)
    }
  }

  // The orchestrator's ledger records of propose and apply.
  ledgerWrites(ctx, 'apply')

  // The final review.
  ctx.run('apply', 'dispatch.mjs', ['attempt', '--change', name, '--name', 'final-review', '--root', ctx.root])
  const fq = question(ctx, 'final-review', 'Review the whole branch once every group is merged.')
  const fp = dispatchPrompt(ctx, 'apply', ['--role', 'final-review', '--question-file', fq])
  if (fp.ok) {
    const { reply, injected } = reviewReply(ctx, 'final-review', 'final-review')
    writeJson(fp.json.replyFile, reply)
    const step = ctx.rec.agent('apply', 'final-review', [`wrote the reply ${fp.json.replyFile}`])
    if (injected) ctx.rec.hint(step, 'injected', injected)
    const r = ctx.run('apply', 'dispatch.mjs', ['reply', '--change', name, '--name', 'final-review', '--file', fp.json.replyFile, '--root', ctx.root])
    if (r.json.result?.result !== 'clean') ctx.rec.hint(r, 'blocked', 'the final review is not clean')
  }

  // The reuse sweep.
  ctx.run('apply', 'dispatch.mjs', ['attempt', '--change', name, '--name', 'sweep', '--root', ctx.root])
  const sp = dispatchPrompt(ctx, 'apply', ['--role', 'sweep'])
  if (sp.ok) {
    const item = itemOf(ctx.replies, 'apply', 'sweep')
    const reply = item && !item.missing ? item.reply : { role: 'sweep', findings: [] }
    writeJson(sp.json.replyFile, reply)
    const step = ctx.rec.agent('apply', 'sweep', [`wrote the reply ${sp.json.replyFile}`])
    if (!item || item.missing) ctx.rec.hint(step, 'injected', `no sweep reply (${item?.missing ?? 'no item'}); a clean one is injected`)
    ctx.run('apply', 'dispatch.mjs', ['reply', '--change', name, '--name', 'sweep', '--file', sp.json.replyFile, '--root', ctx.root])
  }

  // The whole suite, apply's final commit.
  const suite = ctx.run('apply', 'suite.mjs', ['run', '--change', name, '--root', ctx.root, '--base-check', '--record', '--commit'])
  ctx.rec.hint(suite, 'injected', `the whole-suite command is the sandbox's fake ${SUITE}`)
  const report = ctx.run('apply', 'apply-status.mjs', ['--change', name, '--root', ctx.root, '--report'])
  if (report.json.complete !== true) ctx.rec.hint(report, 'blocked', 'apply-status reports the apply not complete')
}

function mergeGroup(ctx, g) {
  const { name } = ctx
  let merge = ctx.run('apply', 'workspace.mjs', ['group-merge', '--change', name, '--group', String(g.n), '--root', ctx.root])
  if (merge.json.merged === false) {
    // A conflict: the resolver's work, from the origin's final tree of each conflicting file.
    const files = merge.json.conflicts ?? []
    const written = writeFrom(ctx.git, ctx.root, ctx.candidate.merge, files, atMerge(ctx))
    ctx.git(ctx.root, 'add', '-A', '--', ...files)
    ctx.git(ctx.root, 'commit', '-q', '--no-edit')
    ctx.rec.hint(ctx.rec.agent('apply', `fix ${g.letter} (merge resolver)`, [`resolved ${files.join(', ')} as ${ctx.candidate.merge.slice(0, 8)} holds them (${written.length} written)`, 'git commit --no-edit']), 'injected', 'the merge conflicted; the resolver dispatch is replaced by the origin\'s final content of each file')
    ctx.difference('apply', `group ${g.letter}'s merge conflicts in ${files.join(', ')}`, `step ${merge.n}`)
    merge = ctx.run('apply', 'workspace.mjs', ['group-merge', '--change', name, '--group', String(g.n), '--root', ctx.root])
  }
  if (!merge.json.merged) throw new Stop(merge.n, `group-merge ${g.n} failed: ${merge.refusal}`)
  ctx.run('apply', 'dispatch.mjs', ['attempt', '--change', name, '--name', `merge-review ${g.letter}`, '--root', ctx.root])
  const q = question(ctx, `merge-review ${g.letter}`, `Review the merge of group ${g.letter}: the package ${merge.json.package?.file ?? 'of the merge'}.`)
  const prompt = dispatchPrompt(ctx, 'apply', ['--role', 'merge-review', '--group', g.letter, '--question-file', q])
  if (prompt.ok) {
    const { reply, injected } = reviewReply(ctx, `merge-review ${g.letter}`, 'merge-review')
    writeJson(prompt.json.replyFile, reply)
    const step = ctx.rec.agent('apply', `merge-review ${g.letter}`, [`wrote the reply ${prompt.json.replyFile}`])
    if (injected) ctx.rec.hint(step, 'injected', injected)
    const r = ctx.run('apply', 'dispatch.mjs', ['reply', '--change', name, '--name', `merge-review ${g.letter}`, '--file', prompt.json.replyFile, '--root', ctx.root])
    if (r.json.result?.result !== 'clean') ctx.rec.hint(r, 'blocked', `merge-review ${g.letter} is not clean`)
  }
  const fin = ctx.run('apply', 'workspace.mjs', ['group-finish', '--change', name, '--group', String(g.n), '--root', ctx.root])
  if (!fin.ok) ctx.rec.hint(fin, 'blocked', `group-finish ${g.n} refused`)
}

// ---------------------------------------------------------------- verify

// The prose edits a verify c4 prompt lists: the `Prose edits` field, `<capability> <sha> (...)`.
function listedProseEdits(prompt) {
  const lines = String(prompt ?? '').split('\n')
  const at = lines.findIndex((l) => /^- Prose edits:/.test(l))
  if (at === -1 || /^- Prose edits: none\s*$/.test(lines[at])) return []
  const out = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+- (\S+) ([0-9a-f]{7,40}) \(/.exec(l)
    if (!m) break
    out.push({ capability: m[1], commit: m[2] })
  }
  return out
}

function verify(ctx) {
  resolveChange(ctx, 'verify')
  const { name } = ctx
  preflight(ctx, 'verify')
  ctx.run('verify', 'verify.mjs', ['run', '--change', name, '--root', ctx.root, '--suite'])
  const prompts = ctx.run('verify', 'verify.mjs', ['prompts', '--change', name, '--root', ctx.root])
  if (!prompts.ok) throw new Stop(prompts.n, `verify prompts refused: ${prompts.refusal}`)
  const verifyDir = join(ctx.root, '.superpowers', 'sdd', name, 'verify')
  for (const d of prompts.json.dispatches ?? []) {
    const item = itemOf(ctx.replies, 'verify', d.name)
    let reply
    const why = []
    if (d.check === 'c4') {
      if (item && !item.missing) {
        reply = { ...item.reply, proseEdits: (item.reply.proseEdits ?? []).map((p) => ({ ...p, commit: ctx.record.shaMap[p.commit] ?? p.commit })) }
        if (item.injected) why.push(item.injected.map((x) => `${x.field}: ${x.why}`).join('; '))
      } else {
        reply = { role: 'verify-c4', case: item?.partial?.case ?? 'no-design', findings: item?.partial?.findings ?? [], proseEdits: [], removalAccounting: [], exercised: [], summary: 'replay: injected' }
        why.push(`no verify c4 reply (${item?.missing ?? 'no item'}); one is injected from what the records give`)
      }
    } else {
      const file = join(verifyDir, 'c8-candidates.json')
      const listed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
      const candidates = Array.isArray(listed) ? listed : (listed.candidates ?? [])
      const answered = item ? c8Reply(item, candidates) : { missing: 'no verify c8 item' }
      if (answered.reply) reply = answered.reply
      else {
        reply = { role: 'verify-c8', candidates: candidates.map((c) => ({ file: c.file, line: c.line, class: 'none', fact: c.text ?? 'replay', why: 'replay: injected' })), summary: 'replay: injected' }
        why.push(`no verify c8 answer (${answered.missing}); every candidate answered none`)
      }
    }
    ctx.run('verify', 'dispatch.mjs', ['attempt', '--change', name, '--name', d.name, '--root', ctx.root])
    writeJson(d.replyFile, reply)
    const step = ctx.rec.agent('verify', d.name, [`wrote the reply ${d.replyFile}`])
    if (why.length) ctx.rec.hint(step, 'injected', why.join('; '))
    const r = ctx.run('verify', 'dispatch.mjs', ['reply', '--change', name, '--name', d.name, '--file', d.replyFile, '--root', ctx.root])
    if (r.json.valid) continue
    ctx.difference('verify', `the port refuses the origin's ${d.name} reply`, r.refusal)
    if (d.check !== 'c4' || r.json.next !== 'retry') continue
    // The retry: the reply answers exactly what the script listed, with the origin's reason for
    // a capability it names, as a resumed agent would correct it from the errors.
    const listed = listedProseEdits(d.prompt)
    const fixed = { ...reply, proseEdits: listed.map((l) => ({ capability: l.capability, commit: l.commit, reason: reply.proseEdits.find((p) => p.capability === l.capability)?.reason ?? null })) }
    const file = d.replyFile.replace(/\.json$/, '-2.json')
    ctx.run('verify', 'dispatch.mjs', ['attempt', '--change', name, '--name', d.name, '--root', ctx.root])
    writeJson(file, fixed)
    ctx.rec.hint(ctx.rec.agent('verify', `${d.name} retry`, [`wrote the reply ${file}`]), 'injected', `proseEdits answered from the script's listing (${listed.map((l) => `${l.capability} ${l.commit.slice(0, 8)}`).join(', ') || 'none'}): the origin's reply names an edit the replay has not made`)
    ctx.run('verify', 'dispatch.mjs', ['reply', '--change', name, '--name', d.name, '--file', file, '--root', ctx.root])
  }
  // The developer's rulings the origin's ledger holds for this phase.
  ledgerWrites(ctx, 'verify')
  let verdict = ctx.run('verify', 'verify.mjs', ['verdict', '--change', name, '--root', ctx.root, '--report'])
  const failing = (v) => [...new Set([...(v.json.needsRuling ?? []), ...((v.json.checks ?? []).filter((c) => c.verdict === 'fail' && !c.ruling).map((c) => c.id))])]
  const left = failing(verdict)
  if (left.length || verdict.json.verdict === 'FAIL') {
    const ids = left.length ? left : (verdict.json.failing ?? [])
    ctx.difference('verify', `the verdict needs rulings the origin's ledger does not hold: ${ids.join(', ') || verdict.json.line || 'FAIL'}`, verdict.refusal ?? verdict.json.line)
    for (const id of ids.filter((x) => !['tree', 'worktrees'].includes(x))) {
      const out = ctx.run('verify', 'ledger.mjs', ['ruling', '--change', name, '--check', id, '--reason', `replay: injected so the replay goes on; no ruling of the origin's ledger covers ${id}`, '--root', ctx.root])
      ctx.rec.hint(out, 'injected', `a ruling on ${id} no developer gave`)
    }
    verdict = ctx.run('verify', 'verify.mjs', ['verdict', '--change', name, '--root', ctx.root, '--report'])
  }
  const assemble = ctx.run('verify', 'verify.mjs', ['assemble', '--change', name, '--root', ctx.root, '--commit'])
  if (!assemble.ok) throw new Stop(assemble.n, `verify assemble refused: ${assemble.refusal}`)
  if (assemble.json.verdict === 'FAIL') throw new Stop(assemble.n, `the verify verdict is FAIL: ${assemble.json.line}`)
}

// ---------------------------------------------------------------- review

// A fix commit made again as two: the finding's file and the test files first, then the rest.
// Returns { fix, rest, actions }, or null when nothing but those files changed.
function splitFix(ctx, sha, findingFile) {
  const files = commitFiles(ctx.git, ctx.root, sha).map((f) => f.file)
  const first = files.filter((f) => f === findingFile || isTestFile(f))
  const rest = files.filter((f) => !first.includes(f))
  if (!rest.length || !first.length) return null
  const message = ctx.git(ctx.root, 'show', '-s', '--format=%B', sha)
  ctx.git(ctx.root, 'reset', '-q', '--soft', `${sha}^`)
  ctx.git(ctx.root, 'reset', '-q')
  ctx.git(ctx.root, 'add', '-A', '--', ...first)
  ctx.git(ctx.root, 'commit', '-q', '-m', message)
  const fix = ctx.git(ctx.root, 'rev-parse', 'HEAD')
  ctx.git(ctx.root, 'add', '-A', '--', ...rest)
  ctx.git(ctx.root, 'commit', '-q', '-m', `${message.split('\n')[0]} (the rest of the origin's fix commit)`)
  return { fix, rest: ctx.git(ctx.root, 'rev-parse', 'HEAD'), actions: [`git reset --soft ${sha.slice(0, 8)}^`, `git commit ${first.join(' ')}`, `git commit ${rest.join(' ')}`] }
}

// The round-1 findings in the port's shape: the reply when step 4 built it, else the partial
// findings with a category and a title the record lacks.
function reviewFindings(ctx, k) {
  const item = itemOf(ctx.replies, 'review', `ai-review r${k}`)
  if (item && !item.missing) return { reply: item.reply, injected: null }
  const partial = item?.partial?.findings ?? []
  if (!item) return { reply: { summary: 'replay: no finding', findings: [] }, injected: `no ai-review r${k} item; an empty reply is injected` }
  if (!partial.length) return { reply: { summary: 'replay: no finding', findings: [] }, injected: `ai-review r${k}: ${item.missing}; an empty reply is injected` }
  const findings = partial.map((f) => ({ id: f.id, severity: f.severity, category: 'origin-review', file: f.file ?? 'unknown', line: f.line ?? null, title: (f.body ?? `finding ${f.id}`).split(/(?<=\.)\s/)[0].slice(0, 120), body: f.body ?? `the origin's finding ${f.id}` }))
  return { reply: { summary: `replay: the origin's ${findings.length} finding(s)`, findings }, injected: `ai-review r${k}: ${item.missing}; category and title are injected` }
}

function review(ctx) {
  resolveChange(ctx, 'review')
  const { name } = ctx
  preflight(ctx, 'review')
  const start = ctx.run('review', 'review.mjs', ['start', '--change', name, '--root', ctx.root])
  if (!start.ok) throw new Stop(start.n, `review start refused: ${start.refusal}`)
  let fixed = false
  if (start.json.empty) {
    const out = ctx.run('review', 'review.mjs', ['assemble', '--change', name, '--not-reviewed', 'the filtered diff is empty', '--commit', '--root', ctx.root])
    if (!out.ok) throw new Stop(out.n, `review assemble refused: ${out.refusal}`)
    return
  }
  if (start.json.over) {
    const out = ctx.run('review', 'ledger.mjs', ['ruling', '--change', name, '--check', 'review-slices', '--reason', 'replay: injected; the slices are approved', '--root', ctx.root])
    ctx.rec.hint(out, 'injected', 'the diff is over one reviewer\'s size; the slices ruling no developer gave')
    ctx.difference('review', 'the diff is over review.maxBytes and needs slices', `step ${start.n}`)
  }
  const reviewItem = itemOf(ctx.replies, 'review', 'ai-review r1')
  const rows = reviewItem?.partial?.findings ?? []
  for (let k = 1; k <= 6; k++) {
    const r = ctx.run('review', 'review.mjs', ['round', '--change', name, '--root', ctx.root])
    if (!r.ok) {
      if (r.json.escalate) throw new Stop(r.n, `the review round cap: ${r.refusal}`)
      break
    }
    const kk = r.json.round
    const input = ctx.run('review', 'review.mjs', ['input', '--change', name, '--round', String(kk), '--root', ctx.root])
    if (!input.ok) throw new Stop(input.n, `review input refused: ${input.refusal}`)
    ctx.run('review', 'dispatch.mjs', ['attempt', '--change', name, '--name', `ai-review r${kk}`, '--root', ctx.root])
    const prompt = dispatchPrompt(ctx, 'review', ['--role', 'ai-review', '--round', String(kk)])
    if (!prompt.ok) throw new Stop(prompt.n, `ai-review prompt refused: ${prompt.refusal}`)
    const { reply, injected } = reviewFindings(ctx, kk)
    writeJson(prompt.json.replyFile, reply)
    const step = ctx.rec.agent('review', `ai-review r${kk}`, [`wrote the reply ${prompt.json.replyFile}`])
    if (injected) ctx.rec.hint(step, 'injected', injected)
    const resp = ctx.run('review', 'review.mjs', ['response', '--change', name, '--round', String(kk), '--file', prompt.json.replyFile, '--root', ctx.root])
    if (!resp.ok) throw new Stop(resp.n, `review response refused: ${resp.refusal}`)
    const ids = resp.json.ids ?? []
    // fixes
    let landed = false
    const handled = new Set()
    for (let i = 0; i < 10; i++) {
      const plan = ctx.run('review', 'review.mjs', ['fixplan', '--change', name, '--round', String(kk), '--root', ctx.root])
      const next = plan.json.next
      if (!next) break
      const fixItem = itemOf(ctx.replies, 'review', `ai-fix ${next.finding} r1`) ?? itemOf(ctx.replies, 'review', `ai-fix ${next.finding} r${kk}`)
      ctx.run('review', 'dispatch.mjs', ['attempt', '--change', name, '--name', next.name, '--root', ctx.root])
      const fp = dispatchPrompt(ctx, 'review', ['--role', 'ai-fix', '--finding', next.finding, '--round', String(kk)])
      if (!fp.ok) throw new Stop(fp.n, `ai-fix prompt refused: ${fp.refusal}`)
      if (!fixItem || fixItem.missing) {
        // No recorded fix: the developer accepts the finding as it is.
        ctx.rec.hint(ctx.rec.agent('review', next.name, ['no fix: the origin records none']), 'injected', `no ${next.name} reply (${fixItem?.missing ?? 'no item'})`)
        const rule = ctx.run('review', 'ledger.mjs', ['ruling', '--change', name, '--finding', next.finding, '--as', 'accepted', '--decision', `replay: the origin's review record: ${rows.find((x) => x.id === next.finding)?.body ?? 'left as it is'}`.slice(0, 500), '--root', ctx.root])
        ctx.rec.hint(rule, 'injected', 'an acceptance no developer gave in these words')
        ctx.run('review', 'review.mjs', ['disposition', '--change', name, '--finding', next.finding, '--as', 'accepted', '--root', ctx.root])
        handled.add(next.finding)
        continue
      }
      const made = replayCommit(ctx.git, ctx.root, fixItem.reply.sha)
      ctx.record.shaMap[fixItem.reply.sha] = made.sha
      writeJson(fp.json.replyFile, { ...fixItem.reply, sha: made.sha })
      ctx.rec.agent('review', next.name, [...made.actions, `wrote the reply ${fp.json.replyFile}`], made.how === 'tree' ? [{ kind: 'injected', why: 'the fix cherry-pick conflicted; its files were written as the origin commit holds them' }] : [])
      const fx = ctx.run('review', 'review.mjs', ['fix', '--change', name, '--round', String(kk), '--finding', next.finding, '--file', fp.json.replyFile, '--root', ctx.root])
      if (!fx.ok) {
        ctx.rec.hint(fx, 'blocked', `review.mjs fix refuses the origin's fix of ${next.finding}`)
        ctx.difference('review', `review.mjs fix refuses the origin's fix of ${next.finding}`, fx.refusal)
        // A workaround for a fix commit that touches more than the finding's file and its tests:
        // the commit made again as two, the finding's file and its tests first, the rest after
        // it, so the fix is recorded and the next round reviews the rest with it.
        const split = /touches .* besides /.test(fx.refusal ?? '') ? splitFix(ctx, made.sha, next.file) : null
        if (split) {
          ctx.record.shaMap[fixItem.reply.sha] = split.fix
          const file2 = fp.json.replyFile.replace(/\.json$/, '-2.json')
          writeJson(file2, { ...fixItem.reply, sha: split.fix })
          ctx.rec.hint(ctx.rec.agent('review', `${next.name} split`, [...split.actions, `wrote the reply ${file2}`]), 'injected', 'the origin\'s fix commit made again as two commits, so the port takes the first as the fix')
          ctx.run('review', 'dispatch.mjs', ['attempt', '--change', name, '--name', next.name, '--root', ctx.root])
          const again = ctx.run('review', 'review.mjs', ['fix', '--change', name, '--round', String(kk), '--finding', next.finding, '--file', file2, '--root', ctx.root])
          if (!again.ok) throw new Stop(again.n, `review fix refused after the split: ${again.refusal}`)
        } else throw new Stop(fx.n, `review fix refused: ${fx.refusal}`)
      }
      handled.add(next.finding)
      landed = true
      fixed = true
    }
    // non-blocking findings left: recorded with their body
    for (const id of ids.filter((x) => !handled.has(x))) {
      const body = rows.find((x) => x.id === id)?.body ?? `the origin's finding ${id}`
      const file = question(ctx, `body-${id}-r${kk}`, body)
      const d = ctx.run('review', 'review.mjs', ['disposition', '--change', name, '--finding', id, '--as', 'recorded', '--body-file', file, '--root', ctx.root])
      if (d.ok) ctx.rec.hint(d, 'injected', `the body is the origin's paragraph for ${id}`)
    }
    if (!landed) break
  }
  if (fixed) ctx.run('review', 'suite.mjs', ['run', '--change', name, '--section', 'review', '--root', ctx.root])
  ledgerWrites(ctx, 'review')
  const out = ctx.run('review', 'review.mjs', ['assemble', '--change', name, '--commit', '--root', ctx.root])
  if (!out.ok) throw new Stop(out.n, `review assemble refused: ${out.refusal}`)
  if (out.json.verdict !== 'PASS') throw new Stop(out.n, `the review verdict is ${out.json.verdict}`)
}

// ---------------------------------------------------------------- archive

// The Purpose of a capability as the origin's main spec holds it after the merge.
function originPurpose(ctx, capability) {
  const text = ctx.git.orNull(ctx.main, 'show', `${ctx.candidate.merge}:openspec/specs/${capability}/spec.md`)
  const m = /## Purpose\s*\n([\s\S]*?)\n## /.exec(text ?? '')
  return m ? m[1].trim() : null
}

function placements(ctx) {
  const { name } = ctx
  // The origin's archive-phase records first (a debt written at archive, the resolves), once,
  // then what the port still lists.
  if (!ctx.archiveLedger) ledgerWrites(ctx, 'archive')
  ctx.archiveLedger = true
  const out = ctx.run('archive', 'archive.mjs', ['placements', '--change', name, '--root', ctx.root])
  if (out.ok) return out
  for (const u of out.json.detail?.unplaced ?? []) {
    const id = u.id ?? u.finding ?? u.debt
    let args
    if (/^deviation-/.test(id ?? '')) args = ['ruling', '--change', name, '--finding', id, '--decision', 'replay: injected; the origin\'s deviation stands as a judgement about this change']
    else if (/^F\d+$/.test(id ?? '')) args = ['resolve', '--change', name, '--finding', id, '--as', 'accepted', '--where', 'replay: injected; the origin\'s review record keeps it']
    else if (/^debt-/.test(id ?? '')) args = ['resolve', '--change', name, '--debt', id, '--as', 'accepted', '--where', 'replay: injected; the origin\'s ledger has no resolve for it']
    if (!args) continue
    const w = ctx.run('archive', 'ledger.mjs', [...args, '--root', ctx.root])
    ctx.rec.hint(w, 'injected', `placement of ${id} the origin's ledger does not give`)
  }
  ctx.difference('archive', 'placements lists items the origin\'s ledger does not place', JSON.stringify((out.json.detail?.unplaced ?? []).map((u) => u.id ?? u)))
  return ctx.run('archive', 'archive.mjs', ['placements', '--change', name, '--root', ctx.root])
}

function ingest(ctx) {
  const { name } = ctx
  const stale = ctx.run('archive', 'ingest.mjs', ['stale', '--change', name, '--root', ctx.root])
  if (stale.json.state === 'none') return ctx.run('archive', 'archive.mjs', ['ingest', '--change', name, '--root', ctx.root])
  ctx.run('archive', 'dispatch.mjs', ['attempt', '--change', name, '--name', 'ingest', '--root', ctx.root])
  const prompt = dispatchPrompt(ctx, 'archive', ['--role', 'ingest'])
  if (!prompt.ok) throw new Stop(prompt.n, `ingest prompt refused: ${prompt.refusal}`)
  const item = itemOf(ctx.replies, 'archive', 'ingest')
  const why = []
  let reply
  if (item && !item.missing) {
    const at = item.source[0].commit
    const pages = item.reply.pages.map((p) => p.path)
    writeFrom(ctx.git, ctx.root, at, [...pages, ...(item.deleted ?? [])])
    const answers = ingestStaleAnswers(item, stale.json.stale ?? [])
    let staleAnswers = answers.stale
    if (!staleAnswers) {
      staleAnswers = (stale.json.stale ?? []).map((s) => (item.reply.pages.some((p) => p.path === s.path) ? { path: s.path, outcome: 'updated' } : { path: s.path, outcome: 'still-true', argument: 'replay: injected; the origin\'s ingest left the page as it was' }))
      why.push(answers.missing)
    }
    reply = { ...item.reply, stale: staleAnswers }
    ctx.rec.agent('archive', 'ingest', [`wrote ${pages.length} page(s) as ${at.slice(0, 8)} holds them`, `wrote the reply ${prompt.json.replyFile}`], why.length ? [{ kind: 'injected', why: why.join('; ') }] : [])
  } else {
    reply = { nothingLearned: true, pages: [], stale: (stale.json.stale ?? []).map((s) => ({ path: s.path, outcome: 'still-true', argument: 'replay: injected' })), invariant: '', likelyMistake: '' }
    ctx.rec.agent('archive', 'ingest', [`wrote the reply ${prompt.json.replyFile}`], [{ kind: 'injected', why: `no ingest reply (${item?.missing ?? 'no item'}); nothingLearned is injected` }])
  }
  writeJson(prompt.json.replyFile, reply)
  return ctx.run('archive', 'archive.mjs', ['ingest', '--change', name, '--reply', prompt.json.replyFile, '--root', ctx.root])
}

// The merge request body from mr-input, in the template's sections: the origin's body is not in git.
function mrBody(input) {
  const what = (input.tasks?.done ?? []).slice(0, 6).map((t) => `- ${typeof t === 'string' ? t : t.description ?? t.text ?? JSON.stringify(t)}`)
  const text = (v) => (Array.isArray(v) ? v.join(' and ') : String(v ?? '')).trim()
  const qa = (input.scenarios ?? []).slice(0, 8).map((s, i) => `${i + 1}. ${[text(s.given) && `Given ${text(s.given)}`, text(s.when) && `when ${text(s.when)}`, text(s.then) && `then ${text(s.then)}`].filter(Boolean).join(', ') || `${s.requirement}: ${s.scenario}`}`)
  return ['## What', '', ...(what.length ? what : ['- The change as its tasks describe it.']), '', '## Why', '', input.why || 'The change as its proposal describes it.', '', '## QA', '', ...(qa.length ? qa : ['1. Follow the change\'s scenarios.']), ''].join('\n')
}

function archiveStep(ctx, step) {
  const { name } = ctx
  const base = ['--change', name, '--root', ctx.root]
  switch (step) {
    case 'check':
      return ctx.run('archive', 'archive.mjs', ['check', ...base])
    case 'placements':
      return placements(ctx)
    case 'merge': {
      // The preview first; its conflicts go to spec-merge dispatches and its new capabilities get
      // their Purpose from the origin's main spec, all passed to the one merge call.
      const preview = ctx.run('archive', 'specs.mjs', ['merge', '--dry-run', '--change', name, '--root', ctx.root])
      const conflicts = preview.json.conflicts ?? []
      const files = []
      for (const cap of [...new Set(conflicts.map((c) => c.capability))]) {
        const own = conflicts.filter((c) => c.capability === cap)
        ctx.run('archive', 'dispatch.mjs', ['attempt', '--change', name, '--name', `spec-merge ${cap}`, '--root', ctx.root])
        const prompt = dispatchPrompt(ctx, 'archive', ['--role', 'spec-merge', '--capability', cap])
        if (!prompt.ok) continue
        const answer = specMergeReply(ctx.sandbox, ctx.candidate, cap, own)
        const reply = answer.reply ?? own.map((x) => ({ capability: cap, requirement: x.requirement, text: x.delta ?? '', reason: 'replay: injected; the delta as written' }))
        writeJson(prompt.json.replyFile, reply)
        const st = ctx.rec.agent('archive', `spec-merge ${cap}`, [`wrote the reply ${prompt.json.replyFile}`])
        if (!answer.reply) ctx.rec.hint(st, 'injected', answer.missing)
        const res = ctx.run('archive', 'specs.mjs', ['resolution', '--change', name, '--capability', cap, '--reply', prompt.json.replyFile, '--root', ctx.root])
        if (res.ok) files.push(prompt.json.replyFile)
      }
      const purposes = []
      for (const capability of preview.json.placeholderPurpose ?? []) {
        const text = originPurpose(ctx, capability)
        const file = join(ctx.main, '.superpowers', 'sdd', name, 'archive', `purpose-${capability}.md`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${text ?? `The ${capability} capability as the change ${name} adds it; replay: no origin Purpose found.`}\n`)
        purposes.push(`${capability}=${file}`)
        const st = ctx.rec.agent('archive', `Purpose of ${capability}`, [`wrote ${file} from the origin's main spec after the merge`])
        if (!text) ctx.rec.hint(st, 'injected', `no origin Purpose for ${capability}`)
      }
      return ctx.run('archive', 'archive.mjs', ['merge', ...base, ...files.flatMap((f) => ['--resolutions', f]), ...purposes.flatMap((x) => ['--purpose', x])])
    }
    case 'ingest':
      return ingest(ctx)
    case 'mr': {
      ctx.run('archive', 'forge.mjs', ['check', '--root', ctx.root])
      const held = ctx.run('archive', 'archive.mjs', ['mr', ...base])
      if (held.ok && held.json.state !== 'pending') return held
      const input = ctx.run('archive', 'archive.mjs', ['mr-input', ...base])
      const bodyFile = held.json.detail?.bodyFile ?? held.json.bodyFile ?? input.json.bodyFile
      writeFileSync(bodyFile, mrBody(input.json))
      ctx.rec.hint(ctx.rec.agent('archive', 'merge request body', [`wrote ${bodyFile} from mr-input`]), 'injected', 'the origin\'s merge request body is not in git; the body is written from mr-input')
      return ctx.run('archive', 'archive.mjs', ['mr', ...base, '--body', bodyFile, '--summary', ctx.summary ?? originTitle(ctx.git, ctx.root, ctx.candidate).summary])
    }
    case 'merge-local':
      return ctx.run('archive', 'archive.mjs', ['merge-local', ...base])
    case 'remove': {
      const out = ctx.run('archive', 'archive.mjs', ['remove', ...base])
      if (out.ok) ctx.root = ctx.main
      return out
    }
    default:
      return ctx.run('archive', 'archive.mjs', [step, ...base])
  }
}

function archive(ctx) {
  resolveChange(ctx, 'archive')
  const { name } = ctx
  preflight(ctx, 'archive')
  const tries = {}
  for (let i = 0; i < 40; i++) {
    const next = ctx.run('archive', 'archive.mjs', ['next', '--change', name, '--root', ctx.root])
    const step = next.json.next
    if (!step) break
    tries[step] = (tries[step] ?? 0) + 1
    if (tries[step] > 2) throw new Stop(next.n, `archive step ${step} does not settle`)
    const out = archiveStep(ctx, step)
    if (!out.ok && out.json.state !== 'degraded' && out.json.state !== 'pending') {
      ctx.difference('archive', `archive.mjs ${step} fails`, out.refusal)
      if (tries[step] >= 2) throw new Stop(out.n, `archive ${step}: ${out.refusal}`)
    }
  }
  const first = ctx.run('archive', 'archive.mjs', ['report', '--change', name, '--root', ctx.main])
  // One resume of the finished archive: a re-run of the command, from the main checkout.
  const again = ctx.run('archive', 'archive.mjs', ['next', '--change', name, '--root', ctx.main])
  const second = ctx.run('archive', 'archive.mjs', ['report', '--change', name, '--root', ctx.main])
  const strip = (j) => JSON.stringify({ ...j, window: undefined, report: String(j.report ?? '').replace(/\d+ (?:second|minute|hour|day)s? ago|age [^\n,)]*/g, '') })
  ctx.record.resume = { next: again.json.next ?? null, same: again.json.next === null && strip(first.json) === strip(second.json), complete: first.json.complete === true }
  if (!ctx.record.resume.same) ctx.rec.hint(second, 'blocked', 'the resumed archive does not give the same result')
  if (first.json.complete !== true) throw new Stop(first.n, `the archive is not complete: next ${first.json.next}`)
}

// ---------------------------------------------------------------- land

function land(ctx) {
  const { name, sandbox } = ctx
  ctx.root = ctx.main
  // The merge request merged in the fake glab, as the developer's merge leaves it.
  const all = existsSync(sandbox.forge) ? JSON.parse(readFileSync(sandbox.forge, 'utf8')) : {}
  const mr = [...(all[ctx.as]?.mrs ?? [])].reverse().find((m) => m.source_branch === (ctx.branch ?? ctx.candidate.branch))
  if (mr) {
    mr.state = 'merged'
    mr.draft = false
    mr.merged_at = new Date().toISOString()
    mr.squash_commit_sha = ctx.git(ctx.main, 'rev-parse', `refs/heads/${mr.source_branch}`)
    writeFileSync(sandbox.forge, `${JSON.stringify(all, null, 2)}\n`)
    ctx.rec.hint(ctx.rec.agent('land', 'merge the merge request', [`set !${mr.iid} merged in <S>/forge.json`]), 'injected', 'the developer\'s merge, in the fake glab')
  }
  const report = ctx.run('land', 'land.mjs', ['report', '--change', name], { cwd: ctx.main })
  if (report.json.complete || report.json.skipped) return
  const check = ctx.run('land', 'land.mjs', ['check', '--change', name], { cwd: ctx.main })
  // The command stops on a skipped check; wait runs once more against the merged request, and
  // records whether it reads it or skips as well.
  const wait = ctx.run('land', 'land.mjs', ['wait', '--change', name], { cwd: ctx.main })
  if (check.json.state === 'skipped') ctx.rec.hint(wait, 'injected', `run past a skipped check, which the command would stop at; wait is ${wait.json.state}`)
  ctx.run('land', 'land.mjs', ['report', '--change', name], { cwd: ctx.main })
}

// ---------------------------------------------------------------- the two modes

export function drive(sandbox, candidate, replies, { phases = PHASES, as = `f-${candidate.name}`.slice(0, 60), host } = {}) {
  const ctx = context(sandbox, candidate, replies, { as, mode: 'fresh' })
  ctx.branch = candidate.branch
  setUp(ctx, { host })
  return runPhases(ctx, PHASES.filter((p) => phases.includes(p)), { propose, apply, verify, review, archive, land })
}

// The origin's propose commit: the first first-parent commit of the kept branch that adds the
// change directory.
function originProposeCommit(sandbox, candidate) {
  const git = gitOf(sandbox)
  const tip = git.orNull(sandbox.cache, 'rev-parse', '--verify', `refs/remotes/origin/${candidate.branch}^{commit}`) ?? git.orNull(sandbox.cache, 'rev-parse', '--verify', `refs/heads/${candidate.branch}^{commit}`)
  if (!tip) return null
  const out = git(sandbox.cache, 'log', '--first-parent', '--reverse', '--format=%H', `${candidate.base.commit}..${tip}`, '--', `openspec/changes/${candidate.name}/`)
  return out.split('\n').filter(Boolean)[0] ?? null
}

// The description a finalize left: { adfBlocks, opsxBlocks, placeholder, ok }.
export function draftCheck(description, change) {
  const count = (s) => description.split(s).length - 1
  const own = markerFor(change)
  const origin = originMarkerFor(change)
  const adfBlocks = Math.min(count(own.open), count(own.close))
  const opsxBlocks = count(origin.open)
  const placeholder = description.includes(originPlaceholder(change))
  return { adfBlocks, opsxBlocks, placeholder, ok: adfBlocks === 1 && count(own.open) === 1 && opsxBlocks === 0 && !placeholder }
}

export function driveMidFlight(sandbox, candidate, replies, { as = `m-${candidate.name}`.slice(0, 60), host, phases = MID_FLIGHT_PHASES } = {}) {
  const ctx = context(sandbox, candidate, replies, { as, mode: 'mid-flight' })
  if (candidate.history !== 'branch' || !candidate.branch) throw new Error(`driveMidFlight: ${candidate.name} has no kept branch (history ${candidate.history})`)
  const propose = originProposeCommit(sandbox, candidate)
  if (!propose) throw new Error(`driveMidFlight: no propose commit of ${candidate.name} on ${candidate.branch}`)
  ctx.branch = candidate.branch
  ctx.record.proposeCommit = propose
  // The kept branch at the origin's propose commit, in the sandbox remote too.
  setUp(ctx, { host, refs: { [candidate.branch]: propose } })
  const { main } = ctx
  ctx.git(main, 'fetch', '-q', 'origin')
  const path = join(main, '.claude', 'worktrees', candidate.name)
  ctx.git(main, 'worktree', 'add', '-q', '-b', candidate.branch, path, `origin/${candidate.branch}`)
  ctx.git(path, 'merge', '-q', '--no-ff', '-m', `Merge branch 'develop' into ${candidate.branch}`, 'origin/develop')
  ctx.git(path, 'push', '-q', '--set-upstream', 'origin', candidate.branch)
  ctx.root = path
  ctx.rec.hint(ctx.rec.agent('host', 'the in-flight change', [`git worktree add -b ${candidate.branch} .claude/worktrees/${candidate.name} origin/${candidate.branch} (the origin's propose commit ${propose.slice(0, 8)})`, 'git merge --no-ff origin/develop (the host setup reaches the branch as the switch brings it to an in-flight change)', `git push --set-upstream origin ${candidate.branch}`]), 'injected', 'the in-flight state the switch meets, made by the driver')
  const meta = join(changeDir(ctx, path), '.openspec.yaml')
  ctx.record.pin = existsSync(meta) ? readFileSync(meta, 'utf8').trim() : null
  // The in-flight change keeps the origin's .openspec.yaml and has no .adf.json: the port reads
  // its base from there, else from the integration branch (lib/changes.mjs readChangeMeta).
  // The Draft as the origin's mr.mjs opened it: the bare placeholder sentence, outside any marker.
  const { subject, summary } = originTitle(ctx.git, main, candidate)
  ctx.summary = summary
  const all = existsSync(sandbox.forge) ? JSON.parse(readFileSync(sandbox.forge, 'utf8')) : {}
  const forge = (all[as] ??= { next: 1, mrs: [] })
  const iid = forge.next++
  forge.mrs.push({ iid, project: as, state: 'opened', draft: true, title: `Draft: ${subject}`, description: originPlaceholder(candidate.name), source_branch: candidate.branch, target_branch: 'develop', squash: true, force_remove_source_branch: true, web_url: `https://gitlab.example.invalid/replay/${as}/-/merge_requests/${iid}`, merged_at: null, merge_commit_sha: null, squash_commit_sha: null })
  writeFileSync(sandbox.forge, `${JSON.stringify(all, null, 2)}\n`)
  ctx.rec.hint(ctx.rec.agent('host', 'the origin\'s Draft', [`seeded !${iid} in <S>/forge.json: draft, description "${originPlaceholder(candidate.name)}"`]), 'injected', 'the Draft the origin\'s /opsx:propose opened')
  const record = runPhases(ctx, MID_FLIGHT_PHASES.filter((p) => phases.includes(p)), { apply, verify, review, archive })
  const after = JSON.parse(readFileSync(sandbox.forge, 'utf8'))[as]?.mrs.find((m) => m.iid === iid)
  record.draft = after ? { iid, draft: after.draft, ...draftCheck(after.description ?? '', candidate.name), description: after.description } : null
  return record
}

// Writes a run record under the sandbox: <S>/runs/<as>.json.
export function writeRunRecord(sandbox, record) {
  return writeJson(join(sandbox.root, 'runs', `${record.as}.json`), record)
}

// One line per phase, then the blocked and refused steps.
export function runReport(record) {
  const lines = [`${record.as} (${record.mode}): ${Object.entries(record.phases).map(([p, s]) => `${p} ${s.reached ? 'reached' : s.stopped ? 'stopped' : 'not run'}`).join(', ')}`]
  for (const [p, s] of Object.entries(record.phases)) if (s.stopped?.step) lines.push(`  ${p} stopped at step ${s.stopped.step}: ${String(s.stopped.reason).split('\n')[0]}`)
  for (const s of record.steps) {
    const blocked = s.classification.filter((c) => c.kind === 'blocked')
    if (s.refusal || blocked.length) lines.push(`  #${s.n} ${s.phase} ${s.command ?? s.step}: ${s.refusal ? `refused: ${String(s.refusal).split('\n')[0].slice(0, 300)}` : ''}${blocked.length ? ` [blocked: ${blocked.map((b) => b.why).join('; ').slice(0, 300)}]` : ''}`)
  }
  for (const d of record.differences) lines.push(`  difference (${d.phase}): ${d.what}`)
  if (record.resume) lines.push(`  resume: ${JSON.stringify(record.resume)}`)
  if (record.draft) lines.push(`  draft: ${JSON.stringify({ ...record.draft, description: undefined })}`)
  return lines.join('\n')
}
