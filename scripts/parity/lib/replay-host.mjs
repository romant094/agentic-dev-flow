// Dev tool: the host setup of a replay (iteration 14, step 3). In one candidate's `main`, at its
// base, it runs the port's own init path as /adf:init and /adf:add run it, with the values
// recorded for the switch (iteration 15), commits the result on `develop` and pushes it to the
// sandbox remote, so a change worktree forks from a host that has ADF.
//
//   1. The Claude Code home of the sandbox: installed_plugins.json names this repository's
//      plugins at user scope, as a real install records them, and Superpowers as a stub
//      directory (the replay runs no Superpowers skill); known_marketplaces.json names this
//      repository as a directory marketplace, as a local install does.
//   2. extensions.mjs init; extensions.mjs branches --integration develop; debt.mjs root --set
//      <debt root>; extensions.mjs add <this repository's plugin directory> --config <json> for
//      each registry entry, in order (a path entry, not an installed id).
//   3. The planning guide sections the switch writes from recorded values: the whole-suite
//      command through `suite.mjs set`, the others by section.
//   4. The host checks, before any of the edits below: each refusal is recorded as it is, and
//      only the minimal edit the switch would make is applied, listed as such.
//   5. The price table: one seeded entry, since every node process of the sandbox runs under the
//      fake-Jira preload, whose fetch refuses the pricing page; archive keeps the seeded entry.
//   6. Commit on develop, push to the sandbox remote; then the host checks again, which must pass.
//
// Every edit is found from `git status` around each step, so a file a step changed without
// saying so is reported as `unclaimed`. Every script runs with `sandbox.env` and cwd in `main`.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertIsolated, REPO } from './sandbox.mjs'

export const PLUGINS = join(REPO, 'plugins')
export const MARKETPLACE = 'agentic-dev-flow'
export const SUPERPOWERS = 'superpowers@claude-plugins-official'
// The registry entries of the switch, in registry order: the stack plugins in the order their
// READMEs ask for (iteration 12); adf-maintainer is left out (its upstream role reaches GitHub).
export const ORDER = ['adf-gitlab', 'adf-memory', 'adf-english-check', 'adf-npm-workspaces', 'adf-postgres', 'adf-prisma', 'adf-jira']
export const DEBT_ROOT = '.claude/memory/tech-debt'
export const MESSAGE = 'chore(adf): set up ADF in the replay host'

// The planning guide values the lessons record for the switch, each with its source. Not origin
// content: every value is already written in docs/lessons.
export const RECORDED_GUIDE = {
  packages: { value: ['packages/shared', 'apps/server', 'apps/client'], source: 'docs/lessons/propose.md: the origin package list and its order (shared, server, client), pending: iteration 15' },
  wholeSuite: { value: 'npm test -- --force', source: 'docs/lessons/apply.md: `npm test -- --force`, a line of the host guide' },
  proof: { value: 'Cached:    0 cached', source: 'docs/lessons/verify.md: the `Cached:` line must read `0 cached`, the guide value written at the switch; the spacing is turbo\'s, as the origin\'s apply test records quote it' },
  copies: { value: ['.env'], source: 'plugins/adf-postgres/README.md: the env file the database URL is rewritten in must be a worktree copy' }
}

// The first ```json block after `marker` in `text`, parsed.
function jsonAfter(text, marker, where) {
  const at = text.indexOf(marker)
  if (at === -1) throw new Error(`${where}: no "${marker}"`)
  const m = /```json\n([\s\S]*?)\n```/.exec(text.slice(at))
  if (!m) throw new Error(`${where}: no json block after "${marker}"`)
  return JSON.parse(m[1])
}

