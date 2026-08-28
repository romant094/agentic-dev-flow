// Detects a dispatch-facing instruction file that tells an agent to RUN a repository-wide
// git mutation — an unscoped `git add -A` / `git add .`, or a `git checkout --`,
// `git restore`, `git stash` or `git clean` that discards work. A dispatched agent runs in
// the developer's shared checkout, so an unscoped mutation reaches files the change does
// not own.
//
// Why prose could not catch this: the same command strings appear all over this repository
// as prohibitions ("Never run `git stash`", "`git add` is path-scoped and cannot pick up
// unrelated work"). A keyword scan of the current tree returns four such prose hits and
// zero real violations — every finding a false positive, and a check whose findings are all
// noise gets switched off, which leaves less protection than none. The discriminator is
// structural rather than lexical: an instruction to RUN a command lives inside a fenced
// code block, a prohibition lives in prose (inline backticks at most). Verified against the
// current tree: all four prohibitions are prose, all eight fenced hits are real commands,
// and every fenced `git add -A` is path-scoped.
//
// Read-only inspection is not a mutation: `git stash list` is fenced in apply.md on purpose
// and must not be flagged, so the stash and clean rules look at the subcommand and flags,
// not just the verb.
const COMMANDS_DIR = '.claude/commands/opsx'
const SKILLS_DIR = '.claude/skills'

const ADD_ONLY_FLAGS = new Set(['-A', '--all', '.'])
const STASH_READ_ONLY = new Set(['list', 'show'])
const CLEAN_DRY_RUN = new Set(['-n', '--dry-run'])

// Segments a shell line into the individual commands it runs, so `cmd && git add -A` is
// examined as `git add -A` rather than skipped for not starting with `git`.
function segments(line) {
  return line
    .replace(/#.*$/, '')
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function violationIn(segment) {
  const match = segment.match(/^git\s+(add|checkout|restore|stash|clean)\b(.*)$/)
  if (!match) return null
  const [, subcommand, rest] = match
  const args = rest.trim().split(/\s+/).filter(Boolean)

  if (subcommand === 'add') {
    // Path-scoped is safe and deliberate; only an add whose every argument is `-A`,
    // `--all` or `.` mutates the whole repository.
    if (args.length === 0 || args.every((a) => ADD_ONLY_FLAGS.has(a))) return 'repository-wide git add'
    return null
  }
  if (subcommand === 'checkout') {
    return args.includes('--') ? 'git checkout -- discards working-tree changes' : null
  }
  if (subcommand === 'restore') return 'git restore discards working-tree changes'
  if (subcommand === 'stash') {
    return args.some((a) => STASH_READ_ONLY.has(a)) ? null : "git stash moves the developer's changes"
  }
  if (subcommand === 'clean') {
    return args.some((a) => CLEAN_DRY_RUN.has(a)) ? null : 'git clean deletes untracked files'
  }
  return null
}

function findingsIn(path, text) {
  const findings = []
  let inFence = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) continue
    for (const segment of segments(line)) {
      const reason = violationIn(segment)
      if (reason) findings.push(`${path}:${i + 1} — ${reason}: \`${segment}\``)
    }
  }
  return findings
}

async function readOrNull(read, path) {
  try {
    return await read(path)
  } catch {
    return null
  }
}

export const meta = {
  incident:
    "adf-flow-improvements: a dispatched agent ran a repository-wide `git add -A` in the developer's shared dirty checkout and unrecoverably destroyed two uncommitted files, .claude/memory/concepts/known-issues.md and .claude/memory/concepts/placeholder-config-write.md",
  lastFired: null
}

export async function check({ read, list }) {
  const paths = []
  for (const name of await list(COMMANDS_DIR)) {
    if (name.endsWith('.md')) paths.push(`${COMMANDS_DIR}/${name}`)
  }
  for (const name of await list(SKILLS_DIR)) {
    paths.push(`${SKILLS_DIR}/${name}/SKILL.md`)
  }

  const findings = []
  let scanned = 0
  for (const path of paths.sort()) {
    const text = await readOrNull(read, path)
    if (text === null) continue
    scanned += 1
    findings.push(...findingsIn(path, text))
  }

  if (findings.length > 0) {
    return { ok: false, detail: `unscoped git mutation instructed in a fenced block:\n  ${findings.join('\n  ')}` }
  }
  return {
    ok: true,
    detail: `no unscoped git mutation instructed in a fenced block across ${scanned} dispatch-facing files`
  }
}
