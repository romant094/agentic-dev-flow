// The core's technical debt store: a Markdown tree at the registry's `debt.root`, its format in
// contract/debt-format.md. A root index lists the blocks; each block is a directory whose
// `index.md` holds the entries as table rows, grouped by sub-block headings; a body file beside
// it explains an area. The block `adf` holds the records of kind `adf`: defects of the flow's
// own plugins, each with its body in `adf/<id>.md`, kept on this machine until the maintainer
// files them. A tree written before the rename keeps them in the block `flow`, read the same way.
//
// Nothing here keeps a roll-up, a count or a status: `listTree` computes every entry on demand
// and writes nothing. An id is allocated once and never renumbered: each block index carries a
// high-water line, `Last id: `<block>-NN``, the highest id the block ever allocated, so an id
// whose row was removed is not allocated again. Resolved debt is history, not an entry: archive
// moves its row to the block's `resolved.md` (`resolveEntry`), where a later entry's Precedent
// cell may name it and propose's gather finds it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const ROOT_INDEX = 'index.md'
export const BLOCK_INDEX = 'index.md'
export const ADF_BLOCK = 'adf'
// The block ADF records lived in before the kind was renamed; read as kind `adf`, never written.
export const LEGACY_ADF_BLOCK = 'flow'
const isAdfBlock = (block) => block === ADF_BLOCK || block === LEGACY_ADF_BLOCK
export const DEBT_COLUMNS = ['ID', 'Title', 'Anchors', 'Class', 'Source', 'Tracker']
// The optional last column of a block's table: the resolved entry whose fix this one may reuse.
export const PRECEDENT = 'Precedent'
const PRECEDENT_COLUMNS = [...DEBT_COLUMNS, PRECEDENT]
// A block's resolved debt, beside its index.
export const RESOLVED_FILE = 'resolved.md'
export const RESOLVED_COLUMNS = ['ID', 'Title', 'Anchors', 'Class', 'Tracker', 'Resolved by', 'Date']
const DATE = /^\d{4}-\d{2}-\d{2}$/
export const ADF_COLUMNS = ['ID', 'Title', 'Plugin', 'Version', 'Change', 'Class', 'Source', 'Filed']
export const ROOT_COLUMNS = ['Block', 'Covers']
export const DEBT_CLASSES = ['defect', 'debt', 'decision']
export const ADF_CLASSES = ['defect', 'deferred wording', 'decision']
const ADF_COVERS = "Defects of the flow's own plugins, kept here until the maintainer files them upstream"
// A column the tree never carries: planning belongs to the tracker, and a count disagrees with
// the rows as soon as one changes.
const PLANNING = /^(status|state|assignee|owner|priority|estimate|effort|due|deadline|sprint|milestone|count|total|points)$/i
// A number of entries stated in prose or a heading.
const COUNT = /\b\d+\s+(?:open\s+)?(?:entries|entry|items|rows|records)\b/i
const BLOCK_ID = /^[a-z][a-z0-9-]*$/
// The high-water line of a block index; any line starting so is one, and must be well formed.
const LAST_ID_LINE = /^last id\b/i
const LAST_ID = /^Last id: `([a-z][a-z0-9-]*)-(\d+)`$/
const idNumber = (id, block) => Number(id.slice(block.length + 1))
const padId = (block, n) => `${block}-${String(n).padStart(2, '0')}`

const ROOT_TEMPLATE = `# Technical Debt

Open technical debt, one entry per unit of work. This tree owns the content of the debt; the
tracker owns its planning, which is never written here. When a change resolves an entry, archive
moves its row to the block's \`resolved.md\`. The format is the ADF core's; \`debt.mjs\` writes it
and \`debt.mjs check\` checks it.

## Blocks

| ${ROOT_COLUMNS.join(' | ')} |
|${ROOT_COLUMNS.map(() => '---').join('|')}|
`

// ---------------------------------------------------------------- Markdown tables

// A cell ends at a `|` that is neither escaped (`\|`) nor inside a code span, as in GitHub
// tables.
export function splitCells(line) {
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const out = []
  let cell = ''
  let code = false
  for (let i = 0; i < row.length; i++) {
    const c = row[i]
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (c === '`') {
      code = !code
      cell += c
    } else if (c === '|' && !code) {
      out.push(cell.trim())
      cell = ''
    } else cell += c
  }
  return [...out, cell.trim()]
}

