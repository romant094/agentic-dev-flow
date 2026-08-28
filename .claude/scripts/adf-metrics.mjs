#!/usr/bin/env node
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Parse session lines from progress.md: `## Sessions` section
// Format: `<session-id> | <window> | <phase>`
function parseSessions(progressText) {
  const lines = progressText.split('\n')
  const sessions = []
  let inSessionsSection = false

  for (const line of lines) {
    if (line.startsWith('## Sessions')) {
      inSessionsSection = true
      continue
    }
    if (inSessionsSection && line.startsWith('##')) {
      break
    }
    if (inSessionsSection && line.trim() && line.includes('|')) {
      const parts = line.split(' | ')
      if (parts.length >= 3) {
        sessions.push({
          id: parts[0].trim(),
          window: parts[1].trim(),
          phase: parts[2].trim()
        })
      }
    }
  }
  return sessions
}

// Collect the lines of one `## <name>` section of the ledger, up to the next heading.
function sectionLines(progressText, heading) {
  const out = []
  let inSection = false
  for (const line of progressText.split('\n')) {
    if (line.startsWith(`## ${heading}`)) {
      inSection = true
      continue
    }
    if (inSection && line.startsWith('##')) break
    if (inSection) out.push(line)
  }
  return out
}

// Split one hand-written ledger line into fields: a markdown table row on `|`, anything
// else on `,`. A line is only treated as an attempted record when it has enough short
// fields to be one — free prose in the section is ignored rather than counted as unparsed.
function recordFields(line) {
  const stripped = line.trim().replace(/^[-*]\s+/, '')
  if (/^\|[\s|:-]+\|$/.test(stripped)) return null
  const fields = stripped.startsWith('|')
    ? stripped
        .split('|')
        .slice(1, -1)
        .map((f) => f.trim())
    : stripped.split(',').map((f) => f.trim())
  if (fields.length < 4) return null
  if (fields.some((f) => f.length === 0 || f.length > 40)) return null
  return fields
}

// Reduce the ledger's `## Dispatches` section to counts. Line format per opsx/apply.md:
// task id, role, declared level, turn count. Hand-written, so a line that does not parse
// is counted as unparsed rather than throwing.
export function parseDispatches(progressText) {
  const byRole = {}
  let total = 0
  let unparsed = 0

  for (const line of sectionLines(progressText, 'Dispatches')) {
    if (!line.trim()) continue
    const fields = recordFields(line)
    if (!fields) continue

    const [taskId, role, , turnField] = fields
    const turns = turnField.match(/\d+/)
    if (!/\d/.test(taskId) || !/^[a-z][a-z -]*$/i.test(role) || !turns) {
      unparsed += 1
      continue
    }
    const key = role.toLowerCase()
    byRole[key] = (byRole[key] || 0) + 1
    total += 1
  }

  return { total, byRole, unparsed }
}

// Reduce the ledger's `## Deviations` section to one entry per deviation with its reason.
// Each blank-line-separated block is one deviation, wrapped across as many lines as the
// author used; the reason is what follows `Reason:` or `because`, when either is present.
export function parseDeviations(progressText) {
  const blocks = []
  let current = []
  for (const line of sectionLines(progressText, 'Deviations')) {
    if (line.trim()) {
      current.push(line.trim())
      continue
    }
    if (current.length > 0) {
      blocks.push(current.join(' '))
      current = []
    }
  }
  if (current.length > 0) blocks.push(current.join(' '))

  // A ledger whose deviations are labelled `Deviation:` also carries rulings and findings
  // in the same section; those are not deviations. When no block is labelled, every block
  // is read as one deviation, which is the format the command file states.
  const labelled = blocks.filter((b) => /^deviations?\b/i.test(b))
  const deviationBlocks = labelled.length > 0 ? labelled : blocks
  const unparsed = blocks.length - deviationBlocks.length

  const entries = []
  let withoutReason = 0
  for (const text of deviationBlocks) {
    const explicit = text.match(/reasons?:\s*(.+)$/is)
    const implicit = text.match(/\bbecause\s+(.+)$/is)
    const reason = explicit ? explicit[1].trim() : implicit ? implicit[1].trim() : null
    if (reason === null) withoutReason += 1
    entries.push({ text, reason })
  }

  return { count: entries.length, entries, withoutReason, unparsed }
}

