#!/usr/bin/env node
// Dev tool: compares the GitLab forge role (plugins/gitlab/scripts/lib/forge.mjs) with the
// origin's .claude/scripts/mr.mjs. The origin module is imported, never run as a script, and
// both sides are driven in process by the same fake `run` over a scenario matrix: no git or
// glab command runs and nothing is written in the origin project.
//
//   node scripts/parity/origin-mr.mjs <origin project root>
//
// Per scenario, both sides yield the sequence of git and glab calls, the outcome class (done,
// degraded, refused) and, when degraded, the kinds of the fallback commands. Normalized away
// on both sides before comparing: the origin's `git rev-parse` (it reads the branch from HEAD;
// ours takes it as input), the tool probe (`which glab` and `glab --version`), `git -C <root>`,
// and the output form (the origin prints prose and returns an exit code; ours returns one JSON
// object). A difference is explained only when it is one the lessons file
// (docs/lessons/forge-gitlab.md) records as deliberate:
//   target-from-base         the merge request targets the change's base, not a literal develop
//   branch-from-input        `glab mr create` names the source branch it was given
//   placeholder-in-marker    the Draft's placeholder sits inside the change's marker block and
//                            names no command
//   marker-adf               the description markers are `adf:<change>`, not `opsx:<change>`
//   finalize-opens-missing   finalize lists the branch's open merge requests first, and opens
//                            a ready one (push, then create) when none exists
//   degraded-finalize-rerun  the degraded finalize leaves a rerun of itself on a saved input
//                            file, not a bare `glab mr update --description-file`
//   host-from-remote         without a configured host, the login hint reads the origin remote
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeDescription, placeholder, runOperation } from '../../plugins/gitlab/scripts/lib/forge.mjs'

const origin = process.argv[2]
const originScript = origin && join(origin, '.claude', 'scripts', 'mr.mjs')
if (!originScript || !existsSync(originScript)) {
  console.error('usage: origin-mr.mjs <origin project root with .claude/scripts/mr.mjs>')
  process.exit(2)
}
const theirs = await import(pathToFileURL(originScript).href)
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'gitlab')

// ---------------------------------------------------------------- normalized calls

