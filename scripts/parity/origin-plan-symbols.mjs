#!/usr/bin/env node
// Dev tool: compares the plan symbol check (plugins/adf/scripts/plan-symbols.mjs) with the
// origin's .claude/scripts/check-plan-symbols.mjs. Both CLIs run on the same inputs; nothing is
// written in the origin project: its HEAD is exported with `git archive` into a temporary
// directory, which becomes a fresh repository so that `git grep` and the apply phase work.
//
//   node scripts/parity/origin-plan-symbols.mjs <origin project root>
//
// Two corpora, each run under --phase propose and --phase apply: every plan.md of the
// origin's archived and active changes, and generated plans that exercise every finding kind
// and every exemption. The origin's prose findings are normalized to our structured fields, and
// the two sets of findings and the exit codes must agree. A difference is explained only when
// it is one the lessons file records as deliberate:
//   phase-without-value  a trailing `--phase` is a usage error (the origin ran propose)
// Kept for parity, so never a difference: a bare filename in a multi-path bullet resolves
// against the first path's directory.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const origin = process.argv[2]
const originScript = origin && join(origin, '.claude', 'scripts', 'check-plan-symbols.mjs')
if (!originScript || !existsSync(originScript)) {
  console.error('usage: origin-plan-symbols.mjs <origin project root with .claude/scripts/check-plan-symbols.mjs>')
  process.exit(2)
}
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'plan-symbols.mjs')

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=parity', '-c', 'user.email=parity@local', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28
  })
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

// ---------------------------------------------------------------- generated plans

const task = (n, files, iface = 'none.') =>
  `### Task ${n}: t\n\n> Implements \`tasks.md\` ${n}.1.\n\n**Files:**\n${files}\n\n**Interfaces:**${iface === 'none.' ? ' none.' : `\n${iface}`}\n`
const F = 'parity-fixture'

// What the base commit holds; the branch commit then adds, grows, deletes and renames.
const FIXTURES = {
  [`${F}/ok.ts`]: 'a\nb\nc\nd\n// parityPresentFn\n',
  [`${F}/ok.test.ts`]: 'x\n',
  [`${F}/lib.ts`]: 'export const parityGrepOnly = 1\n',
  [`${F}/dir/inside.ts`]: 'x\n',
  [`${F}/a/x.ts`]: 'x\n',
  [`${F}/b/z.ts`]: 'x\n',
  [`${F}/b/y.ts`]: 'x\n',
  [`${F}/grown.ts`]: 'one\ntwo\n',
  [`${F}/removed.ts`]: 'x\n',
  [`${F}/moved-from.ts`]: 'x\n'
}
const BRANCH = (root) => {
  put(root, `${F}/added.ts`, 'export const parityAdded = 1\n')
  put(root, `${F}/grown.ts`, `${'line\n'.repeat(40)}`)
  rmSync(join(root, `${F}/removed.ts`))
  git(root, 'mv', `${F}/moved-from.ts`, `${F}/moved-to.ts`)
}