// Derive project-key candidates from an absolute repo path: replace every / with -,
// which keeps the leading - that comes from the leading /. That un-stripped form is the
// real on-disk one, so it is tried first; the leading-dash-stripped form is the fallback.
function deriveProjectKeys(repoPath) {
  const key = repoPath.replace(/\//g, '-')
  const stripped = key.startsWith('-') ? key.slice(1) : key
  return stripped === key ? [key] : [key, stripped]
}

// Sum the usage figures a transcript actually carries, split by actor.
//
// Real records carry their usage under `message.usage`, not under a top-level `record.usage`
// (measured: 0 records with the top-level field, 506 with `message.usage`, in a 1447-record
// transcript). Both are read, so a fixture written in either shape is summed rather than
// silently returning zero.
//
// `isSidechain` is not the discriminator it looks like: subagent turns are not written to the
// orchestrator's transcript at all, so it never marks anything here. It is still honoured when
// present, but subagent attribution comes from the harness notifications instead — see
// parseSubagentUsage. `records` counts what contributed, so a caller can tell a summed zero
// from a figure that had no source at all.
function parseTokens(jsonlText) {
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageRecords: 0, records: 0 })
  const orchestrator = blank()
  const subagents = blank()

  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // Skip non-JSON lines.
    }
    const side = record.isSidechain ? subagents : orchestrator
    side.records += 1
    const usage = record.message?.usage || record.usage
    if (!usage || typeof usage !== 'object') continue
    side.usageRecords += 1
    side.input += usage.input_tokens || 0
    side.output += usage.output_tokens || 0
    side.cacheRead += usage.cache_read_input_tokens || 0
    side.cacheWrite += usage.cache_creation_input_tokens || 0
  }

  return { orchestrator, subagents }
}

// Every `<usage>` block the harness writes into a `<task-notification>`, keyed so that the
// same notification seen twice is one dispatch.
const USAGE_BLOCK =
  /<usage>\s*<subagent_tokens>(\d+)<\/subagent_tokens>\s*<tool_uses>(\d+)<\/tool_uses>\s*<duration_ms>(\d+)<\/duration_ms>\s*<\/usage>/g
const TASK_ID = /<task-id>([^<]+)<\/task-id>/

// Measure subagent work from the harness's own dispatch notifications. These are the only
// deterministic source for it: the subagent transcripts are separate files, so nothing in this
// transcript reports their tokens except the `<usage>` block the harness emits when a dispatched
// agent completes.
//
// The same notification is written into more than one `queue-operation` record — measured on a
// real transcript, 37 blocks across enqueue and remove records represent 30 distinct dispatches,
// so summing every block over-counts by 22%. Blocks are therefore deduplicated on the task id
// together with the figures themselves: an agent that is resumed notifies again with different
// figures and counts again, while the same figures repeated are one dispatch.
//
// Only `queue-operation` records are read. The same text is echoed into user and assistant
// records, and reading those would let an agent's own prose put a number into a measurement.
export function parseSubagentUsage(jsonlText) {
  const seen = new Set()
  let tokens = 0
  let toolUses = 0
  let durationMs = 0
  let usageBlocks = 0
  let duplicateBlocks = 0

  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // Skip non-JSON lines.
    }
    if (record.type !== 'queue-operation') continue
    const content = typeof record.content === 'string' ? record.content : JSON.stringify(record.content ?? '')
    const taskId = content.match(TASK_ID)?.[1] ?? null

    for (const match of content.matchAll(USAGE_BLOCK)) {
      usageBlocks += 1
      const key = `${taskId}|${match[1]}|${match[2]}|${match[3]}`
      if (seen.has(key)) {
        duplicateBlocks += 1
        continue
      }
      seen.add(key)
      tokens += Number(match[1])
      toolUses += Number(match[2])
      durationMs += Number(match[3])
    }
  }

  return { dispatches: seen.size, tokens, toolUses, durationMs, usageBlocks, duplicateBlocks }
}

const ISO_DATETIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/g

// Measure one `## Sessions` window in minutes, or return null when it cannot be parsed.
// Two accepted forms:
//   - an ISO-8601 datetime range, which can span any number of days
//   - `HH:MM-HH:MM`, where an end before the start is read as crossing one midnight
export function parseWindowMinutes(window) {
  const iso = String(window).match(ISO_DATETIME)
  if (iso && iso.length >= 2) {
    const start = new Date(iso[0].replace(' ', 'T'))
    const end = new Date(iso[1].replace(' ', 'T'))
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000)
    return minutes < 0 ? null : minutes
  }

  const clock = String(window)
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/)
  if (!clock) return null
  const startMin = Number(clock[1]) * 60 + Number(clock[2])
  const endMin = Number(clock[3]) * 60 + Number(clock[4])
  if (startMin > 1439 || endMin > 1439) return null
  return endMin >= startMin ? endMin - startMin : endMin + 1440 - startMin
}

// A context read is a record that pulled content into a context window: a tool result
// carrying a file, a search hit or another tool's output. An assistant turn is output, not
// a read, so counting every record with a `type` field measures transcript length instead.
export function isContextRead(record) {
  if (!record || typeof record !== 'object') return false
  if (record.toolUseResult !== undefined) return true
  const content = record.message?.content
  if (Array.isArray(content)) {
    return content.some((block) => block && block.type === 'tool_result')
  }
  return false
}

