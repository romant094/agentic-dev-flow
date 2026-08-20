#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The forge host is deployment-specific. GITLAB_HOST is the explicit override;
// CI_SERVER_HOST is already set inside GitLab CI, so a pipeline needs no extra config.
// The fallback is a visible placeholder rather than a real hostname: an unset value then
// shows up in the auth hint instead of silently pointing somebody at the wrong server.
const HOST = process.env.GITLAB_HOST || process.env.CI_SERVER_HOST || '<your-gitlab-host>'

export const REQUIRED_SECTIONS = ['What', 'Why', 'QA']

export function installHint(platform) {
  if (platform === 'win32') {
    return 'winget install -e --id GitLab.GLab (or, inside WSL: brew install glab)'
  }
  return 'brew install glab'
}

// Injected `run` keeps every test off the real filesystem and off the network,
// matching check-sdd-workspace.mjs.
export function detectTool({ run, platform }) {
  if (!run('which', ['glab']).ok) {
    return {
      state: 'missing',
      message: `glab is not installed, so no merge request was touched. Install it with: ${installHint(platform)}`
    }
  }
  if (!run('glab', ['auth', 'status']).ok) {
    return {
      state: 'unauthenticated',
      message: `glab is installed but not authenticated, so no merge request was touched. Run: glab auth login --hostname ${HOST}`
    }
  }
  return { state: 'ready', message: '' }
}

// Never --force, and never a refspec naming anything but this branch: a push is not
// locally reversible.
export function pushArgs(branch) {
  return ['push', '--set-upstream', 'origin', branch]
}

export const PROTECTED_BRANCHES = ['develop', 'main']

// The branch comes from whatever checkout the caller happens to be standing in, and a
// caller that has already left the change worktree hands us the main checkout's branch
// instead. Enforce the protection here rather than trusting every call site: an
// integration branch is reached only through a merge request the developer merges.
export function protectedBranchRefusal(branch) {
  if (!PROTECTED_BRANCHES.includes(branch)) return null
  return `Refusing to act on the protected branch "${branch}": nothing was pushed and no merge request was touched. Run this from the change branch.`
}

export function parseBody(text) {
  const sections = {}
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const name = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = nl === -1 ? '' : part.slice(nl + 1)
    sections[name] = body.replace(/<!--[\s\S]*?-->/g, '').trim()
  }
  const missing = REQUIRED_SECTIONS.filter((n) => !(n in sections))
  const empty = REQUIRED_SECTIONS.filter((n) => n in sections && sections[n] === '')
  return { ok: missing.length === 0 && empty.length === 0, missing, empty, sections }
}

export function markerFor(changeName) {
  return { open: `<!-- opsx:${changeName} -->`, close: `<!-- /opsx:${changeName} -->` }
}

export function mergeDescription(existing, changeName, block) {
  const { open, close } = markerFor(changeName)
  const wrapped = `${open}\n${block.trim()}\n${close}`
  const start = existing.indexOf(open)
  if (start === -1) {
    return existing.trim() === '' ? `${wrapped}\n` : `${existing.trimEnd()}\n\n${wrapped}\n`
  }
  const end = existing.indexOf(close, start)
  // Guessing where someone else's block ends is how the other change's text gets eaten.
  if (end === -1) throw new Error(`unclosed marker for change "${changeName}"`)
  return existing.slice(0, start) + wrapped + existing.slice(end + close.length)
}

const sh = (cmd, args) => {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '' }
  }
}

export const arg = (argv, name) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return null
  const value = argv[i + 1]
  // `--title --change x` would otherwise title the merge request "--change", and a
  // trailing `--change` would silently become an unmarked description block.
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

// A failed `git rev-parse` or a detached HEAD must not fall through to the protected-branch
// guard as an empty string, which `protectedBranchRefusal` cannot distinguish from "no
// branch to protect" and would silently wave through.
const currentBranch = (run) => {
  const result = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!result.ok) return null
  const branch = result.stdout.trim()
  return branch === '' || branch === 'HEAD' ? null : branch
}

