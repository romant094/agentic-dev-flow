#!/usr/bin/env node
// Dev tool: reads every archived review record of the origin (`openspec/changes/archive/*/review.md`)
// both ways and compares the result. Nothing is written in the origin: the records are copied
// into a directory under the system temp directory and both sides read the copies.
//
//   node scripts/parity/origin-review-records.mjs <origin project root> [--all]
//
// --all also prints every record's reading and every difference, explained ones included.
//
// The origin side:
//   verdict  archive's extraction (`.claude/commands/opsx/archive.md`, step 6), run with bash:
//            grep -m1 '^\*\*Verdict[:*]' | sed 's/^[^:]*:[[:space:]]*//; s/[`*[:space:]]//g' | tr a-z A-Z;
//            a record proceeds only when it reads exactly PASS or BLOCKED
//   commit   archive's extraction: grep -m1 '^\*\*Reviewed commit[:*]' | grep -oE '[0-9a-f]{7,40}'
//   counts   the metrics' read: `countFindings([], md)['opsx-review']` of the origin's
//            `.claude/scripts/adf-metrics-findings.mjs` (it wraps `opsxReviewFindings`, which is
//            not exported), imported read-only: the sum of the four severities, or none
//   rounds   the origin has no reader of the Rounds line; it is read the way archive reads the
//            commit: grep -m1 '^\*\*Rounds[:*]', the first number after the colon
// The port side: `review.mjs check --file` (verdict, commit, the four counts, rounds,
// dispositions, errors, warnings).
//
// A difference is a field on which the two readings disagree. Explained differences:
//   none so far; a disagreement fails the tool.
// Record classes, counted (record defects the origin's extraction lets through and the port's
// check names, or that the port's check alone reads):
//   no-record              the archive directory holds no review.md (archived outside the cycle)
//   free-form              no verdict both sides accept: neither reads PASS or BLOCKED
//   no-counts              no **Counts** line with the four severities (the metrics read none,
//                          the port warns)
//   no-rounds              no **Rounds** number (the port warns)
//   over-cap               rounds above the round cap of three, which no rule covered
//   free-form-disposition  a findings-table disposition outside the vocabulary (the port reads
//                          its kind as `other`)
// The disposition histogram (the port's kinds) is printed as well, and `unnamedByPort`: per
// class, the records the port's check passes with neither an error nor a warning.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROUND_CAP } from '../../plugins/adf/scripts/lib/review-state.mjs'

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
const archive = origin && join(origin, 'openspec', 'changes', 'archive')
const metrics = origin && join(origin, '.claude', 'scripts', 'adf-metrics-findings.mjs')
if (!archive || !existsSync(archive) || !existsSync(metrics)) {
  console.error('usage: origin-review-records.mjs <origin project root with openspec/changes/archive and .claude/scripts/adf-metrics-findings.mjs>')
  process.exit(2)
}
const { countFindings } = await import(pathToFileURL(metrics).href)
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'review.mjs')

const ORIGIN_EXTRACT = `
verdict="$(grep -m1 -E '^\\*\\*Verdict[:*]' "$1" \\
  | sed -E 's/^[^:]*:[[:space:]]*//; s/[\`*[:space:]]//g' \\
  | tr '[:lower:]' '[:upper:]')"
recorded="$(grep -m1 -E '^\\*\\*Reviewed commit[:*]' "$1" | grep -oE '[0-9a-f]{7,40}')"
rounds="$(grep -m1 -E '^\\*\\*Rounds[:*]' "$1" | sed -E 's/^[^:]*://' | grep -oE '[0-9]+' | head -1)"
printf '%s\\n%s\\n%s\\n' "$verdict" "$(printf '%s' "$recorded" | tr '\\n' ' ')" "$rounds"
`