export const formatRow = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`
const separator = (columns) => `|${columns.map(() => '---').join('|')}|`
const isRow = (line) => line.trimStart().startsWith('|')
const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)
const code = (text) => `\`${text}\``
const uncode = (cell) => (/^`[^`]*`$/.test(cell) ? cell.slice(1, -1) : cell)
// An empty key cell, also written as a dash.
const key = (cell) => (cell === '' || /^[-\u2013\u2014]$/.test(cell) ? null : cell)

// The lines of a page sorted into headings, tables and prose. A table belongs to the last
// heading of level two or deeper above it, its sub-block; a level-one heading is the page title.
export function parsePage(text) {
  const lines = text.split('\n')
  const headings = []
  const tables = []
  const prose = []
  let subBlock = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      headings.push({ line: i, level: heading[1].length, text: heading[2] })
      if (heading[1].length >= 2) subBlock = heading[2]
      continue
    }
    if (isRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const table = { header: i, columns: splitCells(line), subBlock, rows: [], end: i + 2 }
      let j = i + 2
      for (; j < lines.length && isRow(lines[j]); j++) table.rows.push({ line: j, cells: splitCells(lines[j]) })
      table.end = j
      tables.push(table)
      i = j - 1
      continue
    }
    if (line.trim() !== '') prose.push({ line: i, text: line })
  }
  return { lines, headings, tables, prose }
}

// ---------------------------------------------------------------- reading the tree

const read = (file) => readFileSync(file, 'utf8')
const isDir = (path) => existsSync(path) && statSync(path).isDirectory()

function anchorsOf(cell) {
  const spans = [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1].trim())
  if (spans.length) return spans.filter(Boolean)
  return cell
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

function rootBlocks(tree) {
  const file = join(tree, ROOT_INDEX)
  if (!existsSync(file)) return { exists: false, page: null, table: null, rows: [] }
  const page = parsePage(read(file))
  const table = page.tables.find((t) => t.columns.join('|') === ROOT_COLUMNS.join('|')) ?? null
  const rows = (table?.rows ?? []).map((row) => {
    const link = /^\[`?([^`\]]*)`?\]\(([^)]*)\)$/.exec(row.cells[0] ?? '')
    return { id: link ? link[1] : uncode(row.cells[0] ?? ''), link: link ? link[2] : null, covers: row.cells[1] ?? '', line: row.line }
  })
  return { exists: true, page, table, rows }
}

function entryOf(block, columns, cells, subBlock) {
  const at = (name) => cells[columns.indexOf(name)] ?? ''
  if (isAdfBlock(block)) {
    return {
      id: uncode(at('ID')),
      kind: 'adf',
      block,
      title: at('Title'),
      plugin: uncode(at('Plugin')),
      pluginVersion: uncode(at('Version')),
      change: uncode(at('Change')),
      class: at('Class'),
      source: at('Source'),
      filed: key(at('Filed'))
    }
  }
  return {
    id: uncode(at('ID')),
    kind: 'debt',
    block,
    subBlock,
    title: at('Title'),
    anchors: anchorsOf(at('Anchors')),
    class: at('Class'),
    source: at('Source'),
    tracker: key(at('Tracker')),
    precedent: key(uncode(at(PRECEDENT)))
  }
}

// A row of a block's resolved.md: history, its anchors as they were when it was resolved.
function resolvedOf(block, columns, cells) {
  const at = (name) => cells[columns.indexOf(name)] ?? ''
  return {
    id: uncode(at('ID')),
    kind: 'debt',
    block,
    title: at('Title'),
    anchors: anchorsOf(at('Anchors')),
    class: at('Class'),
    tracker: key(at('Tracker')),
    resolvedBy: uncode(at('Resolved by')),
    date: at('Date')
  }
}

const adfBodyPath = (tree, block, id) => join(tree, block, `${id}.md`)

function adfBody(tree, block, id) {
  const file = adfBodyPath(tree, block, id)
  if (!existsSync(file)) return null
  return read(file).replace(/^#[^\n]*\n/, '').trim()
}

// Every block the tree names or holds: the root index's rows, then directories it does not list.
function blocksOf(tree) {
  const root = rootBlocks(tree)
  const ids = root.rows.map((r) => r.id)
  if (isDir(tree)) {
    for (const name of readdirSync(tree).sort()) if (isDir(join(tree, name)) && !ids.includes(name)) ids.push(name)
  }
  return ids.map((id) => {
    const dir = join(tree, id)
    const index = join(dir, BLOCK_INDEX)
    const page = existsSync(index) ? parsePage(read(index)) : null
    const others = isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== BLOCK_INDEX && f !== RESOLVED_FILE).sort() : []
    const resolvedFile = join(dir, RESOLVED_FILE)
    const resolved = !isAdfBlock(id) && existsSync(resolvedFile) ? { file: resolvedFile, page: parsePage(read(resolvedFile)) } : null
    return { id, dir, index, page, others, resolved, row: root.rows.find((r) => r.id === id) ?? null }
  })
}

