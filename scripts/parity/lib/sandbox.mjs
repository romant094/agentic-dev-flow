// Dev tool: the sandbox a replay of the origin's archived changes runs in (iteration 14). The
// origin is only ever cloned FROM: nothing is checked out, fetched, pushed or written in it.
//
//   <S> = <os.tmpdir()>/adf-replay-<id>/      no `xnms` in the path: the parity tools read every
//                                            Claude Code project whose slug holds it
//     cache/             `git clone --no-hardlinks --no-checkout <origin>`, once per sandbox: a
//                        copy with no alternates, so nothing in the origin can break it
//     <name>/remote.git  bare, `--shared` from the cache: `develop` at the candidate's base and
//                        the refs given; both `origin` URLs of main point here
//     <name>/main        `--shared` clone of the cache, `develop` checked out at the base
//     bin/               logging fakes of glab, docker, psql and npx, first on PATH
//     fakes/fake.mjs     their one implementation; npx hands every call but prisma to the real
//                        npx that fakes/npx.json names, resolved outside bin/ (D4)
//     fakes/fake-jira-preload.mjs, fakes/fake-jira.mjs
//                        the sandbox's own copy of the fake Jira, the one NODE_OPTIONS preloads
//     log/<tool>.jsonl   one { argv, cwd } line per fake call
//     forge.json         the fake glab's merge requests, per candidate
//     jira.json          the fake Jira (ADF_FAKE_JIRA), preloaded into every node process
//     home/              HOME (with a .gitconfig identity); home/.claude is CLAUDE_CONFIG_DIR
//     tmp/               TMPDIR
//
// Every process of a replay runs with `sandbox.env`; `assertIsolated` refuses a candidate whose
// remote, fakes, home or alternates reach outside the sandbox.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(here, '..', '..', '..')
const PRELOAD = join(REPO, 'plugins', 'adf', 'scripts', '__tests__', 'fake-jira-preload.mjs')
const FAKE_JIRA = join(REPO, 'plugins', 'adf-jira', 'scripts', '__tests__', 'fake-jira.mjs')
export const FAKE_TOOLS = ['glab', 'docker', 'psql', 'npx']
const PREFIX = 'adf-replay-'
// Caller variables that reach a real tracker or forge, redirect git or Claude Code, carry a
// secret, or belong to the caller's agent session.
const DROPPED = /^(JIRA_|GITLAB_|GLAB_|GIT_)|^(NODE_OPTIONS|CLAUDE_PROJECT_DIR|XDG_CONFIG_HOME|SSH_AUTH_SOCK)$|^(CLAUDE|ANTHROPIC)|TOKEN|API_KEY|SECRET|PASSWORD|_PAT$/i

export const IDENTITY = { name: 'ADF Replay', email: 'replay@example.invalid' }

export function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

// The real path of `path`, or of its nearest existing ancestor joined with the rest.
function real(path) {
  const abs = resolve(path)
  if (existsSync(abs)) return realpathSync(abs)
  const parent = dirname(abs)
  return parent === abs ? abs : join(real(parent), basename(abs))
}

// The fake tools' one implementation: logs, then answers what the port's scripts ask. glab keeps
// its merge requests in forge.json, keyed by the candidate the call runs in (the first directory
// of the cwd under the sandbox), so `mr list`, `create`, `view` and `update` agree across calls.
const FAKE = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
const S = ${JSON.stringify('<S>')}
const [tool, ...argv] = process.argv.slice(2)
appendFileSync(join(S, 'log', tool + '.jsonl'), JSON.stringify({ argv, cwd: process.cwd() }) + '\\n')
if (tool === 'npx') {
  const first = argv.find((a) => !a.startsWith('-'))
  if (first === 'prisma' || /^prisma@/.test(first ?? '')) process.exit(0)
  const { real } = JSON.parse(readFileSync(join(S, 'fakes', 'npx.json'), 'utf8'))
  if (!real) { process.stderr.write('fake npx: no real npx outside the sandbox for: ' + argv.join(' ') + '\\n'); process.exit(127) }
  const out = spawnSync(real, argv, { stdio: 'inherit' })
  process.exit(out.status ?? 1)
}
if (tool !== 'glab') process.exit(0)

