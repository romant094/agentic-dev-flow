import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMetrics, renderReport, parseWorktreeList, measureNormativeBytes, extractSchemaInstructionBytes } from './adf-metrics.mjs'

test('names a session whose transcript cannot be resolved', async () => {
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | 10:00-11:00 | apply\n'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.deepEqual(m.sessions, [{ id: 'abc-123', resolved: false }])
})

test('attributes output tokens per actor', async () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', isSidechain: false, usage: { output_tokens: 100 } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, usage: { output_tokens: 40 } })
  ].join('\n')
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const orchestrator = m.tokenEconomy.find((r) => r.actor === 'orchestrator')
  assert.equal(orchestrator.outputTokens, 100)
  assert.equal(m.tokenEconomy.find((r) => r.actor === 'subagents').outputTokens, 40)
})

test('counts only read-shaped records as context reads, split by actor', async () => {
  const transcript = [
    // Neither of these is a read: an assistant turn is output, not context pulled in.
    JSON.stringify({ type: 'assistant', isSidechain: false, usage: { output_tokens: 100 } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, usage: { output_tokens: 40 } }),
    JSON.stringify({ type: 'user', isSidechain: false, toolUseResult: { file: { content: 'x' } } }),
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'y' }] }
    }),
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'z' }] }
    })
  ].join('\n')
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const orchestrator = m.tokenEconomy.find((r) => r.actor === 'orchestrator')
  const subagents = m.tokenEconomy.find((r) => r.actor === 'subagents')
  assert.equal(orchestrator.contextReads, 1)
  assert.equal(subagents.contextReads, 2)
})

test('reports a mandatory fan-out that did not happen', async () => {
  const plan = '## Execution Graph\n| A | 1 | x | 1 |\n| B | 2 | y | 1 |\n'
  const read = async (p) => (p.endsWith('plan.md') ? plan : '## Sessions\n')
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const row = m.compliance.find((r) => r.rule === 'wave-1 fan-out')
  assert.equal(row.required, true)
  assert.equal(row.performed, false)
})

test('passes wave-1 fan-out when every declared group has its own diverged worktree', async () => {
  const plan = '## Execution Graph\n| A | 1 | x | 1 |\n| B | 2 | y | 1 |\n'
  const read = async (p) => (p.endsWith('plan.md') ? plan : '## Sessions\n')
  const git = async (args) => {
    if (args[0] === 'rev-parse') return 'feat/X--group-A\n'
    if (args[0] === 'worktree') {
      return [
        'worktree path-a',
        'HEAD aaaaaaa',
        'branch refs/heads/feat/X--group-A',
        '',
        'worktree path-b',
        'HEAD bbbbbbb',
        'branch refs/heads/feat/X--group-B'
      ].join('\n')
    }
    if (args[0] === 'merge-base') return 'ccccccccccccccccccccccccccccccccccccccc\n'
    return ''
  }
  const m = await extractMetrics({ read, list: async () => [], git })
  const row = m.compliance.find((r) => r.rule === 'wave-1 fan-out')
  assert.equal(row.performed, true)
})

test('flags a wave-1 group whose worktree never advanced past the shared fork point', async () => {
  const plan = '## Execution Graph\n| A | 1 | x | 1 |\n| B | 2 | y | 1 |\n'
  const read = async (p) => (p.endsWith('plan.md') ? plan : '## Sessions\n')
  const git = async (args) => {
    if (args[0] === 'rev-parse') return 'feat/X--group-A\n'
    if (args[0] === 'worktree') {
      return [
        'worktree path-a',
        'HEAD aaaaaaa',
        'branch refs/heads/feat/X--group-A',
        '',
        'worktree path-b',
        'HEAD bbbbbbb',
        'branch refs/heads/feat/X--group-B'
      ].join('\n')
    }
    if (args[0] === 'merge-base') return 'bbbbbbb\n' // group B never moved past the fork point
    return ''
  }
  const m = await extractMetrics({ read, list: async () => [], git })
  const row = m.compliance.find((r) => r.rule === 'wave-1 fan-out')
  assert.equal(row.performed, false)
})