// The registry entries with the values recorded for iteration 15: adf-jira's config from
// docs/iterations/13-tracker-jira.md `## Inputs for iteration 15`; adf-postgres's from its
// README's example for a project whose Postgres runs in the Docker container `db` (iteration 12
// recorded no block of its own); the others with no recorded value, so their defaults apply.
// `notes` name what the records say about an entry beyond its config.
export function recordedRegistry(repo = REPO) {
  const record13 = 'docs/iterations/13-tracker-jira.md'
  const jira = jsonAfter(readFileSync(join(repo, record13), 'utf8'), '## Inputs for iteration 15', record13)
  const postgresReadme = 'plugins/adf-postgres/README.md'
  const postgres = jsonAfter(readFileSync(join(repo, postgresReadme), 'utf8'), 'An example, for a project', postgresReadme)
  const notes = {
    'adf-jira': [`${record13}: the recorded entry; only its config is taken, since the replay registers the plugin by path`],
    'adf-postgres': [`${postgresReadme}: the example config, the only recorded value (iteration 12 wrote no registry block)`],
    'adf-english-check': ['docs/lessons/english-check.md: the origin\'s wider scope moves into the registry at the switch; no globs are recorded, so the defaults apply'],
    'adf-prisma': ['docs/lessons/apply.md: whether packages/shared belongs on ownClientWhen is set at the switch; nothing recorded, so the defaults apply'],
    'adf-npm-workspaces': ['no build command is recorded for the switch; the defaults apply']
  }
  const config = { 'adf-jira': jira.config, 'adf-postgres': postgres }
  return ORDER.map((name) => ({ name, path: join(PLUGINS, name), config: config[name] ?? null, notes: notes[name] ?? [] }))
}

// ---------------------------------------------------------------- the Claude Code home

// installed_plugins.json (version 2) naming this repository's plugins and a Superpowers stub, at
// user scope, and known_marketplaces.json naming this repository as a directory marketplace.
// Returns the files written, each with why.
export function installClaudeHome(sandbox) {
  const home = sandbox.env.CLAUDE_CONFIG_DIR
  const stub = join(home, 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '0.0.0-replay')
  mkdirSync(join(stub, '.claude-plugin'), { recursive: true })
  writeFileSync(join(stub, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'superpowers', version: '0.0.0-replay', description: 'replay stub: no skill runs in a script-level replay' }, null, 2)}\n`)
  const record = (installPath, version) => [{ scope: 'user', installPath, version, installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }]
  const version = (name) => JSON.parse(readFileSync(join(PLUGINS, name, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const plugins = { [SUPERPOWERS]: record(stub, '0.0.0-replay') }
  for (const name of ['adf', ...ORDER]) plugins[`${name}@${MARKETPLACE}`] = record(join(PLUGINS, name), version(name))
  const installed = join(home, 'plugins', 'installed_plugins.json')
  writeFileSync(installed, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`)
  const known = join(home, 'plugins', 'known_marketplaces.json')
  writeFileSync(known, `${JSON.stringify({ [MARKETPLACE]: { source: { source: 'directory', path: REPO }, installLocation: REPO, lastUpdated: '2026-01-01T00:00:00.000Z' } }, null, 2)}\n`)
  return [
    { path: installed, why: `${SUPERPOWERS} (a stub directory in the sandbox) and adf, ${ORDER.join(', ')} at user scope, their installPath this repository's plugin directories, as a real install records them` },
    { path: join(stub, '.claude-plugin', 'plugin.json'), why: 'the Superpowers install path the gate requires on disk; a stub, since a script-level replay runs no skill' },
    { path: known, why: `the ${MARKETPLACE} marketplace as a directory source, as a local install adds it; init then declares no marketplace in the host settings` }
  ]
}

// ---------------------------------------------------------------- running the port

function runner(sandbox, candidate) {
  const node = (script, args, { input } = {}) => {
    const run = spawnSync(process.execPath, [script, ...args], { cwd: candidate.main, env: sandbox.env, encoding: 'utf8', input, maxBuffer: 1 << 28 })
    let json = null
    try {
      json = JSON.parse(run.stdout)
    } catch {}
    return { exit: run.status, json, stdout: run.stdout, stderr: run.stderr }
  }
  const core = (name, ...args) => node(join(PLUGINS, 'adf', 'scripts', name), args)
  // A role operation through the core's own caller, in a process of the sandbox.
  const ROLE = `const [roles, point, operation] = process.argv.slice(1)
const { callRole, CORE } = await import(roles)
const { claudeHome } = await import(new URL('./superpowers.mjs', roles).href)
process.stdout.write(JSON.stringify(callRole(process.cwd(), point, operation, {}, { ...CORE, home: claudeHome() })))`
  const role = (point, operation) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', ROLE, pathToFileURL(join(PLUGINS, 'adf', 'scripts', 'lib', 'roles.mjs')).href, point, operation], { cwd: candidate.main, env: sandbox.env, encoding: 'utf8', maxBuffer: 1 << 28 })
    try {
      return JSON.parse(run.stdout)
    } catch {
      return { state: 'error', error: (run.stderr || run.stdout).trim().split('\n').slice(-5).join('\n') }
    }
  }
  return { node, core, role }
}