const GENERATED = {
  'parity-gen-kinds': {
    plan: [
      task(1, `- Test: \`${F}/ok.ts:1-3\` — fine\n- Test: \`${F}/ok.test.ts\`\n- Create: \`${F}/new.ts\``),
      task(
        2,
        `- Modify: \`${F}/gone.ts\` — x\n- Test: \`${F}/gone.test.ts\`\n- Move: \`${F}/gone2.ts\` → \`${F}/n.ts\`\n- Create: \`${F}/ok.ts\`\n- Modify: \`${F}/ok.ts:1-99\`\n- Delete: \`${F}/never.ts\`\n- Revert: \`${F}/never2.ts\` — x\n- Frobnicate \`x\``,
        `- Consumes: \`missingFn()\` from \`${F}/ok.ts\`; \`parityPresentFn\` in \`${F}/ok.ts\`; \`parityGrepOnly\` from \`@/lib\`; \`parityGhostSymbol()\`.`
      )
    ].join('\n')
  },
  'parity-gen-no-tasks': { plan: '# Plan\n\n## Task 1: wrong level\n\n**Files:**\n- Modify: `src/gone.ts`\n' },
  'parity-gen-ranges': {
    plan: task(
      1,
      [
        `- Modify: \`${F}/dir:1-5\` — a directory`,
        `- Modify: \`${F}/ok.ts\` (\`fn\`, lines 2-90)`,
        `- Modify: \`${F}/ok.ts\` (\`fn\`, line 99)`,
        `- Modify: \`${F}/ok.ts\` (5-80; imports)`,
        `- Modify: \`${F}/ok.ts:7\` — one line`,
        `- Modify: \`${F}/ok.ts:2-4\` — fits`
      ].join('\n')
    )
  },
  'parity-gen-multipath': {
    plan: task(
      1,
      `- Modify: \`${F}/a/x.ts\`, \`y.ts\` and \`${F}/b/z.ts\` (the vi.mock path of \`ledger.md\`)\n- Modify: \`${F}/b/z.ts\` + \`${F}/missing/w.ts\` & \`${F}/a/x.ts:1-9\``
    )
  },
  'parity-gen-deferrals': {
    plan: [
      task(1, `- Create: \`${F}/made.ts\` — x\n- Modify: \`${F}/grown.ts:1-2\` — grow`, `- Produces: \`parityProduced()\` in \`${F}/made.ts\``),
      task(
        2,
        `- Modify: \`${F}/made.ts:1-80\` — y\n- Test: \`${F}/made.ts\`\n- Revert: \`${F}/made.ts\` — z\n- Move: \`${F}/made.ts\` → \`${F}/moved.ts\`\n- Delete: \`${F}/made.ts\`\n- Modify: \`${F}/grown.ts:250-300\` — y`,
        `- Consumes: \`helper(x)\` from \`${F}/made.ts\`; \`parityProduced()\`; \`parityLater()\`.`
      ),
      task(3, `- Create: \`${F}/b.mjs\` — y`, '- Produces: `parityLater()`'),
      task(4, `- Modify: \`${F}/late.ts\` — before its Create`),
      task(5, `- Create: \`${F}/late.ts\` — x`)
    ].join('\n')
  },
  'parity-gen-noops': {
    plan: [
      task(1, `- Modify: \`${F}/ok.ts\`\n- Create: none.\n- Test: none\n- Revert: commits \`bef47607\` and \`e86fdad6\``),
      task(
        2,
        `- Rename \`${F}/a.ts\` to \`${F}/c.ts\`\n- Modify: no path here\n- Move: \`${F}/x.ts\` somewhere\n\nsome stray prose\n- Test: \`${F}/ok.ts\``,
        '- Consumes: none.\n- Consumes: `node .claude/scripts/x.mjs --flag` (Task 2) and `check-reply.mjs` CLI.\n- Produces: `export const Z`\n\nAcceptance: uses `parityAcceptanceOnly()` from `@/lib`.'
      )
    ].join('\n')
  },
  'parity-gen-apply': {
    plan: [
      task(1, `- Modify: \`${F}/ticked-but-missing.ts\` — skipped under apply`),
      task(
        2,
        [
          `- Create: \`${F}/added.ts\` — the branch added it`,
          `- Modify: \`${F}/grown.ts:1-500\` — the branch modified it`,
          `- Modify: \`${F}/moved-to.ts:1-500\` — the branch added it by rename`,
          `- Move: \`${F}/moved-from.ts\` → \`${F}/moved-to.ts\``,
          `- Delete: \`${F}/removed.ts\``,
          `- Delete: \`${F}/never-there.ts\``,
          `- Modify: \`${F}/ok.ts:1-500\` — untouched by the branch`
        ].join('\n')
      )
    ].join('\n'),
    tasks: '- [x] 1.1 done\n- [ ] 2.1 open\n'
  }
}

// ---------------------------------------------------------------- the temporary host

function walkPlans(dir, root) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return walkPlans(path, root)
    return e.name === 'plan.md' ? [relative(root, dirname(path))] : []
  })
}

