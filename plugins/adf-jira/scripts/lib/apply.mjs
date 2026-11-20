// The runner of a confirmed plan. Before a row whose plan recorded its status (`from`), it reads
// the issue's status again and skips the row as drifted when someone moved it by hand. State is
// persisted after every row, so an interrupted run resumes; three failures in a row stop it.
// A comment step marked `once` is posted only when the issue holds no comment with the same
// body, so a rerun after a lost response posts no second copy.
// A row with `body: { shape }` guards a description edit: the description is read with the
// status, and the row is skipped as drifted when it does not match `shape`, a regular expression
// tested against its lines (bodyLines); when it already equals the description the row's
// `fields` step would write, nothing is sent and the row is done, counted as unchanged.
// A transition step marked `check` (a hand-off's) runs only when Jira offers it to the current
// user now and its screen requires no field the step does not fill; else the row fails with a
// reason that names the transition and the status, and nothing more is sent for it.
import { resolvePlaceholders } from './placeholders.mjs'
import { readAllComments } from './readers.mjs'

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
    unchanged: 0,
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
      if (row.from !== undefined || row.body !== undefined) {
        const issue = await currentIssue(client, row.key, row.body !== undefined)
        const current = issue.fields.status?.name
        const drift = (error) => {
          row.state = 'skipped-drift'
          row.error = error
          outcome.skippedDrift += 1
          persist(plan)
        }
        if (row.from !== undefined && current !== row.from) {
          drift(`Expected status "${row.from}" but found "${current ?? 'unknown'}"; left untouched.`)
          continue
        }
        if (row.body !== undefined) {
          const description = issue.fields.description ?? ''
          if (!new RegExp(row.body.shape).test(bodyLines(description))) {
            drift('The description was not built from the template; left untouched.')
            continue
          }
          const next = row.steps.find((s) => s.fields?.description !== undefined)?.fields.description
          if (next !== undefined && bodyLines(next) === bodyLines(description)) {
            row.state = 'done'
            row.error = undefined
            row.note = 'the description is already up to date; nothing was sent'
            outcome.unchanged += 1
            consecutiveFailures = 0
            persist(plan)
            continue
          }
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

async function currentIssue(client, key, description) {
  return client.get(`/rest/api/2/issue/${key}?fields=status${description ? ',description' : ''}`)
}

// A description as a shape is tested: its non-blank lines, each trimmed and ending in a newline.
export const bodyLines = (text) =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${l}\n`)
    .join('')

const sameBody = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim()

async function alreadyPosted(client, key, body) {
  const comments = await readAllComments(client, key)
  return comments.some((c) => sameBody(c.body) === sameBody(body))
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
      if (comment.once && (await alreadyPosted(client, row.key, comment.body))) {
        row.note = 'the comment was already posted; not posted again'
        return
      }
      await client.post(`/rest/api/2/issue/${row.key}/comment`, { body: comment.body })
    } else {
      await client.put(`/rest/api/2/issue/${row.key}/comment/${comment.id}`, { body: comment.body })
    }
    return
  }
  if (step.transitionId !== undefined) {
    if (step.check) {
      const offer = await transitionOffer(client, row.key, step)
      if (!offer.offered) throw new Error(`${transitionText(step)} is not offered to the current user; run the operation again without apply for a new plan`)
      if (offer.missing.length > 0) throw new Error(`${transitionText(step)} requires ${offer.missing.join(', ')}`)
    }
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

// What Jira offers the calling user on the issue now, for one transition step: whether the
// transition is offered (Jira applies the workflow's conditions here), and the names of the
// required screen fields the step does not fill. A field with a default value is filled by Jira.
export async function transitionOffer(client, key, step) {
  const reply = await client.get(`/rest/api/2/issue/${key}/transitions?expand=transitions.fields`)
  const offered = (reply?.transitions ?? []).find((t) => String(t.id) === String(step.transitionId))
  if (!offered) return { offered: false, missing: [] }
  const missing = Object.entries(offered.fields ?? {})
    .filter(([id, f]) => f?.required === true && f.hasDefaultValue !== true && !(id in (step.fields ?? {})))
    .map(([id, f]) => f.name ?? id)
  return { offered: true, missing }
}

export const transitionText = (step) => `the transition "${step.name ?? step.transitionId}" from "${step.from}"`
