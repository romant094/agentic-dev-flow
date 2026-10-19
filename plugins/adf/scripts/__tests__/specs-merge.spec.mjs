// The archive spec merge of lib/specs.mjs: byte equality with openspec 1.5.0's buildUpdatedSpec
// on the frozen fixtures (fixtures/spec-merge, frozen by fixtures/spec-merge/freeze.mjs; with
// OPENSPEC_DIST set to an openspec 1.5.0 dist directory the cases are also run live), the
// merged detection, the all-or-nothing strict validation, and the three-way check against
// real git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSpecSkeleton,
  buildUpdatedSpec,
  changeMergeBase,
  checkResolutions,
  deltaAlreadyMerged,
  findConflicts,
  hasPlaceholderPurpose,
  checkSpecsBase,
  mergePreview,
  NO_SPECS_BASE,
  parseDeltaSpec,
  PURPOSE_PLACEHOLDER,
  specsBasePath,
  validateSpecContent,
  writeMerge,
  writeSpecsBase
} from '../lib/specs.mjs'
import { failed, run as specsCli } from '../specs.mjs'
import { listCases, loadCase, OPENSPEC_PURPOSE, openspecBuild } from './fixtures/spec-merge/cases.mjs'
import { commitFiles, git, mergeRepo } from './fixtures/spec-merge/repo.mjs'

const PURPOSE = 'Widgets are built, stored and shipped by the system, one at a time.'
const req = (name, body = `The system SHALL ${name.toLowerCase()}.`, scenario = 'Works') =>
  `### Requirement: ${name}\n${body}\n\n#### Scenario: ${scenario}\n- **WHEN** x\n- **THEN** y\n`
const mainSpec = (capability, ...reqs) => `# ${capability} Specification\n\n## Purpose\n${PURPOSE}\n\n## Requirements\n${reqs.join('\n')}`
const build = (capability, deltaText, mainText, purpose) => buildUpdatedSpec({ capability, plan: parseDeltaSpec(deltaText), mainText, purpose })
const port = (name) => {
  const c = loadCase(name)
  try {
    return { rebuilt: build(name, c.deltaText, c.mainText, OPENSPEC_PURPOSE).rebuilt }
  } catch (error) {
    return { error: error.message }
  }
}

// ---- Byte equality with openspec 1.5.0 ----

for (const name of listCases()) {
  test(`openspec parity: ${name}`, () => {
    const c = loadCase(name)
    const result = port(name)
    if (c.error !== null) assert.deepEqual(result, { error: c.error })
    else assert.deepEqual(result, { rebuilt: c.expected })
  })
}

test('openspec parity, live against OPENSPEC_DIST', { skip: process.env.OPENSPEC_DIST ? false : 'OPENSPEC_DIST is not set' }, async () => {
  for (const name of listCases()) assert.deepEqual(port(name), await openspecBuild(process.env.OPENSPEC_DIST, name), name)
})

// ---- The pure merge ----

