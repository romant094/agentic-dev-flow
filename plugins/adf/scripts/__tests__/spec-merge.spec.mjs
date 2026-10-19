// The `spec-merge <capability>` reply at archive: lib/spec-merge.mjs checks it against
// schema/spec-merge-resolution.schema.json, checkResolutions and the capability's conflicts, and
// `specs.mjs resolution` runs that check against the dry run's conflicts in a real repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unknownKeywords, readSchema } from '../lib/review.mjs'
import { checkSpecMergeReply, SPEC_MERGE_SCHEMA_PATH, writeConflictTexts } from '../lib/spec-merge.mjs'
import { mergePreview } from '../lib/specs.mjs'
import { mergeRepo } from './fixtures/spec-merge/repo.mjs'

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '..', 'specs.mjs')
const req = (name, body) => `### Requirement: ${name}\n${body}\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n`
const MAIN = `# widgets Specification\n\n## Purpose\nWidgets are built, stored and shipped by the system, one at a time.\n\n## Requirements\n${req('Store', 'The system SHALL store.')}\n${req('Ship', 'The system SHALL ship.')}`
const resolution = (requirement, text, extra = {}) => ({ capability: 'widgets', requirement, text, reason: 'kept both', ...extra })
const conflicts = [{ requirement: 'Store' }, { requirement: 'Ship' }]

test('the schema uses only keywords the validator implements', () => {
  assert.deepEqual(unknownKeywords(readSchema(SPEC_MERGE_SCHEMA_PATH)), [])
})

test('a reply answers every conflict of its capability once, under the schema and checkResolutions', () => {
  const good = JSON.stringify([resolution('Store', req('Store', 'The system SHALL store widgets cold and dry.')), resolution('Ship', '')])
  const ok = checkSpecMergeReply(good, { capability: 'widgets', conflicts })
  assert.deepEqual({ valid: ok.valid, errors: ok.errors }, { valid: true, errors: [] })
  assert.equal(checkSpecMergeReply(`\`\`\`json\n${good}\n\`\`\``, { capability: 'widgets', conflicts }).fenced, true)
  const cases = [
    ['not json', /not JSON/],
    [JSON.stringify({ capability: 'widgets' }), /expected array/],
    [JSON.stringify([{ capability: 'widgets', requirement: 'Store', text: 'x' }]), /reason is required/],
    [JSON.stringify([resolution('Store', 'x', { reason: '  ' })]), /reason/],
    [JSON.stringify([resolution('Store', 'x', { extra: 1 })]), /extra is not allowed/],
    [JSON.stringify([resolution('Store', 'x'), resolution('Store', 'y'), resolution('Ship', '')]), /resolved twice/],
    [JSON.stringify([resolution('Store', 'x'), resolution('Ship', '', { capability: 'other' })]), /not the dispatched widgets/],
    [JSON.stringify([resolution('Store', 'x')]), /"Ship" has no resolution/],
    [JSON.stringify([resolution('Store', 'x'), resolution('Ship', ''), resolution('Build', 'z')]), /"Build" is not a conflict/]
  ]
  for (const [text, message] of cases) {
    const result = checkSpecMergeReply(text, { capability: 'widgets', conflicts })
    assert.equal(result.valid, false, text)
    assert.match(result.errors.join('\n'), message, text)
  }
})

test('writeConflictTexts writes each text that exists and leaves an absent one null', () => {
  const { change } = mergeRepo({ main: { widgets: MAIN }, delta: { widgets: `## REMOVED Requirements\n\n### Requirement: Ship\n**Reason**: gone\n**Migration**: none\n` } })
  const [written] = writeConflictTexts(change, 'add-x', 'widgets', [{ requirement: 'Ship', operation: 'REMOVED', side: 'worktree', base: 'b', current: null, delta: 'd\n\n' }])
  assert.equal(written.current, null)
  assert.match(written.base, /spec-merge\/widgets\/1-base\.md$/)
})

test('specs.mjs resolution checks a reply against the conflicts the dry run finds', () => {
  const { change, onDevelop } = mergeRepo({ main: { widgets: MAIN }, delta: { widgets: `## MODIFIED Requirements\n\n${req('Store', 'The system SHALL store widgets dry.')}` } })
  onDevelop({ 'openspec/specs/widgets/spec.md': MAIN.replace('SHALL store.', 'SHALL store widgets cold.') })
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [SPECS, 'resolution', ...args, '--change', 'add-x', '--root', change], { encoding: 'utf8' })
    return { status: r.status, out: JSON.parse(r.stdout) }
  }
  const reply = join(change, 'reply.json')
  const text = req('Store', 'The system SHALL store widgets cold and dry.')
  writeFileSync(reply, JSON.stringify([resolution('Store', text)]))
  const ok = cli('--capability', 'widgets', '--reply', reply)
  assert.equal(ok.status, 0)
  assert.deepEqual({ valid: ok.out.valid, conflicts: ok.out.conflicts }, { valid: true, conflicts: ['Store'] })
  assert.equal(mergePreview(change, 'add-x', { resolutions: ok.out.resolutions }).ok, true, 'a valid reply is the merge\'s resolutions')
  writeFileSync(reply, JSON.stringify([resolution('Ship', text)]))
  const bad = cli('--capability', 'widgets', '--reply', reply)
  assert.equal(bad.status, 1)
  assert.equal(bad.out.valid, false)
  assert.equal(cli('--capability', 'other', '--reply', reply).status, 1)
  assert.equal(cli('--capability', 'widgets').status, 2)
})