const fail = (message) => { process.stderr.write('fake glab: ' + message + '\\n'); process.exit(1) }
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const has = (name) => argv.includes(name)
const file = join(S, 'forge.json')
const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const rel = relative(S, process.cwd())
const project = rel === '' || rel.startsWith('..') ? '-' : rel.split(sep)[0]
const forge = (all[project] ??= { next: 1, mrs: [] })
const save = () => writeFileSync(file, JSON.stringify(all, null, 2) + '\\n')
const find = (target) => /^\\d+$/.test(target ?? '')
  ? forge.mrs.find((m) => m.iid === Number(target))
  : [...forge.mrs].reverse().find((m) => m.source_branch === target && m.state === 'opened') ?? [...forge.mrs].reverse().find((m) => m.source_branch === target)
const cmd = argv.slice(0, 2).join(' ')

if (argv[0] === '--version') console.log('glab version 1.50.0 (fake)')
else if (cmd === 'auth status') console.log('gitlab.example.invalid: Logged in as replay (fake)')
else if (cmd === 'mr list') console.log(JSON.stringify(forge.mrs.filter((m) => m.state === 'opened' && (flag('--source-branch') === undefined || m.source_branch === flag('--source-branch')))))
else if (cmd === 'mr create') {
  const iid = forge.next++
  const mr = {
    iid, project: project, state: 'opened', draft: has('--draft'), title: flag('--title') ?? '', description: flag('--description') ?? '',
    source_branch: flag('--source-branch'), target_branch: flag('--target-branch'),
    squash: has('--squash-before-merge'), force_remove_source_branch: has('--remove-source-branch'),
    web_url: 'https://gitlab.example.invalid/replay/' + project + '/-/merge_requests/' + iid,
    merged_at: null, merge_commit_sha: null, squash_commit_sha: null
  }
  if (!mr.source_branch || !mr.target_branch) fail('mr create needs --source-branch and --target-branch')
  forge.mrs.push(mr)
  save()
  console.log('\\n!' + iid + ' ' + mr.title + ' (' + mr.source_branch + ')\\n ' + mr.web_url + '\\n')
} else if (cmd === 'mr view') {
  const mr = find(argv[2])
  if (!mr) fail('404 Not Found: merge request ' + argv[2])
  console.log(JSON.stringify(mr))
} else if (cmd === 'mr update') {
  const mr = find(argv[2])
  if (!mr) fail('404 Not Found: merge request ' + argv[2])
  if (has('--ready')) mr.draft = false
  if (has('--draft')) mr.draft = true
  if (flag('--description') !== undefined) mr.description = flag('--description')
  if (flag('--title') !== undefined) mr.title = flag('--title')
  save()
  console.log('- Updated merge request !' + mr.iid + '\\n' + mr.web_url)
} else fail('unexpected ' + argv.join(' '))
`

// The real npx: the first on the caller's PATH outside the sandbox, or null.
function callerNpx(S) {
  const dirs = String(process.env.PATH ?? '').split(delimiter).filter((d) => d && !inside(S, real(d)))
  return which('npx', { PATH: dirs.join(delimiter) })
}

function writeFakes(S, realNpx) {
  mkdirSync(join(S, 'fakes'))
  mkdirSync(join(S, 'bin'))
  const impl = join(S, 'fakes', 'fake.mjs')
  writeFileSync(impl, FAKE.replace(JSON.stringify('<S>'), JSON.stringify(S)))
  writeFileSync(join(S, 'fakes', 'npx.json'), `${JSON.stringify({ real: realNpx })}\n`)
  // The fake Jira, copied so the preload resolves inside the sandbox whatever copy of the port runs.
  writeFileSync(join(S, 'fakes', 'fake-jira.mjs'), readFileSync(FAKE_JIRA, 'utf8'))
  const preload = readFileSync(PRELOAD, 'utf8')
  const from = "'../../../adf-jira/scripts/__tests__/fake-jira.mjs'"
  if (!preload.includes(from)) throw new Error(`createSandbox: ${PRELOAD} no longer imports ${from}`)
  writeFileSync(join(S, 'fakes', 'fake-jira-preload.mjs'), preload.replace(from, "'./fake-jira.mjs'"))
  const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`
  for (const tool of FAKE_TOOLS) {
    writeFileSync(join(S, 'bin', tool), `#!/bin/sh\nexec ${q(process.execPath)} ${q(impl)} ${tool} "$@"\n`, { mode: 0o755 })
  }
}