test('the counts are the delta operations; a renamed requirement moves to the end, as in openspec', () => {
  const c = loadCase('rename-and-modify')
  const built = build('rename-and-modify', c.deltaText, c.mainText)
  assert.deepEqual(built.counts, { added: 0, modified: 2, removed: 0, renamed: 1 })
  assert.deepEqual([...built.rebuilt.matchAll(/^### Requirement: (.+)$/gm)].map((m) => m[1]), ['Paint', 'Count', 'Assemble'])
})

test('a new capability starts from a skeleton with the placeholder Purpose, which passes strict validation', () => {
  const c = loadCase('new-capability')
  const built = build('new-capability', c.deltaText, null)
  assert.equal(built.isNew, true)
  assert.equal(built.rebuilt.split('\n')[3], PURPOSE_PLACEHOLDER)
  assert.ok(hasPlaceholderPurpose(built.rebuilt))
  assert.equal(validateSpecContent(built.rebuilt, { name: 'new-capability', strict: true }).valid, true)
  assert.deepEqual(built.warnings, ['new-capability - 1 REMOVED requirement(s) ignored for new spec (nothing to remove).'])
  assert.equal(buildSpecSkeleton('x', 'Own purpose.'), '# x Specification\n\n## Purpose\nOwn purpose.\n\n## Requirements\n')
})

test('a delta whose every block the main spec already holds is merged', () => {
  for (const name of ['modify-remove-add', 'rename-and-modify', 'trailing-section-crlf']) {
    const c = loadCase(name)
    const plan = parseDeltaSpec(c.deltaText)
    assert.equal(deltaAlreadyMerged(plan, c.mainText), false, name)
    assert.equal(deltaAlreadyMerged(plan, c.expected), true, name)
  }
  const c = loadCase('modify-remove-add')
  const partly = c.expected.replace('in a dry place', 'somewhere')
  assert.equal(deltaAlreadyMerged(parseDeltaSpec(c.deltaText), partly), false)
  assert.equal(deltaAlreadyMerged(parseDeltaSpec(c.deltaText), null), false)
})

// ---- The three-way check, pure ----

test('findConflicts names each touched requirement whose text moved since the base', () => {
  const base = mainSpec('cap', req('Build'), req('Store'), req('Ship'), req('Paint'))
  const now = mainSpec('cap', req('Build', 'The system SHALL build fast.'), req('Store'), req('Ship', 'The system SHALL ship by sea.'), req('Paint'))
  const delta = `## MODIFIED Requirements\n\n${req('Build', 'The system SHALL build slowly.')}\n## REMOVED Requirements\n\n${req('Ship', '**Reason**: gone.')}\n## RENAMED Requirements\n\n- FROM: \`### Requirement: Store\`\n- TO: \`### Requirement: Keep\`\n`
  const plan = parseDeltaSpec(delta)
  const found = findConflicts(plan, delta, { baseText: base, nowText: now, side: 'base-branch' })
  assert.deepEqual(found.map((c) => [c.requirement, c.operation, c.side]), [['Build', 'MODIFIED', 'base-branch'], ['Ship', 'REMOVED', 'base-branch']])
  assert.match(found[0].base, /SHALL build\.$/m)
  assert.match(found[0].current, /SHALL build fast\./)
  assert.match(found[0].delta, /SHALL build slowly\./)
  assert.match(found[1].delta, /\*\*Reason\*\*: gone\./)
  const gone = mainSpec('cap', req('Build'), req('Ship'), req('Paint'))
  assert.deepEqual(findConflicts(plan, delta, { baseText: base, nowText: gone, side: 'base-branch' }).map((c) => [c.requirement, c.to, c.current]), [['Store', 'Keep', null]])
  assert.deepEqual(findConflicts(plan, delta, { baseText: base, nowText: base, side: 'worktree' }), [])
})

test('checkResolutions takes an array of { capability, requirement, text, reason }, one per requirement', () => {
  const ok = { capability: 'c', requirement: 'R', text: '', reason: 'why' }
  assert.deepEqual(checkResolutions([ok]), [ok])
  assert.throws(() => checkResolutions({}), /must be a JSON array/)
  assert.throws(() => checkResolutions([{ ...ok, text: 1 }]), /"text" must be a string/)
  assert.throws(() => checkResolutions([{ ...ok, reason: ' ' }]), /"reason" is empty/)
  assert.throws(() => checkResolutions([ok, { ...ok, requirement: ' R ' }]), /resolved twice/)
})

// ---- The merge over a change, in real git repositories ----

const BASE_MAIN = mainSpec('widgets', req('Build'), req('Store'), req('Ship'))
const DELTA = `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry.')}\n## ADDED Requirements\n\n${req('Track')}`
const read = (dir, capability) => readFileSync(join(dir, 'openspec', 'specs', capability, 'spec.md'), 'utf8')
const status = (dir) => git(dir, 'status', '--porcelain')

test('with no edit since the base the merge writes, and a re-run reports merged and writes nothing', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA, 'new-cap': `## ADDED Requirements\n\n${req('Label')}` } })
  const preview = mergePreview(change, 'add-x')
  assert.equal(preview.ok, true)
  assert.equal(preview.merged, false)
  assert.equal(preview.base.ref, 'develop')
  assert.equal(preview.base.sha, changeMergeBase(change, 'add-x').sha)
  assert.deepEqual(preview.capabilities.map((c) => [c.capability, c.new, c.merged, c.counts]), [
    ['new-cap', true, false, { added: 1, modified: 0, removed: 0, renamed: 0 }],
    ['widgets', false, false, { added: 1, modified: 1, removed: 0, renamed: 0 }]
  ])
  assert.deepEqual(preview.totals, { added: 2, modified: 1, removed: 0, renamed: 0 })
  assert.deepEqual(preview.newCapabilities, ['new-cap'])
  assert.deepEqual(preview.placeholderPurpose, ['new-cap'])
  assert.equal(status(change), '', 'the preview writes nothing')

  const written = writeMerge(change, 'add-x', { purposes: { 'new-cap': 'Labels are put on every widget the system builds, before it ships.' } })
  assert.deepEqual(written.written, ['openspec/specs/new-cap/spec.md', 'openspec/specs/widgets/spec.md'])
  assert.deepEqual(written.placeholderPurpose, [])
  assert.match(read(change, 'widgets'), /SHALL store widgets dry\.[\s\S]*### Requirement: Track/)
  assert.match(read(change, 'new-cap'), /## Purpose\nLabels are put/)

  const again = writeMerge(change, 'add-x')
  assert.equal(again.merged, true)
  assert.deepEqual(again.written, [])
  assert.equal(again.base, null)
})

test('a requirement edited on the base branch since the merge base is a conflict, and nothing is written', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: BASE_MAIN, other: mainSpec('other', req('Keep')) }, delta: { widgets: DELTA, other: `## ADDED Requirements\n\n${req('More')}` }, origin: true })
  onDevelop({ 'openspec/specs/widgets/spec.md': BASE_MAIN.replace('The system SHALL store.', 'The system SHALL store widgets cold.') })
  const preview = mergePreview(change, 'add-x')
  assert.equal(preview.ok, false)
  assert.equal(preview.base.ref, 'origin/develop')
  assert.deepEqual(preview.conflicts.map(({ capability, requirement, operation, side }) => ({ capability, requirement, operation, side })), [
    { capability: 'widgets', requirement: 'Store', operation: 'MODIFIED', side: 'base-branch' }
  ])
  const [conflict] = preview.conflicts
  assert.match(conflict.base, /SHALL store\.$/m)
  assert.match(conflict.current, /SHALL store widgets cold\./)
  assert.match(conflict.delta, /SHALL store widgets dry\./)
  const before = read(change, 'other')
  const result = writeMerge(change, 'add-x')
  assert.deepEqual(result.written, [])
  assert.equal(read(change, 'other'), before, 'all or nothing: the capability without a conflict is not written either')
  assert.equal(status(change), '')
})

