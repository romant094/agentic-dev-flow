import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addAnchor,
  addEntry,
  addAdfRecord,
  checkTree,
  ensureRootIndex,
  listTree,
  markFiled,
  parsePage,
  removeEntry,
  splitCells
} from '../lib/debt.mjs'
import { run } from '../debt.mjs'
import { initRegistry, readRegistry } from '../lib/registry.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'debt.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'adf-debt-'))
const entry = (over = {}) => ({ block: 'snmp', title: 'Trailing index extracted in three places', anchors: ['a.ts:1', 'b.ts:2'], class: 'debt', source: 'some-change', ...over })
const adfInput = (over = {}) => ({ plugin: 'adf', pluginVersion: '0.9.0', class: 'defect', title: 'Verify reads the whole repository', body: 'The check validates every change.\n\nIt should validate one.', ...over })

function write(tree, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true })
    writeFileSync(join(tree, path), text)
  }
  return tree
}

const HEADER = '| ID | Title | Anchors | Class | Source | Tracker |\n|---|---|---|---|---|---|\n'
const ROOT = '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`snmp`](snmp/index.md) | SNMP |\n'

test('splitCells keeps an escaped pipe and a pipe inside a code span', () => {
  assert.deepEqual(splitCells('| a \\| b | `x|y` | c |'), ['a | b', '`x|y`', 'c'])
})

test('parsePage groups a table under the last sub-block heading, never under the page title', () => {
  const page = parsePage(`# Title\n\n${HEADER}| \`s-01\` | t | | debt | s | |\n\n### Sessions\n\n${HEADER}| \`s-02\` | t | | debt | s | |\n`)
  assert.deepEqual(
    page.tables.map((t) => [t.subBlock, t.rows.length]),
    [
      [null, 1],
      ['Sessions', 1]
    ]
  )
})

test('add creates the root index, the block and its root row, and allocates the first id', () => {
  const tree = join(tmp(), 'debt')
  const r = addEntry(tree, entry({ covers: 'SNMP transport' }))
  assert.equal(r.created, true)
  assert.equal(r.newBlock, true)
  assert.deepEqual(r.files, ['index.md', 'snmp/index.md'])
  assert.equal(r.entry.id, 'snmp-01')
  assert.deepEqual(r.entry.anchors, ['a.ts:1', 'b.ts:2'])
  assert.match(readFileSync(join(tree, 'index.md'), 'utf8'), /\| \[`snmp`\]\(snmp\/index\.md\) \| SNMP transport \|/)
  assert.equal(readFileSync(join(tree, 'snmp/index.md'), 'utf8'), `Last id: \`snmp-01\`\n\n${HEADER}| \`snmp-01\` | Trailing index extracted in three places | \`a.ts:1\`, \`b.ts:2\` | debt | some-change |  |\n`)
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
})

test('add allocates the next id of its block and appends to a sub-block, creating its heading', () => {
  const tree = tmp()
  addEntry(tree, entry())
  const second = addEntry(tree, entry({ title: 'Second' }))
  const third = addEntry(tree, entry({ title: 'Third', subBlock: 'Session lifecycle' }))
  const fourth = addEntry(tree, entry({ title: 'Fourth', subBlock: 'Session lifecycle' }))
  assert.deepEqual([second.entry.id, third.entry.id, fourth.entry.id], ['snmp-02', 'snmp-03', 'snmp-04'])
  assert.equal(second.newBlock, false)
  assert.deepEqual(second.files, ['snmp/index.md'])
  const { blocks, entries } = listTree(tree)
  assert.deepEqual(blocks[0].subBlocks, ['Session lifecycle'])
  assert.deepEqual(
    entries.map((e) => [e.id, e.subBlock]),
    [
      ['snmp-01', null],
      ['snmp-02', null],
      ['snmp-03', 'Session lifecycle'],
      ['snmp-04', 'Session lifecycle']
    ]
  )
  assert.equal(checkTree(tree).ok, true)
})

test('add is idempotent on block, title and source', () => {
  const tree = tmp()
  addEntry(tree, entry())
  const again = addEntry(tree, entry({ anchors: ['c.ts:3'] }))
  assert.equal(again.created, false)
  assert.equal(again.entry.id, 'snmp-01')
  assert.equal(listTree(tree).entries.length, 1)
})