// Every block, sub-block and entry, computed from the files; nothing is written. `kind` keeps
// only `debt` (product) or `adf` entries. `resolved` holds the rows of the blocks' resolved.md,
// never an entry: open debt is `entries` alone.
export function listTree(tree, { kind } = {}) {
  const blocks = []
  const entries = []
  const resolved = []
  for (const block of blocksOf(tree)) {
    const blockKind = isAdfBlock(block.id) ? 'adf' : 'debt'
    if (kind && kind !== blockKind) continue
    const tables = block.page?.tables ?? []
    blocks.push({
      id: block.id,
      kind: blockKind,
      covers: block.row?.covers ?? null,
      index: relative(tree, block.index),
      columns: tables[0]?.columns ?? null,
      subBlocks: [...new Set(tables.map((t) => t.subBlock).filter((s) => s !== null))],
      bodyFiles: blockKind === 'adf' ? [] : block.others.map((f) => `${block.id}/${f}`)
    })
    for (const table of tables) {
      for (const row of table.rows) {
        const entry = entryOf(block.id, table.columns, row.cells, table.subBlock)
        if (entry.kind === 'adf') entry.body = adfBody(tree, block.id, entry.id)
        entries.push(entry)
      }
    }
    for (const table of block.resolved?.page.tables ?? []) {
      for (const row of table.rows) resolved.push(resolvedOf(block.id, table.columns, row.cells))
    }
  }
  return { blocks, entries, resolved }
}

// The tracker groups of product debt entries: each key with the ids of the entries holding it,
// in tree order. An entry without a key is in no group.
export function trackerGroups(entries) {
  const groups = new Map()
  for (const e of entries) if (e.kind === 'debt' && e.tracker) groups.set(e.tracker, [...(groups.get(e.tracker) ?? []), e.id])
  return [...groups].map(([key, ids]) => ({ key, entries: ids }))
}

// ---------------------------------------------------------------- the check

function idPattern(blockIds) {
  const alternatives = [...blockIds].sort((a, b) => b.length - a.length).map((id) => id.replace(/[-]/g, '\\-'))
  return alternatives.length ? new RegExp(`(?<![\\w-])(?:${alternatives.join('|')})-\\d+(?![\\w-])`, 'g') : null
}

function mdFiles(dir) {
  if (!isDir(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (isDir(path)) return mdFiles(path)
    return name.endsWith('.md') ? [path] : []
  })
}

