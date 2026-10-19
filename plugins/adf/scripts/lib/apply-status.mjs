// Where a change's apply stands, from what is on disk alone: the plan's Execution Graph, the
// change branch's merge commits and kept group worktrees, the tasks file's ticks, the execution
// ledger and the whole-suite record. A resumed session comes up from this instead of rebuilding
// the state by reading the ledger, tasks.md, git log and the worktree list itself.
//
// A group is `merged` when the change branch holds its merge commit, `blocked` when the last
// `handoff` record names it in `blocked` and it is not merged (its worktree is kept for the
// developer), `running` when its worktree exists otherwise, and `pending` before it starts. A
// blocked group holds no slot under the cap; a group depending on it never starts. A graph with
// one wave-1 group runs in the change worktree, and its groups are `done` or `pending` by ticks.
//
// Which group is blocked, and when to hand off, are the orchestrator's judgements; the records
// are this module's (`recordHandoff`): the handoff takes the merged groups, the remaining items
// and every group still blocked from the state itself, so a later handoff cannot drop a blocked
// group by leaving it out, and a blocked group carries its reason in the handoff.
//
// The reuse sweep's open findings (lib/loop.mjs sweepState) are reported as `sweep.open`, and
// apply is not complete while one is open: the one maintainability finding that blocks.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir } from './changes.mjs'
import { groupState, pushPath } from './groups.mjs'
import { appendRecord, readRecords, unresolvedDebt } from './ledger.mjs'
import { sweepState } from './loop.mjs'
import { DEFAULT_CAP, parsePlan, parseTaskItems, schedule, testFirst } from './plan.mjs'
import { tickMessage } from './tasks.mjs'
import { gitIn } from './workspace.mjs'

export const TEST_RECORD = '.apply-test-record.md'

const read = (file) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// `blocked` as recorded: group letters or row numbers, separated by commas or spaces.
export function blockedNames(text) {
  return String(text ?? '')
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^group-?/i, ''))
    .filter(Boolean)
}

// The whole-suite record's verdict line: pass, pre-existing, fail, not-run, or absent.
export function suiteOf(text) {
  if (text === null) return { state: 'absent' }
  const result = /^\*\*Result:\*\*\s*(.+)$/m.exec(text)?.[1].trim() ?? 'unknown'
  const commit = /^\*\*Ran on:\*\*\s*`?([0-9a-f]{7,40})`?/m.exec(text)?.[1] ?? null
  const reason = /^The whole suite was not run:\s*(.+)$/m.exec(text)?.[1] ?? null
  return { state: result === 'not run' ? 'not-run' : result, commit, ...(reason ? { reason } : {}) }
}

