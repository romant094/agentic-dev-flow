import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PRICES_URL,
  RUNTIME,
  autonomyOf,
  encodeKeys,
  projectKeys,
  readTranscripts,
  responses,
  sliceByBranch
} from '../lib/transcripts.mjs'

const REPO = '/work/repo'
const MAIN = '-work-repo'
const WORKTREE = '-work-repo--claude-worktrees-feat-a'
const BRANCH = 'feat/a'

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
const usage = ({ input = 1, output, cacheRead = 0, w5 = 0, w1 = 0, thinking } = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } })
})
const assistant = (id, at, u, { branch = BRANCH, sidechain = false, model = 'claude-opus-5-5', content = [{ type: 'text' }] } = {}) => ({
  type: 'assistant',
  isSidechain: sidechain,
  timestamp: at,
  gitBranch: branch,
  effort: 'medium',
  message: { id, model, role: 'assistant', content, usage: u }
})
const user = (at, content, { branch = BRANCH, ...extra } = {}) => ({ type: 'user', isSidechain: false, timestamp: at, gitBranch: branch, message: { role: 'user', content }, ...extra })

// A projects directory: the main checkout's key, a worktree key, an unrelated project's key.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-transcripts-'))
  const write = (key, file, text) => {
    mkdirSync(join(dir, key, ...file.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, key, file), text)
  }
  // s1: started on develop with /adf:propose, then on the change's branch; streaming duplicates
  // of one response, a sidechain record, a compaction.
  write(MAIN, 's1.jsonl', jsonl([
    { type: 'mode', mode: 'normal', sessionId: 's1' },
    user('2026-10-01T09:59:00.000Z', 'start the change', { branch: 'develop' }),
    user('2026-10-01T10:00:00.000Z', '<command-message>adf:propose</command-message>\n<command-name>/adf:propose</command-name>', { branch: 'develop' }),
    assistant('msg_1', '2026-10-01T10:01:00.000Z', usage({ output: 5, cacheRead: 100, w1: 50 }), { content: [{ type: 'thinking' }] }),
    assistant('msg_1', '2026-10-01T10:01:02.000Z', usage({ output: 5, cacheRead: 100, w1: 50 }), { content: [{ type: 'text' }] }),
    assistant('msg_1', '2026-10-01T10:01:03.000Z', usage({ output: 120, cacheRead: 100, w1: 50, thinking: 30 }), { content: [{ type: 'tool_use', name: 'AskUserQuestion' }] }),
    assistant('msg_2', '2026-10-01T10:02:00.000Z', usage({ output: 7 })),
    assistant('msg_side', '2026-10-01T10:02:30.000Z', usage({ output: 9, thinking: 0 }), { sidechain: true }),
    user('2026-10-01T10:03:00.000Z', 'please also check the docs'),
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-01T10:04:00.000Z', gitBranch: BRANCH, compactMetadata: { trigger: 'auto', preTokens: 600000 } },
    user('2026-10-01T10:04:01.000Z', 'summary', { isCompactSummary: true }),
    assistant('msg_x', '2026-10-01T10:05:00.000Z', usage({ output: 1 }), { branch: 'develop' })
  ]))
  // s2: found by branch only, in the worktree key, with two subagents, one without a transcript.
  write(WORKTREE, 's2.jsonl', jsonl([
    user('2026-10-02T10:00:00.000Z', 'go'),
    assistant('msg_3', '2026-10-02T10:00:10.000Z', usage({ output: 3, thinking: 1 }))
  ]))
  write(WORKTREE, 's2/subagents/agent-a1.jsonl', jsonl([
    user('2026-10-02T10:01:00.000Z', 'brief'),
    assistant('msg_a1', '2026-10-02T10:01:30.000Z', usage({ output: 40, thinking: 10, w5: 200 }), { sidechain: true, model: 'claude-sonnet-5-5' })
  ]))
  write(WORKTREE, 's2/subagents/agent-a1.meta.json', JSON.stringify({ agentType: 'adf:integration', description: 'T1 impl', model: 'sonnet' }))
  write(WORKTREE, 's2/subagents/agent-a2.meta.json', JSON.stringify({ agentType: 'adf:mechanical', description: 'T1 review' }))
  // s3: another branch only.
  write(MAIN, 's3.jsonl', jsonl([assistant('msg_4', '2026-10-03T10:00:00.000Z', usage({ output: 4, thinking: 0 }), { branch: 'feat/b' })]))
  // A prefix of the branch name is not the branch.
  write(MAIN, 's4.jsonl', jsonl([assistant('msg_5', '2026-10-03T11:00:00.000Z', usage({ output: 4, thinking: 0 }), { branch: 'feat/abc' })]))
  // Another project on the same branch name.
  write('-work-other', 's5.jsonl', jsonl([assistant('msg_6', '2026-10-03T12:00:00.000Z', usage({ output: 4, thinking: 0 }))]))
  return dir
}

