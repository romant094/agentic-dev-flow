#!/usr/bin/env node
// Dev tool: reads the origin's technical debt tree (`.claude/memory/tech-debt/`) with the core's
// debt store (plugins/adf/scripts/lib/debt.mjs) and checks the reading against a plain count.
// Nothing is written in the origin: the tree at HEAD is copied with `git show` into a directory
// under the system temp directory, and the port reads the copy.
//
//   node scripts/parity/origin-debt-tree.mjs <origin project root> [--all]
//
// --all also prints every entry the port reads.
//
// The comparison, per block: the port's `listTree` entries against a plain count of the table
// rows in the block's index.md (every `|` line after a header and its separator line, until the
// first line that is not a row). Then over every entry: ids unique, tracker keys unique, classes
// in the vocabulary (`defect`, `debt`, `decision`). Then the port's `checkTree`: each finding is
// explained below or fails the tool.
// Deliberate differences:
//   tracker-column  the origin's last column is `Jira`; the port's is `Tracker`. The copy renames
//                   the header cell of every table whose columns are otherwise the port's, and the
//                   rename is counted.
// Explained check findings:
//   prose-example   the root index's format example names `snmp-00`, which no row carries
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkTree, DEBT_CLASSES, DEBT_COLUMNS, listTree, splitCells } from '../../plugins/adf/scripts/lib/debt.mjs'

const EXPLAINED_FINDINGS = [{ file: 'index.md', match: /^snmp-00 is named but no row carries it$/, explained: 'prose-example' }]

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, '.git'))) {
  console.error('usage: origin-debt-tree.mjs <origin project root, a git checkout>')
  process.exit(2)
}
const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const TREE = '.claude/memory/tech-debt'
const ORIGIN_COLUMNS = [...DEBT_COLUMNS.slice(0, -1), 'Jira']
const isRow = (line) => line.trimStart().startsWith('|')
const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)

// The rows of every table of a page, counted without the port's parser.
function plainRows(text) {
  const lines = text.split('\n')
  let rows = 0
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]) || !isSeparator(lines[i + 1])) continue
    let j = i + 2
    while (j < lines.length && isRow(lines[j])) j++
    rows += j - i - 2
    i = j - 1
  }
  return rows
}

const copy = mkdtempSync(join(tmpdir(), 'adf-parity-debt-tree-'))
const out = { files: 0, renamedHeaders: 0, blocks: [], rows: { port: 0, plain: 0 }, ids: { duplicate: [] }, trackerKeys: { set: 0, duplicate: [] }, classes: {}, outsideVocabulary: [], check: { findings: 0, explained: {} }, unexplained: [] }
let entries = []
try {
  for (const path of git('ls-tree', '-r', '--name-only', 'HEAD', `${TREE}/`).split('\n').filter(Boolean)) {
    const target = join(copy, path.slice(TREE.length + 1))
    mkdirSync(dirname(target), { recursive: true })
    const text = git('show', `HEAD:${path}`)
    const mapped = text
      .split('\n')
      .map((line) => {
        if (!isRow(line) || splitCells(line).join('|') !== ORIGIN_COLUMNS.join('|')) return line
        out.renamedHeaders++
        return line.replace(/\|\s*Jira\s*\|\s*$/, '| Tracker |')
      })
      .join('\n')
    writeFileSync(target, mapped)
    out.files++
  }

  const tree = listTree(copy)
  entries = tree.entries
  for (const block of tree.blocks) {
    const index = join(copy, block.index)
    const port = entries.filter((e) => e.block === block.id).length
    const plain = existsSync(index) ? plainRows(readFileSync(index, 'utf8')) : 0
    out.blocks.push({ id: block.id, port, plain, subBlocks: block.subBlocks.length, bodyFiles: block.bodyFiles.length })
    out.rows.port += port
    out.rows.plain += plain
    if (port !== plain) out.unexplained.push({ block: block.id, port, plain, message: 'the port reads another number of rows than the plain count' })
  }

  const seen = new Map()
  const keys = new Map()
  for (const e of entries) {
    if (seen.has(e.id)) out.ids.duplicate.push(e.id)
    seen.set(e.id, e)
    if (e.tracker) {
      out.trackerKeys.set++
      if (keys.has(e.tracker)) out.trackerKeys.duplicate.push(`${e.tracker}: ${keys.get(e.tracker)}, ${e.id}`)
      keys.set(e.tracker, e.id)
    }
    out.classes[e.class] = (out.classes[e.class] ?? 0) + 1
    if (!DEBT_CLASSES.includes(e.class)) out.outsideVocabulary.push(`${e.id}: ${e.class}`)
  }
  out.ids.unique = seen.size
  for (const [label, list] of [['duplicate id', out.ids.duplicate], ['duplicate tracker key', out.trackerKeys.duplicate], ['class outside the vocabulary', out.outsideVocabulary]]) {
    for (const item of list) out.unexplained.push({ message: `${label}: ${item}` })
  }

  const report = checkTree(copy)
  out.check.findings = report.errors.length
  out.check.list = report.errors.map((e) => {
    const explained = EXPLAINED_FINDINGS.find((x) => x.file === e.file && x.match.test(e.message))?.explained ?? null
    if (explained) out.check.explained[explained] = (out.check.explained[explained] ?? 0) + 1
    else out.unexplained.push({ finding: e })
    return { ...e, explained }
  })
  if (out.renamedHeaders === 0) out.unexplained.push({ message: 'no table carries the origin\'s Jira column; the tracker-column difference is gone' })
} finally {
  rmSync(copy, { recursive: true, force: true })
}

console.log(JSON.stringify({ ...out, ...(listAll ? { entries } : {}) }, null, 2))
process.exitCode = out.unexplained.length === 0 ? 0 : 1