// The ticks committed since the last apply session started: the work of this session.
function ticksSince(git, change, since) {
  let rows = []
  try {
    rows = git('log', '--format=%cI%x09%s', 'HEAD').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${tickMessage('\u0000', change).split('\u0000').map(escape).join('(\\d+(?:\\.\\d+)*)')}$`)
  const out = []
  for (const row of rows) {
    const [at, subject] = row.split('\t')
    if (since && Date.parse(at) < Date.parse(since) - 1000) continue
    const m = pattern.exec(subject)
    if (m) out.push(m[1])
  }
  return out.reverse()
}

export function applyStatus(root, change, { tracks = 'tasks.md', cap = DEFAULT_CAP } = {}) {
  const dir = changeDir(root, change)
  if (!existsSync(dir)) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const planText = read(join(dir, 'plan.md'))
  if (planText === null) throw new Error(`openspec/changes/${change}/plan.md does not exist`)
  const items = parseTaskItems(read(join(dir, tracks)) ?? '')
  const records = readRecords(root, change)
  const lastHandoff = records.filter((r) => r.kind === 'handoff').at(-1) ?? null
  const lastSession = records.filter((r) => r.kind === 'session' && r.phase === 'apply').at(-1) ?? null

  const sched = schedule(planText, { state: groupState(root, change), ticked: (id) => items.some((i) => i.id === id && i.done), cap })
  if (!sched.ok) return { ok: false, change, findings: sched.findings, error: 'the Execution Graph is missing or defective; plan.mjs lint names why' }

  const named = blockedNames(lastHandoff?.blocked)
  const groups = sched.groups.map((g) => {
    const blocked = !sched.single && !g.merged && g.kept && (named.includes(g.letter) || named.includes(String(g.n)))
    return { ...g, state: blocked ? 'blocked' : g.state }
  })
  const byLetter = Object.fromEntries(groups.map((g) => [g.letter, g]))
  const ofState = (s) => groups.filter((g) => g.state === s).map((g) => g.n)
  let startable
  if (sched.single) startable = sched.startNow
  else {
    const running = groups.filter((g) => g.state === 'running').length
    const ready = groups.filter((g) => g.state === 'pending' && g.dependsOn.every((d) => byLetter[d]?.state === 'merged'))
    startable = ready.slice(0, Math.max(0, cap - running)).map((g) => g.n)
  }
  const waitingOnBlocked = groups
    .filter((g) => g.state === 'pending' && g.dependsOn.some((d) => byLetter[d]?.state === 'blocked'))
    .map((g) => g.n)

  const ticked = items.filter((i) => i.done).map((i) => i.id)
  const remaining = items.filter((i) => !i.done).map((i) => i.id)
  const debt = unresolvedDebt(records)
  const kept = groups.filter((g) => g.kept).map((g) => g.n)
  const sweep = sweepState(root, change)
  const complete = remaining.length === 0 && kept.length === 0 && (sched.single || groups.every((g) => g.state === 'merged')) && sweep.open.length === 0
  const pushText = read(pushPath(root, change))
  let push = null
  try {
    push = pushText === null ? null : JSON.parse(pushText)
  } catch {
    push = { state: 'unreadable' }
  }
  return {
    ok: true,
    change,
    single: sched.single,
    cap,
    groups: groups.map(({ n, letter, tasks, wave, dependsOn, state }) => ({ n, letter, tasks, wave, dependsOn, state })),
    merged: ofState('merged'),
    running: ofState('running'),
    blocked: ofState('blocked'),
    startable,
    waitingOnBlocked,
    ticked,
    remaining,
    progress: { done: ticked.length, total: items.length },
    testFirst: testFirst(parsePlan(planText).tasks),
    completedThisSession: ticksSince(gitIn(root), change, lastSession?.at ?? null),
    openDebt: { count: debt.length, ids: debt.map((d) => d.id) },
    lastHandoff,
    push,
    suite: suiteOf(read(join(dir, TEST_RECORD))),
    sweep: { ran: sweep.ran, open: sweep.open.map(({ id, introduced, existing, why }) => ({ id, introduced, existing, why })), cleared: sweep.cleared },
    complete
  }
}

// A handoff record written from the state: `merged` and `remaining` as they are, `blocked` every
// group still blocked plus `block` when given, `next` the orchestrator's. Blocking a group records
// its reason in the handoff's `blockedReason`: a ruling is the developer's, and blocking is the
// orchestrator's call. Only a started, unmerged group of a multi-group graph can be blocked.
// Returns { handoff, blocked } (blocked as group letters).
export function recordHandoff(root, change, { next, block, reason, tracks, env = process.env } = {}) {
  if (typeof next !== 'string' || !next.trim()) throw new Error('name the next dispatch (--next)')
  if ((block === undefined) !== (reason === undefined)) throw new Error('--block and --reason go together')
  const status = applyStatus(root, change, { tracks })
  if (!status.ok) throw new Error(status.error)
  const letterOf = (n) => status.groups.find((g) => g.n === n).letter
  const blocked = status.blocked.map(letterOf)
  let blockedReason
  if (block !== undefined) {
    if (status.single) throw new Error('a single-group pass has no group to block; report the pause instead')
    const group = status.groups.find((g) => g.letter === block || String(g.n) === String(block))
    if (!group) throw new Error(`group ${block} is not in the plan's Execution Graph`)
    if (group.state === 'merged') throw new Error(`group ${group.letter} is merged; a merged group is not blocked`)
    if (group.state === 'pending') throw new Error(`group ${group.letter} has not started; only a group with a kept worktree is blocked`)
    if (!reason.trim()) throw new Error('--reason is empty')
    if (!blocked.includes(group.letter)) blocked.push(group.letter)
    blockedReason = `group ${group.letter}: ${reason.trim()}`
  }
  const list = (values) => (values.length ? values.join(', ') : 'none')
  const fields = { merged: list(status.merged.map(letterOf)), remaining: list(status.remaining), next: next.trim(), ...(blocked.length ? { blocked: blocked.join(', ') } : {}), ...(blockedReason ? { blockedReason } : {}) }
  const handoff = appendRecord(root, change, 'handoff', fields, { env }).record
  return { handoff, blocked }
}

const SUITE_LINE = {
  pass: 'passed',
  'pre-existing': 'failed only where the base fails too, named as separate work in the test record',
  'not-run': 'not run'
}

function pushLine(push) {
  if (!push) return 'no group merge pushed yet'
  if (push.state === 'none') return 'no forge plugin is enabled, nothing was pushed'
  if (push.state === 'done') return 'after each group merge'
  if (push.state === 'degraded') return `degraded: ${push.hint ?? push.error ?? 'no hint'}`
  return `${push.state}: ${push.error ?? push.hint ?? ''}`.trim()
}

// The apply command's report. The Complete block is filled in whole; the Paused block leaves the
// issue and the options to the orchestrator, marked `<...>`, and names any blocked group.
export function renderReport(status, { schemaName, items = [] }) {
  const text = (id) => items.find((i) => i.id === id)?.text ?? ''
  const session = status.completedThisSession.length
    ? status.completedThisSession.map((id) => `- [x] ${id} ${text(id)}`.trimEnd())
    : ['- (none)']
  const head = (title) => [`## Implementation ${title}`, '', `**Change:** ${status.change}`, `**Schema:** ${schemaName}`, `**Progress:** ${status.progress.done}/${status.progress.total} tasks complete`, '']
  if (status.complete) {
    const s = status.suite
    const suite = s.state === 'not-run' ? `not run: ${s.reason ?? 'no reason recorded'}` : (SUITE_LINE[s.state] ?? `${s.state} (no passing test record)`)
    return [
      ...head('Complete'),
      '### Completed This Session',
      ...session,
      '',
      `Whole suite: ${suite}`,
      `Pushed: ${pushLine(status.push)}`,
      `Open debt: ${status.openDebt.count}`,
      '',
      'Run /adf:verify, then the review, before archiving this change.'
    ].join('\n')
  }
  const blocked = status.blocked.map((n) => {
    const g = status.groups.find((x) => x.n === n)
    return `- group ${g.letter} (${n}) is blocked; its worktree is kept`
  })
  for (const f of status.sweep?.open ?? []) blocked.push(`- sweep finding ${f.id}: ${f.introduced} repeats ${f.existing}; consolidate it, or the developer dismisses it`)
  return [
    ...head('Paused'),
    '### Completed This Session',
    ...session,
    '',
    '### Issue Encountered',
    ...(blocked.length ? blocked : []),
    '<the issue>',
    '',
    '**Options:**',
    '1. <option>',
    '2. <option>',
    '3. Other approach',
    '',
    'What would you like to do?'
  ].join('\n')
}