test('an edit on the base branch to a requirement the delta does not touch is no conflict', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  onDevelop({ 'openspec/specs/widgets/spec.md': BASE_MAIN.replace('The system SHALL ship.', 'The system SHALL ship by sea.') })
  assert.deepEqual(mergePreview(change, 'add-x').conflicts, [])
})

test('a main spec edited in the change worktree itself is a worktree conflict', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  writeFileSync(join(change, 'openspec', 'specs', 'widgets', 'spec.md'), BASE_MAIN.replace('The system SHALL store.', 'The system SHALL store here.'))
  assert.deepEqual(mergePreview(change, 'add-x').conflicts.map((c) => [c.requirement, c.side]), [['Store', 'worktree']])
})

test('resolutions apply to conflicts only: MODIFIED, REMOVED and RENAMED', () => {
  const main = mainSpec('widgets', req('Build'), req('Store'), req('Ship'), req('Paint'))
  const delta = `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry.')}\n## REMOVED Requirements\n\n${req('Ship', '**Reason**: gone.')}\n## RENAMED Requirements\n\n- FROM: \`### Requirement: Paint\`\n- TO: \`### Requirement: Colour\`\n`
  const { change, onDevelop } = mergeRepo({ main: { widgets: main }, delta: { widgets: delta } })
  onDevelop({ 'openspec/specs/widgets/spec.md': main.replace('SHALL store.', 'SHALL store cold.').replace('SHALL ship.', 'SHALL ship fast.').replace('SHALL paint.', 'SHALL paint red.') })
  const conflicts = mergePreview(change, 'add-x').conflicts
  assert.deepEqual(conflicts.map((c) => c.requirement), ['Store', 'Ship', 'Paint'])
  // The worktree still holds the base text: a resolution is built on it, the base branch's edit
  // reaching the main spec through the resolved text.
  const resolutions = [
    { capability: 'widgets', requirement: 'Store', text: req('Store', 'The system SHALL store widgets cold and dry.'), reason: 'both edits kept' },
    { capability: 'widgets', requirement: 'Ship', text: '', reason: 'the removal stands' },
    { capability: 'widgets', requirement: 'Paint', text: req('Colour', 'The system SHALL paint red.'), reason: 'rename kept, colour kept' }
  ]
  const preview = mergePreview(change, 'add-x', { resolutions })
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.capabilities[0].conflicts.map((c) => [c.requirement, c.resolved, c.reason]), [
    ['Store', true, 'both edits kept'], ['Ship', true, 'the removal stands'], ['Paint', true, 'rename kept, colour kept']
  ])
  assert.deepEqual(writeMerge(change, 'add-x', { resolutions }).written, ['openspec/specs/widgets/spec.md'])
  const text = read(change, 'widgets')
  assert.match(text, /SHALL store widgets cold and dry\./)
  assert.doesNotMatch(text, /Requirement: Ship/)
  assert.match(text, /### Requirement: Colour\nThe system SHALL paint red\./)

  const again = writeMerge(change, 'add-x', { resolutions })
  assert.equal(again.merged, true, 'a re-run with the same resolutions finds them in place')
  assert.deepEqual(again.written, [])
})

