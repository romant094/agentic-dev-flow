// The core's technical debt store: a Markdown tree at the registry's `debt.root`, its format in
// contract/debt-format.md. A root index lists the blocks; each block is a directory whose
// `index.md` holds the entries as table rows, grouped by sub-block headings; a body file beside
// it explains an area. The block `adf` holds the records of kind `adf`: defects of the flow's
// own plugins, each with its body in `adf/<id>.md`, kept on this machine until the maintainer
// files them. A tree written before the rename keeps them in the block `flow`, read the same way.
//
// Nothing here keeps a roll-up, a count or a status: `listTree` computes every entry on demand
// and writes nothing. An id is allocated once and never renumbered.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const ROOT_INDEX = 'index.md'
export const BLOCK_INDEX = 'index.md'
export const ADF_BLOCK = 'adf'
// The block ADF records lived in before the kind was renamed; read as kind `adf`, never written.
export const LEGACY_ADF_BLOCK = 'flow'
const isAdfBlock = (block) => block === ADF_BLOCK || block === LEGACY_ADF_BLOCK
export const DEBT_COLUMNS = ['ID', 'Title', 'Anchors', 'Class', 'Source', 'Tracker']
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

const ROOT_TEMPLATE = `# Technical Debt

Open technical debt, one entry per unit of work. This tree owns the content of the debt; the
tracker owns its planning, which is never written here. An entry is deleted when its debt is
resolved. The format is the ADF core's; \`debt.mjs\` writes it and \`debt.mjs check\` checks it.

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
    tracker: key(at('Tracker'))
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
    const others = isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== BLOCK_INDEX).sort() : []
    return { id, dir, index, page, others, row: root.rows.find((r) => r.id === id) ?? null }
  })
}

// Every block, sub-block and entry, computed from the files; nothing is written. `kind` keeps
// only `debt` (product) or `adf` entries.
export function listTree(tree, { kind } = {}) {
  const blocks = []
  const entries = []
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
  }
  return { blocks, entries }
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
  const keys = new Map()
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
    for (const table of block.page.tables) {
      const planning = table.columns.filter((c) => PLANNING.test(c))
      if (planning.length) err(block.index, table.header, `columns ${planning.join(', ')} hold planning or a count, which the tracker owns`)
      if (table.columns.join('|') !== expected.join('|')) {
        err(block.index, table.header, `the columns must be ${expected.join(' | ')}`)
        continue
      }
      for (const row of table.rows) {
        const entry = entryOf(block.id, table.columns, row.cells, table.subBlock)
        if (row.cells.length !== expected.length) err(block.index, row.line, `the row has ${row.cells.length} cells, not ${expected.length}`)
        if (!new RegExp(`^${block.id.replace(/-/g, '\\-')}-\\d+$`).test(entry.id)) {
          err(block.index, row.line, `"${entry.id}" is not an id of block ${block.id}; a sub-block is a heading, never a row`)
          continue
        }
        if (ids.has(entry.id)) err(block.index, row.line, `id ${entry.id} is already used at ${ids.get(entry.id)}`)
        else ids.set(entry.id, `${relative(tree, block.index)}:${row.line + 1}`)
        if (!entry.title) err(block.index, row.line, `${entry.id} has no title`)
        if (!classes.includes(entry.class)) err(block.index, row.line, `${entry.id}: class "${entry.class}" is not one of ${classes.join(', ')}`)
        if (!entry.source) err(block.index, row.line, `${entry.id} has no source`)
        const identity = adf ? entry.filed : entry.tracker
        if (identity) {
          if (keys.has(identity)) err(block.index, row.line, `${entry.id} shares ${adf ? 'the filed issue' : 'the tracker key'} ${identity} with ${keys.get(identity)}`)
          else keys.set(identity, entry.id)
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
  }
  if (root.page) {
    for (const line of [...root.page.prose, ...root.page.headings]) {
      if (COUNT.test(line.text)) err(rootFile, line.line, 'a count of entries; the tree carries no counts')
    }
  }

  // An id named anywhere in the tree that no row carries: a pointer to a closed or renumbered
  // entry, which would silently redirect if the id were allocated again.
  const pattern = idPattern(blocks.map((b) => b.id))
  if (pattern) {
    for (const file of mdFiles(tree)) {
      read(file)
        .split('\n')
        .forEach((text, line) => {
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

// The ids of a block in use: its rows, and every id the tree names, so an id still pointed at
// is never allocated again.
function nextId(tree, block) {
  const pattern = idPattern([block])
  let max = 0
  for (const file of mdFiles(tree)) {
    for (const match of read(file).matchAll(pattern)) max = Math.max(max, Number(match[0].slice(block.length + 1)))
  }
  return `${block}-${String(max + 1).padStart(2, '0')}`
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

const oneLine = (name, value) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  if (/\n/.test(value)) throw new Error(`${name} must be one line`)
  return value.trim()
}

// A product debt entry. Adding an entry already present (same block, title and source) changes
// nothing and returns it, so a re-run of archive does not file it twice.
export function addEntry(tree, { block, title, anchors, class: cls, source, subBlock = null, covers = null }) {
  if (!BLOCK_ID.test(block ?? '')) throw new Error(`block "${block}" is not a kebab-case name`)
  if (isAdfBlock(block)) throw new Error(`the block ${block} holds ADF records; write them with debt.mjs adf`)
  title = oneLine('title', title)
  source = oneLine('source', source)
  if (!DEBT_CLASSES.includes(cls)) throw new Error(`class "${cls}" is not one of ${DEBT_CLASSES.join(', ')}`)
  if (!Array.isArray(anchors) || anchors.length === 0) throw new Error('at least one anchor is required')
  for (const a of anchors) if (a.includes('`') || a.includes('\n')) throw new Error(`anchor "${a}" must be one line without backticks`)
  if (subBlock !== null) subBlock = oneLine('sub-block', subBlock)
  const existing = listTree(tree).entries.find((e) => e.block === block && e.title === title && e.source === source)
  if (existing) return { created: false, newBlock: false, entry: existing, files: [] }
  const blockRow = addRootRow(tree, block, covers)
  const dir = join(tree, block)
  const newBlock = !existsSync(join(dir, BLOCK_INDEX))
  mkdirSync(dir, { recursive: true })
  const id = nextId(tree, block)
  insertRow(join(dir, BLOCK_INDEX), DEBT_COLUMNS, formatRow([code(id), title, anchors.map(code).join(', '), cls, source, '']), subBlock)
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

// Delete an entry whose debt is resolved. No other id changes.
export function removeEntry(tree, { id }) {
  const at = locate(tree, id)
  const removed = entryOf(at.block, at.table.columns, at.row.cells, at.table.subBlock)
  at.page.lines.splice(at.row.line, 1)
  save(at.file, at.page.lines)
  const files = [`${at.block}/${BLOCK_INDEX}`]
  if (isAdfBlock(at.block) && existsSync(adfBodyPath(tree, at.block, id))) {
    removed.body = adfBody(tree, at.block, id)
    rmSync(adfBodyPath(tree, at.block, id))
    files.push(`${at.block}/${id}.md`)
  }
  return { removed, files }
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
// key again changes nothing; another key is refused, since the key is the entry's identity, and
// so is a key another entry already holds.
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
  const holder = listTree(tree, { kind: 'debt' }).entries.find((e) => e.tracker === trackerKey)
  if (holder) throw new Error(`${trackerKey} is already the tracker key of ${holder.id}`)
  while (at.row.cells.length < at.table.columns.length) at.row.cells.push('')
  at.row.cells[column] = trackerKey
  rewriteRow(at, at.row.cells)
  return { changed: true, entry: entry(), files: [`${at.block}/${BLOCK_INDEX}`] }
}