// Derive velocity metrics from session windows. `sessionsPerHour` is named for what the
// extractor can count: the ledger's session lines carry no per-session task count, so a
// rate per task cannot be derived here without inventing it.
function deriveVelocity(sessions, subagentDispatches) {
  const d = subagentDispatches || { dispatches: 0, toolUses: 0, durationMs: 0 }
  let totalMinutes = 0
  let measuredWindows = 0
  let unparsedWindows = 0

  for (const s of sessions) {
    const minutes = parseWindowMinutes(s.window)
    if (minutes === null) {
      unparsedWindows += 1
      continue
    }
    totalMinutes += minutes
    measuredWindows += 1
  }

  return {
    sessionCount: sessions.length,
    measuredWindows,
    unparsedWindows,
    totalMinutes,
    averageMinutesPerSession: measuredWindows > 0 ? (totalMinutes / measuredWindows).toFixed(1) : 0,
    sessionsPerHour: totalMinutes > 0 ? ((measuredWindows * 60) / totalMinutes).toFixed(2) : 0,
    // Measured per dispatch by the harness, rather than derived from the hand-written session
    // windows above: this is real wall clock, and it has a source or it has none.
    dispatchesCompleted: d.dispatches,
    dispatchToolUses: d.toolUses,
    dispatchMinutes: d.dispatches > 0 ? (d.durationMs / 60000).toFixed(1) : null,
    averageDispatchMinutes: d.dispatches > 0 ? (d.durationMs / 60000 / d.dispatches).toFixed(1) : null
  }
}

// Parse the `## Execution Graph` table in a change's plan.md for group -> wave assignments.
// Distinguishes execution-graph rows (second column starts with a task number) from the
// coupling table further down (second column is another group letter).
function parseExecutionGraph(planText) {
  const lines = planText.split('\n')
  let inSection = false
  const rows = []

  for (const line of lines) {
    if (line.startsWith('## Execution Graph')) {
      inSection = true
      continue
    }
    if (inSection && line.startsWith('##')) break
    if (!inSection) continue

    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue

    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 4) continue

    const [group, tasks] = cells
    if (!/^[A-Z]$/.test(group) || !/^\d/.test(tasks)) continue

    rows.push({ group, wave: cells[cells.length - 1] })
  }

  return rows
}

// Parse `git worktree list --porcelain` output into { path, sha, branch } entries. The
// porcelain form is blank-line-separated records of `worktree <path>` / `HEAD <sha>` /
// `branch refs/heads/<name>` (or `detached` in place of the branch line), and it is used
// instead of the human-readable form because that form's `^\S+` path match breaks on any
// worktree path containing a space. A detached worktree is kept with `branch: null` rather
// than dropped, so it stays visible instead of silently vanishing; a record missing its
// `worktree` or `HEAD` line is counted as unparsed rather than silently dropped, the same
// way this file already counts unparsed dispatches and unparsed velocity windows.
export function parseWorktreeList(text) {
  const entries = []
  let unparsed = 0
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    const worktreeLine = lines.find((l) => l.startsWith('worktree '))
    const headLine = lines.find((l) => l.startsWith('HEAD '))
    if (!worktreeLine || !headLine) {
      unparsed += 1
      continue
    }
    const branchLine = lines.find((l) => l.startsWith('branch '))
    const branch = branchLine
      ? branchLine
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '')
      : null
    entries.push({
      path: worktreeLine.slice('worktree '.length).trim(),
      sha: headLine.slice('HEAD '.length).trim(),
      branch
    })
  }

  return { entries, unparsed }
}

// Grades whether the mandatory wave-1 fan-out (CLAUDE.md §5) actually happened: every group
// the plan assigns to wave 1 must have its own worktree, and that worktree must carry commits
// of its own rather than sitting at the commit all wave-1 branches forked from.
async function computeWaveOneFanoutRow(planText, git) {
  const waveOneGroups = parseExecutionGraph(planText)
    .filter((r) => r.wave === '1')
    .map((r) => r.group)

  // The obligation is scoped to two or more wave-1 groups (CLAUDE.md §5, opsx/apply.md):
  // a plan with one wave-1 group has nothing to fan out.
  if (waveOneGroups.length < 2) {
    return { rule: 'wave-1 fan-out', required: false, performed: true }
  }

  let currentBranch = ''
  try {
    currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    currentBranch = ''
  }
  const branchPrefix = currentBranch.replace(/--group-[^/]+$/, '')

  let worktrees = []
  let unparsedWorktrees = 0
  try {
    const parsed = parseWorktreeList(await git(['worktree', 'list', '--porcelain']))
    worktrees = parsed.entries
    unparsedWorktrees = parsed.unparsed
  } catch {
    worktrees = []
  }

  const groupShas = {}
  for (const group of waveOneGroups) {
    const entry = worktrees.find((w) => w.branch === `${branchPrefix}--group-${group}`)
    if (entry) groupShas[group] = entry.sha
  }

  const foundGroups = Object.keys(groupShas)
  if (foundGroups.length !== waveOneGroups.length) {
    return { rule: 'wave-1 fan-out', required: true, performed: false, unparsedWorktrees }
  }

  let commonBase = groupShas[foundGroups[0]]
  try {
    for (let i = 1; i < foundGroups.length; i++) {
      commonBase = (await git(['merge-base', commonBase, groupShas[foundGroups[i]]])).trim()
    }
  } catch {
    commonBase = null
  }

  const allDiverged = commonBase !== null && foundGroups.every((g) => !commonBase.startsWith(groupShas[g]))

  return { rule: 'wave-1 fan-out', required: true, performed: allDiverged, unparsedWorktrees }
}