test('a REMOVED conflict resolved with a text keeps the requirement', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: `## REMOVED Requirements\n\n${req('Ship', '**Reason**: gone.')}` } })
  onDevelop({ 'openspec/specs/widgets/spec.md': BASE_MAIN.replace('SHALL ship.', 'SHALL ship fast.') })
  const resolutions = [{ capability: 'widgets', requirement: 'Ship', text: req('Ship', 'The system SHALL ship fast.'), reason: 'still needed' }]
  assert.deepEqual(writeMerge(change, 'add-x', { resolutions }).written, ['openspec/specs/widgets/spec.md'])
  assert.match(read(change, 'widgets'), /### Requirement: Ship\nThe system SHALL ship fast\./)
})

test('a resolution for a requirement that is no conflict, or with the wrong header, is refused', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  assert.throws(() => mergePreview(change, 'add-x', { resolutions: [{ capability: 'widgets', requirement: 'Store', text: req('Store'), reason: 'r' }] }), /answer no conflict: widgets "Store"/)
  onDevelop({ 'openspec/specs/widgets/spec.md': BASE_MAIN.replace('SHALL store.', 'SHALL store cold.') })
  assert.throws(() => mergePreview(change, 'add-x', { resolutions: [{ capability: 'widgets', requirement: 'Store', text: req('Stash'), reason: 'r' }] }), /must start with "### Requirement: Store"/)
  assert.throws(() => mergePreview(change, 'add-x', { resolutions: [{ capability: 'widgets', requirement: 'Store', text: '', reason: 'r' }] }), /empty text resolves a REMOVED conflict only/)
  assert.throws(() => mergePreview(change, 'add-x', { resolutions: [{ capability: 'widgets', requirement: 'Build', text: req('Build'), reason: 'r' }] }), /answer no conflict: widgets "Build"/)
  assert.equal(status(change), '')
})

test('every rebuilt spec is validated strictly before any write: one failure writes nothing', () => {
  const brief = BASE_MAIN.replace(PURPOSE, 'Too brief.')
  const { change } = mergeRepo({
    main: { widgets: BASE_MAIN, brief: brief.replace('# widgets', '# brief'), bare: mainSpec('bare', req('Keep')) },
    delta: { widgets: DELTA, brief: `## ADDED Requirements\n\n${req('Track')}`, bare: `## MODIFIED Requirements\n\n### Requirement: Keep\nThe system SHALL keep.\n` }
  })
  const result = writeMerge(change, 'add-x')
  assert.equal(result.ok, false)
  assert.deepEqual(result.written, [])
  assert.deepEqual(result.errors.map((e) => [e.capability, e.error, e.issues.map((i) => `${i.level} ${i.path}`)]), [
    ['bare', 'Validation errors in rebuilt spec for bare', ['ERROR requirements.0.scenarios', 'WARNING requirements[0].scenarios']],
    ['brief', 'Validation errors in rebuilt spec for brief', ['WARNING overview']]
  ])
  assert.equal(result.capabilities.find((c) => c.capability === 'widgets').error, undefined)
  assert.equal(status(change), '')
})

test('a refusal of the merge itself is reported per capability, and an unknown change throws', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: `## ADDED Requirements\n\n${req('Store')}\n${req('Store')}` } })
  const preview = mergePreview(change, 'add-x')
  assert.deepEqual(preview.errors, [{ capability: 'widgets', error: 'widgets validation failed - duplicate requirement in ADDED for header "### Requirement: Store"' }])
  assert.throws(() => mergePreview(change, 'add-y'), /no change "add-y"/)
  assert.equal(existsSync(join(change, 'openspec', 'specs', 'widgets', 'spec.md')), true)
})

