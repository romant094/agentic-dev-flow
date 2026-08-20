import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { checkSddWorkspace } from './check-sdd-workspace.mjs'

// `read` mirrors `readFileSync`'s contract, `.code` included: the check distinguishes a
// missing file from an unreadable one, and a harness that threw a bare Error could not tell
// them apart either.
const enoent = (f) => Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' })

const io = (files, dirs) => ({
  read: (f) => {
    if (!(f in files)) throw enoent(f)
    return files[f]
  },
  list: (d) => dirs[d] ?? []
})

test('a foreign ledger on the shared path is reported', () => {
  const { ok, foreign } = checkSddWorkspace({
    changeName: 'my-change',
    ...io(
      { '.superpowers/sdd/plan/progress.md': '# SDD ledger — plan: openspec/changes/other-change/plan.md\n' },
      { '.superpowers/sdd': ['plan'] }
    )
  })
  assert.equal(ok, false)
  assert.equal(foreign.path, '.superpowers/sdd/plan')
  assert.ok(foreign.plan.includes('other-change'))
})

test('an empty workspace root is clean', () => {
  const { ok, foreign } = checkSddWorkspace({
    changeName: 'my-change',
    ...io({}, { '.superpowers/sdd': [] })
  })
  assert.equal(ok, true)
  assert.equal(foreign, null)
})

// Named for what it actually exercises. The check only ever inspects the legacy `plan`
// directory, so a workspace under any other name short-circuits at the `includes(LEGACY)`
// guard and never reaches the ledger. The previous name claimed this proved a
// change-named workspace is accepted; it did not — the assertion held for every
// `changeName`, including one the ledger contradicts, which the second case now pins.
test('a workspace not on the legacy path is never inspected', () => {
  const { ok } = checkSddWorkspace({
    changeName: 'my-change',
    ...io(
      { '.superpowers/sdd/my-change/progress.md': '# SDD ledger — plan: openspec/changes/my-change/plan.md\n' },
      { '.superpowers/sdd': ['my-change'] }
    )
  })
  assert.equal(ok, true)

  const other = checkSddWorkspace({
    changeName: 'my-change',
    ...io(
      { '.superpowers/sdd/other/progress.md': '# SDD ledger — plan: openspec/changes/other/plan.md\n' },
      { '.superpowers/sdd': ['other'] }
    )
  })
  assert.equal(other.ok, true, 'a foreign ledger off the legacy path is still not this check business')
})

test('the shared path holding this change own ledger is clean', () => {
  const { ok } = checkSddWorkspace({
    changeName: 'my-change',
    ...io(
      { '.superpowers/sdd/plan/progress.md': '# SDD ledger — plan: openspec/changes/my-change/plan.md\n' },
      { '.superpowers/sdd': ['plan'] }
    )
  })
  assert.equal(ok, true, 'it is this change own work, on the legacy path')
})

test('a ledger whose first line names no plan is reported', () => {
  const { ok, foreign } = checkSddWorkspace({
    changeName: 'my-change',
    ...io(
      { '.superpowers/sdd/plan/progress.md': '# Progress ledger (v2)\n\n- [x] Task 1\n' },
      { '.superpowers/sdd': ['plan'] }
    )
  })
  assert.equal(ok, false, 'an unidentifiable ledger is the foreign ledger this check exists for')
  assert.equal(foreign.path, '.superpowers/sdd/plan')
  assert.equal(foreign.plan, null)
})

test('a shared path with no ledger is clean', () => {
  const { ok } = checkSddWorkspace({
    changeName: 'my-change',
    ...io({}, { '.superpowers/sdd': ['plan'] })
  })
  assert.equal(ok, true, 'no ledger means no progress to misread')
})

test('a missing workspace root is clean', () => {
  const { ok } = checkSddWorkspace({
    changeName: 'my-change',
    read: () => {
      throw new Error('ENOENT')
    },
    list: () => {
      throw new Error('ENOENT')
    }
  })
  assert.equal(ok, true, 'nothing has run yet')
})

test('an unreadable ledger fails closed rather than reading as no ledger', () => {
  const { list } = io({}, { '.superpowers/sdd': ['plan'] })
  const read = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  }
  const r = checkSddWorkspace({ changeName: 'my-change', read, list })
  assert.equal(r.ok, false)
  assert.equal(r.foreign.unreadable, 'EACCES')
})

test('a missing ledger still reads as no ledger', () => {
  const { read, list } = io({}, { '.superpowers/sdd': ['plan'] })
  const r = checkSddWorkspace({ changeName: 'my-change', read, list })
  assert.equal(r.ok, true)
  assert.equal(r.foreign, null)
})
