// The `forge` role on GitLab, through the `glab` CLI: `check` reports whether glab can be used,
// `open` pushes a change branch and opens (or reuses) its merge request, `push` pushes the
// branch alone, `finalize` writes the change's description, takes the merge request out of
// draft and pushes the last commit.
//
// Every operation returns one result object with `state`: `done`, `degraded` (glab is missing
// or not logged in: nothing was sent, and `fallback` says what to run later) or `refused`
// (with `error`). The role never merges and never sets a reviewer, label or milestone:
// integration is the developer's action.
//
// Every git and glab call goes through the injected `run(cmd, args, opts)`, which returns
// { status, stdout, stderr }, so no test touches the network or a real repository. The file
// system is injected too (exists, readFile, saveInput).
import { join } from 'node:path'

export const HOST_TEMPLATE = '.gitlab/merge_request_templates/adf.md'
export const PLUGIN_TEMPLATE = 'templates/merge_request.md'
const NOTHING_SENT = 'nothing was pushed and no merge request was touched'

const ok = (result) => result?.status === 0
const output = (result) => `${result?.stderr ?? ''}${result?.stdout ?? ''}`.trim()
const refused = (error) => ({ state: 'refused', error })

// Fallback commands are printed for a POSIX shell; one argument per quoted word.
export const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

export function installHint(platform) {
  if (platform === 'win32') return 'winget install -e --id GitLab.GLab (or, inside WSL: brew install glab)'
  return 'brew install glab'
}

// The host of a remote URL: `git@host:group/p.git`, `ssh://git@host:2222/group/p.git` or
// `https://host/group/p.git`. An ssh port is not the web port, so it is dropped; an https
// port is kept.
export function hostFromRemote(url) {
  const text = String(url ?? '').trim()
  const scp = /^[^/@\s]+@([^:/\s]+):/.exec(text)
  if (scp) return scp[1]
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'ssh:') return parsed.hostname || null
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.host || null
  } catch {
    // not a URL
  }
  return null
}

// A bare `glab auth login` defaults to gitlab.com and authenticates the wrong instance of a
// self-hosted GitLab, so the hint names the host.
export function loginHint(host) {
  return host ? `glab auth login --hostname ${host}` : 'glab auth login'
}

function configuredHost({ run, root, config }) {
  if (typeof config.host === 'string' && config.host.trim() !== '') return config.host.trim()
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'])
  return ok(remote) ? hostFromRemote(remote.stdout) : null
}

export function detectTool(ctx) {
  const { run, root, platform } = ctx
  if (!ok(run('glab', ['--version'], { cwd: root }))) {
    return { state: 'degraded', tool: 'missing', hint: installHint(platform) }
  }
  if (!ok(run('glab', ['auth', 'status'], { cwd: root }))) {
    return { state: 'degraded', tool: 'unauthenticated', hint: loginHint(configuredHost(ctx)) }
  }
  return { state: 'done', tool: 'ready' }
}

const toolMessage = (tool) =>
  tool === 'missing' ? `glab is not installed, so ${NOTHING_SENT}.` : `glab is installed but not authenticated, so ${NOTHING_SENT}.`

// Never --force, and never a refspec naming anything but this branch: a push is not locally
// reversible. `ci: false` asks GitLab to create no pipeline for this push (`-o ci.skip`); the
// option is a push option, never a marker in a title or a commit message.
export function pushArgs(root, branch, ci = true) {
  return ['-C', root, 'push', ...(ci === false ? ['-o', 'ci.skip'] : []), '--set-upstream', 'origin', branch]
}

// ---------------------------------------------------------------- the description