test('parses a porcelain worktree record whose path contains a space', () => {
  const text = [
    'worktree /Users/me/My Projects/repo',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/feat/X--group-A',
    '',
    'worktree /Users/me/My Projects/repo/.claude/worktrees/X--group-B',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'branch refs/heads/feat/X--group-B'
  ].join('\n')
  const { entries, unparsed } = parseWorktreeList(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, '/Users/me/My Projects/repo')
  assert.equal(entries[0].sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(entries[0].branch, 'feat/X--group-A')
  assert.equal(unparsed, 0)
})

test('keeps a detached worktree record instead of dropping it silently', () => {
  const text = [
    'worktree /repo/.claude/worktrees/X--group-C',
    'HEAD cccccccccccccccccccccccccccccccccccccccc',
    'detached'
  ].join('\n')
  const { entries, unparsed } = parseWorktreeList(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].branch, null)
  assert.equal(unparsed, 0)
})

test('counts an unparsable worktree record instead of silently dropping it', () => {
  const text = 'this is not a worktree record at all'
  const { entries, unparsed } = parseWorktreeList(text)
  assert.equal(entries.length, 0)
  assert.equal(unparsed, 1)
})

test('reports wave-1 fan-out as performed when group worktrees live under a path with a space', async () => {
  const plan = '## Execution Graph\n| A | 1 | x | 1 |\n| B | 2 | y | 1 |\n'
  const read = async (p) => (p.endsWith('plan.md') ? plan : '## Sessions\n')
  const git = async (args) => {
    if (args[0] === 'rev-parse') return 'feat/X--group-A\n'
    if (args[0] === 'worktree') {
      return [
        'worktree /Users/me/My Projects/repo/.claude/worktrees/X--group-A',
        'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'branch refs/heads/feat/X--group-A',
        '',
        'worktree /Users/me/My Projects/repo/.claude/worktrees/X--group-B',
        'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'branch refs/heads/feat/X--group-B'
      ].join('\n')
    }
    if (args[0] === 'merge-base') return 'ccccccccccccccccccccccccccccccccccccccc\n'
    return ''
  }
  const m = await extractMetrics({ read, list: async () => [], git })
  const row = m.compliance.find((r) => r.rule === 'wave-1 fan-out')
  assert.equal(row.performed, true)
})

test('computes maintainability indicators from git log and openspec/specs, without an agent or session id', async () => {
  const git = async (args) => {
    const joined = args.join(' ')
    if (joined.includes('openspec/changes/archive')) return '3\t1\ta.md\n2\t0\ta.md\n1\t1\tb.md\n'
    if (joined.includes('openspec/specs')) {
      return '4\t2\topenspec/specs/foo/spec.md\n1\t1\topenspec/specs/bar/spec.md\n2\t2\topenspec/specs/foo/spec.md\n'
    }
    if (joined.startsWith('log')) return '10\t2\tfile1.js\n5\t1\tfile2.js\n'
    return ''
  }
  const list = async (d) => (d.endsWith('specs') ? ['foo', 'bar'] : [])
  const read = async (p) => (p.endsWith('plan.md') ? '## Execution Graph\n' : '## Sessions\n')
  const m = await extractMetrics({ read, list, git })
  assert.deepEqual(m.maintainability.insertionsVsDeletions, { insertions: 15, deletions: 3 })
  assert.deepEqual(m.maintainability.perFileChurn, [
    { file: 'a.md', changes: 6 },
    { file: 'b.md', changes: 2 }
  ])
  assert.equal(m.maintainability.capabilityChurn.capabilityCount, 2)
  assert.deepEqual(m.maintainability.capabilityChurn.editsByCapability, { foo: 2, bar: 1 })
})

test('exempts a plan with a single wave-1 group from the fan-out obligation', async () => {
  const plan = '## Execution Graph\n| A | 1-5 | x | 1 |\n| B | 6 | y | 2 |\n'
  const read = async (p) => (p.endsWith('plan.md') ? plan : '## Sessions\n')
  const git = async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/X\n'
    return ''
  }
  const m = await extractMetrics({ read, list: async () => [], git })
  const row = m.compliance.find((r) => r.rule === 'wave-1 fan-out')
  assert.equal(row.required, false)
  assert.equal(row.performed, true)
})