const ledger = [
  { id: 'session-1', kind: 'session', at: '2026-10-01T10:00:30.000Z', sessionId: 's1', phase: 'propose' },
  { id: 'session-2', kind: 'session', at: '2026-10-04T10:00:00.000Z', sessionId: 's9', phase: 'apply' }
]

test('names the runtime and the default prices page', () => {
  assert.equal(RUNTIME, 'claude-code')
  assert.equal(DEFAULT_PRICES_URL, 'https://platform.claude.com/docs/en/about-claude/pricing.md')
})

test('project keys: three encodings of the checkout and the main checkout, then worktree keys', () => {
  assert.deepEqual(encodeKeys('/work/my.repo'), ['-work-my.repo', 'work-my.repo', '-work-my-repo'])
  assert.ok(encodeKeys('C:\\Users\\me\\repo').includes('C--Users-me-repo'))
  const keys = projectKeys({
    repoPath: '/work/repo/.claude/worktrees/feat-a',
    commonDir: '/work/repo/.git',
    entries: [MAIN, WORKTREE, '-work-other', '-work-repo-sibling']
  })
  assert.ok(keys.includes('-work-repo--claude-worktrees-feat-a'))
  assert.ok(keys.includes(MAIN))
  assert.ok(!keys.includes('-work-other') && !keys.includes('-work-repo-sibling'))
})

test('streaming duplicates of one response count once, the final record preferred', () => {
  const list = responses([
    assistant('m', '2026-10-01T10:00:00.000Z', usage({ output: 5, cacheRead: 10 })),
    assistant('m', '2026-10-01T10:00:01.000Z', usage({ output: 80, cacheRead: 10, thinking: 20 })),
    assistant('m', '2026-10-01T10:00:02.000Z', usage({ output: 5, cacheRead: 10 })),
    assistant('n', '2026-10-01T10:00:03.000Z', usage({ output: 6 })),
    assistant('s', '2026-10-01T10:00:04.000Z', usage({ output: 1 }), { model: '<synthetic>' })
  ])
  assert.equal(list.length, 2)
  assert.deepEqual(
    { ...list[0] },
    { id: 'm', at: '2026-10-01T10:00:00.000Z', model: 'claude-opus-5-5', effort: 'medium', input: 1, output: 80, thinking: 20, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0, outputFinal: true }
  )
  assert.equal(list[1].outputFinal, false, 'a response with only the placeholder is flagged')
})

test('a record with no 5m/1h split counts its cache writes as 5-minute writes', () => {
  const [r] = responses([{ type: 'assistant', timestamp: 't', message: { id: 'x', model: 'm', usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 70 } } }])
  assert.equal(r.cacheWrite5m, 70)
  assert.equal(r.cacheWrite1h, 0)
})

test('the branch slice keeps records on the branch and its group branches, inheriting the branch', () => {
  const records = [
    { type: 'x', gitBranch: 'develop', timestamp: '2026-10-01T10:00:00.000Z' },
    { type: 'x', gitBranch: BRANCH, timestamp: '2026-10-01T10:01:00.000Z' },
    { type: 'x', timestamp: '2026-10-01T10:02:00.000Z' },
    { type: 'x', gitBranch: `${BRANCH}--group-A`, timestamp: '2026-10-01T10:03:00.000Z' },
    { type: 'x', gitBranch: 'feat/abc', timestamp: '2026-10-01T10:04:00.000Z' }
  ]
  const s = sliceByBranch(records, BRANCH)
  assert.equal(s.records.length, 3)
  assert.equal(s.first, '2026-10-01T10:01:00.000Z')
  assert.equal(s.last, '2026-10-01T10:03:00.000Z')
})

test('sessions: the ledger first, then the branch, marked by source; unresolved named', () => {
  const dir = fixture()
  const { value, reason } = readTranscripts({ repoPath: `${REPO}/.claude/worktrees/feat-a`, commonDir: `${REPO}/.git`, branch: BRANCH, ledger, projectsDir: dir })
  assert.equal(reason, null)
  assert.equal(value.runtime, 'claude-code')
  assert.deepEqual(value.sessions.map((s) => [s.id, s.source, s.key, s.scope]), [
    ['s1', 'both', MAIN, 'branch'],
    ['s2', 'branch', WORKTREE, 'branch']
  ])
  assert.deepEqual(value.unresolved, ['s9'])
})