export function templateSections(text) {
  return [...String(text).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
}

// The host's installed copy wins, so a team that edits its template edits what is validated.
export function readTemplate({ root, pluginDir, exists, readFile }) {
  const host = join(root, HOST_TEMPLATE)
  return readFile(exists(host) ? host : join(pluginDir, PLUGIN_TEMPLATE))
}

// A comment-only section counts as empty: the template's guidance comments are not content.
export function parseBody(text, required) {
  const sections = {}
  for (const part of String(text).split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const name = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = nl === -1 ? '' : part.slice(nl + 1)
    sections[name] = body.replace(/<!--[\s\S]*?-->/g, '').trim()
  }
  const missing = required.filter((n) => !Object.hasOwn(sections, n))
  const empty = required.filter((n) => Object.hasOwn(sections, n) && sections[n] === '')
  return { ok: missing.length === 0 && empty.length === 0, missing, empty, sections }
}

export function markerFor(change) {
  return { open: `<!-- adf:${change} -->`, close: `<!-- /adf:${change} -->` }
}

export function mergeDescription(existing, change, block) {
  const { open, close } = markerFor(change)
  const wrapped = `${open}\n${block.trim()}\n${close}`
  const start = existing.indexOf(open)
  if (start === -1) return existing.trim() === '' ? `${wrapped}\n` : `${existing.trimEnd()}\n\n${wrapped}\n`
  const end = existing.indexOf(close, start)
  // Guessing where someone else's block ends is how the other change's text gets eaten.
  if (end === -1) throw new Error(`unclosed marker for change "${change}"`)
  return existing.slice(0, start) + wrapped + existing.slice(end + close.length)
}

// Written inside the change's marker, so `finalize` replaces it rather than leaving it above
// the final description.
export function placeholder(change) {
  return mergeDescription('', change, `Draft for change ${change}. The description is written when the change is finalized.`)
}

// ---------------------------------------------------------------- input

function validate(input, fields) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object'
  for (const field of fields) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') return `input.${field} is required`
  }
  if (!Array.isArray(input.protected) || !input.protected.every((b) => typeof b === 'string')) {
    return 'input.protected must be a list of branch names'
  }
  // An integration branch is reached only through a merge request the developer merges.
  if (input.protected.includes(input.branch)) return `refusing to act on the protected branch "${input.branch}"`
  if (input.draft !== undefined && typeof input.draft !== 'boolean') return 'input.draft must be true or false'
  if (input.ci !== undefined && typeof input.ci !== 'boolean') return 'input.ci must be true or false'
  return null
}

function options(config) {
  return {
    squash: config.squash !== false,
    removeSourceBranch: config.removeSourceBranch !== false
  }
}

function createArgs({ branch, base, title, draft, description }, config) {
  const { squash, removeSourceBranch } = options(config)
  return [
    'mr',
    'create',
    ...(draft ? ['--draft'] : []),
    '--source-branch',
    branch,
    '--target-branch',
    base,
    ...(squash ? ['--squash-before-merge'] : []),
    ...(removeSourceBranch ? ['--remove-source-branch'] : []),
    '--title',
    title,
    '--description',
    description
  ]
}

const created = (result) => {
  const match = /(https?:\/\/\S+?\/-\/merge_requests\/(\d+))/.exec(result.stdout ?? '')
  return match ? { number: Number(match[2]), url: match[1] } : { number: null, url: null }
}

// Parse rather than compare the raw text against '[]': a warning line or a pager artefact on
// stdout is neither '' nor '[]', and a string comparison reads it as "a merge request exists".
function listOpen(run, root, branch) {
  const listed = run('glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'], { cwd: root })
  if (!ok(listed)) return { error: `could not list merge requests for ${branch}: ${output(listed)}` }
  try {
    const list = JSON.parse(listed.stdout)
    if (!Array.isArray(list)) throw new Error('not a list')
    return { list }
  } catch {
    return { error: `could not read the merge request list for ${branch}` }
  }
}

// ---------------------------------------------------------------- operations

export function check(ctx) {
  const tool = detectTool(ctx)
  return tool.state === 'done' ? tool : { ...tool, message: toolMessage(tool.tool) }
}