async function computeCompliance({ read, git, repoPath, changeName }) {
  const planPath = join(repoPath, 'openspec', 'changes', changeName || '', 'plan.md')
  let planText
  try {
    planText = await read(planPath)
  } catch {
    return []
  }
  return [await computeWaveOneFanoutRow(planText, git)]
}

// Sums insertions/deletions from `git log --numstat` output lines ("<ins>\t<del>\t<path>").
function sumNumstat(text) {
  let insertions = 0
  let deletions = 0
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t/)
    if (match) {
      insertions += Number(match[1])
      deletions += Number(match[2])
    }
  }
  return { insertions, deletions }
}

// Aggregates per-file churn (insertions + deletions) from `git log --numstat` output.
function perFileChurnFromNumstat(text) {
  const churn = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t(.+)$/)
    if (match) {
      const file = match[3]
      churn[file] = (churn[file] || 0) + Number(match[1]) + Number(match[2])
    }
  }
  return Object.entries(churn)
    .map(([file, changes]) => ({ file, changes }))
    .sort((a, b) => b.changes - a.changes)
}

// Three indicators computed only from `git` and `openspec/` — no agent, no session id:
// insertions vs deletions, per-file churn across archived changes, and capability count
// against how often existing capabilities are edited.
async function computeMaintainability({ list, git, repoPath }) {
  // Per change, not per repository: the change's own commits are the ones whose
  // insertion/deletion balance says whether this change only accumulated. The range is
  // the change branch since it forked from the integration branch; when no such fork
  // point can be resolved, the whole history is used and the scope says so.
  let range = ''
  for (const base of ['origin/develop', 'develop']) {
    try {
      const mergeBase = (await git(['merge-base', base, 'HEAD'])).trim()
      if (mergeBase) {
        range = `${mergeBase}..HEAD`
        break
      }
    } catch {
      // Try the next candidate base.
    }
  }

  let changeNumstat = ''
  const insertionsArgs = ['log', '--numstat', '--pretty=format:']
  if (range) insertionsArgs.push(range)
  try {
    changeNumstat = await git(insertionsArgs)
  } catch {
    changeNumstat = ''
  }
  const insertionsVsDeletions = sumNumstat(changeNumstat)
  const insertionsVsDeletionsScope = range || 'whole history (no fork point resolved)'

  let archiveNumstat = ''
  try {
    archiveNumstat = await git(['log', '--numstat', '--pretty=format:', '--', 'openspec/changes/archive'])
  } catch {
    archiveNumstat = ''
  }
  const perFileChurn = perFileChurnFromNumstat(archiveNumstat)

  let capabilities = []
  try {
    capabilities = await list(join(repoPath, 'openspec', 'specs'))
  } catch {
    capabilities = []
  }

  let specsNumstat = ''
  try {
    specsNumstat = await git(['log', '--numstat', '--pretty=format:', '--', 'openspec/specs'])
  } catch {
    specsNumstat = ''
  }
  const editsByCapability = {}
  for (const line of specsNumstat.split('\n')) {
    const match = line.match(/^\d+\t\d+\topenspec\/specs\/([^/]+)\//)
    if (match) {
      const capability = match[1]
      editsByCapability[capability] = (editsByCapability[capability] || 0) + 1
    }
  }

  return {
    insertionsVsDeletions,
    insertionsVsDeletionsScope,
    perFileChurn,
    capabilityChurn: { capabilityCount: capabilities.length, editsByCapability }
  }
}

// Extract a schema instruction block for a given artifact or top-level block. Returns the
// byte count of the instruction body, or null if the file cannot be read or the
// instruction is not found. `kind` selects the anchor form: an artifact instruction is
// anchored by `- id: <anchorId>` inside `artifacts:`, a top-level block by the unindented
// line `<anchorId>:` — the schema carries `resolve:`, `propose:`, `apply:` and `archive:`
// in that form. The two forms are matched exactly, never by prefix: `- id: proposal`
// starts with `- id: propose` and would otherwise answer to the wrong anchor.
export function extractSchemaInstructionBytes(schemaText, anchorId, kind = 'artifact') {
  const lines = schemaText.split('\n')
  let anchorLineIdx = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const matched = kind === 'block'
      ? line === `${anchorId}:`
      : line.trim() === `- id: ${anchorId}`
    if (matched) {
      anchorLineIdx = i
      break
    }
  }

  if (anchorLineIdx === -1) return null

  // Find `instruction: |` inside the anchored block only: stop at the next non-blank
  // line whose indentation is at or below the anchor's own, which signals either the
  // next sibling anchor or a dedent out of the block entirely.
  const anchorIndent = lines[anchorLineIdx].match(/^(\s*)/)[0].length
  let instructionLineIdx = -1
  for (let i = anchorLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lineIndent = line.match(/^(\s*)/)[0].length
    if (lineIndent <= anchorIndent) break
    if (line.trim() === 'instruction: |') {
      instructionLineIdx = i
      break
    }
  }

  if (instructionLineIdx === -1) return null

  // Collect the instruction body lines, dedented by the indentation of the first body line
  const instructionLines = []
  let baseIndent = -1

  for (let i = instructionLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      // Skip blank lines for now, we'll handle trailing blanks later
      instructionLines.push(line)
      continue
    }

    // Determine base indent from the first non-blank line
    if (baseIndent === -1) {
      const match = line.match(/^(\s*)/)
      baseIndent = match ? match[1].length : 0
    }

    // Stop if this line has less indentation than the base (signals end of block)
    const lineIndent = line.match(/^(\s*)/)[0].length
    if (lineIndent < baseIndent) {
      break
    }

    // Add the dedented line
    if (line.length >= baseIndent) {
      instructionLines.push(line.slice(baseIndent))
    } else {
      instructionLines.push(line)
    }
  }

  // Remove trailing blank lines
  while (instructionLines.length > 0 && instructionLines[instructionLines.length - 1].trim() === '') {
    instructionLines.pop()
  }

  // Join and add one closing newline, measured in UTF-8 bytes (not code units)
  const text = instructionLines.join('\n') + '\n'
  const bytes = Buffer.byteLength(text, 'utf8')
  return bytes
}

