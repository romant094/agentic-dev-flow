#!/usr/bin/env node
// CLI over lib/specs.mjs. Prints one JSON object on stdout with the fields of
// `openspec validate --all --json` (items, summary, version, root) and exits 1 when any item
// is invalid or the command is refused, 2 on a usage error.
//
//   specs.mjs validate [--all]              every active change and every main spec
//   specs.mjs validate --change <name>      one active change's delta specs
//   specs.mjs validate --spec <capability>  one main spec
//   specs.mjs validate --change <name> --against-main
//       also each delta against its main spec, as archive will apply it, under `againstMain`
//       ({ ok, capabilities: [{ capability, mainSpec, findings }] }): a MODIFIED, REMOVED or
//       RENAMED-from header the main spec lacks, an ADDED or RENAMED-to name it already holds,
//       a REMOVED without Reason, Migration or Code Disposition, a RENAMED without Code
//       Disposition. Exit 1 on any finding as well.
//   specs.mjs capabilities [--change <name>]
//       the proposal's Capabilities section against the change's spec folders and the main
//       specs: { ok, new, modified, missingSpec, unlistedSpec, modifiedNotFound, newCollides,
//       badName, listedTwice }. Exit 1 when not ok.
//   specs.mjs merge --dry-run [--change <name>] [--resolutions <file>]
//       the read-only preview of archive's spec merge (lib/specs.mjs mergePreview): per
//       capability the counts added, modified, removed and renamed, `new`, `merged` (the main
//       spec already holds the delta), the conflicts of the three-way check against the base in
//       the change's specs-base.json (its merge base when it has none, with a warning), refusals;
//       and the totals, newCapabilities, placeholderPurpose, conflicts, errors and warnings. --resolutions previews a JSON array of { capability, requirement, text, reason }
//       applied to the conflicts; a resolution that answers no conflict is refused. Exit 1 on
//       an unresolved conflict or a refusal. Nothing is written: the writing merge is
//       `archive.mjs merge`, after archive's gate.
//   specs.mjs base [--check] [--change <name>]
//       writes openspec/changes/<name>/specs-base.json (lib/specs.mjs writeSpecsBase): the main
//       spec's text of every requirement a delta modifies, removes or renames, with the hash of
//       the delta block it was taken for, so a rebase cannot move the three-way check's base.
//       An entry whose delta block is unchanged keeps its text; a changed one is taken again
//       from the main spec; one no delta touches is dropped. { ok, file, added, refreshed,
//       kept, dropped }; exit 1 when a touched requirement is not in its main spec (nothing
//       written). --check writes nothing: { ok, file, exists, touched, missing, stale, refusal? }, exit 1
//       when a requirement has no entry or its entry was taken for another delta text.
//   specs.mjs resolution --capability <capability> --reply <file> [--change <name>] [--resume yes|no]
//       the check of a `spec-merge <capability>` agent's reply (lib/spec-merge.mjs): valid under
//       schema/spec-merge-resolution.schema.json and checkResolutions, every resolution of the
//       capability, and exactly one per unresolved conflict the dry run finds in it. The checked
//       reply is an event of the dispatch `spec-merge <capability>` in the change's shared log
//       (lib/attempts.mjs). { ok, valid, errors, capability, conflicts, resolutions, next, mode,
//       invalid }; exit 1 when not valid. The valid replies of every capability in conflict,
//       joined into one array, are the merge's --resolutions file; a refused reply goes back once
//       (`next: retry`, `mode: resume`, or `fresh` with --resume no), and a second refusal stops
//       archive (`next: stop`; a later reply of the name is refused unrecorded).
//
// Without --change, capabilities, merge, base and --against-main act on the one active change under the root.
//
// --strict also fails an item on a WARNING, as the CLI's --strict does. --root <dir> names the
// project holding openspec/ (default: the current directory).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { changeAgainstMain, checkCapabilities, checkSpecsBase, mergePreview, validateProject, writeSpecsBase } from './lib/specs.mjs'
import { checkSpecMergeReply } from './lib/spec-merge.mjs'
import { recordReply } from './lib/attempts.mjs'
import { inferChange } from './lib/changes.mjs'
import { loadSchema } from './lib/schema.mjs'
import { isMain } from './lib/main.mjs'

export class UsageError extends Error {}