// The changed paths of the work tree with a hash of each one's content (null when deleted).
function snapshot(sandbox, main) {
  const out = new Map()
  // Not sandbox.git: it trims, and the first entry's status may start with a space.
  const status = execFileSync('git', ['status', '--porcelain=v1', '-uall', '-z'], { cwd: main, env: sandbox.env, encoding: 'utf8', maxBuffer: 1 << 28 })
  for (const line of status.split('\0').filter(Boolean)) {
    const path = line.slice(3)
    const file = join(main, path)
    out.set(path, existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null)
  }
  return out
}

const changedSince = (before, after) => [...after.keys()].filter((p) => before.get(p) !== after.get(p)).concat([...before.keys()].filter((p) => !after.has(p))).sort()

// ---------------------------------------------------------------- host edits the checks demand

const DEBT_COLUMNS = /^\|\s*ID\s*\|\s*Title\s*\|\s*Anchors\s*\|\s*Class\s*\|\s*Source\s*\|\s*Jira\s*\|(.*)$/
const COLUMN_ERROR = /^the columns must be ID \| Title \| Anchors \| Class \| Source \| Tracker/
const NAMED_ERROR = /^(\S+) is named but no row carries it$/

// The minimal edit for one refusal of `debt.mjs check`, applied to the tree; null when the
// refusal is not one the switch fixes by a rule, which is then left as it is.
function fixDebtRefusal(tree, error, root) {
  const file = join(tree, error.file)
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').split('\n')
  if (COLUMN_ERROR.test(error.message)) {
    const i = error.line - 1
    const m = DEBT_COLUMNS.exec(lines[i] ?? '')
    if (!m) return null
    lines[i] = `| ID | Title | Anchors | Class | Source | Tracker |${m[1]}`
    writeFileSync(file, lines.join('\n'))
    return { file: join(root, error.file), line: error.line, edit: 'the table header\'s last column renamed Jira to Tracker, the column debt.mjs checks and `track` writes (docs/lessons/memory.md, pending: iteration 15)' }
  }
  const named = NAMED_ERROR.exec(error.message)
  // The root index of the origin documents the row format with an example row; the port reads
  // every id named in the tree, so the example's id is a dangling reference.
  if (named && error.file === 'index.md') {
    const i = lines.findIndex((l, k) => k >= error.line - 3 && k <= error.line + 1 && l.startsWith('|') && l.includes(named[1]))
    if (i === -1) return null
    lines.splice(i, 1)
    writeFileSync(file, lines.join('\n'))
    return { file: join(root, error.file), line: i + 1, edit: `the example row naming ${named[1]} removed from the root index's format description; the switch replaces that description with the port's (plugins/adf/contract/debt-format.md)` }
  }
  return null
}

// ---------------------------------------------------------------- the planning guide

// Replaces the body of `heading` in the guide with `body`, keeping its HTML comments.
function setSection(text, heading, body) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at === -1) return `${text.replace(/\n*$/, '\n')}\n${heading}\n\n${body.join('\n')}\n`
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  if (end === -1) end = lines.length
  const comments = (lines.slice(at + 1, end).join('\n').match(/<!--[\s\S]*?-->/g) ?? []).flatMap((c) => c.split('\n'))
  lines.splice(at + 1, end - at - 1, '', ...(comments.length ? [...comments, ''] : []), ...body, '')
  return lines.join('\n')
}

// ---------------------------------------------------------------- the host checks

