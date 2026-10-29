// The origin's v1 apply replies (.claude/scripts/check-reply.mjs) against the port's v2 replies
// (plugins/adf/scripts/lib/reply.mjs): a converter from a v1 reply to the port's schema shape, a
// git fixture the port's checker reads its context from, and the classes of every deliberate
// difference. Shared by origin-reply.mjs (the generated matrix) and origin-reply-corpus.mjs (the
// real replies of the session transcripts).
//
// The converter, per v1 role (the role the reply is checked as, not the reply's own `role`):
//   impl, fix      status -> outcome (DONE, DONE_WITH_CONCERNS -> done; BLOCKED -> blocked;
//                  NEEDS_CONTEXT -> needs-context); commits [{ sha, subject }] -> [sha], each
//                  distinct hex sha mapped to a commit of the fixture's change range in order of
//                  first appearance; tests { command, result, summary } -> testRuns [record], a
//                  real record `suite.mjs covering` wrote for a runner that prints the summary and
//                  exits 0 for pass, 1 for fail; concerns [string] -> [{ text }]; report ->
//                  summary; blocker (blocked, needs-context) from the concerns, else the report
//   review, final-review, merge-review
//                  verdict dropped; findings [{ severity, file, line?, summary }] -> [{ severity,
//                  kind quality, category quality, file, line ?? null, title and body summary }];
//                  summary and unverifiable [] added
//   re-review      as a review, into the re-review shape: previous [] (the fixture's open set is
//                  empty), outOfScope [] added
//   sweep          verdict dropped; findings and dispositions unchanged
//   investigate    unchanged
//   spec-merge     not converted: the role is gone (role-removed)
// A value the converter cannot map (a wrong type, a malformed element, an unknown key) is carried
// unchanged, so the port refuses it as v1 does. Text that is not a JSON object is not converted.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkReply, replyContext } from '../../../plugins/adf/scripts/lib/reply.mjs'
import { runCovering } from '../../../plugins/adf/scripts/lib/suite.mjs'

// A text that parses as a JSON object whose `role` is a v1 role, as that object; else null.
export function asV1Reply(text) {
  const t = String(text).trim()
  if (!t.startsWith('{')) return null
  let value
  try {
    value = JSON.parse(t)
  } catch {
    return null
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) && V1_ROLES.includes(value.role) ? value : null
}