test('treats a same-day window whose end precedes its start as crossing one midnight', async () => {
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | 23:30-01:00 | apply\n'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.velocity.totalMinutes, 90)
  assert.equal(m.velocity.unparsedWindows, 0)
})

test('measures a multi-day window given as an ISO-8601 datetime range', async () => {
  const read = async (p) => {
    if (p.endsWith('progress.md')) {
      return '## Sessions\nabc-123 | 2026-08-22T09:00/2026-08-24T06:00 | apply\n'
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.velocity.totalMinutes, 45 * 60)
  assert.equal(m.velocity.unparsedWindows, 0)
})

test('counts an unparsable window instead of contributing zero minutes silently', async () => {
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | sometime last week | apply\n'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.velocity.unparsedWindows, 1)
  assert.equal(m.velocity.measuredWindows, 0)
})

test('reports sessions per hour under a name that matches what it counts', async () => {
  const read = async (p) => {
    if (p.endsWith('progress.md')) {
      return '## Sessions\na | 10:00-11:00 | apply\nb | 11:00-12:00 | apply\n'
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.velocity.sessionsPerHour, '1.00')
  assert.equal(m.velocity.tasksPerHour, undefined)
})

test('reduces the ledger dispatch lines to counts, per role and in total', async () => {
  const ledger = [
    '## Dispatches',
    '',
    '3.4, implementer, integration, 41 turns',
    '- 3.4, reviewer, architecture, 12 turns',
    '| 5.1 | implementer | mechanical | 7 turns |',
    'this prose sentence is not a dispatch line and must not be counted at all',
    '| Task | Role | Level | Turns |',
    '',
    '## Deviations',
    ''
  ].join('\n')
  const read = async (p) => {
    if (p.endsWith('progress.md')) return ledger
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.dispatches.total, 3)
  assert.deepEqual(m.dispatches.byRole, { implementer: 2, reviewer: 1 })
  assert.equal(m.dispatches.unparsed, 1)
})

test('reduces the ledger deviation lines to their text and reason', async () => {
  const ledger = [
    '## Dispatches',
    '',
    '## Deviations',
    '',
    'Groups B and C were run serially. Reason: both wrote into the main checkout.',
    '',
    'Task 9 met the split rule and was not split, because the split would cross no',
    'failure path.',
    '',
    '## Debt',
    ''
  ].join('\n')
  const read = async (p) => {
    if (p.endsWith('progress.md')) return ledger
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.deviations.count, 2)
  assert.equal(m.deviations.entries[0].reason, 'both wrote into the main checkout.')
  assert.equal(m.deviations.entries[1].reason, 'the split would cross no failure path.')
})

test('renders the dispatch and deviation reductions into the report', async () => {
  const ledger = [
    '## Dispatches',
    '',
    '3.4, implementer, integration, 41 turns',
    '',
    '## Deviations',
    '',
    'Groups B and C were run serially. Reason: both wrote into the main checkout.',
    ''
  ].join('\n')
  const read = async (p) => {
    if (p.endsWith('progress.md')) return ledger
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const report = renderReport(m)
  assert.match(report, /## Dispatches/)
  assert.match(report, /implementer \| 1/)
  assert.match(report, /## Deviations/)
  assert.match(report, /Groups B and C were run serially/)
})

test('titles the report after the change it measured', async () => {
  const read = async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '', changeName: 'some-change' })
  const report = renderReport(m)
  assert.match(report.split('\n')[0], /some-change/)
  assert.doesNotMatch(report, /ADF Flow Improvements/)
})

test('scopes insertions against deletions to the change, not the whole repository history', async () => {
  const calls = []
  const git = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n'
    if (args[0] === 'merge-base') return 'basesha\n'
    if (args.join(' ').startsWith('log --numstat --pretty=format: basesha..HEAD')) return '7\t3\tx.js\n'
    if (args[0] === 'log') return '9999\t9999\twhole-history.js\n'
    return ''
  }
  const read = async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git, changeName: 'some-change' })
  assert.deepEqual(m.maintainability.insertionsVsDeletions, { insertions: 7, deletions: 3 })
  assert.match(m.maintainability.insertionsVsDeletionsScope, /basesha\.\.HEAD/)
})

