#!/usr/bin/env node
// CLI over lib/ledger.mjs. Every subcommand prints one JSON object on stdout and exits 1 on
// a refusal.
//
//   ledger.mjs <kind> --change <name> [--field value ...]   append one record
//   ledger.mjs ruling --change <name> --check <id> --reason <text>
//                                                            a developer ruling accepting a
//                                                            failing verify check
//   ledger.mjs ruling --change <name> --finding F<n> --as dismissed|accepted|fix --decision <text>
//                                                            a developer ruling on a review
//                                                            finding, which review.mjs
//                                                            disposition requires; `fix`
//                                                            rejects a false-positive claim,
//                                                            and review.mjs fixplan lists the
//                                                            finding again
//   ledger.mjs ruling --change <name> --check review-<id> --reason <text>
//                                                            a ruling of the review stage:
//                                                            review-range, review-slices,
//                                                            review-suite, review-round-<k>
//   ledger.mjs resolve --change <name> --finding F<n> --as <destination> --where <where>
//                                                            the placement of a recorded or
//                                                            accepted review finding, which
//                                                            archive.mjs placements reads
//   ledger.mjs skill-edit --change <name> --sha <commit> [--message <m>]
//                                                            an approved skill edit's commit,
//                                                            which every later verify run exempts
//   ledger.mjs list --change <name> [--unresolved-debt]      the records, or the open debt
//
// --root <dir> names the host project (default: the current directory); --repo <dir> is
// kept as its older spelling. The session id is read from CLAUDE_CODE_SESSION_ID.
import { appendRecord, KINDS, listRecords, parseFlags } from './lib/ledger.mjs'
import { isMain } from './lib/main.mjs'

export const USAGE = `Usage:
  ledger.mjs <kind> --change <name> [--field value ...] [--root <dir>]
  ledger.mjs list --change <name> [--unresolved-debt] [--root <dir>]
Kinds: ${Object.entries(KINDS)
  .map(
    ([k, v]) =>
      `${k} (${v.required.map((f) => `--${f}`).join(' ')}${v.optional.length ? ` [${v.optional.map((f) => `--${f}`).join(' ')}]` : ''})`
  )
  .join('; ')}; ruling on a verify check or a review stage step (--check --reason); ruling on a review finding (--finding --as dismissed|accepted|fix --decision); resolve of a review finding (--finding F<n> --as --where); skill-edit (--sha [--message])`

export function run(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const [kind, ...rest] = argv
  if (!kind) throw new Error('a kind is required')
  const unresolvedOnly = rest.includes('--unresolved-debt')
  const { change, root, repo, ...fields } = parseFlags(rest.filter((a) => a !== '--unresolved-debt'))
  if (!change) throw new Error('--change is required')
  const dir = root ?? repo ?? cwd
  if (kind === 'list') return { ok: true, records: listRecords(dir, change, { unresolvedOnly }) }
  const { record, path } = appendRecord(dir, change, kind, fields, { env })
  return { ok: true, record, path }
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, usage: USAGE })}\n`)
    process.exitCode = 1
  }
}