export function open(ctx) {
  const { run, root, config, input } = ctx
  const problem = validate(input, ['change', 'branch', 'base', 'title'])
  if (problem) return refused(`${problem}; ${NOTHING_SENT}.`)
  const draft = input.draft ?? true
  const mr = { ...input, draft, description: placeholder(input.change) }

  const tool = detectTool(ctx)
  if (tool.state !== 'done') {
    // The branch is not on origin yet, so the create command alone would fail: the push it
    // depends on comes first.
    return {
      ...tool,
      message: toolMessage(tool.tool),
      fallback: [
        `cd ${quote(root)}`,
        `git push ${input.ci === false ? '-o ci.skip ' : ''}--set-upstream origin ${quote(input.branch)}`,
        ['glab', ...createArgs(mr, config).map((a) => (a.startsWith('--') || a === 'mr' || a === 'create' ? a : quote(a)))].join(' ')
      ]
    }
  }
  if (!ok(run('git', pushArgs(root, input.branch, input.ci)))) return refused('git push failed; no merge request was touched.')
  const listed = listOpen(run, root, input.branch)
  if (listed.error) return refused(`${listed.error}; the branch was pushed, but no merge request was created or reused.`)
  if (listed.list.length > 0) {
    const [first] = listed.list
    return { state: 'done', number: first.iid ?? null, url: first.web_url ?? null, reused: true }
  }
  const result = run('glab', createArgs(mr, config), { cwd: root })
  if (!ok(result)) return refused(`could not create the merge request: ${output(result)}; the branch was pushed.`)
  return { state: 'done', ...created(result), reused: false }
}

export function finalize(ctx) {
  const { run, root, config, input } = ctx
  const problem = validate(input, ['change', 'branch', 'base', 'title', 'body'])
  if (problem) return refused(`${problem}; ${NOTHING_SENT}.`)
  const parsed = parseBody(input.body, templateSections(readTemplate(ctx)))
  if (!parsed.ok) {
    return refused(`Description rejected; nothing was sent. Missing: [${parsed.missing.join(', ')}] Empty: [${parsed.empty.join(', ')}]`)
  }
  const { change, branch, body } = input

  const tool = detectTool(ctx)
  if (tool.state !== 'done') {
    // The rerun reads the existing description and merges this change's block into it, so
    // other changes' blocks and hand-written prose survive; a bare `glab mr update
    // --description-file` would replace them all.
    const file = ctx.saveInput({ root, config, input })
    return {
      ...tool,
      message: toolMessage(tool.tool),
      inputFile: file,
      fallback: [`node ${quote(join(ctx.pluginDir, 'scripts', 'forge.mjs'))} finalize --input-file ${quote(file)}`]
    }
  }

  const listed = listOpen(run, root, branch)
  if (listed.error) return refused(`${listed.error}; ${NOTHING_SENT}.`)
  if (listed.list.length === 0) {
    // No merge request was ever opened (open degraded and nobody created one by hand). Open
    // it ready, with the final description. The branch must be on origin before the create.
    if (!ok(run('git', pushArgs(root, branch, input.ci)))) return refused('git push failed; no merge request was touched.')
    const description = mergeDescription('', change, body)
    const result = run('glab', createArgs({ ...input, draft: false, description }, config), { cwd: root })
    if (!ok(result)) return refused(`could not create the merge request: ${output(result)}; the branch was pushed.`)
    return { state: 'done', ...created(result), created: true }
  }

  // review-ignore-start: CWE-20 — `glab mr view <branch>` and `glab mr update <branch>` pass a
  // branch name where a review round expected an integer IID. glab documents the positional
  // as `[<id> | <branch>]` for these subcommands, verified against glab 1.113.0: `mr view
  // <branch>` returned the merge request with a matching `source_branch`, and `mr update
  // <branch> --ready` resolved to it and applied. `--source-branch` is not a flag of these
  // subcommands.
  const current = run('glab', ['mr', 'view', branch, '--output', 'json'], { cwd: root })
  // Falling back to an empty description would make the merge see no markers and drop another
  // change's block, whether the call failed or returned unparsable JSON: read it or change
  // nothing. Only a missing or null `description` in valid JSON is genuinely empty.
  if (!ok(current)) return refused('Could not read the existing merge request description; nothing was changed.')
  let view
  try {
    view = JSON.parse(current.stdout)
  } catch {
    return refused('Could not read the existing merge request description; nothing was changed.')
  }
  let merged
  try {
    merged = mergeDescription(view?.description ?? '', change, body)
  } catch (error) {
    return refused(`${error.message}; nothing was changed.`)
  }
  // Undraft BEFORE the push: changing a title starts no pipeline, so a push that lands while
  // the title still says Draft runs CI's draft rule and skips the review for that commit.
  const ready = run('glab', ['mr', 'update', branch, '--ready', '--description', merged], { cwd: root })
  // review-ignore-end
  if (!ok(ready)) return refused(`Could not take the merge request out of draft: ${output(ready)}; the final commit was not pushed.`)
  if (!ok(run('git', pushArgs(root, branch, input.ci)))) {
    return refused(
      'The merge request is out of draft with the final description, but the last commit failed to push; push the branch by hand to finish.'
    )
  }
  return { state: 'done', number: view?.iid ?? null, url: view?.web_url ?? null, created: false }
}