test('roots every path it reads at the repository, not at the working directory', async () => {
  const listed = []
  const git = async (args) => (args[1] === '--show-toplevel' ? '/repo\n' : '')
  const list = async (d) => {
    listed.push(d)
    return []
  }
  const read = async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  await extractMetrics({ read, list, git, changeName: 'some-change' })
  assert.deepEqual(listed, ['/repo/openspec/specs'])
})

test('counts only the labelled deviation blocks when the section also carries rulings', async () => {
  const ledger = [
    '## Deviations',
    '',
    'Deviation: groups B and C ran serially. Reason: both wrote into the main checkout.',
    '',
    'Ruling: accept the work where it landed rather than re-running it.',
    '',
    '## Debt',
    ''
  ].join('\n')
  const read = async (p) => {
    if (p.endsWith('progress.md')) return ledger
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.deviations.count, 1)
  assert.equal(m.deviations.unparsed, 1)
})

test('resolves a session whose transcript exists only under the un-stripped project key', async () => {
  const transcript = JSON.stringify({ type: 'assistant', isSidechain: false, usage: { output_tokens: 7 } })
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | 10:00-11:00 | apply\n'
    if (p.includes('/projects/-repo-x/')) return transcript
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const git = async (args) => (args[1] === '--show-toplevel' ? '/repo/x\n' : '')
  const m = await extractMetrics({ read, list: async () => [], git })
  assert.deepEqual(m.sessions, [{ id: 'abc-123', resolved: true }])
  assert.equal(m.tokenEconomy.find((r) => r.actor === 'orchestrator').outputTokens, 7)
})

test('falls back to the stripped project key when the un-stripped directory yields nothing', async () => {
  const transcript = JSON.stringify({ type: 'assistant', isSidechain: false, usage: { output_tokens: 3 } })
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | 10:00-11:00 | apply\n'
    if (p.includes('/projects/repo-x/')) return transcript
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const git = async (args) => (args[1] === '--show-toplevel' ? '/repo/x\n' : '')
  const m = await extractMetrics({ read, list: async () => [], git })
  assert.deepEqual(m.sessions, [{ id: 'abc-123', resolved: true }])
  assert.equal(m.tokenEconomy.find((r) => r.actor === 'orchestrator').outputTokens, 3)
})

test('sums orchestrator tokens from message.usage, the field real records carry', async () => {
  const transcript = [
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 11,
          output_tokens: 700,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 900
        }
      }
    }),
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 9, output_tokens: 300, cache_read_input_tokens: 100 } }
    })
  ].join('\n')
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const orchestrator = m.tokenEconomy.find((r) => r.actor === 'orchestrator')
  assert.equal(orchestrator.outputTokens, 1000)
  assert.equal(orchestrator.inputTokens, 20)
  assert.equal(orchestrator.cacheReadTokens, 5100)
  assert.equal(orchestrator.cacheWriteTokens, 900)
})