const ROOT = '/parity/host'
const flag = (args, name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

// One normalized string per call, or null for a call normalized away.
function kindOf(cmd, args) {
  if (cmd === 'which' && args[0] === 'glab') return 'probe'
  if (cmd === 'git') {
    const a = args[0] === '-C' ? args.slice(2) : args
    if (a[0] === 'rev-parse') return null
    if (a[0] === 'push') return `push ${a.slice(1).join(' ')}`
    if (a[0] === 'remote') return `remote ${a.slice(1).join(' ')}`
    return `git ${a.join(' ')}`
  }
  if (cmd === 'glab') {
    if (args[0] === '--version') return 'probe'
    if (args[0] === 'auth') return 'auth'
    const [, sub, ...rest] = args
    if (sub === 'list') return `list ${flag(rest, '--source-branch')}`
    if (sub === 'view') return `view ${rest[0]}`
    if (sub === 'update') return `update ${rest[0]} ready=${rest.includes('--ready')} description=${flag(rest, '--description')}`
    if (sub === 'create') {
      const source = flag(rest, '--source-branch')
      return [
        'create',
        `draft=${rest.includes('--draft')}`,
        ...(source ? [`source=${source}`] : []),
        `target=${flag(rest, '--target-branch')}`,
        `squash=${rest.includes('--squash-before-merge')}`,
        `remove=${rest.includes('--remove-source-branch')}`,
        `title=${flag(rest, '--title')}`,
        `description=${flag(rest, '--description')}`
      ].join(' ')
    }
  }
  return `${cmd} ${args.join(' ')}`
}

// The kind of each fallback command: what it does, not how it is quoted.
const fallbackKind = (command) => {
  if (/^cd /.test(command)) return null
  if (/^git push/.test(command)) return 'push'
  if (/^glab mr create/.test(command)) return `create target=${/--target-branch '?([^ ']+)/.exec(command)?.[1]}`
  if (/^glab mr update/.test(command)) return 'update'
  if (/ finalize --input-file /.test(command)) return 'rerun finalize'
  return command
}

// ---------------------------------------------------------------- scenarios

const CHANGE = 'my-change'
const BRANCH = 'feat/x'
const BASE = 'release/2'
const URL7 = 'https://gitlab.example.com/g/p/-/merge_requests/7'
const good = '## What\n- did a thing\n\n## Why\nbecause.\n\n## QA\n1. open the page\n'
const base = {
  argv: ['--title', 't', '--change', CHANGE],
  input: { change: CHANGE, branch: BRANCH, base: BASE, title: 't', protected: ['develop', 'main'] },
  config: { host: 'gitlab.promwad.com' },
  head: BRANCH,
  probe: true,
  auth: true,
  push: true,
  // What `glab mr list` answers for ours at finalize; the origin never lists there.
  finalList: JSON.stringify([{ iid: 7, web_url: URL7 }])
}
const scenarios = []
const add = (name, op, over = {}) => {
  const s = { ...base, ...over, name, op }
  s.input = { ...base.input, ...(op === 'finalize' ? { body: good } : {}), ...over.input }
  if (op === 'finalize') s.argv = over.argv ?? ['--body-file', 'body.md', '--change', CHANGE]
  scenarios.push(s)
}

for (const op of ['open', 'finalize']) {
  add('missing glab', op, { probe: false })
  add('unauthenticated', op, { auth: false })
  add('unauthenticated, host from remote', op, { auth: false, config: {} })
  add('protected develop', op, { head: 'develop', input: { branch: 'develop' } })
  add('protected main', op, { head: 'main', input: { branch: 'main' } })
  add('detached HEAD', op, { head: 'HEAD', input: { branch: '' } })
  add('missing change', op, { argv: op === 'open' ? ['--title', 't'] : ['--body-file', 'body.md'], input: { change: undefined } })
}
add('missing title', 'open', { argv: ['--change', CHANGE], input: { title: undefined } })
add('push fails', 'open', { push: false })
add('list fails', 'open', { list: { ok: false, stdout: '' } })
add('list unparsable', 'open', { list: { ok: true, stdout: 'warning: a new version of glab is available\n' } })
add('list existing', 'open', { list: { ok: true, stdout: JSON.stringify([{ iid: 7, web_url: URL7 }]) } })
add('list none, create fails', 'open', { list: { ok: true, stdout: '[]' }, create: { ok: false, stdout: '403' } })
add('list none, create ok', 'open', { list: { ok: true, stdout: '[]' }, create: { ok: true, stdout: `${URL7}\n` } })

const view = (description) => ({ ok: true, stdout: JSON.stringify({ iid: 7, web_url: URL7, description }) })
const marked = (text) => (prefix) => text.replaceAll('{M}', prefix)
add('missing body section', 'finalize', { input: { body: '## What\n- x\n\n## Why\ny\n' } })
add('comment-only section', 'finalize', { input: { body: '## What\n- x\n\n## Why\n<!-- todo -->\n\n## QA\n1. y\n' } })
add('view fails', 'finalize', { view: { ok: false, stdout: '' } })
add('view unparsable', 'finalize', { view: { ok: true, stdout: 'A new version of glab is available\n' } })
add('null description', 'finalize', { view: view(null), update: true })
add('empty description', 'finalize', { view: view(''), update: true })
add('prose outside markers', 'finalize', { view: view('Please read the ticket first.'), update: true })
add('sibling block kept', 'finalize', { view: view(marked('<!-- {M}:other -->\nOTHER\n<!-- /{M}:other -->')), update: true })
add('own block replaced', 'finalize', {
  view: view(marked('Prose.\n\n<!-- {M}:my-change -->\nOLD\n<!-- /{M}:my-change -->\n\n<!-- {M}:other -->\nO\n<!-- /{M}:other -->')),
  update: true
})
add('unclosed marker', 'finalize', { view: view(marked('<!-- {M}:my-change -->\nA')), update: true })
add('undraft fails', 'finalize', { view: view(''), update: false })
add('push after undraft fails', 'finalize', { view: view(''), update: true, push: false })
add('no merge request at finalize', 'finalize', {
  view: { ok: false, stdout: '' },
  finalList: '[]',
  create: { ok: true, stdout: `${URL7}\n` },
  noMr: true
})

// ---------------------------------------------------------------- the fake run

const resolveText = (value, prefix) => (typeof value === 'function' ? value(prefix) : value)

function fakeRun(s, side) {
  const prefix = side === 'theirs' ? 'opsx' : 'adf'
  const calls = []
  const answer = (cmd, args) => {
    const kind = kindOf(cmd, args)
    if (kind !== null) calls.push(kind)
    const yes = (stdout = '') => ({ ok: true, stdout })
    const no = { ok: false, stdout: '' }
    if (kind === null) return yes(`${s.head}\n`)
    if (kind === 'probe') return s.probe ? yes('glab') : no
    if (kind === 'auth') return s.auth ? yes() : no
    if (kind.startsWith('remote')) return yes('git@gitlab.promwad.com:g/p.git\n')
    if (kind.startsWith('push')) return s.push ? yes() : no
    if (kind.startsWith('list')) return s.op === 'finalize' ? yes(s.finalList) : (s.list ?? no)
    if (kind.startsWith('create')) return s.create ?? no
    if (kind.startsWith('view')) {
      const v = s.view ?? no
      return { ok: v.ok, stdout: resolveText(v.stdout, prefix) }
    }
    if (kind.startsWith('update')) return s.update ? yes() : no
    return no
  }
  if (side === 'theirs') return { calls, run: (cmd, args) => answer(cmd, args) }
  return {
    calls,
    run: (cmd, args) => {
      const r = answer(cmd, args)
      return { status: r.ok ? 0 : 1, stdout: r.stdout, stderr: '' }
    }
  }
}

// View descriptions are functions of the marker prefix; resolve them per side.
const sideView = (s, prefix) => (s.view ? { ...s.view, stdout: resolveText(s.view.stdout, prefix) } : s.view)

function runTheirs(s) {
  const { run, calls } = fakeRun({ ...s, view: sideView(s, 'opsx') }, 'theirs')
  const lines = []
  const { log, error } = console
  console.log = (line) => lines.push(String(line))
  console.error = (line) => lines.push(String(line))
  let code
  try {
    code = s.op === 'open' ? theirs.ensureDraft({ run, platform: 'darwin', argv: s.argv }) : theirs.finalize({ run, platform: 'darwin', argv: s.argv, read: () => s.input.body })
  } catch {
    code = 1
  } finally {
    console.log = log
    console.error = error
  }
  const fallback = lines.find((l) => l.startsWith('When you have it, run: '))
  if (code !== 0) return { calls, outcome: 'refused' }
  if (fallback) return { calls, outcome: 'degraded', fallback: fallback.slice('When you have it, run: '.length).split(' && ').map(fallbackKind).filter(Boolean) }
  return { calls, outcome: 'done' }
}

function runOurs(s) {
  const { run, calls } = fakeRun({ ...s, view: sideView(s, 'adf') }, 'ours')
  const ctx = {
    run,
    platform: 'darwin',
    pluginDir,
    exists: () => false,
    readFile: (path) => readFileSync(path, 'utf8'),
    saveInput: () => '/parity/tmp/finalize.json'
  }
  const { result } = runOperation(s.op, { root: ROOT, config: s.config, input: s.input }, ctx)
  const out = { calls, outcome: result.state }
  if (result.state === 'degraded') out.fallback = result.fallback.map(fallbackKind).filter(Boolean)
  return out
}

// ---------------------------------------------------------------- explanations

const mapCalls = (r, f) => ({ ...r, calls: r.calls.map(f) })
const EXPLANATIONS = [
  [
    'target-from-base',
    (r, s) => ({
      ...mapCalls(r, (c) => c.replace(' target=develop ', ` target=${s.input.base} `)),
      ...(r.fallback ? { fallback: r.fallback.map((c) => c.replace('target=develop', `target=${s.input.base}`)) } : {})
    })
  ],
  ['branch-from-input', (r, s) => mapCalls(r, (c) => c.replace(/^create (draft=\w+) /, `create $1 source=${s.input.branch} `))],
  [
    'placeholder-in-marker',
    (r, s) =>
      mapCalls(r, (c) =>
        c.replace(
          ` description=Draft opened by /opsx:propose for change ${s.input.change}. Description is written at archive.`,
          ` description=${placeholder(s.input.change)}`
        )
      )
  ],
  ['marker-adf', (r) => mapCalls(r, (c) => (c.startsWith('update ') ? c.replace(/<!-- (\/?)opsx:/g, '<!-- $1adf:') : c))],
  [
    'finalize-opens-missing',
    (r, s) => {
      if (s.op !== 'finalize') return r
      if (s.noMr) {
        const { branch, base: target, title, change, body } = s.input
        const create = `create draft=false source=${branch} target=${target} squash=true remove=true title=${title} description=${mergeDescription('', change, body)}`
        return { calls: [...r.calls.filter((c) => !c.startsWith('view ')), `list ${branch}`, `push --set-upstream origin ${branch}`, create], outcome: 'done' }
      }
      const at = r.calls.findIndex((c) => c.startsWith('view '))
      return at === -1 ? r : { ...r, calls: [...r.calls.slice(0, at), `list ${s.input.branch}`, ...r.calls.slice(at)] }
    }
  ],
  ['degraded-finalize-rerun', (r, s) => (s.op === 'finalize' && r.outcome === 'degraded' ? { ...r, fallback: ['rerun finalize'] } : r)],
  [
    'host-from-remote',
    (r, s) => {
      const at = r.calls.indexOf('auth')
      if (s.config.host || s.auth || at === -1) return r
      return { ...r, calls: [...r.calls.slice(0, at + 1), 'remote get-url origin', ...r.calls.slice(at + 1)] }
    }
  ]
]

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const differences = []
for (const s of scenarios) {
  const their = runTheirs(s)
  const ours = runOurs(s)
  if (same(their, ours)) continue
  let expected = their
  const reasons = []
  for (const [reason, apply] of EXPLANATIONS) {
    const next = apply(expected, s)
    if (!same(next, expected)) reasons.push(reason)
    expected = next
  }
  differences.push({ case: `${s.op}: ${s.name}`, theirs: their, ours, explained: same(expected, ours) ? reasons : null })
}

const unexplained = differences.filter((d) => d.explained === null)
const byReason = {}
for (const d of differences) for (const reason of d.explained ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1
console.log(JSON.stringify({ compared: scenarios.length, differences: differences.length, explained: byReason, unexplained }, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