// ---- The base snapshot (specs-base.json) ----

const SPEC = 'openspec/specs/widgets/spec.md'
const DELTA_PATH = 'openspec/changes/add-x/specs/widgets/spec.md'
const BASE_PATH = 'openspec/changes/add-x/specs-base.json'
const snapshotOf = (dir) => JSON.parse(readFileSync(specsBasePath(dir, 'add-x'), 'utf8')).capabilities
const ids = (list) => list.map((m) => `${m.capability}: ${m.requirement}`)

test('a rebase moves the merge base past the other change: the snapshot still sees the conflict, the merge base does not', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  assert.equal(writeSpecsBase(change, 'add-x').ok, true)
  commitFiles(change, {}, 'snapshot')
  // Another change edits the requirement on develop; the branch is then rebased onto it, so the
  // merge base is the new develop tip and the worktree's main spec holds the other edit.
  const tip = onDevelop({ [SPEC]: BASE_MAIN.replace('The system SHALL store.', 'The system SHALL store widgets cold.') })
  git(change, 'rebase', '-q', 'develop')
  assert.equal(changeMergeBase(change, 'add-x').sha, tip)

  const preview = mergePreview(change, 'add-x')
  assert.equal(preview.ok, false)
  assert.deepEqual(preview.base, { ref: 'develop', sha: null, snapshot: BASE_PATH })
  assert.deepEqual(preview.warnings, [])
  assert.deepEqual(preview.conflicts.map(({ requirement, operation, side }) => [requirement, operation, side]), [['Store', 'MODIFIED', 'base-branch']])
  assert.match(preview.conflicts[0].base, /SHALL store\.$/m)
  assert.match(preview.conflicts[0].current, /SHALL store widgets cold\./)
  assert.deepEqual(writeMerge(change, 'add-x').written, [])

  rmSync(specsBasePath(change, 'add-x'))
  const fallback = mergePreview(change, 'add-x')
  assert.equal(fallback.ok, true, 'without the snapshot the rebase hides the conflict')
  assert.deepEqual(fallback.conflicts, [])
  assert.equal(fallback.base.sha, tip)
  assert.deepEqual(fallback.warnings, [NO_SPECS_BASE])
  assert.equal(NO_SPECS_BASE, 'no specs-base.json; base from git merge-base, which a rebase moves')
})

test('a snapshot with no entry for a touched requirement refuses that capability\'s merge', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  writeFileSync(specsBasePath(change, 'add-x'), '{"capabilities":{}}\n')
  const preview = mergePreview(change, 'add-x')
  assert.equal(preview.ok, false)
  assert.deepEqual(preview.errors, [{ capability: 'widgets', error: `${BASE_PATH} holds no base for "Store"; the three-way check cannot run without it` }])
  assert.deepEqual(writeMerge(change, 'add-x').written, [])
  writeFileSync(specsBasePath(change, 'add-x'), '{"capabilities":[]}\n')
  assert.throws(() => mergePreview(change, 'add-x'), /specs-base\.json is not \{ capabilities/)
})

