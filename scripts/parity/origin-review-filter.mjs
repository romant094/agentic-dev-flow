#!/usr/bin/env node
// Dev tool: replays the review's diff filter on every merge request merged into the origin's
// `origin/develop` and compares three file lists. Nothing is written in the origin: every git
// command run on it is read-only (`log`, `diff`).
//
//   node scripts/parity/origin-review-filter.mjs <origin project root> [--all]
//
// --all also prints every difference, explained ones included.
//
// The merge requests: `git log --first-parent --merges origin/develop`; each merge's
// `<merge>^1...<merge>^2` is its merge request diff (what `git diff --merge-base origin/develop
// HEAD` gave the branch just before the merge). For each, three lists:
//   local  the origin's local stage: `git diff --name-only` with the pathspecs of
//          `.claude/skills/ai-code-review/SKILL.md`, run by git itself
//   ci     the origin's CI filter: the `jq` program of `infra/claude/review.sh`, reimplemented
//          (the same regex on `new_path`; `.diff != ""` read from `--numstat`: a file with no
//          changed lines, a pure rename or a mode change or an empty file, has an empty diff;
//          `.collapsed` is not applicable, the API decides it)
//   port   `filterPaths` of plugins/adf/scripts/lib/review.mjs with the default list
// The port must equal the local list. Explained differences:
//   change-dir    the port excludes `openspec/changes/**`, which the local stage sends when the
//                 file is not markdown (deliberate: a change's artifacts are not the code)
//   gitlab-ci     the local stage excludes `.gitlab-ci.yml` and `.gitlab-ci-playbook.yml`
//                 because the origin's prompt skips them; the port's defaults hold no host file,
//                 a host adds them to `review.exclude`
//   snapshots-top the port's `**/__snapshots__/**` matches a top-level `__snapshots__/`; the
//                 local non-glob pathspec needs a directory before it
// And between the local and the CI lists (origin defect 1 and 3), counted, never failing:
//   md              CI keeps `.md` files the local stage excludes
//   gitlab-ci       CI keeps the two GitLab CI files
//   generated-edge  the CI regex and the local pathspecs disagree on a `generated` name
//   snapshots-top   the CI regex misses a top-level `__snapshots__/`
//   empty-diff      CI drops a file whose diff is empty; the local name list keeps it
// Any other difference between the local and the port lists is unexplained and fails the tool;
// a local and CI difference outside the classes above is printed as `unclassified-ci`.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { filterPaths } from '../../plugins/adf/scripts/lib/review.mjs'

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, '.git'))) {
  console.error('usage: origin-review-filter.mjs <origin project root, a git checkout>')
  process.exit(2)
}
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const lines = (text) => text.split('\n').filter(Boolean)

const MAIN = 'origin/develop'
git('rev-parse', '--verify', '--quiet', MAIN)

// `.claude/skills/ai-code-review/SKILL.md`, step 1.
const LOCAL_PATHSPECS = [
  ':(exclude)*.md',
  ':(exclude).gitlab-ci.yml',
  ':(exclude).gitlab-ci-playbook.yml',
  ':(exclude)package-lock.json',
  ':(exclude)**/package-lock.json',
  ':(exclude)**/yarn.lock',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)**/*.min.js',
  ':(exclude)**/*.min.css',
  ':(exclude)**/*.map',
  ':(exclude)dist/**',
  ':(exclude)**/dist/**',
  ':(exclude)generated.*',
  ':(exclude)**/generated.*',
  ':(exclude)*.generated.*',
  ':(exclude)**/*.generated.*',
  ':(exclude)**/__snapshots__/**',
  ':(exclude)coverage/**',
  ':(exclude)**/coverage/**'
]

// `infra/claude/review.sh`: jq `test()` is an unanchored PCRE-like search, as is RegExp#test.
const CI_EXCLUDE =
  /(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)pnpm-lock\.yaml$|\.min\.js$|\.min\.css$|\.map$|(^|\/)dist\/|(^|\.)(generated)\.|\/__snapshots__\/|(^|\/)coverage\//

const GITLAB_CI = new Set(['.gitlab-ci.yml', '.gitlab-ci-playbook.yml'])
const GENERATED = /(^|[/.])generated\./
const SNAPSHOTS_TOP = /^__snapshots__\//

// The paths `--numstat -z` reports with no added and no deleted line. A rename's record is
// `added\tdeleted\t\0old\0new\0`; the new path is the one the name list shows.
function numstatEmpty(text) {
  const fields = text.split('\0')
  const empty = new Set()
  for (let i = 0; i < fields.length; i++) {
    const m = /^(\S+)\t(\S+)\t(.*)$/.exec(fields[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      path = fields[i + 2]
      i += 2
    }
    if (m[1] === '0' && m[2] === '0') empty.add(path)
  }
  return empty
}

const merges = lines(git('log', '--first-parent', '--merges', '--format=%H %s', MAIN))
const differences = []
const ciClasses = {}
let files = 0
for (const entry of merges) {
  const [merge, ...subject] = entry.split(' ')
  const range = `${merge}^1...${merge}^2`
  const all = lines(git('diff', '--name-only', range))
  const local = lines(git('diff', '--name-only', range, '--', ...LOCAL_PATHSPECS))
  const emptyDiff = numstatEmpty(git('diff', '--numstat', '-z', range))
  const ci = all.filter((f) => !emptyDiff.has(f) && !CI_EXCLUDE.test(f))
  const port = filterPaths(all).kept
  files += all.length

  const localSet = new Set(local)
  const portSet = new Set(port)
  for (const file of all) {
    if (localSet.has(file) === portSet.has(file)) continue
    let explained = null
    if (localSet.has(file) && file.startsWith('openspec/changes/')) explained = 'change-dir'
    else if (!localSet.has(file) && GITLAB_CI.has(file)) explained = 'gitlab-ci'
    else if (localSet.has(file) && SNAPSHOTS_TOP.test(file)) explained = 'snapshots-top'
    differences.push({ merge: merge.slice(0, 8), subject: subject.join(' '), file, local: localSet.has(file), port: portSet.has(file), explained })
  }

  const ciSet = new Set(ci)
  for (const file of all) {
    if (localSet.has(file) === ciSet.has(file)) continue
    let label = 'unclassified-ci'
    if (!localSet.has(file) && file.endsWith('.md')) label = 'md'
    else if (!localSet.has(file) && GITLAB_CI.has(file)) label = 'gitlab-ci'
    else if (GENERATED.test(file)) label = 'generated-edge'
    else if (SNAPSHOTS_TOP.test(file)) label = 'snapshots-top'
    else if (localSet.has(file) && emptyDiff.has(file)) label = 'empty-diff'
    ciClasses[label] = (ciClasses[label] ?? 0) + 1
  }
}

const unexplained = differences.filter((d) => d.explained === null)
const explained = {}
for (const d of differences) if (d.explained) explained[d.explained] = (explained[d.explained] ?? 0) + 1
console.log(
  JSON.stringify(
    { mergeRequests: merges.length, files, differences: differences.length, explained, localVsCi: ciClasses, unexplained, ...(listAll ? { all: differences } : {}) },
    null,
    2
  )
)
process.exitCode = unexplained.length === 0 ? 0 : 1