// The tree's rules, each defect named with its file and line (1-based).
export function checkTree(tree) {
  const errors = []
  const err = (file, line, message) => errors.push({ file: relative(tree, file), line: line === null ? null : line + 1, message })
  if (!isDir(tree)) return { ok: true, errors }
  const rootFile = join(tree, ROOT_INDEX)
  const root = rootBlocks(tree)
  if (!root.exists) err(rootFile, null, 'the tree has no root index')
  else if (!root.table) err(rootFile, null, `the root index has no "${ROOT_COLUMNS.join(' | ')}" table`)

  const blocks = blocksOf(tree)
  const ids = new Map()
  const filed = new Map()
  const resolvedIds = new Set()
  const precedents = []
  for (const block of blocks) {
    const adf = isAdfBlock(block.id)
    if (!BLOCK_ID.test(block.id)) err(rootFile, block.row?.line ?? null, `block "${block.id}" is not a kebab-case name`)
    if (root.exists && !block.row) err(rootFile, null, `block ${block.id} has no row in the root index`)
    if (block.row && block.row.link !== `${block.id}/${BLOCK_INDEX}`) err(rootFile, block.row.line, `the root row of ${block.id} must link ${block.id}/${BLOCK_INDEX}`)
    if (!block.page) {
      err(block.index, null, `block ${block.id} has no ${BLOCK_INDEX}`)
      continue
    }
    const expected = adf ? ADF_COLUMNS : DEBT_COLUMNS
    const classes = adf ? ADF_CLASSES : DEBT_CLASSES
    const lastLines = block.page.prose.filter((p) => LAST_ID_LINE.test(p.text))
    let last = null
    if (lastLines.length > 1) err(block.index, lastLines[1].line, `a second high-water line; a block index carries one "Last id: \`${block.id}-NN\`"`)
    if (lastLines.length) {
      const m = LAST_ID.exec(lastLines[0].text.trim())
      if (!m || m[1] !== block.id) err(block.index, lastLines[0].line, `the high-water line must read "Last id: \`${block.id}-NN\`"`)
      else last = Number(m[2])
    }
    // The rules every row shares, in the index and in resolved.md: an id of the block, at or
    // below its high-water line, used once across both, a title and a class. False when the id is
    // not one of the block's.
    const checkRow = (file, row, entry) => {
      if (!new RegExp(`^${block.id.replace(/-/g, '\\-')}-\\d+$`).test(entry.id)) {
        err(file, row.line, `"${entry.id}" is not an id of block ${block.id}; a sub-block is a heading, never a row`)
        return false
      }
      if (last !== null && idNumber(entry.id, block.id) > last) err(file, row.line, `${entry.id} is above the block's high-water line ${padId(block.id, last)}`)
      if (ids.has(entry.id)) err(file, row.line, `id ${entry.id} is already used at ${ids.get(entry.id)}`)
      else ids.set(entry.id, `${relative(tree, file)}:${row.line + 1}`)
      if (!entry.title) err(file, row.line, `${entry.id} has no title`)
      if (!classes.includes(entry.class)) err(file, row.line, `${entry.id}: class "${entry.class}" is not one of ${classes.join(', ')}`)
      return true
    }
    for (const table of block.page.tables) {
      const planning = table.columns.filter((c) => PLANNING.test(c))
      if (planning.length) err(block.index, table.header, `columns ${planning.join(', ')} hold planning or a count, which the tracker owns`)
      const columns = table.columns.join('|')
      if (columns !== expected.join('|') && (adf || columns !== PRECEDENT_COLUMNS.join('|'))) {
        err(block.index, table.header, `the columns must be ${expected.join(' | ')}${adf ? '' : `, optionally followed by ${PRECEDENT}`}`)
        continue
      }
      for (const row of table.rows) {
        const entry = entryOf(block.id, table.columns, row.cells, table.subBlock)
        if (row.cells.length !== table.columns.length) err(block.index, row.line, `the row has ${row.cells.length} cells, not ${table.columns.length}`)
        if (!checkRow(block.index, row, entry)) continue
        if (!entry.source) err(block.index, row.line, `${entry.id} has no source`)
        if (entry.precedent) precedents.push({ line: row.line, file: block.index, entry })
        // A filed URL is one record's; a tracker key may mirror a group of debt entries.
        if (adf && entry.filed) {
          if (filed.has(entry.filed)) err(block.index, row.line, `${entry.id} shares the filed issue ${entry.filed} with ${filed.get(entry.filed)}`)
          else filed.set(entry.filed, entry.id)
        }
        if (adf) {
          for (const field of ['plugin', 'pluginVersion', 'change']) if (!entry[field]) err(block.index, row.line, `${entry.id} has no ${field}`)
          if (entry.filed && !/^https?:\/\/\S+$/.test(entry.filed)) err(block.index, row.line, `${entry.id}: filed "${entry.filed}" is not a URL`)
          if (!existsSync(adfBodyPath(tree, block.id, entry.id))) err(adfBodyPath(tree, block.id, entry.id), null, `${entry.id} has no body file`)
        }
      }
    }
    for (const line of [...block.page.prose, ...block.page.headings]) {
      if (COUNT.test(line.text)) err(block.index, line.line, 'a count of entries; the tree carries no counts')
    }
    if (!block.resolved) continue
    const { file, page } = block.resolved
    if (page.tables.length === 0) err(file, null, `${RESOLVED_FILE} has no "${RESOLVED_COLUMNS.join(' | ')}" table`)
    for (const table of page.tables) {
      if (table.columns.join('|') !== RESOLVED_COLUMNS.join('|')) {
        err(file, table.header, `the columns must be ${RESOLVED_COLUMNS.join(' | ')}`)
        continue
      }
      for (const row of table.rows) {
        const entry = resolvedOf(block.id, table.columns, row.cells)
        if (row.cells.length !== RESOLVED_COLUMNS.length) err(file, row.line, `the row has ${row.cells.length} cells, not ${RESOLVED_COLUMNS.length}`)
        if (!checkRow(file, row, entry)) continue
        resolvedIds.add(entry.id)
        if (!entry.resolvedBy) err(file, row.line, `${entry.id} names no change it was resolved by`)
        if (!DATE.test(entry.date)) err(file, row.line, `${entry.id}: date "${entry.date}" is not YYYY-MM-DD`)
      }
    }
    for (const line of [...page.prose, ...page.headings]) {
      if (COUNT.test(line.text)) err(file, line.line, 'a count of entries; the tree carries no counts')
    }
  }
  for (const { file, line, entry } of precedents) {
    if (!resolvedIds.has(entry.precedent)) err(file, line, `${entry.id}: precedent ${entry.precedent} is not a row of any block's ${RESOLVED_FILE}`)
  }
  if (root.page) {
    for (const line of [...root.page.prose, ...root.page.headings]) {
      if (COUNT.test(line.text)) err(rootFile, line.line, 'a count of entries; the tree carries no counts')
    }
  }

  // An id named anywhere in the tree that no row carries, in an index or in a resolved.md: a
  // pointer to a removed or renumbered entry, which would silently redirect if the id were
  // allocated again. The high-water line names a removed id on purpose.
  const pattern = idPattern(blocks.map((b) => b.id))
  if (pattern) {
    for (const file of mdFiles(tree)) {
      read(file)
        .split('\n')
        .forEach((text, line) => {
          if (LAST_ID_LINE.test(text)) return
          for (const match of text.matchAll(pattern)) if (!ids.has(match[0])) err(file, line, `${match[0]} is named but no row carries it`)
        })
    }
  }
  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------- writing

const lines = (file) => read(file).split('\n')
const save = (file, list) => writeFileSync(file, list.join('\n'))

export function ensureRootIndex(tree) {
  const file = join(tree, ROOT_INDEX)
  if (existsSync(file)) return { created: false }
  mkdirSync(tree, { recursive: true })
  writeFileSync(file, ROOT_TEMPLATE)
  return { created: true }
}

function addRootRow(tree, block, covers) {
  ensureRootIndex(tree)
  const file = join(tree, ROOT_INDEX)
  const root = rootBlocks(tree)
  if (root.rows.some((r) => r.id === block)) return false
  const row = formatRow([`[${code(block)}](${block}/${BLOCK_INDEX})`, covers ?? ''])
  const list = lines(file)
  if (root.table) list.splice(root.table.end, 0, row)
  else {
    while (list.length && list[list.length - 1] === '') list.pop()
    list.push('', '## Blocks', '', formatRow(ROOT_COLUMNS), separator(ROOT_COLUMNS), row, '')
  }
  save(file, list)
  return true
}

// The highest number of a block ever allocated: its rows, every id the tree names, so an id
// still pointed at is never allocated again, and the block's high-water line, which names it.
function highest(tree, block) {
  const pattern = idPattern([block])
  let max = 0
  for (const file of mdFiles(tree)) {
    for (const match of read(file).matchAll(pattern)) max = Math.max(max, idNumber(match[0], block))
  }
  return max
}

const nextId = (tree, block) => padId(block, highest(tree, block) + 1)

// Write the block index's high-water line: replaced where it stands, else under the title, else
// on top.
function setLastId(file, id) {
  const page = parsePage(read(file))
  const list = page.lines
  const line = `Last id: ${code(id)}`
  const at = list.findIndex((l) => LAST_ID_LINE.test(l))
  if (at >= 0) list[at] = line
  else {
    const title = page.headings.find((h) => h.level === 1)
    if (title) list.splice(title.line + 1, 0, '', line)
    else list.splice(0, 0, line, '')
  }
  save(file, list)
}

// Insert a row into the block's table for `subBlock` (null: the table above every sub-block),
// creating the index, the table or the sub-block heading when missing.
function insertRow(file, columns, row, subBlock) {
  const created = !existsSync(file)
  if (created) {
    writeFileSync(file, `${formatRow(columns)}\n${separator(columns)}\n${row}\n`)
    return
  }
  const page = parsePage(read(file))
  const list = page.lines
  const table = page.tables.find((t) => t.subBlock === subBlock)
  if (table) list.splice(table.end, 0, row)
  else if (subBlock === null) {
    const title = page.headings.find((h) => h.level === 1)
    const at = title ? title.line + 1 : 0
    list.splice(at, 0, ...(title ? [''] : []), formatRow(columns), separator(columns), row, ...(list[at] === '' ? [] : ['']))
  } else {
    while (list.length && list[list.length - 1] === '') list.pop()
    list.push('', `### ${subBlock}`, '', formatRow(columns), separator(columns), row, '')
  }
  save(file, list)
}

// The columns of the block's table for `subBlock`, or null when the file or the table is missing.
function tableColumns(file, subBlock) {
  if (!existsSync(file)) return null
  return parsePage(read(file)).tables.find((t) => t.subBlock === subBlock)?.columns ?? null
}

// Give the block's table for `subBlock` the Precedent column when it has none: its header, its
// separator and every row get the cell, empty. A table written before the column stays valid.
function addPrecedentColumn(file, subBlock) {
  if (!existsSync(file)) return
  const page = parsePage(read(file))
  const table = page.tables.find((t) => t.subBlock === subBlock)
  if (!table || table.columns.includes(PRECEDENT)) return
  const list = page.lines
  list[table.header] = formatRow([...table.columns, PRECEDENT])
  list[table.header + 1] = separator([...table.columns, PRECEDENT])
  for (const row of table.rows) list[row.line] = formatRow([...row.cells, ''])
  save(file, list)
}

const oneLine = (name, value) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  if (/\n/.test(value)) throw new Error(`${name} must be one line`)
  return value.trim()
}