function theirs(file) {
  const [verdict, recorded, rounds] = execFileSync('bash', ['-c', ORIGIN_EXTRACT, 'extract', file], { encoding: 'utf8' }).split('\n')
  const proceeds = verdict === 'PASS' || verdict === 'BLOCKED'
  const shas = recorded.trim() ? recorded.trim().split(' ') : []
  return {
    verdict: proceeds ? verdict : null,
    rawVerdict: verdict,
    commit: shas.length === 1 ? shas[0] : shas.length === 0 ? null : shas.join(' '),
    findings: countFindings([], readFileSync(file, 'utf8'))['opsx-review']?.findings ?? null,
    rounds: rounds === '' ? null : Number(rounds)
  }
}

function ours(file) {
  let out
  try {
    out = execFileSync('node', [ourScript, 'check', '--file', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = error.stdout
  }
  const r = JSON.parse(out)
  return {
    verdict: r.verdict,
    commit: r.commit,
    findings: r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : null,
    rounds: r.rounds,
    ok: r.ok,
    dispositions: r.dispositions ?? [],
    errors: r.errors ?? [],
    warnings: r.warnings ?? []
  }
}

const dirs = readdirSync(archive, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
  .map((e) => e.name)
  .sort()
const copy = mkdtempSync(join(tmpdir(), 'adf-parity-review-records-'))
const classes = {}
const classed = (label, dir) => (classes[label] ??= []).push(dir)
// Per class, the records the port's check passes with neither an error nor a warning.
const unnamed = {}
const silent = (label, o) => {
  if (o.errors.length === 0 && o.warnings.length === 0) unnamed[label] = (unnamed[label] ?? 0) + 1
}
const histogram = {}
const differences = []
const readings = []
let compared = 0
try {
  for (const dir of dirs) {
    const source = join(archive, dir, 'review.md')
    if (!existsSync(source)) {
      classed('no-record', dir)
      continue
    }
    mkdirSync(join(copy, dir))
    const file = join(copy, dir, 'review.md')
    copyFileSync(source, file)
    compared++
    const t = theirs(file)
    const o = ours(file)
    readings.push({ dir, theirs: t, ours: { ...o, dispositions: o.dispositions.length } })

    if (t.verdict === null && o.verdict === null) classed('free-form', dir)
    if (o.verdict !== null && o.findings === null) classed('no-counts', dir)
    if (o.verdict !== null && o.rounds === null) classed('no-rounds', dir)
    if (o.rounds !== null && o.rounds > ROUND_CAP) {
      classed('over-cap', dir)
      silent('over-cap', o)
    }
    const other = o.dispositions.filter((d) => d.kind === 'other')
    if (other.length > 0) {
      classed('free-form-disposition', `${dir} (${other.length}: ${other.map((d) => d.disposition).join('; ')})`)
      silent('free-form-disposition', o)
    }
    for (const d of o.dispositions) histogram[d.kind] = (histogram[d.kind] ?? 0) + 1

    // The port reads the verdict, the commit and the rounds of a malformed record too; archive
    // stops on it before reading anything else, so those fields are compared only for a record
    // that proceeds.
    const fields = t.verdict === null ? ['verdict', 'findings'] : ['verdict', 'commit', 'findings', 'rounds']
    for (const f of fields) {
      if (t[f] === o[f]) continue
      differences.push({ dir, field: f, theirs: t[f], ours: o[f], explained: null })
    }
    if ((t.verdict !== null && t.commit !== null) !== o.ok) differences.push({ dir, field: 'proceeds', theirs: t.verdict !== null && t.commit !== null, ours: o.ok, explained: null })
  }
} finally {
  rmSync(copy, { recursive: true, force: true })
}

const unexplained = differences.filter((d) => d.explained === null)
const explained = {}
for (const d of differences) if (d.explained) explained[d.explained] = (explained[d.explained] ?? 0) + 1
console.log(
  JSON.stringify(
    {
      archived: dirs.length,
      compared,
      classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length])),
      classMembers: classes,
      unnamedByPort: unnamed,
      dispositions: histogram,
      differences: differences.length,
      explained,
      unexplained,
      ...(listAll ? { readings, all: differences } : {})
    },
    null,
    2
  )
)
process.exitCode = unexplained.length === 0 ? 0 : 1
