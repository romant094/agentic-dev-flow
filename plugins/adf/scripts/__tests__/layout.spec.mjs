import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARCHIVE_DIR, CHANGES_DIR, changePath, CONTEXT_FILE, FLOW_ROOTS, flowPath, flowRelative, isFlowPath, LEGACY_ROOT, GUIDE_FILE, REVIEW_PROMPT, SETTINGS_FILE, ROOT, RULES_DIR, SPECS_DIR, specPath } from '../lib/layout.mjs'

test('lib/layout.mjs derives every path from the one root', () => {
  for (const path of [CHANGES_DIR, ARCHIVE_DIR, SPECS_DIR, CONTEXT_FILE, RULES_DIR, SETTINGS_FILE, GUIDE_FILE, REVIEW_PROMPT]) {
    assert.ok(path.startsWith(`${ROOT}/`), path)
  }
  assert.equal(ARCHIVE_DIR, `${CHANGES_DIR}/archive`)
  assert.equal(changePath('add-x'), `${ROOT}/changes/add-x`)
  assert.equal(changePath('add-x', 'plan.md'), `${ROOT}/changes/add-x/plan.md`)
  assert.equal(specPath('auth'), `${ROOT}/specs/auth/spec.md`)
  assert.equal(flowPath('settings.json'), SETTINGS_FILE)
})

test('the history readers know the current and the legacy root', () => {
  assert.ok(FLOW_ROOTS.includes(ROOT))
  assert.ok(FLOW_ROOTS.includes(LEGACY_ROOT))
  const roots = ['adf', 'openspec']
  assert.equal(flowRelative('adf/changes/archive/2026-01-01-x/tasks.md', 'changes/archive', roots), '2026-01-01-x/tasks.md')
  assert.equal(flowRelative('openspec/changes/archive/2026-01-01-x/tasks.md', 'changes/archive', roots), '2026-01-01-x/tasks.md')
  assert.equal(flowRelative('openspec/specs/auth/spec.md', '', roots), 'specs/auth/spec.md')
  assert.equal(flowRelative('src/openspec/changes/x', 'changes', roots), null)
  assert.equal(isFlowPath('adf/specs/auth/spec.md', 'specs', roots), true)
  assert.equal(isFlowPath('adfx/specs/auth/spec.md', 'specs', roots), false)
  assert.equal(isFlowPath('openspec', '', roots), false)
})