// A product debt entry. Adding an entry already present (same block, title and source) changes
// nothing and returns it, so a re-run of archive does not file it twice. `precedent` names a
// resolved entry, a row of some block's resolved.md, whose fix this one may reuse.
export function addEntry(tree, { block, title, anchors, class: cls, source, subBlock = null, covers = null, precedent = null }) {
  if (!BLOCK_ID.test(block ?? '')) throw new Error(`block "${block}" is not a kebab-case name`)
  if (isAdfBlock(block)) throw new Error(`the block ${block} holds ADF records; write them with debt.mjs adf`)
  title = oneLine('title', title)
  source = oneLine('source', source)
  if (!DEBT_CLASSES.includes(cls)) throw new Error(`class "${cls}" is not one of ${DEBT_CLASSES.join(', ')}`)
  if (!Array.isArray(anchors) || anchors.length === 0) throw new Error('at least one anchor is required')
  for (const a of anchors) if (a.includes('`') || a.includes('\n')) throw new Error(`anchor "${a}" must be one line without backticks`)
  if (subBlock !== null) subBlock = oneLine('sub-block', subBlock)
  const listed = listTree(tree)
  if (precedent !== null) {
    precedent = oneLine('precedent', precedent)
    if (!listed.resolved.some((r) => r.id === precedent)) throw new Error(`precedent ${precedent} is not a row of any block's ${RESOLVED_FILE}; a precedent is a resolved entry`)
  }
  const existing = listed.entries.find((e) => e.block === block && e.title === title && e.source === source)
  if (existing) return { created: false, newBlock: false, entry: existing, files: [] }
  const blockRow = addRootRow(tree, block, covers)
  const dir = join(tree, block)
  const newBlock = !existsSync(join(dir, BLOCK_INDEX))
  mkdirSync(dir, { recursive: true })
  const id = nextId(tree, block)
  const file = join(dir, BLOCK_INDEX)
  if (precedent !== null) addPrecedentColumn(file, subBlock)
  const columns = tableColumns(file, subBlock) ?? (precedent !== null ? PRECEDENT_COLUMNS : DEBT_COLUMNS)
  const cells = [code(id), title, anchors.map(code).join(', '), cls, source, '', ...(columns.includes(PRECEDENT) ? [precedent !== null ? code(precedent) : ''] : [])]
  insertRow(file, columns, formatRow(cells), subBlock)
  setLastId(file, id)
  const entry = listTree(tree).entries.find((e) => e.id === id)
  return { created: true, newBlock, entry, files: [...(blockRow ? [ROOT_INDEX] : []), `${block}/${BLOCK_INDEX}`] }
}