function buildHost() {
  const tmp = mkdtempSync(join(tmpdir(), 'adf-parity-plan-symbols-'))
  const archive = execFileSync('git', ['-C', origin, 'archive', 'HEAD'], { maxBuffer: 1 << 30 })
  execFileSync('tar', ['-x', '-C', tmp], { input: archive, maxBuffer: 1 << 28 })
  const changesDir = join(tmp, 'openspec', 'changes')
  const real = walkPlans(changesDir, changesDir).sort()
  for (const [path, text] of Object.entries(FIXTURES)) put(tmp, path, text)
  for (const [name, { plan, tasks }] of Object.entries(GENERATED)) {
    put(tmp, `openspec/changes/${name}/plan.md`, plan)
    if (tasks) put(tmp, `openspec/changes/${name}/tasks.md`, tasks)
  }
  // Our apply phase reads the base from each change's metadata; the origin's is hard-coded
  // to origin/develop, which the temporary repository provides.
  for (const name of [...real, ...Object.keys(GENERATED)]) {
    const meta = join(changesDir, name, '.adf.json')
    if (!existsSync(meta)) writeFileSync(meta, `${JSON.stringify({ base: 'develop' })}\n`)
  }
  git(tmp, 'init', '-q', '-b', 'develop')
  git(tmp, 'add', '-A', '-f')
  git(tmp, 'commit', '-q', '-m', 'base')
  git(tmp, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
  git(tmp, 'checkout', '-q', '-b', 'feat')
  BRANCH(tmp)
  git(tmp, 'add', '-A', '-f')
  git(tmp, 'commit', '-q', '-m', 'branch')
  return { tmp, real }
}

// ---------------------------------------------------------------- running and normalizing

// The origin's finding lines, to the fields our findings carry.
function normalizeOrigin(line) {
  if (line === 'no `### Task N` heading found') return { task: null, kind: 'no-tasks' }
  const m = /^Task (\d+): (.*?) — (.*)$/s.exec(line)
  if (!m) return { kind: 'unrecognized', line }
  const [, n, what, why] = m
  const task = Number(n)
  if (what === 'Files line cannot be parsed') return { task, kind: 'unparsed', line: why }
  const consumes = /^Consumes (.+)$/.exec(what)
  if (consumes) {
    const inPath = /^not found in (.+) or anywhere in the repository$/.exec(why)
    return { task, kind: 'symbol-missing', symbol: consumes[1], ...(inPath ? { path: inPath[1] } : {}) }
  }
  const [verb, ...rest] = what.split(' ')
  const path = rest.join(' ')
  if (why === 'path already exists') return { task, kind: 'path-exists', verb, path }
  if (why === 'path does not exist') return { task, kind: 'path-missing', verb, path }
  if (why === `${path} is a directory`) return { task, kind: 'path-is-directory', verb, path }
  const range = /^range (\d+)(?:-(\d+))? ends beyond the file's (\d+) lines$/.exec(why)
  if (range) {
    const start = Number(range[1])
    return { task, kind: 'range-beyond', verb, path, range: [start, Number(range[2] ?? start)], lines: Number(range[3]) }
  }
  return { kind: 'unrecognized', line }
}

const FIELDS = ['task', 'kind', 'verb', 'path', 'symbol', 'range', 'lines', 'line']
const key = (f) => JSON.stringify(FIELDS.map((k) => f[k] ?? null))

function runOrigin(tmp, name, extra) {
  const r = spawnSync('node', [originScript, name, '--repo', tmp, ...extra], { cwd: tmp, encoding: 'utf8', maxBuffer: 1 << 26 })
  const lines = r.stderr.split('\n')
  const findings = r.status === 1 ? lines.filter((l) => l.startsWith('  ')).map((l) => normalizeOrigin(l.slice(2))) : []
  return { code: r.status, findings, error: r.status === 2 ? r.stderr.trim() : undefined }
}

function runOurs(tmp, name, extra) {
  const r = spawnSync('node', [ourScript, name, '--root', tmp, ...extra], { cwd: tmp, encoding: 'utf8', maxBuffer: 1 << 26 })
  let out
  try {
    out = JSON.parse(r.stdout)
  } catch {
    out = { findings: [], error: `unparsable output: ${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}` }
  }
  return { code: r.status, findings: out.findings.map(({ message, ...rest }) => rest), error: out.error }
}

const diffSets = (a, b) => {
  const left = a.map(key)
  const right = b.map(key)
  const minus = (x, y) => {
    const rest = [...y]
    return x.filter((k) => {
      const i = rest.indexOf(k)
      if (i === -1) return true
      rest.splice(i, 1)
      return false
    })
  }
  return { onlyOrigin: minus(left, right).map(JSON.parse), onlyOurs: minus(right, left).map(JSON.parse) }
}

function explain(c, theirs, ours) {
  if (c.extra.at(-1) === '--phase' && ours.code === 2 && /^usage:/.test(ours.error ?? '') && theirs.code !== 2) {
    return 'phase-without-value'
  }
  return null
}

const { tmp, real } = buildHost()
try {
  const cases = []
  for (const phase of ['propose', 'apply']) {
    for (const name of real) cases.push({ corpus: 'origin', name, extra: ['--phase', phase] })
    for (const name of Object.keys(GENERATED)) cases.push({ corpus: 'generated', name, extra: ['--phase', phase] })
  }
  // A trailing --phase: the one argv where the two tools must differ.
  cases.push({ corpus: 'argv', name: 'parity-gen-kinds', extra: ['--phase'] })

  const differences = []
  const findingsCompared = { origin: 0, ours: 0 }
  const kindsSeen = new Set()
  const exitCodes = {}
  for (const c of cases) {
    const theirs = runOrigin(tmp, c.name, c.extra)
    const ours = runOurs(tmp, c.name, c.extra)
    findingsCompared.origin += theirs.findings.length
    findingsCompared.ours += ours.findings.length
    for (const f of ours.findings) kindsSeen.add(f.kind)
    exitCodes[ours.code] = (exitCodes[ours.code] ?? 0) + 1
    const { onlyOrigin, onlyOurs } = diffSets(theirs.findings, ours.findings)
    const unrecognized = theirs.findings.filter((f) => f.kind === 'unrecognized')
    if (theirs.code === ours.code && !onlyOrigin.length && !onlyOurs.length && !unrecognized.length) continue
    differences.push({
      case: c,
      codes: { origin: theirs.code, ours: ours.code },
      onlyOrigin,
      onlyOurs,
      errors: { origin: theirs.error, ours: ours.error },
      explained: explain(c, theirs, ours)
    })
  }

  const unexplained = differences.filter((d) => d.explained === null)
  const byReason = {}
  for (const d of differences) if (d.explained) byReason[d.explained] = (byReason[d.explained] ?? 0) + 1
  console.log(
    JSON.stringify(
      {
        compared: cases.length,
        corpus: { originPlans: real.length, generatedPlans: Object.keys(GENERATED).length, phases: 2 },
        findingsCompared,
        exitCodes,
        kindsSeen: [...kindsSeen].sort(),
        differences: differences.length,
        explained: byReason,
        unexplained
      },
      null,
      2
    )
  )
  process.exitCode = unexplained.length === 0 ? 0 : 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
