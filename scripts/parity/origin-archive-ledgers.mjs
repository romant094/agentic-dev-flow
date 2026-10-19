#!/usr/bin/env node
// Dev tool: replays archive's placement gate on every archived execution ledger of the origin
// (`openspec/changes/archive/*/ledger.jsonl`), the origin's rule against the port's. Nothing is
// written in the origin: the ledgers and the origin's `.claude/scripts/ledger.mjs` are copied
// with `git show HEAD:` into a directory under the system temp directory and run from there.
//
//   node scripts/parity/origin-archive-ledgers.mjs <origin project root> [--all]
//
// --all also prints every ledger's record counts.
//
// The origin's rule: archive places every debt record `ledger.mjs list --change <name>
// --unresolved-debt` prints (the origin's script, run as a command on the copy). The port's
// rule: `unplaced` of plugins/adf/scripts/lib/archive.mjs, over the same records and the
// dispositions the port's `checkRecord` reads from the archived review.md. The unresolved debt
// of both must be the same list of ids (an archived change has placed all of it, so both are
// expected empty); a disagreement fails the tool.
// Deliberate differences, the port's new rules, listed per change and never failing:
//   deviation  a deviation record cited by no debt record (`forced deviation-<n>`) and by no
//              ruling; the origin's archive does not look at deviations
//   finding    a recorded or accepted review finding with no `resolve --finding` record; the
//              origin's ledger has no such record, so every one is listed
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unplaced } from '../../plugins/adf/scripts/lib/archive.mjs'
import { readLedger } from '../../plugins/adf/scripts/lib/ledger.mjs'
import { checkRecord } from '../../plugins/adf/scripts/lib/review-state.mjs'

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, '.git'))) {
  console.error('usage: origin-archive-ledgers.mjs <origin project root, a git checkout>')
  process.exit(2)
}
const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const gitOrNull = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const ARCHIVE = 'openspec/changes/archive'

// The real path: the origin's script runs its command only when argv[1] is its own URL's path.
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-archive-ledgers-')))
const out = { ledgers: 0, records: 0, unresolvedDebt: { origin: 0, port: 0 }, deliberate: { deviation: 0, finding: 0 }, changes: [], unexplained: [] }
try {
  const originScript = join(temp, 'ledger.mjs')
  writeFileSync(originScript, git('show', 'HEAD:.claude/scripts/ledger.mjs'))
  const ledgers = git('ls-tree', '-r', '--name-only', 'HEAD', `${ARCHIVE}/`)
    .split('\n')
    .filter((p) => /^openspec\/changes\/archive\/[^/]+\/ledger\.jsonl$/.test(p))
    .sort()
  for (const path of ledgers) {
    out.ledgers++
    const dir = path.split('/')[3]
    const change = dir.replace(/^\d{4}-\d{2}-\d{2}-/, '')
    const text = git('show', `HEAD:${path}`)
    const ledger = join(temp, '.superpowers', 'sdd', change, 'ledger.jsonl')
    mkdirSync(dirname(ledger), { recursive: true })
    writeFileSync(ledger, text)

    const run = spawnSync('node', [originScript, 'list', '--change', change, '--unresolved-debt', '--repo', temp], { encoding: 'utf8' })
    const theirs = run.status === 0 ? JSON.parse(run.stdout).map((r) => r.id) : null
    const records = readLedger(text)
    out.records += records.length
    const review = gitOrNull('show', `HEAD:${ARCHIVE}/${dir}/review.md`)
    const findings = review === null ? [] : checkRecord(review).dispositions.map((d) => ({ id: d.id, kind: d.kind }))
    const list = unplaced(records, findings, change)
    const ours = list.filter((i) => i.kind === 'debt').map((i) => i.id)
    const deviations = list.filter((i) => i.kind === 'deviation').map((i) => i.id)
    const unresolvedFindings = list.filter((i) => i.kind === 'finding').map((i) => `${i.id} (${i.disposition})`)

    if (theirs === null) out.unexplained.push({ change: dir, message: `the origin's script stopped: ${run.stderr.trim().split('\n')[0]}` })
    else {
      out.unresolvedDebt.origin += theirs.length
      if (theirs.join(',') !== ours.join(',')) out.unexplained.push({ change: dir, origin: theirs, port: ours })
    }
    out.unresolvedDebt.port += ours.length
    out.deliberate.deviation += deviations.length
    out.deliberate.finding += unresolvedFindings.length
    const kinds = {}
    for (const r of records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
    out.changes.push({
      change: dir,
      review: review !== null,
      unresolvedDebt: { origin: theirs, port: ours },
      deviation: deviations,
      finding: unresolvedFindings,
      ...(listAll ? { records: kinds } : {})
    })
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

if (!listAll) out.changes = out.changes.filter((c) => c.deviation.length + c.finding.length > 0 || c.unresolvedDebt.port.length > 0)
console.log(JSON.stringify(out, null, 2))
process.exitCode = out.unexplained.length === 0 ? 0 : 1