function locate(tree, id) {
  const match = /^(.+)-\d+$/.exec(id ?? '')
  if (!match) throw new Error(`"${id}" is not an entry id`)
  const block = match[1]
  const file = join(tree, block, BLOCK_INDEX)
  if (!existsSync(file)) throw new Error(`no entry ${id}: block ${block} has no ${BLOCK_INDEX}`)
  const page = parsePage(read(file))
  for (const table of page.tables) {
    for (const row of table.rows) {
      if (uncode(row.cells[0] ?? '') === id) return { block, file, page, table, row }
    }
  }
  throw new Error(`no entry ${id}`)
}

function rewriteRow(at, cells) {
  at.page.lines[at.row.line] = formatRow(cells)
  save(at.file, at.page.lines)
}

// One more code site for an existing entry: the same action at another place.
export function addAnchor(tree, { id, anchor }) {
  anchor = oneLine('anchor', anchor)
  if (anchor.includes('`')) throw new Error('an anchor has no backticks')
  const at = locate(tree, id)
  if (isAdfBlock(at.block)) throw new Error('an ADF record has no anchors')
  const column = at.table.columns.indexOf('Anchors')
  const anchors = anchorsOf(at.row.cells[column] ?? '')
  if (anchors.includes(anchor)) return { added: false, entry: entryOf(at.block, at.table.columns, at.row.cells, at.table.subBlock) }
  const cells = [...at.row.cells]
  cells[column] = [...anchors, anchor].map(code).join(', ')
  rewriteRow(at, cells)
  return { added: true, entry: entryOf(at.block, at.table.columns, cells, at.table.subBlock) }
}