// The texts of one transcript record a reply may be in: the body of a `Write` tool call, and of
// every Bash heredoc (`expanded` when its delimiter is unquoted, so the shell expanded it). `path`
// is the file written: the Write's `file_path`, or the redirection target of the heredoc's own
// command, unexpanded: the last `>` before the `<<` on its line (`cmd 2>/dev/null; cat > f <<'E'`),
// else the first after it (`cat <<'E' > f`); a file descriptor's redirect (`2>`, `&>`) is none.
// `command` is the heredoc's whole command, for its variable assignments.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\2(?=\s|$)/g
const REDIRECT = /(?<![\d&>])>>?\s*['"]?([^\s'"<>;|&]+)/g
const redirectOf = (before, after) => [...before.matchAll(REDIRECT)].at(-1)?.[1] ?? [...after.matchAll(REDIRECT)][0]?.[1] ?? null
export function replyBodies(entry) {
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type !== 'tool_use') continue
    if (part.name === 'Write') out.push({ text: part.input?.content ?? '', source: 'write', expanded: false, path: part.input?.file_path ?? null })
    if (part.name === 'Bash') {
      const command = String(part.input?.command ?? '')
      for (const m of command.matchAll(HEREDOC)) {
        const start = command.lastIndexOf('\n', m.index) + 1
        const before = command.slice(start, m.index)
        const after = command.slice(m.index, command.indexOf('\n', m.index)).replace(/^<<-?\s*(['"]?)\w+\1/, '')
        out.push({ text: m[3], source: 'heredoc', expanded: m[1] === '', path: redirectOf(before, after), command })
      }
    }
  }
  return out
}

export const V1_ROLES = ['impl', 'fix', 'review', 're-review', 'final-review', 'merge-review', 'sweep', 'investigate', 'spec-merge']
export const CHANGE = 'add-x'
// The dispatch name each v1 role is checked under in the fixture.
export const NAMES = {
  impl: 'T1 impl',
  fix: 'T1 fix r1',
  review: 'T1 review',
  're-review': 'T1 re-review r1',
  'final-review': 'final-review',
  'merge-review': 'merge-review A',
  sweep: 'sweep',
  investigate: 'investigate topic'
}

// Every deliberate difference. `theirs` matches a reason the origin gives when it refuses a reply
// the port accepts; `ours` an error the port gives when it refuses a reply the origin accepts.
export const CLASSES = {
  'verdict-computed': {
    why: 'v1 states a verdict (review pass|fail, sweep CLEAN|FINDINGS) and refuses one its findings contradict; v2 states none and computes it',
    theirs: /^verdict /
  },
  'tests-structured': {
    why: 'v1 accepts a free-text test summary of any result; v2 reads a test-run record and refuses a done reply whose last run failed or ran no test',
    ours: /^\$\.testRuns: the last covering run .* (failed \(|ran no test$)/
  },
  'commits-from-git': {
    why: 'v1 accepts any { sha, subject } list; v2 names git shas only, each once, inside the change range, at least one for done, and reads the subject from git',
    ours: /^\$\.commits(\[\d+\])?: /
  },
  'text-nonempty': { why: 'v1 accepts an empty string; v2 requires non-empty text', ours: /: must not be empty$/ },
  'line-integer': { why: 'v1 accepts any finite line number; v2 requires an integer of at least 1', ours: /\.line: (expected integer|must be at least 1$)/ },
  'blocker-required': {
    why: 'v2 requires a blocker for blocked and needs-context; the converter takes it from the concerns, else the report, and has none when both are empty',
    ours: /^\$: blocker is required$/
  },
  'dispositions-checked': {
    why: 'v1 takes dispositions as optional; v2 requires exactly one for each REMOVED or RENAMED requirement the change lists, and none when it lists none',
    ours: /^\$\.dispositions/
  },
  'location-form': {
    why: 'v1 accepts any text as a sweep location; v2 refuses text after a location\'s line (`path:16 symbolName`), which once kept a consolidated duplicate open, and accepts a bare path, path:line and path:line-line',
    ours: /^\$\.findings\[\d+\]\.(introduced|existing): .* has text after its line; /
  },
  'role-removed': { why: 'the v1 spec-merge counts role is gone; the port\'s spec-merge replies under spec-merge-resolution.schema.json' },
  'cli-form': { why: 'the port\'s CLI is `reply.mjs check --change --name --file`; a stray positional is a wrong call there, ignored by the origin' }
}

// Values compared between the stated v1 field and the port's computed result of a reply both
// accept; a disagreement is reported, never a failure.
export const COMPUTED = {
  'status-computed': 'v1 states the implementer status; v2 computes it from the outcome and the agent\'s and the script\'s concerns (no-count-line: the record of the v1 summary has no runner count line, a script concern)',
  'verdict-computed': 'v1 states the verdict; v2 computes it from the findings (and the DUP markers for the sweep)'
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
// An object of exactly `keys` (each optional key in `optional`), every value passing its test.
const shaped = (v, tests, optional = []) =>
  isObject(v) && Object.keys(v).every((k) => Object.hasOwn(tests, k)) && Object.entries(tests).every(([k, t]) => (Object.hasOwn(v, k) ? t(v[k]) : optional.includes(k)))
// Object.fromEntries defines each key, so a JSON `__proto__` key stays a key, never a prototype.
const fromEntries = Object.fromEntries

const OUTCOME = { DONE: 'done', DONE_WITH_CONCERNS: 'done', BLOCKED: 'blocked', NEEDS_CONTEXT: 'needs-context' }
const finite = (v) => typeof v === 'number' && Number.isFinite(v)

// One v1 reply value checked as `role` -> the v2 value, using `fixture` for the commits and the
// test-run records. Returns { converted: false } for a role the port no longer has.
export function convert(role, value, fixture) {
  if (role === 'spec-merge') return { converted: false, class: 'role-removed' }
  if (!isObject(value)) return { converted: true, value }
  const entries = Object.entries(value)
  const out = []
  if (role === 'impl' || role === 'fix') {
    for (const [k, v] of entries) {
      if (k === 'status') out.push(['outcome', Object.hasOwn(OUTCOME, v) ? OUTCOME[v] : v])
      else if (k === 'commits') out.push(['commits', Array.isArray(v) ? v.map((c) => (shaped(c, { sha: isString, subject: isString }) ? fixture.shaOf(c.sha) : c)) : v])
      else if (k === 'tests') out.push(shaped(v, { command: isString, result: (r) => r === 'pass' || r === 'fail', summary: isString }) ? ['testRuns', [fixture.record(NAMES[role], v)]] : ['tests', v])
      else if (k === 'concerns') out.push(['concerns', Array.isArray(v) ? v.map((c) => (isString(c) ? { text: c } : c)) : v])
      else if (k === 'report') out.push(['summary', v])
      else out.push([k, v])
    }
    const outcome = OUTCOME[value.status]
    if (outcome === 'blocked' || outcome === 'needs-context') {
      const concerns = Array.isArray(value.concerns) ? value.concerns.filter((c) => isString(c) && c) : []
      const blocker = concerns.length ? concerns.join('; ') : isString(value.report) && value.report ? value.report : null
      if (blocker) out.push(['blocker', blocker])
    }
    return { converted: true, value: fromEntries(out) }
  }
  if (['review', 're-review', 'final-review', 'merge-review'].includes(role)) {
    for (const [k, v] of entries) {
      if (k === 'verdict') continue
      if (k === 'findings')
        out.push([
          'findings',
          Array.isArray(v)
            ? v.map((f) =>
                shaped(f, { severity: () => true, file: isString, line: finite, summary: isString }, ['line'])
                  ? { severity: f.severity, kind: 'quality', category: 'quality', file: f.file, line: Object.hasOwn(f, 'line') ? f.line : null, title: f.summary, body: f.summary }
                  : f
              )
            : v
        ])
      else out.push([k, v])
    }
    out.push(['summary', `converted from a v1 ${role} reply`])
    if (role === 're-review') out.push(['previous', []], ['outOfScope', []])
    else out.push(['unverifiable', []])
    return { converted: true, value: fromEntries(out) }
  }
  if (role === 'sweep') return { converted: true, value: fromEntries(entries.filter(([k]) => k !== 'verdict')) }
  return { converted: true, value }
}

// ---------------------------------------------------------------- the fixture

const PLAN = `# Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1 | x | 1 |

---

### Task 1: parser

> Implements \`tasks.md\` 1.1.

**Files:**
- Modify: \`src/a.mjs\` — the parser

**Level:** integration
`

// The covering runner: prints summaries.json[<index>] and exits with its code.
const RUNNER = `const [text, code] = require('./summaries.json')[Number(process.argv[2])]
process.stdout.write(text)
process.exit(code)
`

// A repository whose develop holds the change and the runner, with the change branch checked out
// and `commits` commits on it, each changing src/a.mjs (inside Task 1's **Files:**). The events log
// holds one accepted T1 review with nothing open, so a T1 re-review answers an empty open set.
export function makeFixture(commits = 40) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-reply-v2-')))
  const root = join(top, 'repo')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git('config', 'user.email', 'parity@example.com')
  git('config', 'user.name', 'Parity')
  git('config', 'commit.gpgsign', 'false')
  write('.gitignore', '.superpowers/\nsummaries.json\n')
  write('runner.cjs', RUNNER)
  write('src/a.mjs', 'export const a = 0\n')
  write(`openspec/changes/${CHANGE}/.adf.json`, `${JSON.stringify({ schema: 'adf', base: 'develop' })}\n`)
  write(`openspec/changes/${CHANGE}/plan.md`, PLAN)
  write(`openspec/changes/${CHANGE}/tasks.md`, '- [ ] 1.1 parser\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('checkout', '-q', '-b', `feat/${CHANGE}`)
  const shas = []
  for (let i = 1; i <= commits; i++) {
    write('src/a.mjs', `export const a = ${i}\n`)
    git('commit', '-q', '-am', `feat: step ${i}`)
    shas.push(git('rev-parse', 'HEAD'))
  }
  write(`.superpowers/sdd/${CHANGE}/attempts.jsonl`, `${JSON.stringify({ name: 'T1 review', event: 'valid', result: { findings: [], open: [], toRule: [], deferred: [], unverifiable: [], result: 'clean' } })}\n`)

  const summaries = []
  const records = new Map()
  const shaMap = new Map()
  let stamp = Date.parse('2026-01-01T00:00:00.000Z')
  return {
    top,
    root,
    // A v1 sha -> a fixture commit, by first appearance; a non-hex sha, or one past the fixture's
    // commits, is carried unchanged.
    shaOf(sha) {
      if (!/^[0-9a-f]{7,40}$/.test(sha)) return sha
      if (!shaMap.has(sha)) shaMap.set(sha, shas[shaMap.size] ?? sha)
      return shaMap.get(sha)
    },
    resetShas: () => shaMap.clear(),
    // The test-run record of a v1 tests object, run once per dispatch name, result and summary.
    record(name, tests) {
      const key = JSON.stringify([name, tests.result, tests.summary])
      if (!records.has(key)) {
        summaries.push([tests.summary, tests.result === 'pass' ? 0 : 1])
        writeFileSync(join(root, 'summaries.json'), JSON.stringify(summaries))
        stamp += 1000
        const run = runCovering(root, { change: CHANGE, name, command: `node runner.cjs ${summaries.length - 1}`, worktree: root, now: new Date(stamp).toISOString() })
        records.set(key, run.file)
      }
      return records.get(key)
    },
    // The change's delta lists exactly these REMOVED requirements (none: no delta).
    removals(requirements) {
      const dir = join(root, 'openspec', 'changes', CHANGE, 'specs')
      rmSync(dir, { recursive: true, force: true })
      if (!requirements.length) return
      mkdirSync(join(dir, 'cap'), { recursive: true })
      const body = requirements.map((r) => `### Requirement: ${r}\n\n**Reason**: gone.\n\n**Migration**: none.\n`).join('\n')
      writeFileSync(join(dir, 'cap', 'spec.md'), `## REMOVED Requirements\n\n${body}`)
    },
    remove: () => rmSync(top, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- checking and classifying

// The port's check of one v1 reply text checked as `role`: { converted, accepted, errors, result }.
export function portCheck(role, text, fixture) {
  let value
  let isJson = true
  try {
    value = JSON.parse(text)
  } catch {
    isJson = false
  }
  fixture.resetShas()
  if (isJson) {
    const conv = convert(role, value, fixture)
    if (!conv.converted) return { converted: false, class: conv.class }
    text = JSON.stringify(conv.value)
  } else if (role === 'spec-merge') return { converted: false, class: 'role-removed' }
  const out = checkReply(role, text, () => replyContext(fixture.root, CHANGE, NAMES[role]))
  return { converted: true, accepted: out.valid, errors: out.errors, result: out.result, value: isJson ? JSON.parse(text) : undefined }
}

// The classes of an accept/refuse difference, or null when one reason has no class.
export function classify(theirs, ours) {
  const match = (side, lines) => {
    const classes = new Set()
    for (const line of lines) {
      const c = Object.entries(CLASSES).find(([, def]) => def[side]?.test(line))
      if (!c) return null
      classes.add(c[0])
    }
    return [...classes].sort()
  }
  if (!theirs.accepted && ours.accepted) return match('theirs', theirs.reasons)
  if (theirs.accepted && !ours.accepted) return match('ours', ours.errors)
  return []
}

// What the port computed differently from what the v1 reply stated, for a reply both accept.
export function computedDiffers(role, v1, result) {
  const out = []
  if ((role === 'impl' || role === 'fix') && v1.status !== result.status) {
    const script = result.concerns.filter((c) => c.source === 'script')
    const why = script.length === 0 ? 'agent-concerns' : script.every((c) => c.text.includes('printed no count line')) ? 'no-count-line' : 'script-concern'
    out.push(`status-computed (${v1.status} -> ${result.status}, ${why})`)
  }
  if (['review', 're-review', 'final-review', 'merge-review'].includes(role)) {
    const pass = result.open.length === 0 && (result.toRule ?? []).length === 0
    if ((v1.verdict === 'pass') !== pass) out.push('verdict-computed')
  }
  if (role === 'sweep' && v1.verdict !== result.verdict) out.push('verdict-computed')
  return out
}