const USAGE = 'usage: specs.mjs validate [--all | --change <name> [--against-main] | --spec <capability>] [--strict] [--root <dir>] | specs.mjs capabilities [--change <name>] [--root <dir>] | specs.mjs merge --dry-run [--change <name>] [--resolutions <file>] [--root <dir>] | specs.mjs base [--check] [--change <name>] [--root <dir>] | specs.mjs resolution --capability <capability> --reply <file> [--change <name>] [--resume yes|no] [--root <dir>]'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  if (value === undefined) throw new UsageError(`${name} needs a value`)
  return value
}

function readResolutions(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`--resolutions ${file}: ${error.message}`)
  }
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

export function run(argv) {
  const args = [...argv]
  const rootOption = option(args, '--root')
  let change = option(args, '--change')
  const spec = option(args, '--spec')
  const strict = flag(args, '--strict')
  const all = flag(args, '--all')
  const againstMain = flag(args, '--against-main')
  const dryRun = flag(args, '--dry-run')
  const resolutions = option(args, '--resolutions')
  const capability = option(args, '--capability')
  const reply = option(args, '--reply')
  const resume = option(args, '--resume')
  const check = flag(args, '--check')
  const [command, ...rest] = args
  const root = resolve(rootOption ?? process.cwd())
  if (command === 'base') {
    if (rest.length > 0 || spec || all || strict || againstMain || dryRun || resolutions !== undefined || capability !== undefined || reply !== undefined || resume !== undefined) throw new UsageError(USAGE)
    change = inferChange(root, change, loadSchema())
    return { change, ...(check ? checkSpecsBase(root, change) : writeSpecsBase(root, change)) }
  }
  if (check) throw new UsageError(USAGE)
  if (command === 'resolution') {
    if (!capability || !reply || rest.length > 0 || spec || all || strict || againstMain || dryRun || resolutions !== undefined) throw new UsageError(USAGE)
    if (resume !== undefined && !['yes', 'no'].includes(resume)) throw new UsageError('--resume is yes or no')
    change = inferChange(root, change, loadSchema())
    let text
    try {
      text = readFileSync(reply, 'utf8')
    } catch (error) {
      throw new Error(`--reply ${reply}: ${error.message}`)
    }
    const conflicts = mergePreview(root, change).conflicts.filter((c) => c.capability === capability)
    if (conflicts.length === 0) throw new Error(`${capability} has no unresolved conflict in ${change}; there is nothing to resolve`)
    const checked = checkSpecMergeReply(text, { capability, conflicts })
    const recorded = recordReply(root, change, { name: `spec-merge ${capability}`, file: resolve(reply), errors: checked.errors, resume: resume !== 'no' })
    return {
      ok: checked.valid,
      valid: checked.valid,
      errors: checked.errors,
      capability,
      conflicts: conflicts.map((c) => c.requirement),
      resolutions: checked.valid ? checked.reply : null,
      next: recorded.next,
      mode: recorded.mode,
      invalid: recorded.invalid
    }
  }
  if (capability !== undefined || reply !== undefined || resume !== undefined) throw new UsageError(USAGE)
  if (command === 'merge') {
    if (!dryRun || rest.length > 0 || spec || all || strict || againstMain) {
      throw new UsageError(dryRun ? USAGE : 'specs.mjs merge writes nothing: pass --dry-run (the writing merge is archive.mjs merge, after the gate)')
    }
    change = inferChange(root, change, loadSchema())
    return mergePreview(root, change, { resolutions: resolutions === undefined ? [] : readResolutions(resolutions) })
  }
  if (dryRun || resolutions !== undefined) throw new UsageError(USAGE)
  if (command === 'capabilities' && rest.length === 0 && !spec && !all && !strict && !againstMain) {
    change = inferChange(root, change, loadSchema())
    return { change, ...checkCapabilities(root, change) }
  }
  if (command !== 'validate' || rest.length > 0 || [all, change, spec].filter((x) => x).length > 1 || (againstMain && (all || spec))) {
    throw new UsageError(USAGE)
  }
  if (againstMain) change = inferChange(root, change, loadSchema())
  const result = validateProject(root, { change, spec, strict })
  return {
    ...result,
    ...(againstMain ? { againstMain: changeAgainstMain(root, change) } : {}),
    root: { path: root, source: rootOption ? 'option' : 'cwd' }
  }
}

export const failed = (result) =>
  result.ok === false || (result.summary?.totals.failed ?? 0) > 0 || result.againstMain?.ok === false

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = failed(result) ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