test('add refuses a class outside the vocabulary, no anchor, a bad block and an ADF block', () => {
  const tree = tmp()
  assert.throws(() => addEntry(tree, entry({ class: 'chore' })), /class "chore" is not one of defect, debt, decision/)
  assert.throws(() => addEntry(tree, entry({ anchors: [] })), /at least one anchor/)
  assert.throws(() => addEntry(tree, entry({ block: 'Bad Block' })), /kebab-case/)
  assert.throws(() => addEntry(tree, entry({ block: 'adf' })), /debt\.mjs adf/)
  assert.throws(() => addEntry(tree, entry({ block: 'flow' })), /block flow holds ADF records/)
  assert.throws(() => addEntry(tree, entry({ title: 'two\nlines' })), /one line/)
})

test('an id is never renumbered, and an id the tree still names is not allocated again', () => {
  const tree = tmp()
  addEntry(tree, entry({ title: 'One' }))
  addEntry(tree, entry({ title: 'Two' }))
  addEntry(tree, entry({ title: 'Three, see snmp-03 elsewhere' }))
  removeEntry(tree, { id: 'snmp-02' })
  assert.deepEqual(
    listTree(tree).entries.map((e) => e.id),
    ['snmp-01', 'snmp-03']
  )
  removeEntry(tree, { id: 'snmp-03' })
  write(tree, { 'snmp/notes.md': 'Background for snmp-03.\n' })
  assert.equal(addEntry(tree, entry({ title: 'Four' })).entry.id, 'snmp-04')
})

test('removing the last entry keeps its id: the next add takes the number after it', () => {
  const tree = tmp()
  addEntry(tree, entry({ title: 'One' }))
  addEntry(tree, entry({ title: 'Two' }))
  removeEntry(tree, { id: 'snmp-02' })
  assert.match(readFileSync(join(tree, 'snmp/index.md'), 'utf8'), /^Last id: `snmp-02`$/m)
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] }, 'the high-water line names a removed id on purpose')
  assert.equal(addEntry(tree, entry({ title: 'Three' })).entry.id, 'snmp-03')
  assert.match(readFileSync(join(tree, 'snmp/index.md'), 'utf8'), /^Last id: `snmp-03`$/m)
  addAdfRecord(tree, 'my-change', adfInput())
  removeEntry(tree, { id: 'adf-01' })
  assert.equal(addAdfRecord(tree, 'my-change', adfInput({ title: 'Another' })).record.id, 'adf-02')
})

test('check refuses a row above the high-water line and a malformed or second line', () => {
  const row = (id) => `| \`${id}\` | T | \`a.ts:1\` | debt | c |  |\n`
  const above = write(tmp(), { 'index.md': ROOT, 'snmp/index.md': `# SNMP\n\nLast id: \`snmp-02\`\n\n${HEADER}${row('snmp-01')}${row('snmp-03')}` })
  assert.deepEqual(checkTree(above).errors.map((e) => [e.file, e.line, e.message]), [['snmp/index.md', 8, 'snmp-03 is above the block\'s high-water line snmp-02']])
  const malformed = write(tmp(), { 'index.md': ROOT, 'snmp/index.md': `# SNMP\n\nLast id: snmp-2\n\n${HEADER}${row('snmp-01')}` })
  assert.match(checkTree(malformed).errors.map((e) => e.message).join('\n'), /the high-water line must read "Last id: `snmp-NN`"/)
  const foreign = write(tmp(), { 'index.md': ROOT, 'snmp/index.md': `Last id: \`data-04\`\nLast id: \`snmp-04\`\n\n${HEADER}${row('snmp-01')}` })
  assert.deepEqual(checkTree(foreign).errors.map((e) => e.line), [2, 1])
})