test('measures subagent tokens from the harness task notifications', async () => {
  const notification = (taskId, tokens, toolUses, durationMs) =>
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n` +
        `<usage><subagent_tokens>${tokens}</subagent_tokens>` +
        `<tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>\n</task-notification>`
    })
  const transcript = [notification('aaa', 42139, 14, 70058), notification('bbb', 105552, 49, 471979)].join('\n')
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const subagents = m.tokenEconomy.find((r) => r.actor === 'subagents')
  assert.equal(subagents.totalTokens, 147691)
  assert.equal(m.subagentDispatches.dispatches, 2)
  assert.equal(m.subagentDispatches.toolUses, 63)
  assert.equal(m.subagentDispatches.durationMs, 542037)
})

test('counts one dispatch when the same notification repeats across queue operations', async () => {
  const block =
    '<task-notification>\n<task-id>aaa</task-id>\n' +
    '<usage><subagent_tokens>42139</subagent_tokens><tool_uses>14</tool_uses><duration_ms>70058</duration_ms></usage>\n' +
    '</task-notification>'
  const transcript = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: block }),
    JSON.stringify({ type: 'queue-operation', operation: 'remove', content: block })
  ].join('\n')
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(m.subagentDispatches.dispatches, 1)
  assert.equal(m.subagentDispatches.duplicateBlocks, 1)
  assert.equal(m.tokenEconomy.find((r) => r.actor === 'subagents').totalTokens, 42139)
})

test('distinguishes a figure with no source from a measured zero', async () => {
  const transcript = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }
  })
  const read = async (p) => (p.endsWith('progress.md') ? '## Sessions\nabc-123 | 10:00-11:00 | apply\n' : transcript)
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  const report = renderReport(m)
  // The orchestrator's zero is a measurement: records carrying usage were found and summed.
  assert.match(report, /\| orchestrator \| 0 \| 0 \|/)
  // The subagents' figures are not: no notification and no sidechain record exists to sum.
  assert.match(report, /\| subagents \| \(no source\)/)
})

test('measures normative bytes per phase', async () => {
  const read = async (p) => (p.endsWith('propose.md') ? 'x'.repeat(10) : 'y'.repeat(20))
  const rows = await measureNormativeBytes({ read, repoPath: '/repo' })
  const propose = rows.find((r) => r.phase === 'propose')
  assert.equal(propose.commandBytes, 10)
  assert.equal(propose.totalBytes, propose.commandBytes + propose.schemaBytes)
})

test('reads the schema and command files rooted at the supplied repository path, not at the working directory', async () => {
  const read = async (p) => {
    if (p === '/repo/openspec/schemas/sdd-plus-superpowers/schema.yaml') return ''
    if (p === '/repo/.claude/commands/opsx/propose.md') return 'x'.repeat(10)
    throw Object.assign(new Error(`ENOENT: unexpected path ${p}`), { code: 'ENOENT' })
  }
  const rows = await measureNormativeBytes({ read, repoPath: '/repo' })
  const propose = rows.find((r) => r.phase === 'propose')
  assert.equal(propose.commandBytes, 10)
})

test('a phase whose file cannot be read reports no source rather than zero', async () => {
  const read = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const rows = await measureNormativeBytes({ read, repoPath: '/repo' })
  assert.equal(rows.every((r) => r.commandBytes === null), true)
})

test('stops the instruction search at the anchored block boundary instead of borrowing the next block\'s instruction', () => {
  // `design` carries no `instruction: |` of its own; `specs` does. An unbounded scan
  // from the `design` anchor would walk past its block and return the `specs` body.
  const schema = `  - id: design
    template: design.md
    requires: []

  - id: specs
    instruction: |
      Specs body text that belongs to the next block, not to design.
    requires: []
`
  assert.equal(extractSchemaInstructionBytes(schema, 'design', 'artifact'), null)
})

test('measures schema bytes in UTF-8, not code units, for multi-byte characters', async () => {
  // Schema with multiple em dashes (— = U+2014, 3 bytes each in UTF-8, 1 code unit each in JS .length)
  // This creates a large measurable gap between .length and Buffer.byteLength(text, 'utf8')
  const schema = `- id: brainstorm
    instruction: |
      Multiple em dashes follow — — — — —.
      More text — and — another — dash.
      This fixture has several multi-byte chars so .length differs from UTF-8 bytes by enough to fail if wrong.`
  const read = async (p) => {
    if (p.endsWith('schema.yaml')) return schema
    return ''  // no source for command files
  }
  const rows = await measureNormativeBytes({ read, repoPath: '/repo' })
  const propose = rows.find((r) => r.phase === 'propose')

  // The dedented instruction text should be measured in UTF-8 bytes, not code units.
  // Fixture content (after dedent and newline): 3 lines with 8 em dashes total
  // UTF-8: each em dash is 3 bytes instead of 1 code unit, so 16 extra bytes
  // .length would give 177 code units; Buffer.byteLength(utf8) gives 193 bytes
  const expectedUTF8Bytes = 193
  assert.equal(propose.schemaBytes, expectedUTF8Bytes, `must measure exactly ${expectedUTF8Bytes} UTF-8 bytes`)
  // Demonstrate the regression: if .length were used, it would be 177 (not 193)
  assert.notEqual(propose.schemaBytes, 177, 'must NOT use .length (code units) — would be 177 instead of 193')
})

test('renders the normative surface table from the metrics the extractor produces', async () => {
  // The extractor is the sole producer of the object the CLI hands to the renderer, so the
  // table only reaches a report if extractMetrics itself measures the normative bytes.
  const schema = `apply:
    instruction: |
      Apply the change.`
  const read = async (p) => {
    if (p.endsWith('progress.md')) return '## Sessions\nabc-123 | 10:00-11:00 | apply\n'
    if (p.endsWith('schema.yaml')) return schema
    if (p.endsWith('apply.md')) return 'z'.repeat(30)
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const m = await extractMetrics({ read, list: async () => [], git: async () => '' })
  assert.equal(Array.isArray(m.normativeBytes), true)
  const report = renderReport(m)
  assert.doesNotMatch(report, /\(no normative byte data\)/)
  assert.match(report, /\| Phase \| Command File \| Schema Instruction \| Total \|/)
  assert.match(report, /\| apply \| 30 \| \d+ \| \d+ \|/)
})

// A schema fixture shaped like the real one: artifact instructions under `artifacts:`,
// then the top-level phase blocks the change added (`resolve:`, `propose:`, `archive:`)
// beside the one that already existed (`apply:`).
const PHASE_BLOCK_SCHEMA = `artifacts:
  - id: proposal
    instruction: |
      Proposal artifact.
  - id: plan
    instruction: |
      Plan artifact.
  - id: verify
    instruction: |
      Verify artifact.

resolve:
  instruction: |
    Resolve rules.

propose:
  instruction: |
    Propose procedure.

apply:
  requires: [plan]
  instruction: |
    Apply procedure.

archive:
  instruction: |
    Archive procedure.
`
const blockBytes = (body) => Buffer.byteLength(`${body}\n`, 'utf8')
const readPhaseBlockSchema = async (p) => {
  if (p.endsWith('schema.yaml')) return PHASE_BLOCK_SCHEMA
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

test('the archive phase reads the top-level archive: block, so its schema bytes are measured', async () => {
  const rows = await measureNormativeBytes({ read: readPhaseBlockSchema, repoPath: '/repo' })
  const archive = rows.find((r) => r.phase === 'archive')
  assert.equal(archive.schemaBytes, blockBytes('Archive procedure.'))
})

test("the propose phase's schema bytes include the top-level propose: block, not only the artifact instructions", async () => {
  const rows = await measureNormativeBytes({ read: readPhaseBlockSchema, repoPath: '/repo' })
  const propose = rows.find((r) => r.phase === 'propose')
  const artifactsOnly = blockBytes('Proposal artifact.') + blockBytes('Plan artifact.')
  assert.equal(propose.schemaBytes, artifactsOnly + blockBytes('Propose procedure.'))
})

test('the shared resolve: block is reported on its own row and is not folded into the phases that point at it', async () => {
  const rows = await measureNormativeBytes({ read: readPhaseBlockSchema, repoPath: '/repo' })
  const resolve = rows.find((r) => r.phase.startsWith('resolve'))
  assert.ok(resolve, 'the resolve block must appear as its own row')
  assert.equal(resolve.schemaBytes, blockBytes('Resolve rules.'))
  // It is text, not a phase: no command file of its own.
  assert.equal(resolve.commandBytes, null)
  assert.equal(resolve.totalBytes, blockBytes('Resolve rules.'))
  // Counted once, so the three phases whose command files point at it do not each carry it.
  assert.equal(rows.find((r) => r.phase === 'apply').schemaBytes, blockBytes('Apply procedure.'))
  assert.equal(rows.find((r) => r.phase === 'verify').schemaBytes, blockBytes('Verify artifact.'))
  assert.equal(rows.find((r) => r.phase === 'archive').schemaBytes, blockBytes('Archive procedure.'))
})