test('a session is measured on its branch records; a sidechain record is kept apart', () => {
  const { value } = readTranscripts({ repoPath: REPO, branch: BRANCH, ledger, projectsDir: fixture() })
  const s1 = value.sessions.find((s) => s.id === 's1')
  assert.deepEqual(s1.responses.map((r) => [r.id, r.output, r.outputFinal]), [['msg_1', 120, true], ['msg_2', 7, false]])
  assert.deepEqual(s1.sidechain.map((r) => r.id), ['msg_side'])
  assert.equal(s1.first, '2026-10-01T10:01:00.000Z')
  assert.equal(s1.last, '2026-10-01T10:04:01.000Z')
  // The launch on develop is read from the whole transcript.
  assert.deepEqual(s1.commands, [{ at: '2026-10-01T10:00:00.000Z', name: 'adf:propose' }])
  assert.deepEqual(s1.autonomy, { developerMessages: 1, askUserQuestion: 1, clears: 0 })
  assert.deepEqual(s1.compactions, [{ at: '2026-10-01T10:04:00.000Z', trigger: 'auto', preTokens: 600000 }])
  assert.equal(s1.foreignRecords, 0)
})

test('subagents: transcript and meta read; a meta without a transcript is named missing', () => {
  const { value } = readTranscripts({ repoPath: REPO, branch: BRANCH, ledger, projectsDir: fixture() })
  const s2 = value.sessions.find((s) => s.id === 's2')
  const [a1, a2] = s2.subagents
  assert.equal(a1.agentId, 'a1')
  assert.equal(a1.agentType, 'adf:integration')
  assert.equal(a1.description, 'T1 impl')
  assert.equal(a1.model, 'sonnet')
  assert.equal(a1.missing, false)
  assert.deepEqual(a1.responses.map((r) => [r.model, r.output, r.cacheWrite5m]), [['claude-sonnet-5-5', 40, 200]])
  assert.equal(a2.agentId, 'a2')
  assert.equal(a2.missing, true)
  assert.match(a2.reason, /no agent-a2\.jsonl/)
  assert.deepEqual(a2.responses, [])
})

test('on an integration branch nothing is discovered; ledger sessions are measured whole', () => {
  const { value } = readTranscripts({ repoPath: REPO, branch: 'develop', ledger, projectsDir: fixture() })
  assert.deepEqual(value.sessions.map((s) => [s.id, s.source, s.scope]), [['s1', 'ledger', 'session']])
  assert.equal(value.sessions[0].responses.length, 3)
})

test('a session on another branch is not the change\'s', () => {
  const { value, reason } = readTranscripts({ repoPath: REPO, branch: 'feat/none', ledger: [], projectsDir: fixture() })
  assert.equal(value, null)
  assert.match(reason, /no session on branch feat\/none/)
  const b = readTranscripts({ repoPath: REPO, branch: 'feat/b', projectsDir: fixture() })
  assert.deepEqual(b.value.sessions.map((s) => s.id), ['s3'])
})

test('no transcripts is null with the reason', () => {
  const missing = readTranscripts({ repoPath: REPO, branch: BRANCH, projectsDir: join(tmpdir(), 'adf-no-such-dir-xyz') })
  assert.equal(missing.value, null)
  assert.match(missing.reason, /no transcript directory/)
  const noKey = readTranscripts({ repoPath: '/elsewhere', branch: BRANCH, projectsDir: fixture() })
  assert.equal(noKey.value, null)
  assert.match(noKey.reason, /no project key of \/elsewhere/)
  const onlyGone = readTranscripts({ repoPath: REPO, branch: 'develop', ledger: [ledger[1]], projectsDir: fixture() })
  assert.equal(onlyGone.value, null)
  assert.match(onlyGone.reason, /s9 have no transcript/)
})

test('autonomy skips the opening message, flow launches, injected text and reminders; counts /clear', () => {
  const records = [
    user('t1', 'first'),
    user('t2', '<command-name>/adf:apply</command-name>'),
    user('t3', '<command-name>/clear</command-name>'),
    user('t4', '<task-notification>done</task-notification>'),
    user('t5', '<system-reminder>x</system-reminder>'),
    user('t6', [{ type: 'tool_result', content: 'x' }]),
    user('t7', [{ type: 'text', text: 'real message' }]),
    user('t8', '<command-name>/other</command-name>'),
    user('t9', 'meta', { isMeta: true })
  ]
  assert.deepEqual(autonomyOf(records), { developerMessages: 2, askUserQuestion: 0, clears: 1 })
})