function hostChecks(run, change) {
  const init = run.core('extensions.mjs', 'init')
  const debt = run.core('debt.mjs', 'check')
  const forge = run.core('forge.mjs', 'check')
  const preflight = change ? run.core('preflight.mjs', '--phase', 'propose', '--change', change) : null
  const tracker = run.role('tracker', 'check')
  const knowledge = run.role('knowledge', 'check')
  return {
    registry: { ok: init.json?.check?.ok === true, errors: init.json?.check?.errors ?? [init.stderr.trim()], warnings: init.json?.check?.warnings ?? [], plugins: (init.json?.check?.plugins ?? []).map((p) => p.name) },
    superpowers: init.json?.superpowers ?? { ok: false, reason: init.stderr.trim() },
    branches: init.json?.branches ?? null,
    debt: { ok: debt.json?.ok === true, errors: debt.json?.errors ?? [debt.json?.error ?? debt.stderr.trim()] },
    forge: { state: forge.json?.state ?? 'error', ...(forge.json?.error ? { error: forge.json.error } : {}), ...(forge.json?.hint ? { hint: forge.json.hint } : {}) },
    tracker: { state: tracker.state, ...(tracker.error ? { error: tracker.error } : {}), ...(tracker.hint ? { hint: tracker.hint } : {}), ...(tracker.reason ? { reason: tracker.reason } : {}) },
    knowledge: { state: knowledge.state, findings: knowledge.findings ?? [], ...(knowledge.error ? { error: knowledge.error } : {}) },
    preflight: preflight && { ok: preflight.json?.ok === true, ...(preflight.json?.refusal ? { refusal: preflight.json.refusal } : {}), ...(preflight.json?.error ? { error: preflight.json.error } : {}) }
  }
}

// Whether the host checks pass: the registry, the debt tree, the Superpowers gate, a forge that is
// not refused and propose's preflight. The tracker and the knowledge base are reported only: a
// tracker without its profile or env file is `degraded`, which /adf-jira:setup and the
// developer's env file settle at the switch.
export const passed = (checks) => checks.registry.ok && checks.debt.ok && checks.superpowers.ok === true && checks.forge.state !== 'refused' && checks.forge.state !== 'error' && (checks.preflight === null || checks.preflight.ok)

// ---------------------------------------------------------------- setup

