// Test fixtures for the verify dispatches: a c4 or c8 reply written to its reply file and recorded
// the way `dispatch.mjs reply` records it, which writes the section `verify.mjs verdict` reads.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { replyFile } from '../lib/dispatch.mjs'
import { c4Case, recordVerifyReply } from '../lib/verify-reply.mjs'
import { skillCandidates, verifyDir } from '../lib/verify.mjs'

export const c4Reply = (over = {}) => ({ role: 'verify-c4', case: 'no-design', findings: [], proseEdits: [], removalAccounting: [], exercised: [], summary: 'coherent', ...over })
export const c8Reply = (over = {}) => ({ role: 'verify-c8', candidates: [], summary: 'no stale skill', ...over })

// A drift (warn) and an executable contradiction (fail), as c4 findings.
export const DRIFT = { kind: 'doc-drift', where: [{ file: 'design.md', line: 3 }, { file: 'specs/greeting/spec.md', line: 5 }], text: 'the two disagree' }
export const CONTRADICTION = { kind: 'exec-contradiction', where: [{ file: 'src/a.mjs', line: 1 }], text: 'the code contradicts the script' }

// Writes the reply of `verify <check>` and records it at the session's start; returns the result.
// A c4 reply's case defaults to the one the change's files give.
export function judge(root, change, check, given, { now } = {}) {
  const reply = given ?? (check === 'c4' ? c4Reply({ case: c4Case(root, change) ?? 'no-design' }) : c8Reply())
  if (check === 'c8' && !existsSync(join(verifyDir(root, change), 'c8-candidates.json'))) skillCandidates(root, { change })
  const name = `verify ${check}`
  const file = replyFile(root, change, name, existsSync)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof reply === 'string' ? reply : JSON.stringify(reply))
  const run = JSON.parse(readFileSync(join(verifyDir(root, change), 'run.json'), 'utf8'))
  return recordVerifyReply(root, change, { name, file, now: now ?? run.started })
}

// The two judgement sections every verdict needs, as passes.
export function judged(root, change) {
  judge(root, change, 'c4')
  judge(root, change, 'c8')
}