// Prints the command the developer can run later, so a degraded state leaves a usable
// artifact rather than only a complaint.
const reportDegraded = (detected, branch, fallback) => {
  console.log(detected.message)
  console.log(`Branch: ${branch}`)
  console.log(`When you have it, run: ${fallback}`)
}

export function ensureDraft({ run, platform, argv }) {
  const title = arg(argv, 'title')
  const changeName = arg(argv, 'change')
  if (title === null) {
    console.error('--title is required; nothing was pushed and no merge request was touched.')
    return 1
  }
  if (changeName === null) {
    console.error('--change is required; nothing was pushed and no merge request was touched.')
    return 1
  }
  const branch = currentBranch(run)
  if (branch === null) {
    console.error('Could not determine the current branch; nothing was pushed and no merge request was touched.')
    return 1
  }
  const refusal = protectedBranchRefusal(branch)
  if (refusal) {
    console.error(refusal)
    return 1
  }
  const detected = detectTool({ run, platform })
  // review-ignore: CWE-754 — a review round called returning 0 here a silent success after a
  // failed push. Nothing has been pushed at this point and nothing failed: the tool is absent
  // or unauthenticated, which `specs/merge-request-lifecycle` requires to degrade rather than
  // block, so exit 0 is the specified outcome and the printed command is what completes it by
  // hand. A real push failure is a separate path further down and returns 1.
  if (detected.state !== 'ready') {
    // The degraded path returns before pushing, so the branch is not on origin yet and
    // `glab mr create` alone would fail. Print the push it depends on.
    reportDegraded(
      detected,
      branch,
      `git ${pushArgs(branch).join(' ')} && glab mr create --draft --target-branch develop --squash-before-merge --remove-source-branch --title ${JSON.stringify(title)}`
    )
    return 0
  }
  const pushed = run('git', pushArgs(branch))
  if (!pushed.ok) {
    console.error('git push failed; no merge request was touched.')
    return 1
  }
  const existing = run('glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'])
  if (!existing.ok) {
    console.error(`Could not list merge requests for ${branch}; the branch was pushed, but no merge request was created or reused.`)
    return 1
  }
  // Parse rather than compare the raw text against '[]'. Any non-JSON on stdout — a warning
  // line, a pager artefact — is neither '' nor '[]', so a string comparison reads it as "a
  // merge request exists" and returns success without creating one. The failure is silent
  // and inverted: propose reports a reused merge request that was never there.
  let openCount
  try {
    openCount = JSON.parse(existing.stdout).length
  } catch {
    console.error(`Could not read the merge request list for ${branch}; nothing was created or reused.`)
    return 1
  }
  if (openCount > 0) {
    console.log(`An open merge request already exists for ${branch}; reusing it.`)
    return 0
  }
  const created = run('glab', [
    'mr',
    'create',
    '--draft',
    '--target-branch',
    'develop',
    '--squash-before-merge',
    '--remove-source-branch',
    '--title',
    title,
    '--description',
    `Draft opened by /opsx:propose for change ${changeName}. Description is written at archive.`
  ])
  console.log(created.stdout)
  return created.ok ? 0 : 1
}

