import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAllowlist, assertConfiguredAllowlist, loadPlan, planFileName, projectOf, savePlan, validatePlan } from '../lib/plan.mjs'

function plan(rows) {
  return {
    version: 1,
    operation: 'transition',
    jql: 'project = PROJ',
    allowlist: ['PROJ'],
    discoveredAt: '2026-09-09T13:06:36.000+03:00',
    rows: rows.map((r) => ({ key: r.key, summary: 's', from: 'Opened', steps: [], state: 'pending' }))
  }
}

describe('projectOf', () => {
  it('takes the segment before the last hyphen', () => {
    assert.equal(projectOf('PROJ-564'), 'PROJ')
  })

  it('handles a project key containing digits', () => {
    assert.equal(projectOf('AD10ACSENG-7'), 'AD10ACSENG')
  })

  it('throws on something that is not an issue key', () => {
    assert.throws(() => projectOf('not-a-key-'), /issue key/i)
  })
})

describe('assertAllowlist', () => {
  it('accepts a plan whose rows are all inside the allowlist', () => {
    assert.doesNotThrow(() => assertAllowlist(plan([{ key: 'PROJ-1' }, { key: 'PROJ-2' }])))
  })

  it('rejects the whole plan when one row is outside, naming the offender', () => {
    const p = plan([{ key: 'PROJ-1' }, { key: 'OTHER-9' }])
    assert.throws(() => assertAllowlist(p), /OTHER-9/)
  })

  it('does not filter — the plan keeps every row after a rejection', () => {
    const p = plan([{ key: 'PROJ-1' }, { key: 'OTHER-9' }])
    try {
      assertAllowlist(p)
    } catch {
      // expected
    }
    assert.equal(p.rows.length, 2)
  })

  it('rejects an empty allowlist rather than treating it as permissive', () => {
    const p = plan([{ key: 'PROJ-1' }])
    p.allowlist = []
    assert.throws(() => assertAllowlist(p), /allowlist/i)
  })
})

describe('assertAllowlist for link steps', () => {
  function linkPlan(inwardIssue, outwardIssue) {
    return {
      version: 1,
      operation: 'transition',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [{ key: 'PROJ-999', summary: 's', steps: [{ link: { type: 'Relates', inwardIssue, outwardIssue } }], state: 'pending' }]
    }
  }

  it('rejects a link step whose outward key names a foreign project, naming that key', () => {
    assert.throws(() => assertAllowlist(linkPlan('PROJ-1', 'OTHER-9')), /OTHER-9/)
  })

  it('rejects a link step whose inward key names a foreign project, naming that key', () => {
    assert.throws(() => assertAllowlist(linkPlan('OTHER-9', 'PROJ-1')), /OTHER-9/)
  })

  it('accepts a link step whose both keys are inside the allowlist', () => {
    assert.doesNotThrow(() => assertAllowlist(linkPlan('PROJ-1', 'PROJ-999')))
  })

  it('accepts a link step on a create row, checked against the row project rather than its (new) key', () => {
    const p = {
      version: 1,
      operation: 'create',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [
        {
          key: '(new)',
          project: 'PROJ',
          summary: 's',
          steps: [{ link: { type: 'Relates', inwardIssue: 'PROJ-1', outwardIssue: 'PROJ-999' } }],
          state: 'pending'
        }
      ]
    }
    assert.doesNotThrow(() => assertAllowlist(p))
  })
})

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => {
    assert.equal(validatePlan(plan([{ key: 'PROJ-1' }])).rows.length, 1)
  })

  it('rejects an unknown version', () => {
    assert.throws(() => validatePlan({ ...plan([]), version: 2 }), /version/i)
  })

  it('rejects an unknown operation', () => {
    assert.throws(() => validatePlan({ ...plan([]), operation: 'delete' }), /operation/i)
  })

  it('rejects a row with an unknown state', () => {
    const p = plan([{ key: 'PROJ-1' }])
    p.rows[0].state = 'weird'
    assert.throws(() => validatePlan(p), /state/i)
  })

  it('throws "not an object" on null row, not TypeError', () => {
    const p = plan([{ key: 'PROJ-1' }])
    p.rows = [null]
    try {
      validatePlan(p)
      throw new Error('Should have thrown')
    } catch (e) {
      assert.ok(!(e instanceof TypeError))
      assert.match(String(e), /not an object/i)
    }
  })

  it('throws "not an object" on top-level array input, not version error', () => {
    assert.throws(() => validatePlan([]), /not an object/i)
  })

  it('still rejects null and string inputs with "not an object" message', () => {
    assert.throws(() => validatePlan(null), /not an object/i)
    assert.throws(() => validatePlan('hello'), /not an object/i)
  })
})

describe('planFileName', () => {
  it('embeds the operation and a sortable timestamp', () => {
    assert.match(planFileName('transition', new Date('2026-09-09T14:12:00Z')), /^plan-transition-2026-09-09-\d{4}\.json$/)
  })
})

describe('savePlan and loadPlan', () => {
  it('writes under .claude-reports/jira and reads back identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-plan-'))
    const p = plan([{ key: 'PROJ-1' }])
    const path = savePlan(dir, p, new Date('2026-09-09T14:12:00Z'))
    assert.ok(path.includes(join('.claude-reports', 'jira')))
    assert.deepEqual(loadPlan(path), p)
  })
})

describe('assertAllowlist for create rows', () => {
  function createRowPlan(project) {
    return {
      version: 1,
      operation: 'create',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [{ key: '(new)', project, summary: 's', steps: [], state: 'pending' }]
    }
  }

  it('checks the row project when the row has no issue key yet', () => {
    assert.doesNotThrow(() => assertAllowlist(createRowPlan('PROJ')))
  })

  it('rejects a create row for a project outside the allowlist', () => {
    assert.throws(() => assertAllowlist(createRowPlan('OTHER')), /OTHER/)
  })
})

describe('validatePlan for comment plans', () => {
  it('accepts the comment operation', () => {
    const value = {
      version: 1,
      operation: 'comment',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [{ key: 'PROJ-586', summary: 's', steps: [{ comment: { action: 'add', body: 'b' } }], state: 'pending' }]
    }
    assert.equal(validatePlan(value).operation, 'comment')
  })
})

describe('assertConfiguredAllowlist', () => {
  it('refuses a plan whose own allowlist reaches past the configured one', () => {
    const p = plan([{ key: 'PROJ-1' }])
    p.allowlist = ['PROJ', 'OTHER']
    assert.throws(() => assertConfiguredAllowlist(p, ['PROJ']), /OTHER/)
  })

  it('accepts a plan within the configured allowlist', () => {
    assert.doesNotThrow(() => assertConfiguredAllowlist(plan([{ key: 'PROJ-1' }]), ['PROJ', 'OTHER']))
  })
})