// Take a row out of its block index. No other id changes; the high-water line keeps the highest
// id, written when absent, so the id is not allocated again.
function dropRow(tree, at) {
  const last = padId(at.block, highest(tree, at.block))
  at.page.lines.splice(at.row.line, 1)
  save(at.file, at.page.lines)
  setLastId(at.file, last)
}

// Delete a record that is not work: an ADF record, or an entry written by mistake. Debt a change
// resolved is moved to resolved.md instead (`resolveEntry`).
export function removeEntry(tree, { id }) {
  const at = locate(tree, id)
  const removed = entryOf(at.block, at.table.columns, at.row.cells, at.table.subBlock)
  dropRow(tree, at)
  const files = [`${at.block}/${BLOCK_INDEX}`]
  if (isAdfBlock(at.block) && existsSync(adfBodyPath(tree, at.block, id))) {
    removed.body = adfBody(tree, at.block, id)
    rmSync(adfBodyPath(tree, at.block, id))
    files.push(`${at.block}/${id}.md`)
  }
  return { removed, files }
}

const RESOLVED_TEMPLATE = (block) => `# Resolved debt of \`${block}\`

The entries of this block that a change resolved, moved here from \`index.md\` by archive. A
row is history: its anchors are as they were and are never checked against the code. Resolved by
is the archived change, whose proposal, design and tasks say how the debt was fixed.

${formatRow(RESOLVED_COLUMNS)}
${separator(RESOLVED_COLUMNS)}
`

