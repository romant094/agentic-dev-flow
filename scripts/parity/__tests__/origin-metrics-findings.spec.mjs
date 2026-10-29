// origin-metrics-findings.mjs on a fixture origin and a fixture transcript corpus: a reply file
// whose only body the transcripts hold is one the origin's validateReply refuses, made valid later
// by a script the tool cannot read, is an `unread-write`, not an unexplained difference. The
// origin's scripts are stubs: a validateReply refusing an unknown key, and countFindings counting
// the valid replies per layer as the origin's does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORIGIN_SCRIPTS } from '../lib/origin-metrics.mjs'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'origin-metrics-findings.mjs')

const CHECK_REPLY = `export function validateReply(role, value) {
  return Object.keys(value).filter((k) => !['role', 'verdict', 'findings'].includes(k)).map((k) => k + ' is not allowed')
}
`
const COUNT = `import { validateReply } from './check-reply.mjs'
export function countFindings(replies) {
  const out = {}
  for (const { role, value } of replies) {
    if (validateReply(role, value).length > 0) continue
    const entry = (out[role] ??= { dispatches: 0, findings: 0 })
    entry.dispatches += 1
    entry.findings += value.findings.length
  }
  return out
}
`

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-findings-')))
  const origin = join(root, 'origin')
  const files = {
    ...Object.fromEntries(ORIGIN_SCRIPTS.map((name) => [`.claude/scripts/${name}`, 'export {}\n'])),
    '.claude/scripts/check-reply.mjs': CHECK_REPLY,
    '.claude/scripts/adf-metrics-findings.mjs': COUNT,
    'openspec/changes/archive/2026-10-01-add-x/metrics.json': `${JSON.stringify({ branch: 'feat/add-x', sessions: [], findings: { review: { dispatches: 2, findings: 3 } } })}\n`
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, path)), { recursive: true })
    writeFileSync(join(origin, path), text)
  }
  execFileSync('git', ['init', '-q', '-b', 'develop', origin])
  execFileSync('git', ['-C', origin, 'add', '-A'])
  execFileSync('git', ['-C', origin, '-c', 'user.name=O', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', 'origin'])
  const replies = '/w/.superpowers/sdd/add-x/replies'
  const bash = (at, command) => JSON.stringify({ timestamp: at, cwd: '/w', gitBranch: 'feat/add-x', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
  const transcripts = join(root, 'projects', '-w-xnms')
  mkdirSync(transcripts, { recursive: true })
  writeFileSync(join(transcripts, 's1.jsonl'), [
    bash('2026-10-01T10:00:00Z', `cat > ${replies}/T1-review.json <<'E'\n${JSON.stringify({ role: 'review', verdict: 'fail', findings: [{ summary: 'a' }] })}\nE`),
    bash('2026-10-01T10:01:00Z', `cat > ${replies}/T2-review.json <<'E'\n${JSON.stringify({ role: 'review', verdict: 'fail', findings: [{ summary: 'b' }, { summary: 'c' }], notes: 'extra' })}\nE`),
    bash('2026-10-01T10:02:00Z', `node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f));delete j.notes;require("fs").writeFileSync(f,JSON.stringify(j))' ${replies}/T2-review.json`),
    ''
  ].join('\n'))
  return { root, origin, transcripts: join(root, 'projects') }
}

test('a reply file whose last read body the origin refuses, fixed by a script, is an unread-write', () => {
  const f = fixture()
  try {
    const run = spawnSync(process.execPath, [TOOL, f.origin, '--all'], { encoding: 'utf8', env: { ...process.env, ADF_TRANSCRIPTS: f.transcripts } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const out = JSON.parse(run.stdout)
    assert.deepEqual(out.unexplained, [])
    assert.deepEqual(out.classes, { 'unread-write': 1 })
    assert.deepEqual(out.rows[0].layers.review, { record: { dispatches: 2, findings: 3 }, corpus: { dispatches: 1, findings: 1 } })
    assert.deepEqual(out.rows[0].unread, ['T2-review.json'])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