test('a tree written before the high-water line is valid and gets the line on its first add or remove', () => {
  const old = () => write(tmp(), { 'index.md': ROOT, 'snmp/index.md': `# SNMP\n\n${HEADER}| \`snmp-01\` | T | \`a.ts:1\` | debt | c |  |\n| \`snmp-02\` | U | \`a.ts:2\` | debt | c |  |\n` })
  const added = old()
  assert.deepEqual(checkTree(added), { ok: true, errors: [] })
  assert.equal(addEntry(added, entry({ title: 'V' })).entry.id, 'snmp-03')
  assert.match(readFileSync(join(added, 'snmp/index.md'), 'utf8'), /^# SNMP\n\nLast id: `snmp-03`\n\n\| ID/)
  const removed = old()
  removeEntry(removed, { id: 'snmp-02' })
  assert.match(readFileSync(join(removed, 'snmp/index.md'), 'utf8'), /^# SNMP\n\nLast id: `snmp-02`\n\n\| ID/)
  assert.deepEqual(checkTree(removed), { ok: true, errors: [] })
  assert.equal(addEntry(removed, entry({ title: 'V' })).entry.id, 'snmp-03')
})

test('anchor adds a site once and refuses an unknown id', () => {
  const tree = tmp()
  addEntry(tree, entry())
  const r = addAnchor(tree, { id: 'snmp-01', anchor: 'c.ts:9' })
  assert.equal(r.added, true)
  assert.deepEqual(r.entry.anchors, ['a.ts:1', 'b.ts:2', 'c.ts:9'])
  assert.equal(addAnchor(tree, { id: 'snmp-01', anchor: 'c.ts:9' }).added, false)
  assert.deepEqual(listTree(tree).entries[0].anchors, ['a.ts:1', 'b.ts:2', 'c.ts:9'])
  assert.throws(() => addAnchor(tree, { id: 'snmp-07', anchor: 'x' }), /no entry snmp-07/)
  assert.throws(() => removeEntry(tree, { id: 'nonsense' }), /not an entry id/)
})

test('list reads an origin-shaped tree: columns, sub-blocks, body files, dash keys', () => {
  const tree = write(tmp(), {
    'index.md': ROOT,
    'snmp/index.md': `${HEADER}| \`snmp-01\` | One | \`a.ts:187,207\`, \`b.ts\` | defect | todos.md | KEY-1 |\n\n### Pool\n\n${HEADER}| \`snmp-02\` | Two | \`c.ts\` | decision | x | — |\n`,
    'snmp/background.md': '# Background\n'
  })
  const r = listTree(tree)
  assert.deepEqual(r.blocks, [{ id: 'snmp', kind: 'debt', covers: 'SNMP', index: 'snmp/index.md', columns: ['ID', 'Title', 'Anchors', 'Class', 'Source', 'Tracker'], subBlocks: ['Pool'], bodyFiles: ['snmp/background.md'] }])
  assert.deepEqual(r.entries[0], { id: 'snmp-01', kind: 'debt', block: 'snmp', subBlock: null, title: 'One', anchors: ['a.ts:187,207', 'b.ts'], class: 'defect', source: 'todos.md', tracker: 'KEY-1' })
  assert.equal(r.entries[1].tracker, null)
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
})

test('check names every rule a tree breaks', () => {
  const tree = write(tmp(), {
    'index.md': `${ROOT}\nThere are 12 open entries.\n`,
    'snmp/index.md': [
      HEADER.trim(),
      '| `snmp-01` | One | `a` | chore | s | K-1 |',
      '| `snmp-01` | Again | `a` | debt | s | K-1 |',
      '| **Pool** | | | | | |',
      '| `snmp-02` | Two, unlike snmp-09 | `a` | debt |  | |',
      '',
      '| ID | Title | Anchors | Class | Source | Tracker | Status |',
      '|---|---|---|---|---|---|---|',
      ''
    ].join('\n'),
    'orphan/index.md': HEADER
  })
  const messages = checkTree(tree).errors.map((e) => `${e.file}:${e.line} ${e.message}`)
  const expect = [
    /^index\.md:\d+ a count of entries/,
    /^snmp\/index\.md:3 snmp-01: class "chore"/,
    /^snmp\/index\.md:4 id snmp-01 is already used at snmp\/index\.md:3/,
    /^snmp\/index\.md:4 snmp-01 shares the tracker key K-1 with snmp-01/,
    /^snmp\/index\.md:5 "\*\*Pool\*\*" is not an id of block snmp; a sub-block is a heading/,
    /^snmp\/index\.md:6 snmp-02 has no source/,
    /^snmp\/index\.md:6 snmp-09 is named but no row carries it/,
    /^snmp\/index\.md:8 columns Status hold planning or a count/,
    /^snmp\/index\.md:8 the columns must be/,
    /^index\.md:null block orphan has no row in the root index/
  ]
  for (const pattern of expect) assert.ok(messages.some((m) => pattern.test(m)), `missing ${pattern}\n${messages.join('\n')}`)
  assert.equal(messages.length, expect.length, messages.join('\n'))
})

test('check accepts an absent tree and refuses a tree without a root index', () => {
  assert.deepEqual(checkTree(join(tmp(), 'none')), { ok: true, errors: [] })
  const tree = write(tmp(), { 'snmp/index.md': HEADER })
  assert.deepEqual(
    checkTree(tree).errors.map((e) => e.message),
    ['the tree has no root index']
  )
})

test('an ADF record lands in the adf block with its body file, once', () => {
  const tree = tmp()
  addEntry(tree, entry())
  const r = addAdfRecord(tree, 'my-change', adfInput())
  assert.equal(r.created, true)
  assert.deepEqual(r.files, ['index.md', 'adf/index.md', 'adf/adf-01.md'])
  assert.deepEqual(r.record, {
    id: 'adf-01',
    kind: 'adf',
    block: 'adf',
    title: 'Verify reads the whole repository',
    plugin: 'adf',
    pluginVersion: '0.9.0',
    change: 'my-change',
    class: 'defect',
    source: 'my-change',
    filed: null,
    body: 'The check validates every change.\n\nIt should validate one.'
  })
  assert.equal(addAdfRecord(tree, 'my-change', adfInput({ body: 'other' })).created, false)
  const second = addAdfRecord(tree, 'my-change', adfInput({ class: 'deferred wording', title: 'A rule stated twice', source: 'ledger deviation-1' }))
  assert.equal(second.record.id, 'adf-02')
  assert.deepEqual(
    listTree(tree, { kind: 'adf' }).entries.map((e) => e.id),
    ['adf-01', 'adf-02']
  )
  assert.deepEqual(
    listTree(tree, { kind: 'debt' }).entries.map((e) => e.id),
    ['snmp-01']
  )
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
})

test('an ADF record refuses a wrong class, a missing field, an unknown field and another change', () => {
  const tree = tmp()
  assert.throws(() => addAdfRecord(tree, 'c', adfInput({ class: 'debt' })), /not one of defect, deferred wording, decision/)
  assert.throws(() => addAdfRecord(tree, 'c', adfInput({ pluginVersion: '' })), /pluginVersion is required/)
  assert.throws(() => addAdfRecord(tree, 'c', adfInput({ body: ' ' })), /body is required/)
  assert.throws(() => addAdfRecord(tree, 'c', adfInput({ status: 'open' })), /unknown fields status/)
  assert.throws(() => addAdfRecord(tree, 'c', adfInput({ change: 'd' })), /names change d, not c/)
  assert.throws(() => addAdfRecord(tree, 'c', []), /JSON object/)
  assert.equal(existsSync(join(tree, 'adf')), false)
})

test('mark-filed records the issue once and removing an ADF record deletes its body', () => {
  const tree = tmp()
  addAdfRecord(tree, 'c', adfInput())
  addEntry(tree, entry())
  assert.throws(() => markFiled(tree, { id: 'adf-01', url: 'not a url' }), /not a URL/)
  assert.throws(() => markFiled(tree, { id: 'snmp-01', url: 'https://x/1' }), /not an ADF record/)
  assert.equal(markFiled(tree, { id: 'adf-01', url: 'https://forge/issues/1' }).changed, true)
  assert.equal(markFiled(tree, { id: 'adf-01', url: 'https://forge/issues/1' }).changed, false)
  assert.throws(() => markFiled(tree, { id: 'adf-01', url: 'https://forge/issues/2' }), /already filed as https:\/\/forge\/issues\/1/)
  assert.equal(listTree(tree, { kind: 'adf' }).entries[0].filed, 'https://forge/issues/1')
  assert.equal(checkTree(tree).ok, true)
  const r = removeEntry(tree, { id: 'adf-01' })
  assert.deepEqual(r.files, ['adf/index.md', 'adf/adf-01.md'])
  assert.equal(existsSync(join(tree, 'adf/adf-01.md')), false)
  assert.equal(checkTree(tree).ok, true)
})

test('check refuses an ADF record with no body file and a duplicate filed issue', () => {
  const tree = tmp()
  addAdfRecord(tree, 'c', adfInput())
  addAdfRecord(tree, 'c', adfInput({ title: 'Other' }))
  const index = join(tree, 'adf/index.md')
  writeFileSync(index, readFileSync(index, 'utf8').replace(/\|  \|\n/g, '| https://f/1 |\n'))
  writeFileSync(join(tree, 'adf/adf-02.md'), '')
  const before = checkTree(tree).errors.map((e) => e.message)
  assert.deepEqual(before, ['adf-02 shares the filed issue https://f/1 with adf-01'])
})

test('a block flow written before the rename reads as kind adf; new records go to the adf block', () => {
  const tree = write(tmp(), {
    'index.md': '# Technical Debt\n\n## Blocks\n\n| Block | Covers |\n|---|---|\n| [`flow`](flow/index.md) | Old ADF records |\n',
    'flow/index.md': '| ID | Title | Plugin | Version | Change | Class | Source | Filed |\n|---|---|---|---|---|---|---|---|\n| `flow-01` | Verify reads the whole repository | `adf` | `0.9.0` | `c` | defect | c |  |\n',
    'flow/flow-01.md': '# `flow-01` Verify reads the whole repository\n\nOld body.\n'
  })
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
  const [old] = listTree(tree, { kind: 'adf' }).entries
  assert.deepEqual([old.id, old.kind, old.block, old.body], ['flow-01', 'adf', 'flow', 'Old body.'])
  assert.deepEqual(listTree(tree).blocks.map((b) => [b.id, b.kind]), [['flow', 'adf']])
  assert.equal(addAdfRecord(tree, 'c', adfInput()).created, false)
  const added = addAdfRecord(tree, 'c', adfInput({ title: 'Other' }))
  assert.deepEqual([added.record.id, added.record.block], ['adf-01', 'adf'])
  assert.deepEqual(added.files, ['index.md', 'adf/index.md', 'adf/adf-01.md'])
  assert.equal(markFiled(tree, { id: 'flow-01', url: 'https://forge/issues/1' }).record.body, 'Old body.')
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
  assert.deepEqual(removeEntry(tree, { id: 'flow-01' }).files, ['flow/index.md', 'flow/flow-01.md'])
  assert.equal(existsSync(join(tree, 'flow/flow-01.md')), false)
  assert.deepEqual(listTree(tree, { kind: 'adf' }).entries.map((e) => e.id), ['adf-01'])
})

test('ensureRootIndex writes the template once', () => {
  const tree = join(tmp(), 'debt')
  assert.deepEqual(ensureRootIndex(tree), { created: true })
  assert.deepEqual(ensureRootIndex(tree), { created: false })
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
})

// ---------------------------------------------------------------- CLI

function hostWithRegistry() {
  const root = tmp()
  initRegistry(root, '1.0')
  return root
}

test('root reads and sets debt.root and creates the root index', () => {
  const root = hostWithRegistry()
  assert.deepEqual(run(['root', '--root', root]), { ok: true, root: null, created: false })
  assert.deepEqual(run(['root', '--set', 'docs/tech-debt', '--root', root]), { ok: true, root: 'docs/tech-debt', created: true })
  assert.equal(readRegistry(root).debt.root, 'docs/tech-debt')
  assert.ok(existsSync(join(root, 'docs/tech-debt/index.md')))
  assert.deepEqual(run(['root', '--root', root]), { ok: true, root: 'docs/tech-debt', created: false })
  assert.throws(() => run(['root', '--set', '../outside', '--root', root]), /debt\.root must be a path relative/)
})

test('the CLI reads the tree from the registry, and --tree overrides it', () => {
  const root = hostWithRegistry()
  assert.throws(() => run(['list', '--root', root]), /sets no debt\.root; run \/adf:init/)
  run(['root', '--set', 'debt', '--root', root])
  const added = run(['add', '--block', 'snmp', '--title', 'T', '--anchors', 'a.ts:187,207, b.ts', '--class', 'debt', '--source', 's', '--covers', 'SNMP', '--root', root])
  assert.equal(added.entry.id, 'snmp-01')
  assert.deepEqual(added.entry.anchors, ['a.ts:187,207', 'b.ts'])
  const listed = run(['list', '--root', root])
  assert.equal(listed.root, 'debt')
  assert.deepEqual(
    listed.entries.map((e) => e.id),
    ['snmp-01']
  )
  const other = tmp()
  assert.deepEqual(run(['list', '--tree', other, '--root', root]).entries, [])
})

test('the CLI exits 2 on a usage error, 1 on a refusal and a failing check, 0 otherwise', () => {
  const root = hostWithRegistry()
  run(['root', '--set', 'debt', '--root', root])
  const call = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  assert.equal(call('nonsense').code, 2)
  assert.equal(call('add', '--block', 'snmp').code, 2)
  assert.equal(call('remove', '--id', 'snmp-01', '--url', 'x').code, 2)
  assert.equal(call('list', '--kind', 'other').code, 2)
  const refused = call('remove', '--id', 'snmp-01')
  assert.equal(refused.code, 1)
  assert.match(refused.out.error, /no entry snmp-01/)
  const file = join(root, 'adf.json')
  writeFileSync(file, JSON.stringify(adfInput()))
  const adf = call('adf', '--change', 'c', '--file', file)
  assert.equal(adf.code, 0)
  assert.equal(adf.out.record.id, 'adf-01')
  assert.equal(call('mark-filed', '--id', 'adf-01', '--url', 'https://f/1').out.changed, true)
  assert.deepEqual(call('list', '--kind', 'adf').out.entries.map((e) => e.filed), ['https://f/1'])
  assert.equal(call('check').code, 0)
  writeFileSync(join(root, 'debt/index.md'), `${readFileSync(join(root, 'debt/index.md'), 'utf8')}\nSee adf-07.\n`)
  const failing = call('check')
  assert.equal(failing.code, 1)
  assert.equal(failing.out.ok, false)
})

test('track writes the Tracker cell once, is idempotent, and refuses an unknown id, another key and a taken key', () => {
  const tree = tmp()
  addEntry(tree, entry())
  addEntry(tree, entry({ title: 'Second' }))
  const cli = (...args) => run([...args, '--tree', tree])
  const first = cli('track', '--id', 'snmp-01', '--key', 'PROJ-7')
  assert.deepEqual([first.ok, first.changed, first.entry.tracker, first.files], [true, true, 'PROJ-7', ['snmp/index.md']])
  assert.match(readFileSync(join(tree, 'snmp/index.md'), 'utf8'), /\| `snmp-01` \| Trailing index extracted in three places \| `a\.ts:1`, `b\.ts:2` \| debt \| some-change \| PROJ-7 \|/)
  const before = readFileSync(join(tree, 'snmp/index.md'), 'utf8')
  assert.deepEqual(cli('track', '--id', 'snmp-01', '--key', 'PROJ-7'), { ok: true, changed: false, entry: first.entry, files: [] })
  assert.equal(readFileSync(join(tree, 'snmp/index.md'), 'utf8'), before)
  assert.throws(() => cli('track', '--id', 'snmp-09', '--key', 'PROJ-8'), /no entry snmp-09/)
  assert.throws(() => cli('track', '--id', 'snmp-01', '--key', 'PROJ-8'), /already tracked as PROJ-7/)
  assert.throws(() => cli('track', '--id', 'snmp-02', '--key', 'PROJ-7'), /already the tracker key of snmp-01/)
  assert.throws(() => cli('track', '--id', 'snmp-02', '--key', 'PROJ 8'), /is not a tracker key/)
  assert.throws(() => cli('track', '--id', 'snmp-02'), /track needs --key/)
  addAdfRecord(tree, 'my-change', adfInput())
  assert.throws(() => cli('track', '--id', 'adf-01', '--key', 'PROJ-9'), /ADF record; it has no Tracker cell/)
  assert.deepEqual(checkTree(tree), { ok: true, errors: [] })
})