// Move a product debt entry a change resolved from its block index to the block's resolved.md:
// its id, title, anchors, class and tracker key as they were, the archived change's directory
// (`by`) and the date. The high-water line keeps the id, which stays a row of the tree, so it is
// never allocated again. An id already resolved, an unknown id and an ADF record are refused.
export function resolveEntry(tree, { id, by, date = new Date().toISOString().slice(0, 10) }) {
  by = oneLine('resolved by', by)
  if (/[`|]/.test(by)) throw new Error(`resolved by "${by}" holds a backtick or a pipe; it is the archived change's directory`)
  if (!DATE.test(date ?? '')) throw new Error(`date "${date}" is not YYYY-MM-DD`)
  const done = listTree(tree, { kind: 'debt' }).resolved.find((r) => r.id === id)
  if (done) throw new Error(`${id} is already resolved, by ${done.resolvedBy}`)
  const at = locate(tree, id)
  if (isAdfBlock(at.block)) throw new Error(`${id} is an ADF record; it is removed with debt.mjs remove, never resolved`)
  const entry = entryOf(at.block, at.table.columns, at.row.cells, at.table.subBlock)
  dropRow(tree, at)
  const file = join(tree, at.block, RESOLVED_FILE)
  if (!existsSync(file)) writeFileSync(file, RESOLVED_TEMPLATE(at.block))
  insertRow(file, RESOLVED_COLUMNS, formatRow([code(id), entry.title, entry.anchors.map(code).join(', '), entry.class, entry.tracker ?? '', code(by), date]), null)
  const resolved = listTree(tree, { kind: 'debt' }).resolved.find((r) => r.id === id)
  return { resolved, files: [`${at.block}/${BLOCK_INDEX}`, `${at.block}/${RESOLVED_FILE}`] }
}

// A record of kind `adf`: a defect of a flow plugin, kept on this machine, always written to the
// block `adf`. Recording the same plugin, change and title again, in either block, changes
// nothing and returns the record.
export function addAdfRecord(tree, change, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('the ADF record must be a JSON object')
  const known = ['plugin', 'pluginVersion', 'change', 'class', 'title', 'body', 'source']
  const stray = Object.keys(input).filter((k) => !known.includes(k))
  if (stray.length) throw new Error(`unknown fields ${stray.join(', ')}; an ADF record has ${known.join(', ')}`)
  change = oneLine('change', change)
  if (input.change !== undefined && input.change !== change) throw new Error(`the record names change ${input.change}, not ${change}`)
  const plugin = oneLine('plugin', input.plugin)
  const pluginVersion = oneLine('pluginVersion', input.pluginVersion)
  const title = oneLine('title', input.title)
  const source = input.source === undefined ? change : oneLine('source', input.source)
  if (!ADF_CLASSES.includes(input.class)) throw new Error(`class "${input.class}" is not one of ${ADF_CLASSES.join(', ')}`)
  if (typeof input.body !== 'string' || input.body.trim() === '') throw new Error('body is required')
  for (const [name, value] of [['plugin', plugin], ['pluginVersion', pluginVersion], ['change', change]]) {
    if (value.includes('`')) throw new Error(`${name} has no backticks`)
  }
  const existing = listTree(tree, { kind: 'adf' }).entries.find((e) => e.plugin === plugin && e.change === change && e.title === title)
  if (existing) return { created: false, record: existing, files: [] }
  const blockRow = addRootRow(tree, ADF_BLOCK, ADF_COVERS)
  mkdirSync(join(tree, ADF_BLOCK), { recursive: true })
  const id = nextId(tree, ADF_BLOCK)
  writeFileSync(adfBodyPath(tree, ADF_BLOCK, id), `# ${code(id)} ${title}\n\n${input.body.trim()}\n`)
  insertRow(join(tree, ADF_BLOCK, BLOCK_INDEX), ADF_COLUMNS, formatRow([code(id), title, code(plugin), code(pluginVersion), code(change), input.class, source, '']), null)
  setLastId(join(tree, ADF_BLOCK, BLOCK_INDEX), id)
  const record = listTree(tree, { kind: 'adf' }).entries.find((e) => e.id === id)
  return { created: true, record, files: [...(blockRow ? [ROOT_INDEX] : []), `${ADF_BLOCK}/${BLOCK_INDEX}`, `${ADF_BLOCK}/${id}.md`] }
}

// The issue an ADF record was filed as. The same URL again changes nothing; another URL is
// refused, since a record is filed once.
export function markFiled(tree, { id, url }) {
  url = oneLine('url', url)
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`"${url}" is not a URL`)
  const at = locate(tree, id)
  if (!isAdfBlock(at.block)) throw new Error(`${id} is not an ADF record`)
  const column = at.table.columns.indexOf('Filed')
  const current = key(at.row.cells[column] ?? '')
  const record = () => ({ ...entryOf(at.block, at.table.columns, at.row.cells, null), body: adfBody(tree, at.block, id) })
  if (current === url) return { changed: false, record: record() }
  if (current) throw new Error(`${id} is already filed as ${current}`)
  at.row.cells[column] = url
  rewriteRow(at, at.row.cells)
  return { changed: true, record: record() }
}

// The tracker key a product debt entry is mirrored as, written into its Tracker cell. The same
// key again changes nothing; another key is refused, since an entry is mirrored once. A key
// another entry holds is accepted: one tracker issue mirrors a group of related entries.
export function setTracker(tree, { id, key: trackerKey }) {
  trackerKey = oneLine('key', trackerKey)
  if (/[\s|`]/.test(trackerKey)) throw new Error(`"${trackerKey}" is not a tracker key: it holds a space, a pipe or a backtick`)
  const at = locate(tree, id)
  if (isAdfBlock(at.block)) throw new Error(`${id} is an ADF record; it has no Tracker cell`)
  const column = at.table.columns.indexOf('Tracker')
  if (column === -1) throw new Error(`${id}: its table has no Tracker column`)
  const current = key(at.row.cells[column] ?? '')
  const entry = () => entryOf(at.block, at.table.columns, at.row.cells, at.table.subBlock)
  if (current === trackerKey) return { changed: false, entry: entry(), files: [] }
  if (current) throw new Error(`${id} is already tracked as ${current}`)
  while (at.row.cells.length < at.table.columns.length) at.row.cells.push('')
  at.row.cells[column] = trackerKey
  rewriteRow(at, at.row.cells)
  return { changed: true, entry: entry(), files: [`${at.block}/${BLOCK_INDEX}`] }
}