// Which schema instructions each phase loads. `propose` loads the six artifact
// instructions plus the top-level `propose:` block; `apply` and `archive` load their own
// top-level block; `verify` and `review` load the artifact instruction of the same name.
const PHASE_SCHEMA_ANCHORS = {
  propose: [
    ['brainstorm', 'artifact'],
    ['proposal', 'artifact'],
    ['design', 'artifact'],
    ['specs', 'artifact'],
    ['tasks', 'artifact'],
    ['plan', 'artifact'],
    ['propose', 'block']
  ],
  apply: [['apply', 'block']],
  verify: [['verify', 'artifact']],
  review: [['review', 'artifact']],
  archive: [['archive', 'block']]
}

export async function measureNormativeBytes({ read, repoPath }) {
  // The five cycle phases and their corresponding command files
  const phases = ['propose', 'apply', 'verify', 'review', 'archive']
  const results = []

  // Read schema.yaml once
  let schemaText = null
  try {
    schemaText = await read(join(repoPath, 'openspec', 'schemas', 'sdd-plus-superpowers', 'schema.yaml'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    // If schema can't be read, all schema bytes will be null
  }

  for (const phase of phases) {
    let commandBytes = null
    let schemaBytes = null

    // Read the command file for this phase
    try {
      const commandPath = join(repoPath, '.claude', 'commands', 'opsx', `${phase}.md`)
      const commandFile = await read(commandPath)
      commandBytes = Buffer.byteLength(commandFile, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // File not found, bytes stay null
    }

    // Extract schema instruction bytes: sum every instruction the phase loads.
    if (schemaText) {
      let total = 0
      let found = false
      for (const [anchorId, kind] of PHASE_SCHEMA_ANCHORS[phase]) {
        const bytes = extractSchemaInstructionBytes(schemaText, anchorId, kind)
        if (bytes !== null) {
          total += bytes
          found = true
        }
      }
      schemaBytes = found ? total : null
    }

    // totalBytes is the sum of command and schema bytes (null coerces to 0 in addition)
    const totalBytes = commandBytes !== null || schemaBytes !== null
      ? (commandBytes ?? 0) + (schemaBytes ?? 0)
      : null

    results.push({
      phase,
      commandBytes,
      schemaBytes,
      totalBytes
    })
  }

  // The top-level `resolve:` block is pointed at by three command files (apply, verify and
  // archive), so it gets a row of its own rather than being added to each of those phases:
  // this table measures the size of the normative surface, and text written once is counted
  // once — charging it to three phases would report bytes that do not exist. It has no
  // command file, so that cell is `(no source)`.
  if (schemaText) {
    const resolveBytes = extractSchemaInstructionBytes(schemaText, 'resolve', 'block')
    if (resolveBytes !== null) {
      results.push({
        phase: 'resolve (shared: apply, verify, archive)',
        commandBytes: null,
        schemaBytes: resolveBytes,
        totalBytes: resolveBytes
      })
    }
  }

  return results
}

export async function extractMetrics({ read, list, git, changeName }) {
  // Discover repo path for fallback ledger lookup.
  // When changeName is provided, read from .superpowers/sdd/<changeName>/progress.md (the SDD ledger).
  // When changeName is absent (tests), read from ~/.claude/projects/<project-key>/progress.md (the session ledger).
  const repoPathResult = await git(['rev-parse', '--show-toplevel'])
  const repoPath = repoPathResult.trim()
  const projectKeys = deriveProjectKeys(repoPath)

  let progressPath
  if (changeName) {
    // Read the SDD ledger for the change: .superpowers/sdd/<changeName>/progress.md
    progressPath = join(repoPath, '.superpowers', 'sdd', changeName, 'progress.md')
  } else {
    // Fallback for tests: read from ~/.claude/projects/<project-key>/progress.md (session ledger)
    progressPath = join(homedir(), '.claude', 'projects', projectKeys[0], 'progress.md')
  }

  const compliance = await computeCompliance({ read, git, repoPath, changeName })
  const maintainability = await computeMaintainability({ list, git, repoPath })
  const normativeBytes = await measureNormativeBytes({ read, repoPath })

  let progressText
  try {
    progressText = await read(progressPath)
  } catch {
    return {
      changeName,
      sessions: [],
      tokenEconomy: [],
      subagentDispatches: { dispatches: 0, tokens: 0, toolUses: 0, durationMs: 0, usageBlocks: 0, duplicateBlocks: 0 },
      velocity: {},
      dispatches: { total: 0, byRole: {}, unparsed: 0 },
      deviations: { count: 0, entries: [], withoutReason: 0, unparsed: 0 },
      compliance,
      maintainability,
      normativeBytes
    }
  }

  const sessionLines = parseSessions(progressText)
  const sessions = []
  const blankActor = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usageRecords: 0,
    records: 0
  })
  const tokensByActor = { orchestrator: blankActor(), subagents: blankActor() }
  const readsByActor = { orchestrator: 0, subagents: 0 }
  const subagentDispatches = {
    dispatches: 0,
    tokens: 0,
    toolUses: 0,
    durationMs: 0,
    usageBlocks: 0,
    duplicateBlocks: 0
  }

  // Process each session
  for (const s of sessionLines) {
    // Try every project-key candidate; the session resolves if any of them holds its transcript.
    let resolved = false
    let transcriptText = null
    for (const key of projectKeys) {
      const transcriptPath = join(homedir(), '.claude', 'projects', key, `${s.id}.jsonl`)
      try {
        transcriptText = await read(transcriptPath)
        resolved = true
        break
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    if (resolved) {
      // Parse tokens
      const tokens = parseTokens(transcriptText)
      for (const actor of ['orchestrator', 'subagents']) {
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'usageRecords', 'records']) {
          tokensByActor[actor][field] += tokens[actor][field]
        }
      }

      // Measure the dispatched subagents from the harness's notifications.
      const dispatched = parseSubagentUsage(transcriptText)
      for (const field of Object.keys(subagentDispatches)) {
        subagentDispatches[field] += dispatched[field]
      }

      // Count context reads, split by actor using isSidechain
      const lines = transcriptText.split('\n').filter((l) => l.trim())
      for (const line of lines) {
        try {
          const record = JSON.parse(line)
          if (isContextRead(record)) {
            if (record.isSidechain) {
              readsByActor.subagents += 1
            } else {
              readsByActor.orchestrator += 1
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    }

    sessions.push({ id: s.id, resolved })
  }

  // Build token economy array. Each row carries the count of records that contributed, so the
  // report can say "no source" instead of printing a 0 that reads as a measurement. The
  // subagents' own input, output and cache figures have no source in an orchestrator transcript;
  // `totalTokens` is what the harness reports for them, which is a total and not output-only.
  const row = (actor, t, contextReads, totalTokens, totalSource) => ({
    actor,
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    totalTokens,
    contextReads,
    usageRecords: t.usageRecords,
    records: t.records,
    totalTokensSource: totalSource
  })
  const o = tokensByActor.orchestrator
  const tokenEconomy = [
    row('orchestrator', o, readsByActor.orchestrator, o.input + o.output + o.cacheRead + o.cacheWrite, o.usageRecords),
    row(
      'subagents',
      tokensByActor.subagents,
      readsByActor.subagents,
      subagentDispatches.tokens,
      subagentDispatches.dispatches
    )
  ]

  // Derive velocity
  const velocity = deriveVelocity(sessionLines, subagentDispatches)

  return {
    changeName,
    sessions,
    tokenEconomy,
    subagentDispatches,
    velocity,
    dispatches: parseDispatches(progressText),
    deviations: parseDeviations(progressText),
    compliance,
    maintainability,
    normativeBytes
  }
}

export function renderReport(metrics) {
  const title = metrics.changeName ? `# ${metrics.changeName} — Metrics` : '# Metrics'
  let report = `${title}\n\n`

  // Sessions section
  report += '## Sessions\n\n'
  if (metrics.sessions.length === 0) {
    report += '(no sessions found)\n\n'
  } else {
    report += '| Session ID | Resolved |\n'
    report += '|---|---|\n'
    for (const s of metrics.sessions) {
      report += `| ${s.id} | ${s.resolved ? 'yes' : 'no'} |\n`
    }
    report += '\n'
  }

  // Token economy section
  report += '## Token Economy\n\n'
  if (metrics.tokenEconomy.length === 0) {
    report += '(no token data)\n\n'
  } else {
    // A cell prints a number only when something was summed into it. `(no source)` means the
    // input carried nothing to measure — printing 0 there would state a measurement that was
    // never made, which is the one thing this extractor exists to avoid.
    const cell = (value, source) => (source > 0 ? String(value) : '(no source)')
    report += '| Actor | Input Tokens | Output Tokens | Cache Read | Cache Write | Total Tokens | Context Reads |\n'
    report += '|---|---|---|---|---|---|---|\n'
    for (const r of metrics.tokenEconomy) {
      report += `| ${r.actor} | ${cell(r.inputTokens, r.usageRecords)} | ${cell(r.outputTokens, r.usageRecords)}`
      report += ` | ${cell(r.cacheReadTokens, r.usageRecords)} | ${cell(r.cacheWriteTokens, r.usageRecords)}`
      report += ` | ${cell(r.totalTokens, r.totalTokensSource)} | ${cell(r.contextReads, r.records)} |\n`
    }
    report += '\n'
    report += '- The orchestrator row is summed from the `message.usage` of its own transcript.\n'
    report += '- The subagents row is measured from the harness dispatch notifications, which report\n'
    report += '  one total per completed dispatch; that total is under Total Tokens, not Output Tokens,\n'
    report += '  because the harness does not split it. Subagent transcripts are separate files, so\n'
    report += '  their input, output, cache and context reads have no source in this transcript.\n\n'
  }

  // Velocity section
  report += '## Velocity\n\n'
  if (Object.keys(metrics.velocity).length === 0) {
    report += '(no velocity data)\n\n'
  } else {
    report += `- Session count: ${metrics.velocity.sessionCount}\n`
    report += `- Measured windows: ${metrics.velocity.measuredWindows}\n`
    report += `- Unparsed windows: ${metrics.velocity.unparsedWindows}\n`
    report += `- Total minutes: ${metrics.velocity.totalMinutes}\n`
    report += `- Average minutes per measured session: ${metrics.velocity.averageMinutesPerSession}\n`
    report += `- Sessions per hour: ${metrics.velocity.sessionsPerHour}\n`
    const v = metrics.velocity
    if (v.dispatchesCompleted > 0) {
      report += `- Completed dispatches measured from harness notifications: ${v.dispatchesCompleted}\n`
      report += `- Subagent wall clock (sum of measured dispatch durations), minutes: ${v.dispatchMinutes}\n`
      report += `- Average minutes per dispatch: ${v.averageDispatchMinutes}\n`
      report += `- Tool uses across measured dispatches: ${v.dispatchToolUses}\n\n`
    } else {
      report += '- Completed dispatches measured from harness notifications: (no source)\n\n'
    }
  }

  // Dispatch section — the ledger's `## Dispatches` lines, reduced to counts
  report += '## Dispatches\n\n'
  const d = metrics.dispatches || { total: 0, byRole: {}, unparsed: 0 }
  const roleRows = Object.entries(d.byRole)
  if (roleRows.length === 0) {
    report += '(no dispatch lines parsed)\n\n'
  } else {
    report += '| Role | Dispatches |\n'
    report += '|---|---|\n'
    for (const [role, count] of roleRows) {
      report += `| ${role} | ${count} |\n`
    }
    report += `| total | ${d.total} |\n\n`
  }
  report += `- Lines that could not be parsed: ${d.unparsed}\n`
  // The section above is hand-written. This line is measured, and the two are reported side by
  // side rather than reconciled, so a ledger that disagrees with the transcript stays visible.
  const sd = metrics.subagentDispatches || { dispatches: 0, usageBlocks: 0, duplicateBlocks: 0 }
  if (sd.dispatches > 0) {
    report += `- Completed dispatches measured from the transcript: ${sd.dispatches}\n`
    report += `- Notification usage blocks read: ${sd.usageBlocks}, of which repeated: ${sd.duplicateBlocks}\n\n`
  } else {
    report += '- Completed dispatches measured from the transcript: (no source)\n\n'
  }

  // Deviation section — the ledger's `## Deviations` lines with their reasons
  report += '## Deviations\n\n'
  const dev = metrics.deviations || { count: 0, entries: [], withoutReason: 0, unparsed: 0 }
  if (dev.count === 0) {
    report += '(none recorded)\n\n'
  } else {
    for (const e of dev.entries) {
      report += `- ${e.text}\n`
      report += `  - Reason: ${e.reason === null ? '(not stated)' : e.reason}\n`
    }
    report += `- Deviations with no stated reason: ${dev.withoutReason}\n`
    report += `- Blocks in the section that are not deviation lines: ${dev.unparsed}\n\n`
  }

  // Compliance section
  report += '## Compliance\n\n'
  if (metrics.compliance.length === 0) {
    report += '(no compliance data)\n\n'
  } else {
    report += '| Rule | Required | Performed |\n'
    report += '|---|---|---|\n'
    for (const r of metrics.compliance) {
      report += `| ${r.rule} | ${r.required ? 'yes' : 'no'} | ${r.performed ? 'yes' : 'no'} |\n`
    }
    for (const r of metrics.compliance) {
      if (r.unparsedWorktrees) {
        report += `- Worktree records that could not be parsed (${r.rule}): ${r.unparsedWorktrees}\n`
      }
    }
    report += '\n'
  }

  // Maintainability section — computed from git and openspec/ only, no agent and no session id
  report += '## Maintainability (computed without an agent or a session id)\n\n'
  const m = metrics.maintainability
  report += `- Insertions vs deletions (${m.insertionsVsDeletionsScope}): ${m.insertionsVsDeletions.insertions} / ${m.insertionsVsDeletions.deletions}\n`
  report += `- Capability count: ${m.capabilityChurn.capabilityCount}\n`
  if (m.perFileChurn.length === 0) {
    report += '- Per-file churn (openspec/changes/archive): (none)\n'
  } else {
    report += '- Per-file churn (openspec/changes/archive):\n'
    for (const f of m.perFileChurn) {
      report += `  - ${f.file}: ${f.changes}\n`
    }
  }
  const capabilityEdits = Object.entries(m.capabilityChurn.editsByCapability)
  if (capabilityEdits.length === 0) {
    report += '- Capability edit frequency (openspec/specs): (none)\n\n'
  } else {
    report += '- Capability edit frequency (openspec/specs):\n'
    for (const [capability, edits] of capabilityEdits) {
      report += `  - ${capability}: ${edits}\n`
    }
    report += '\n'
  }

  // Normative Surface Size section
  report += '## Normative Surface Size\n\n'
  if (!metrics.normativeBytes || metrics.normativeBytes.length === 0) {
    report += '(no normative byte data)\n\n'
  } else {
    // A cell prints a number only when something was measured. (no source) means the
    // input carried nothing to measure — printing 0 there would state a measurement that was
    // never made, which we exist to avoid.
    const cell = (value) => (value !== null ? String(value) : '(no source)')
    report += '| Phase | Command File | Schema Instruction | Total |\n'
    report += '|---|---|---|---|\n'
    for (const r of metrics.normativeBytes) {
      report += `| ${r.phase} | ${cell(r.commandBytes)} | ${cell(r.schemaBytes)} | ${cell(r.totalBytes)} |\n`
    }
    report += '\n'
  }

  return report
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  // Parse `--change <name>` and the optional `--repo <path>` from argv. `--repo` exists so
  // the extractor can run from any working directory: every git invocation and every path
  // below is rooted at that repository rather than at the process's cwd.
  const changeIndex = process.argv.indexOf('--change')
  if (changeIndex === -1 || changeIndex >= process.argv.length - 1) {
    console.error('Usage: node adf-metrics.mjs --change <name> [--repo <path>]')
    process.exit(1)
  }
  const changeName = process.argv[changeIndex + 1]
  const repoIndex = process.argv.indexOf('--repo')
  const repoArg = repoIndex !== -1 && repoIndex < process.argv.length - 1 ? process.argv[repoIndex + 1] : process.cwd()

  // Wire real fs and git. `execFileSync` with an argument array keeps paths with spaces
  // intact, which string interpolation into a shell command does not.
  const git = async (args) => {
    return execFileSync('git', ['-C', repoArg, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
  }

  const read = async (p) => {
    return readFileSync(p, 'utf8')
  }

  const list = async (d) => {
    return readdirSync(d)
  }

  extractMetrics({ read, list, git, changeName })
    .then((metrics) => {
      const report = renderReport(metrics)

      // Write to <repo>/.claude-reports/adf-retro/<change-name>-metrics.md
      const reportDir = join(repoArg, '.claude-reports', 'adf-retro')
      mkdirSync(reportDir, { recursive: true })
      const reportPath = join(reportDir, `${changeName}-metrics.md`)
      writeFileSync(reportPath, report, 'utf8')
      console.log(`Report written to ${reportPath}`)
    })
    .catch((err) => {
      console.error('Error:', err)
      process.exit(1)
    })
}
