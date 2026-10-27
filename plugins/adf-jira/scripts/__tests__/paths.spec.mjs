import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { solvePath } from '../lib/paths.mjs'

const t = (id, name, to, requiredFields = []) => ({ id, name, to, requiredFields, allowedValues: {} })

const graph = {
  Opened: [t('4', 'Start Progress', 'In Progress'), t('5', 'Resolve Issue', 'Resolved', ['resolution'])],
  'In Progress': [t('811', 'Suspend', 'Suspended'), t('821', 'Review Issue', 'Review')],
  Review: [t('741', 'Open Issue', 'Opened'), t('751', 'Resolve Issue', 'Resolved', ['resolution'])],
  Resolved: [t('701', 'Close Issue', 'Closed'), t('831', 'Reopen Issue', 'Opened')],
  Closed: [t('761', 'Reopen Issue', 'Opened')],
  Suspended: [t('791', 'Open Issue', 'Opened')]
}

function path(result) {
  if (result.kind !== 'path') throw new Error(`expected a path, got ${result.kind}`)
  return result.transitions
}

describe('solvePath', () => {
  it('returns an empty path when the issue is already at the target', () => {
    const result = solvePath(graph, 'Resolved', 'Resolved')
    assert.equal(result.kind, 'path')
    assert.deepEqual(path(result), [])
  })

  it('finds the single hop when one exists', () => {
    assert.deepEqual(
      path(solvePath(graph, 'Opened', 'Resolved')).map((x) => x.id),
      ['5']
    )
  })

  it('routes In Progress to Resolved through Review, since no direct hop exists', () => {
    assert.deepEqual(
      path(solvePath(graph, 'In Progress', 'Resolved')).map((x) => x.id),
      ['821', '751']
    )
  })

  it('finds the three-hop path from In Progress to Closed', () => {
    assert.deepEqual(
      path(solvePath(graph, 'In Progress', 'Closed')).map((x) => x.id),
      ['821', '751', '701']
    )
  })

  it('reopens and re-resolves to get from Closed to Resolved', () => {
    assert.deepEqual(
      path(solvePath(graph, 'Closed', 'Resolved')).map((x) => x.id),
      ['761', '5']
    )
  })

  it('carries the required fields of each hop, so the caller can supply resolution', () => {
    const transitions = path(solvePath(graph, 'In Progress', 'Resolved'))
    assert.deepEqual(transitions[0].requiredFields, [])
    assert.deepEqual(transitions[1].requiredFields, ['resolution'])
  })

  it('returns unreachable when the target status is not in the graph and nothing visited was unsampled', () => {
    assert.deepEqual(solvePath(graph, 'Opened', 'Nirvana'), { kind: 'unreachable' })
  })

  it('returns unreachable when the origin status is not in the graph and it was not unsampled', () => {
    assert.deepEqual(solvePath(graph, 'Nirvana', 'Opened'), { kind: 'unreachable' })
  })

  it('prefers the shortest path when several exist', () => {
    const branchy = { A: [t('1', 'long', 'B'), t('2', 'short', 'C')], B: [t('3', 'b-to-c', 'C')], C: [] }
    assert.deepEqual(
      path(solvePath(branchy, 'A', 'C')).map((x) => x.id),
      ['2']
    )
  })

  it('returns unknown when an unreachable target leaves no unsampled status visited', () => {
    assert.deepEqual(solvePath(graph, 'Opened', 'Nirvana', []), { kind: 'unreachable' })
  })

  it('returns unknown naming a visited status that was unsampled, when no path is found', () => {
    assert.deepEqual(solvePath(graph, 'Opened', 'Nirvana', ['Review']), { kind: 'unknown', unsampled: ['Review'] })
  })

  it('returns unknown when the origin is absent from the graph but listed as unsampled', () => {
    assert.deepEqual(solvePath(graph, 'Nirvana', 'Opened', ['Nirvana']), { kind: 'unknown', unsampled: ['Nirvana'] })
  })

  it('behaves exactly as before for the path case when unsampledStatuses is omitted', () => {
    assert.deepEqual(solvePath(graph, 'Opened', 'Resolved'), { kind: 'path', transitions: [t('5', 'Resolve Issue', 'Resolved', ['resolution'])] })
  })

  it('behaves exactly as before for the unreachable case when unsampledStatuses is omitted', () => {
    assert.deepEqual(solvePath(graph, 'Opened', 'Nirvana'), { kind: 'unreachable' })
  })

  it('never passes through an avoided status, whichever route the graph lists first', () => {
    const reviewFirst = { ...graph, 'In Progress': [t('821', 'Review Issue', 'Review'), t('811', 'Suspend', 'Suspended')] }
    for (const g of [graph, reviewFirst]) {
      assert.deepEqual(
        path(solvePath(g, 'In Progress', 'Opened', [], ['Review'])).map((x) => x.id),
        ['811', '791']
      )
    }
    assert.deepEqual(
      path(solvePath(reviewFirst, 'In Progress', 'Opened')).map((x) => x.id),
      ['821', '741']
    )
  })

  it('still ends at an avoided status when it is the target, and is unreachable when only an avoided status leads there', () => {
    assert.deepEqual(
      path(solvePath(graph, 'In Progress', 'Review', [], ['Review'])).map((x) => x.id),
      ['821']
    )
    assert.deepEqual(solvePath(graph, 'In Progress', 'Resolved', [], ['Review', 'Opened']), { kind: 'unreachable' })
  })
})