// Pushes the change branch and changes nothing else. It needs only git, so it never degrades
// on glab. A Draft runs no pipeline, so this push is a backup and a progress signal; it gates
// nothing.
export function push(ctx) {
  const { run, root, input } = ctx
  const problem = validate(input, ['change', 'branch'])
  if (problem) return refused(`${problem}; nothing was pushed and nothing else changed.`)
  const current = run('git', ['-C', root, 'branch', '--show-current'])
  if (!ok(current)) return refused(`could not read the current branch of ${root}: ${output(current)}; nothing was pushed and nothing else changed.`)
  const checkedOut = current.stdout.trim()
  if (checkedOut !== input.branch) {
    // A group worktree has its group branch checked out: a push from it pushes the group
    // branch, not the change branch. Push from the main change worktree.
    return refused(
      `${root} has "${checkedOut || '(detached HEAD)'}" checked out, not the change branch "${input.branch}"; a push from a group worktree pushes the group branch instead of the change branch, so run it from the main change worktree. Nothing was pushed and nothing else changed.`
    )
  }
  const pushed = run('git', pushArgs(root, input.branch, input.ci))
  if (!ok(pushed)) return refused(`git push failed: ${output(pushed)}; nothing else changed.`)
  return { state: 'done' }
}

export const OPERATIONS = { check, open, push, finalize }

// Runs one operation on the payload the core writes: { root, config, input }. Returns the exit
// code and the result object. An unexpected error is a refusal that says what was already sent.
export function runOperation(operation, payload, ctx) {
  const sent = []
  const run = (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('push')) sent.push('the branch was pushed')
    if (cmd === 'glab' && args[0] === 'mr' && (args[1] === 'create' || args[1] === 'update')) sent.push(`glab mr ${args[1]} was called`)
    return ctx.run(cmd, args, opts)
  }
  try {
    if (!Object.hasOwn(OPERATIONS, operation)) {
      return { code: 1, result: refused(`unknown operation "${operation}", expected ${Object.keys(OPERATIONS).join(', ')}; ${NOTHING_SENT}.`) }
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { code: 1, result: refused(`the input must be a JSON object; ${NOTHING_SENT}.`) }
    }
    const { root, config = {}, input = {} } = payload
    if (typeof root !== 'string' || root.trim() === '') return { code: 1, result: refused(`root is required; ${NOTHING_SENT}.`) }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { code: 1, result: refused(`config must be an object; ${NOTHING_SENT}.`) }
    }
    const result = OPERATIONS[operation]({ ...ctx, run, root, config, input })
    return { code: result.state === 'refused' ? 1 : 0, result }
  } catch (error) {
    const what = sent.length ? `${[...new Set(sent)].join(' and ')} before the error` : NOTHING_SENT
    return { code: 1, result: refused(`${error.message}; ${what}.`) }
  }
}