// `candidate` is a sandbox candidate (sandbox.addCandidate) at its base, with `develop` checked
// out; `change` (optional) names the change propose's preflight is run for. Returns
//   { ok, edits: [{ path, step, kind, why }], refusals: [{ check, file, line, message, edit | null }],
//     environment: [{ path, why }], unclaimed: [path], before, checks, commit, pushed, notes }
// kind: init | branches | debt-root | add | recorded | refusal | stub. `before` holds the host
// checks run before any edit of this step's own (after init, branches, the debt root and the
// plugins), so every refusal the origin tree raises is in it.
export function setupHost(sandbox, candidate, { registry = recordedRegistry(), guide = RECORDED_GUIDE, integration = 'develop', debtRoot = DEBT_ROOT, change = null, message = MESSAGE } = {}) {
  assertIsolated(sandbox, candidate)
  const { main } = candidate
  if (sandbox.git(main, 'rev-parse', '--abbrev-ref', 'HEAD') !== integration) throw new Error(`setupHost: ${main} is not on ${integration}`)
  if (sandbox.git(main, 'status', '--porcelain')) throw new Error(`setupHost: ${main} has uncommitted changes`)
  const run = runner(sandbox, candidate)
  const edits = []
  const notes = []
  const environment = installClaudeHome(sandbox)
  const unclaimed = []
  let state = snapshot(sandbox, main)
  // Runs `fn`, then lists every path it changed with the why `why(path, result)` gives; a path
  // with no why is a change the step did not announce.
  const step = (name, kind, why, fn) => {
    const result = fn()
    const now = snapshot(sandbox, main)
    for (const path of changedSince(state, now)) {
      const reason = why(path, result)
      if (!reason) unclaimed.push(path)
      edits.push({ path, step: name, kind, why: reason ?? `changed by ${name}, which did not say so` })
    }
    state = now
    return result
  }
  const refuse = (what, out) => {
    throw new Error(`setupHost: ${what} refused: ${out.json?.error ?? out.json?.refusal ?? (out.stderr || out.stdout).trim()}`)
  }

  const init = step('extensions.mjs init', 'init', (path, r) => {
    const j = r.json ?? {}
    if (path === '.claude/adf-extensions.json') return `the ADF registry, contract ${j.contract}${j.reviewPrompt?.registered ? ', with review.prompt' : ''}`
    if (path === '.claude/settings.json') return `ADF declared in the host settings: ${j.settings?.added?.join(', ') || 'nothing added'}`
    if (path === '.gitignore') return `the flow's local state ignored: ${j.gitignore?.added?.join(', ')}`
    if (path === j.planningGuide?.path) return 'the planning guide template; the team fills it in'
    if (path === j.reviewPrompt?.path) return 'the review prompt template; the team tunes its criteria'
    return null
  }, () => run.core('extensions.mjs', 'init'))
  if (init.exit !== 0 && !init.json) refuse('extensions.mjs init', init)
  notes.push(...(init.json?.settings?.notes ?? []).map((n) => `init: ${n}`))
  if (init.json?.branches === null) {
    const out = step('extensions.mjs branches', 'branches', (path) => (path === '.claude/adf-extensions.json' ? `branch policy: integration ${integration} (init detected ${init.json.detectedIntegration ?? 'none'})` : null), () => run.core('extensions.mjs', 'branches', '--integration', integration))
    if (!out.json || out.json.ok === false && out.json.error) refuse('extensions.mjs branches', out)
  }
  const root = run.core('debt.mjs', 'root')
  if (root.json?.root === null) {
    const out = step('debt.mjs root --set', 'debt-root', (path, r) => (path === '.claude/adf-extensions.json' ? `debt.root = ${debtRoot}` : path === `${debtRoot}/index.md` && r.json?.created ? 'the debt tree\'s root index' : null), () => run.core('debt.mjs', 'root', '--set', debtRoot))
    if (out.json?.ok !== true) refuse('debt.mjs root --set', out)
  } else notes.push(`debt.root was already ${root.json?.root}`)

  for (const entry of registry) {
    const args = ['add', entry.path, ...(entry.config ? ['--config', JSON.stringify(entry.config)] : [])]
    const out = step(`extensions.mjs add ${entry.name}`, 'add', (path, r) => {
      if (path === '.claude/adf-extensions.json') return `${entry.name} enabled as a path entry${entry.config ? ` with config ${JSON.stringify(entry.config)}` : ', defaults'}`
      if ((r.json?.hostFiles?.copied ?? []).includes(path)) return `a host file ${entry.name} declares, copied`
      if (path === '.claude/settings.json' && r.json?.settings?.added?.length) return `host settings added: ${r.json.settings.added.join(', ')}`
      return null
    }, () => run.core('extensions.mjs', ...args))
    if (out.json?.ok === false && out.json.error) refuse(`extensions.mjs add ${entry.name}`, out)
    notes.push(...entry.notes.map((n) => `${entry.name}: ${n}`))
  }

  // The planning guide sections the switch writes.
  if (guide) {
    const file = join(main, 'openspec', 'planning.md')
    if (guide.wholeSuite) {
      const out = step('suite.mjs set', 'recorded', (path) => (path === 'openspec/planning.md' ? `## Whole-suite command: ${guide.wholeSuite.value} (${guide.wholeSuite.source})` : null), () => run.core('suite.mjs', 'set', '--command', guide.wholeSuite.value))
      if (out.exit !== 0) refuse('suite.mjs set', out)
    }
    const sections = [
      ['## Packages', guide.packages, (v) => v.map((p) => `- \`${p}\``)],
      ['## Fresh-run proof', guide.proof, (v) => [`\`${v}\``]],
      ['## Worktree copies', guide.copies, (v) => v.map((p) => `- \`${p}\``)]
    ].filter(([, value]) => value)
    for (const [heading, value, body] of sections) {
      step(`guide ${heading}`, 'recorded', (path) => (path === 'openspec/planning.md' ? `${heading}: ${[].concat(value.value).join(', ')} (${value.source})` : null), () => writeFileSync(file, setSection(readFileSync(file, 'utf8'), heading, body(value.value))))
    }
  }

  // The checks on the tree as the switch leaves it before its own fixes: every refusal recorded.
  // Propose's preflight runs after the commit only: before it, the edits are uncommitted work.
  const before = hostChecks(run, null)
  const refusals = []
  if (!before.debt.ok) {
    const tree = join(main, debtRoot)
    for (const error of before.debt.errors) {
      if (typeof error !== 'object') {
        refusals.push({ check: 'debt.mjs check', message: String(error), edit: null })
        continue
      }
      const fixed = step('debt refusal', 'refusal', (path) => `debt.mjs check refused ${error.file}:${error.line} (${error.message})`, () => fixDebtRefusal(tree, error, debtRoot))
      refusals.push({ check: 'debt.mjs check', file: join(debtRoot, error.file), line: error.line, message: error.message, edit: fixed ? fixed.edit : null })
    }
    // An error that follows from another (an id a renamed table now carries) needs no edit of its own.
    const again = run.core('debt.mjs', 'check')
    const left = new Set((again.json?.errors ?? []).map((e) => `${e.file}:${e.line}:${e.message}`))
    for (const r of refusals) if (r.edit === null && r.file && !left.has(`${r.file.slice(debtRoot.length + 1)}:${r.line}:${r.message}`)) r.edit = 'none needed: it followed from another refusal, which its edit cleared'
  }
  for (const [name, check] of [['registry', before.registry], ['preflight', before.preflight]]) {
    if (check && !check.ok) refusals.push({ check: name, message: (check.errors ?? [check.refusal ?? check.error]).join('; '), edit: null })
  }
  if (before.superpowers.ok !== true) refusals.push({ check: 'superpowers', message: before.superpowers.reason, edit: null })
  if (before.forge.state === 'refused' || before.forge.state === 'error') refusals.push({ check: 'forge check', message: before.forge.error ?? before.forge.state, edit: null })

  // The price table: one seeded entry, so archive's failed fetch keeps it.
  const seedDate = sandbox.git(main, 'show', '-s', '--format=%cs', 'HEAD')
  step('price seed', 'stub', () => 'the price table seeded with one entry and no models: every node process of the sandbox runs under the fake-Jira preload, whose fetch refuses the pricing page, so archive keeps this entry and cost stays unpriced', () => {
    mkdirSync(join(main, '.adf', 'prices'), { recursive: true })
    writeFileSync(join(main, '.adf', 'prices', `${seedDate}.json`), `${JSON.stringify({ from: seedDate, models: {}, source: 'replay seed' }, null, 2)}\n`)
  })

  const paths = [...new Set(edits.map((e) => e.path))]
  sandbox.git(main, 'add', '--', ...paths)
  sandbox.git(main, 'commit', '-q', '-m', message)
  const commit = sandbox.git(main, 'rev-parse', 'HEAD')
  sandbox.git(main, 'push', '-q', 'origin', integration)
  const pushed = sandbox.git(candidate.remote, 'rev-parse', `refs/heads/${integration}`) === commit
  sandbox.git(main, 'fetch', '-q', 'origin')

  const checks = hostChecks(run, change)
  const dirty = sandbox.git(main, 'status', '--porcelain')
  if (dirty) notes.push(`the host checks after the commit changed the tree: ${dirty.split('\n').join('; ')}`)
  const ok = passed(checks) && pushed && unclaimed.length === 0 && !dirty
  return { ok, edits, refusals, environment, unclaimed, before, checks, commit, pushed, notes }
}

