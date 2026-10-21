// The runner of a confirmed plan. Before a row whose plan recorded its status (`from`), it reads
// the issue's status again and skips the row as drifted when someone moved it by hand. State is
// persisted after every row, so an interrupted run resumes; three failures in a row stop it.
import { resolvePlaceholders } from './placeholders.mjs'

const SUPPORTED_OPERATIONS = ['transition', 'edit', 'worklog', 'create', 'comment']

// `values` resolves the plan's login placeholders inside this process; the plan keeps them.
export async function applyPlan({ plan, client, persist, maxConsecutiveFailures = 3, values = {} }) {
  if (!SUPPORTED_OPERATIONS.includes(plan.operation)) {
    throw new Error(`applyPlan does not support operation "${plan.operation}". Nothing was applied.`)
  }

  const outcome = {
    applied: 0,
    skippedDone: 0,
    skippedDrift: 0,
    failed: 0,
    abortedAfterConsecutiveFailures: false
  }
  let consecutiveFailures = 0

  for (const row of plan.rows) {
    if (row.state === 'done') {
      outcome.skippedDone += 1
      continue
    }

    try {
      if (row.from !== undefined) {
        const current = await currentStatus(client, row.key)
        if (current !== row.from) {
          row.state = 'skipped-drift'
          row.error = `Expected status "${row.from}" but found "${current ?? 'unknown'}"; left untouched.`
          outcome.skippedDrift += 1
          persist(plan)
          continue
        }
      }

      for (const step of row.steps) {
        await runStep(client, row, resolvePlaceholders(step, values))
      }
      row.state = 'done'
      row.error = undefined
      outcome.applied += 1
      consecutiveFailures = 0
    } catch (error) {
      row.state = 'failed'
      row.error = error instanceof Error ? error.message : String(error)
      outcome.failed += 1
      consecutiveFailures += 1
    }

    persist(plan)

    if (consecutiveFailures >= maxConsecutiveFailures) {
      outcome.abortedAfterConsecutiveFailures = true
      return outcome
    }
  }

  return outcome
}

async function currentStatus(client, key) {
  const issue = await client.get(`/rest/api/2/issue/${key}?fields=status`)
  return issue.fields.status?.name
}

async function runStep(client, row, step) {
  if (step.create !== undefined) {
    const created = await client.post('/rest/api/2/issue', { fields: step.create.fields })
    if (created?.key === undefined) {
      throw new Error(`Jira accepted the create for ${row.key} but returned no issue key.`)
    }
    row.createdKey = created.key
    return
  }
  if (step.worklog !== undefined) {
    const { timeSpent, started, comment } = step.worklog
    await client.post(`/rest/api/2/issue/${row.key}/worklog`, {
      timeSpent,
      ...(started === undefined ? {} : { started }),
      ...(comment === undefined ? {} : { comment })
    })
    return
  }
  if (step.comment !== undefined) {
    const { comment } = step
    if (comment.action === 'add') {
      await client.post(`/rest/api/2/issue/${row.key}/comment`, { body: comment.body })
    } else {
      await client.put(`/rest/api/2/issue/${row.key}/comment/${comment.id}`, { body: comment.body })
    }
    return
  }
  if (step.transitionId !== undefined) {
    await client.post(`/rest/api/2/issue/${row.key}/transitions`, {
      transition: { id: step.transitionId },
      ...(step.fields === undefined ? {} : { fields: step.fields })
    })
    return
  }
  if (step.fields !== undefined) {
    await client.put(`/rest/api/2/issue/${row.key}`, { fields: step.fields })
    return
  }
  if (step.link !== undefined) {
    const { type, inwardIssue, outwardIssue } = step.link
    await client.post('/rest/api/2/issueLink', {
      type: { name: type },
      inwardIssue: { key: inwardIssue },
      outwardIssue: { key: outwardIssue }
    })
    return
  }
  throw new Error(`Step for ${row.key} has no create, worklog, comment, transitionId, fields or link.`)
}
