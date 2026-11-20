import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARCHIVE_DIR, CHANGES_DIR, changePath, CONTEXT_FILE, flowPath, PLANNING_FILE, REVIEW_PROMPT, ROOT, RULES_DIR, SPECS_DIR, specPath } from '../lib/layout.mjs'

test('lib/layout.mjs derives every path from the one root', () => {
  for (const path of [CHANGES_DIR, ARCHIVE_DIR, SPECS_DIR, CONTEXT_FILE, RULES_DIR, PLANNING_FILE, REVIEW_PROMPT]) {
    assert.ok(path.startsWith(`${ROOT}/`), path)
  }
  assert.equal(ARCHIVE_DIR, `${CHANGES_DIR}/archive`)
  assert.equal(changePath('add-x'), `${ROOT}/changes/add-x`)
  assert.equal(changePath('add-x', 'plan.md'), `${ROOT}/changes/add-x/plan.md`)
  assert.equal(specPath('auth'), `${ROOT}/specs/auth/spec.md`)
  assert.equal(flowPath('planning.md'), PLANNING_FILE)
})