const sandboxPreload = (S) => join(S, 'fakes', 'fake-jira-preload.mjs')

function sandboxEnv(S, jira) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED.test(key)))
  return Object.assign(env, {
    HOME: join(S, 'home'),
    CLAUDE_CONFIG_DIR: join(S, 'home', '.claude'),
    XDG_CONFIG_HOME: join(S, 'home', '.config'),
    TMPDIR: join(S, 'tmp'),
    PATH: `${join(S, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    NODE_OPTIONS: `--import=${pathToFileURL(sandboxPreload(S)).href}`,
    ADF_FAKE_JIRA: jira,
    GIT_TERMINAL_PROMPT: '0'
  })
}

// The first executable named `tool` on `env.PATH`, as `which` resolves it.
export function which(tool, env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const path = join(dir, tool)
    try {
      if (!statSync(path).isFile()) continue
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return null
}

// The object directories a repository borrows from, resolved; `gitDir` is a .git or bare dir.
export function alternatesOf(gitDir) {
  const file = join(gitDir, 'objects', 'info', 'alternates')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => real(resolve(join(gitDir, 'objects'), l)))
}

// `realNpx`: the npx the fake hands every call but prisma to; by default the first on the
// caller's PATH outside the sandbox, and null for none.
export function createSandbox({ origin, id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, jiraIssues = {}, identity = IDENTITY, realNpx } = {}) {
  if (typeof origin !== 'string' || origin === '') throw new Error('createSandbox: origin is required')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`createSandbox: id "${id}" may hold only letters, digits, ".", "_" and "-"`)
  const parent = realpathSync(tmpdir())
  const S = join(parent, `${PREFIX}${id}`)
  if (S.toLowerCase().includes('xnms')) throw new Error(`refusing a sandbox at ${S}: the path contains "xnms", which the parity corpora read`)
  const originDir = realpathSync(origin)
  if (inside(originDir, S) || inside(S, originDir)) throw new Error(`refusing a sandbox at ${S}: it overlaps the origin ${originDir}`)
  mkdirSync(S) // throws when it exists: a sandbox is never reused
  for (const dir of ['log', 'tmp', 'home', join('home', '.claude'), join('home', '.config')]) mkdirSync(join(S, dir))
  writeFileSync(join(S, 'home', '.gitconfig'), `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n[init]\n\tdefaultBranch = develop\n`)
  const jira = join(S, 'jira.json')
  writeFileSync(jira, `${JSON.stringify({ issues: jiraIssues, comments: {}, calls: [] })}\n`)
  const npx = realNpx === undefined ? callerNpx(S) : realNpx
  writeFakes(S, npx)
  const env = sandboxEnv(S, jira)
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim()

  const cache = join(S, 'cache')
  git(S, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', originDir, cache)

  const sandbox = {
    root: S,
    origin: originDir,
    cache,
    bin: join(S, 'bin'),
    log: join(S, 'log'),
    jira,
    forge: join(S, 'forge.json'),
    env,
    realNpx: npx,
    candidates: {},
    git,
    // Every call the fake `tool` received, in order.
    calls(tool) {
      const file = join(S, 'log', `${tool}.jsonl`)
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    },
    // `base` and the values of `refs` are revisions the cache resolves (any origin commit: the
    // cache holds every object of the origin). A `refs` key is a branch name or a full ref.
    addCandidate(name, { base, refs = {} } = {}) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || ['cache', 'bin', 'fakes', 'log', 'home', 'tmp'].includes(name)) {
        throw new Error(`addCandidate: "${name}" is not a usable candidate name`)
      }
      if (sandbox.candidates[name]) throw new Error(`addCandidate: candidate "${name}" exists`)
      if (typeof base !== 'string' || base === '') throw new Error('addCandidate: base is required')
      const dir = join(S, name)
      mkdirSync(dir)
      const baseSha = git(cache, 'rev-parse', '--verify', `${base}^{commit}`)
      const wanted = { 'refs/heads/develop': baseSha }
      for (const [ref, rev] of Object.entries(refs)) wanted[ref.startsWith('refs/') ? ref : `refs/heads/${ref}`] = git(cache, 'rev-parse', '--verify', `${rev}^{commit}`)

      const remote = join(dir, 'remote.git')
      git(dir, 'clone', '--quiet', '--bare', '--shared', '--no-tags', cache, remote)
      git(remote, 'remote', 'remove', 'origin')
      for (const ref of git(remote, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)) {
        if (!Object.hasOwn(wanted, ref)) git(remote, 'update-ref', '-d', ref)
      }
      for (const [ref, sha] of Object.entries(wanted)) git(remote, 'update-ref', ref, sha)
      git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop')

      const main = join(dir, 'main')
      git(dir, 'clone', '--quiet', '--shared', '--no-checkout', '--no-tags', cache, main)
      git(main, 'remote', 'set-url', 'origin', remote)
      git(main, 'remote', 'set-url', '--push', 'origin', remote)
      git(main, 'fetch', '--quiet', '--prune', '--no-tags', 'origin')
      git(main, 'checkout', '--quiet', '-B', 'develop', baseSha)
      git(main, 'branch', '--quiet', '--set-upstream-to=origin/develop', 'develop')

      const candidate = { name, dir, main, remote, base: baseSha }
      sandbox.candidates[name] = candidate
      assertIsolated(sandbox, candidate)
      return candidate
    },
    destroy() {
      if (!S.startsWith(join(parent, PREFIX))) throw new Error(`destroy: ${S} is not a sandbox`)
      rmSync(S, { recursive: true, force: true })
    }
  }
  return sandbox
}

// Throws, naming every problem, unless the candidate and the sandbox environment stay inside
// the sandbox. Run it before any phase of a replay.
export function assertIsolated(sandbox, candidate) {
  const S = sandbox.root
  const { env } = sandbox
  const problems = []
  if (S.toLowerCase().includes('xnms')) problems.push(`the sandbox path ${S} contains "xnms"`)
  const realHomes = new Set([homedir(), userInfo().homedir].filter(Boolean).map(real))
  if (!env.HOME || realHomes.has(real(env.HOME))) problems.push(`HOME is the real home (${env.HOME})`)
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'XDG_CONFIG_HOME', 'ADF_FAKE_JIRA']) {
    if (!env[key] || !inside(S, real(env[key]))) problems.push(`${key} is outside the sandbox (${env[key]})`)
  }
  if (!String(env.NODE_OPTIONS ?? '').includes(pathToFileURL(sandboxPreload(S)).href)) problems.push("NODE_OPTIONS does not preload the sandbox's fake Jira")
  for (const key of Object.keys(env)) if (/^(JIRA_|GITLAB_|GLAB_)/.test(key)) problems.push(`${key} is set`)
  for (const tool of FAKE_TOOLS) {
    const found = which(tool, env)
    if (found !== join(S, 'bin', tool)) problems.push(`${tool} resolves to ${found ?? 'nothing'}, not into ${join(S, 'bin')}`)
  }
  let realNpx = null
  try {
    realNpx = JSON.parse(readFileSync(join(S, 'fakes', 'npx.json'), 'utf8')).real
  } catch (error) {
    problems.push(`fakes/npx.json is unreadable: ${error.message.split('\n')[0]}`)
  }
  if (realNpx && inside(join(S, 'bin'), real(realNpx))) problems.push(`the real npx ${realNpx} is inside the sandbox bin/, so the fake would call itself`)
  if (candidate) {
    for (const push of [false, true]) {
      let url
      try {
        url = sandbox.git(candidate.main, 'remote', 'get-url', ...(push ? ['--push'] : []), 'origin')
      } catch (error) {
        problems.push(`git remote get-url ${push ? '--push ' : ''}origin failed: ${error.message.split('\n')[0]}`)
        continue
      }
      const path = url.startsWith('file://') ? fileURLToPath(url) : url
      if (!isAbsolute(path) || !inside(S, real(path))) problems.push(`the ${push ? 'push' : 'fetch'} URL of origin is outside the sandbox (${url})`)
    }
    for (const [what, gitDir] of [['main', join(candidate.main, '.git')], ['remote.git', candidate.remote], ['cache', join(sandbox.cache, '.git')]]) {
      for (const alt of alternatesOf(gitDir)) if (!inside(S, alt)) problems.push(`the alternates of ${what} point outside the sandbox (${alt})`)
    }
  }
  if (problems.length) throw new Error(`the sandbox is not isolated:\n- ${problems.join('\n- ')}`)
  return true
}