test('specs.mjs base adds, keeps, refreshes and drops entries, deterministically', () => {
  const main = mainSpec('widgets', req('Build'), req('Store'), req('Ship'))
  const delta = `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry.')}\n## REMOVED Requirements\n\n${req('Ship', '**Reason**: gone.')}`
  const { change } = mergeRepo({ main: { widgets: main }, delta: { widgets: delta, 'new-cap': `## ADDED Requirements\n\n${req('Label')}` } })
  const first = writeSpecsBase(change, 'add-x')
  assert.deepEqual([first.ok, first.file, ids(first.added), first.refreshed, first.kept, first.dropped], [true, BASE_PATH, ['widgets: Store', 'widgets: Ship'], [], [], []])
  const bytes = readFileSync(specsBasePath(change, 'add-x'), 'utf8')
  assert.ok(bytes.endsWith('}\n'))
  assert.deepEqual(Object.keys(snapshotOf(change).widgets), ['Ship', 'Store'], 'keys sorted')
  assert.deepEqual(Object.keys(snapshotOf(change).widgets.Store), ['operation', 'delta', 'base'])
  assert.equal(snapshotOf(change).widgets.Store.base, req('Store').trimEnd())
  assert.equal(snapshotOf(change).widgets.Store.operation, 'MODIFIED')

  const again = writeSpecsBase(change, 'add-x')
  assert.deepEqual([again.added, ids(again.kept)], [[], ['widgets: Store', 'widgets: Ship']])
  assert.equal(readFileSync(specsBasePath(change, 'add-x'), 'utf8'), bytes, 'a re-run writes the same bytes')

  // The main spec moves (a rebase): an unchanged delta block keeps the base it was written on.
  writeFileSync(join(change, SPEC), main.replace('SHALL store.', 'SHALL store cold.'))
  assert.deepEqual(ids(writeSpecsBase(change, 'add-x').kept), ['widgets: Store', 'widgets: Ship'])
  assert.match(snapshotOf(change).widgets.Store.base, /SHALL store\.$/m)
  // Blank-line and trailing-space edits are no change of the block.
  writeFileSync(join(change, DELTA_PATH), delta.replace('dry.', 'dry.  \n'))
  assert.deepEqual(ids(writeSpecsBase(change, 'add-x').kept), ['widgets: Store', 'widgets: Ship'])

  // The delta is edited: Store's block changes, Ship leaves, Build is renamed.
  writeFileSync(join(change, DELTA_PATH), `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry and cold.')}\n## RENAMED Requirements\n\n- FROM: \`### Requirement: Build\`\n- TO: \`### Requirement: Make\`\n`)
  const edited = writeSpecsBase(change, 'add-x')
  assert.deepEqual([ids(edited.added), ids(edited.refreshed), edited.kept, ids(edited.dropped)], [['widgets: Build'], ['widgets: Store'], [], ['widgets: Ship']])
  assert.match(snapshotOf(change).widgets.Store.base, /SHALL store cold\./, 'a changed block takes the main spec as it is now')
  assert.deepEqual(Object.keys(snapshotOf(change).widgets), ['Build', 'Store'])
  assert.equal(snapshotOf(change).widgets.Build.operation, 'RENAMED')
})

test('specs.mjs base refuses, writing nothing, when the main spec lacks a touched requirement', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: `## MODIFIED Requirements\n\n${req('Paint')}` } })
  const result = writeSpecsBase(change, 'add-x')
  assert.equal(result.ok, false)
  assert.deepEqual(ids(result.missing), ['widgets: Paint'])
  assert.match(result.error, /the main spec holds no requirement widgets "Paint"/)
  assert.equal(existsSync(specsBasePath(change, 'add-x')), false)
})

test('specs.mjs base --check refuses a missing file, a missing entry and a stale one, and writes nothing', () => {
  const { change } = mergeRepo({ main: { widgets: BASE_MAIN }, delta: { widgets: DELTA } })
  const check = (...args) => specsCli(['base', '--check', '--change', 'add-x', '--root', change, ...args])
  let result = check()
  assert.equal(failed(result), true)
  assert.deepEqual([result.ok, result.exists, ids(result.missing), result.stale], [false, false, ['widgets: Store'], []])
  assert.match(result.refusal, /has no base for widgets "Store": run specs\.mjs base --change add-x/)
  assert.equal(existsSync(specsBasePath(change, 'add-x')), false)

  const written = specsCli(['base', '--change', 'add-x', '--root', change])
  assert.deepEqual([written.ok, written.change, written.file, ids(written.added)], [true, 'add-x', BASE_PATH, ['widgets: Store']])
  result = check()
  assert.deepEqual([failed(result), result.exists, result.missing, result.stale], [false, true, [], []])

  writeFileSync(join(change, DELTA_PATH), DELTA.replace('dry.', 'wet.'))
  result = check()
  assert.deepEqual([failed(result), ids(result.stale)], [true, ['widgets: Store']])
  assert.match(result.refusal, /a base taken for another delta text for widgets "Store"/)

  writeFileSync(join(change, DELTA_PATH), `${DELTA}\n## REMOVED Requirements\n\n${req('Ship', '**Reason**: gone.')}`)
  result = check()
  assert.deepEqual([ids(result.missing), result.stale], [['widgets: Ship'], []])
  assert.throws(() => specsCli(['base', '--check', '--spec', 'widgets', '--root', change]), /usage/)
  assert.throws(() => specsCli(['merge', '--dry-run', '--check', '--root', change]), /usage/)
})