// The host edits by path, in first-change order: { path, kinds, why: [one line per step] }.
export function hostEdits(result) {
  const byPath = new Map()
  for (const e of result.edits) {
    if (!byPath.has(e.path)) byPath.set(e.path, { path: e.path, kinds: [], why: [] })
    const entry = byPath.get(e.path)
    if (!entry.kinds.includes(e.kind)) entry.kinds.push(e.kind)
    if (!entry.why.includes(e.why)) entry.why.push(e.why)
  }
  return [...byPath.values()]
}

// The edit list as text: one block per changed path, then the refusals (those that followed from
// another counted, not listed), the environment and the notes.
export function editReport(result) {
  const lines = []
  for (const e of hostEdits(result)) {
    lines.push(`${e.path} [${e.kinds.join(', ')}]`)
    for (const why of e.why) lines.push(`  - ${why}`)
  }
  const followed = result.refusals.filter((r) => r.edit?.startsWith('none needed'))
  for (const r of result.refusals.filter((r) => !followed.includes(r))) lines.push(`refusal ${r.check}${r.file ? ` ${r.file}:${r.line}` : ''}: ${r.message} -> ${r.edit ?? 'no edit: left as it is'}`)
  if (followed.length) lines.push(`refusal ${followed.length} more of debt.mjs check followed from the refusals above and cleared with them`)
  for (const e of result.environment) lines.push(`home ${e.path}: ${e.why}`)
  for (const n of result.notes) lines.push(`note ${n}`)
  return lines.join('\n')
}