export function finalize({ run, platform, argv, read }) {
  const changeName = arg(argv, 'change')
  const bodyFile = arg(argv, 'body-file')
  if (bodyFile === null) {
    console.error('--body-file is required; nothing was pushed and no merge request was touched.')
    return 1
  }
  if (changeName === null) {
    console.error('--change is required; nothing was pushed and no merge request was touched.')
    return 1
  }
  const body = read(bodyFile)
  const parsed = parseBody(body)
  if (!parsed.ok) {
    console.error(`Description rejected; nothing was sent. Missing: [${parsed.missing}] Empty: [${parsed.empty}]`)
    return 1
  }
  const branch = currentBranch(run)
  if (branch === null) {
    console.error('Could not determine the current branch; nothing was pushed and no merge request was touched.')
    return 1
  }
  const refusal = protectedBranchRefusal(branch)
  if (refusal) {
    console.error(refusal)
    return 1
  }
  const detected = detectTool({ run, platform })
  if (detected.state !== 'ready') {
    reportDegraded(
      detected,
      branch,
      `glab mr update ${branch} --ready --description-file ${bodyFile} && git ${pushArgs(branch).join(' ')}`
    )
    return 0
  }
  // review-ignore-start: CWE-20 — every `glab mr <sub> <branch>` below passes a branch name
  // where a review round expected an integer IID. `glab` documents the positional as
  // `[<id> | <branch>]` for these subcommands, and both were verified against glab 1.113.0
  // on a live GitLab instance: `mr view <branch>` returned the merge request's iid with a
  // matching `source_branch`, and `mr update <branch> --ready` resolved and applied. The
  // alternative the review suggested, `--source-branch` on these subcommands, is not a flag
  // they have. This is a block marker rather than a line marker because the first round of
  // this dismissal covered `mr view` only and the next round raised `mr update` beside it.
  const current = run('glab', ['mr', 'view', branch, '--output', 'json'])
  // Falling back to an empty description here would make mergeDescription see no markers
  // and quietly drop another change's block — whether the call itself failed (network
  // blip, forge error) or it returned unparseable JSON. Either way, read it or change
  // nothing. A successful call whose JSON has no `description` (or a null one) is a
  // genuinely empty description, not an error, so that alone maps to ''.
  if (!current.ok) {
    console.error('Could not read the existing merge request description; nothing was changed.')
    return 1
  }
  let existingDescription
  try {
    existingDescription = JSON.parse(current.stdout).description ?? ''
  } catch {
    console.error('Could not read the existing merge request description; nothing was changed.')
    return 1
  }
  const merged = mergeDescription(existingDescription, changeName, body.trim())
  // Undraft BEFORE the push: changing a title starts no pipeline, so a push that lands
  // while the title still says Draft runs ai_claude_inspect's rule against a draft and
  // skips the AI review for that commit permanently.
  const ready = run('glab', ['mr', 'update', branch, '--ready', '--description', merged])
  // review-ignore-end
  if (!ready.ok) {
    console.error('Could not take the merge request out of draft; the final commit was not pushed.')
    return 1
  }
  const pushed = run('git', pushArgs(branch))
  if (!pushed.ok) {
    console.error(
      'The merge request is out of draft with the final description, but the last commit failed to push; push the branch by hand to finish.'
    )
    return 1
  }
  return 0
}

// `process.argv[1] &&` is not decoration: without it, importing this module from a context
// that sets no script path — `node -e`, a REPL — makes pathToFileURL(undefined) throw before
// any export is reachable. The five sibling guard scripts all carry the same guard.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const ctx = { run: sh, platform: process.platform, argv, read: (p) => readFileSync(p, 'utf8') }
  // review-ignore: CWE-703 — a review round reported that `code` stays `undefined` when the
  // catch fires, making `process.exit(undefined)` report success after a throw. The premise
  // about Node is right (`process.exit(undefined)` does exit 0, verified), but the catch
  // below assigns `code = 1` before falling through, so no path reaches `process.exit` with
  // `code` unset. Read the catch block before re-raising this.
  let code
  try {
    if (argv[0] === 'ensure-draft') {
      code = ensureDraft(ctx)
    } else if (argv[0] === 'finalize') {
      code = finalize(ctx)
    } else {
      console.error('usage: mr.mjs ensure-draft|finalize')
      code = 1
    }
  } catch (e) {
    console.error(`${e.message}; nothing was pushed and no merge request was touched.`)
    code = 1
  }
  process.exit(code)
}
