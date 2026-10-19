#!/usr/bin/env node
// CLI over lib/ingest.mjs: the deterministic half of archive's ingest. Prints one JSON object on
// stdout; exit 1 on a refusal or an invalid reply, 2 on a usage error.
//
//   ingest.mjs stale --change <name> [--base <rev>] [--root <dir>] [--home <dir>]
//       before the `ingest` dispatch: reads the knowledge role's `context`, lists the stale
//       pages (lib/ingest.mjs staleList, the diff `<base>..HEAD`, base by default the change's
//       merge base) and writes the dispatch's input to .superpowers/sdd/<change>/ingest/input.json:
//       { change, changeDir, base, knowledge: { index, instruction, paths, log }, stale }.
//       Prints { ok, state: 'done', file, ...input }. With no knowledge provider:
//       { ok: true, state: 'none', report }, nothing written, and archive skips the ingest.
//   ingest.mjs check --change <name> --reply <file> [--root <dir>]
//       after it: the reply against schema/ingest.schema.json and the rules of
//       checkIngestReply, with the changed files read from `git status`.
//       { ok, valid, errors, log, reply }: `log` is the knowledge role's `log` input to write,
//       null when nothing was learned. A refused reply goes back once (`dispatch.mjs attempt`);
//       a second refusal stops archive.
//
// --root names the change worktree (default: the current directory); the change may be active
// or already archived. --home names the Claude Code home where the knowledge plugin is found.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkIngestReply, findChangeDir, ingestInputFile, ingestLogInput, mergeBaseOf, relativeTo, staleList, workingChanges } from './lib/ingest.mjs'
import { isMain } from './lib/main.mjs'
import { callRole, CORE, knowledgeReport } from './lib/roles.mjs'
import { claudeHome } from './lib/superpowers.mjs'

export const USAGE = `usage:
  ingest.mjs stale --change <name> [--base <rev>] [--root <dir>] [--home <dir>]
  ingest.mjs check --change <name> --reply <file> [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = { change: { type: 'string' }, base: { type: 'string' }, root: { type: 'string' }, home: { type: 'string' }, reply: { type: 'string' } }
const ALLOWED = { stale: ['change', 'base', 'root', 'home'], check: ['change', 'reply', 'root'] }

const globs = (value) => (Array.isArray(value) ? value.filter((g) => typeof g === 'string' && g !== '') : [])

// knowledge(root, home) -> the knowledge role's context result; injected by the tests.
export function run(argv, { cwd = process.cwd(), knowledge = (root, home) => callRole(root, 'knowledge', 'context', {}, { ...CORE, home }) } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(error.message)
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (!Object.hasOwn(ALLOWED, command ?? '') || extra.length > 0 || !values.change) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => !ALLOWED[command].includes(k))
  if (stray.length > 0) throw new UsageError(`${command} takes no --${stray[0]}\n${USAGE}`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.change)) throw new Error(`"${values.change}" is not a change name`)
  const root = resolve(cwd, values.root ?? '.')
  const change = values.change
  const file = ingestInputFile(root, change)

  if (command === 'stale') {
    const context = knowledge(root, values.home ?? claudeHome())
    if (context.state === 'none') return { ok: true, state: 'none', report: knowledgeReport('context', context) }
    if (context.state !== 'done') throw new Error(knowledgeReport('context', context))
    const paths = globs(context.paths)
    if (paths.length === 0) throw new Error(`${context.plugin ?? 'the knowledge provider'} names no paths in its context`)
    const log = globs(context.log)
    const dir = findChangeDir(root, change)
    const base = values.base ?? mergeBaseOf(root, dir)
    const input = {
      change,
      changeDir: relativeTo(root, dir),
      base,
      knowledge: { index: context.index ?? null, instruction: context.instructions?.ingest ?? null, paths, log },
      stale: staleList(root, change, { knowledgePaths: paths, logPaths: log, base })
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`)
    return { ok: true, state: 'done', file, ...input }
  }

  if (!values.reply) throw new UsageError(USAGE)
  if (!existsSync(file)) throw new Error(`no ${file}: run ingest.mjs stale --change ${change} first`)
  const input = JSON.parse(readFileSync(file, 'utf8'))
  let text
  try {
    text = readFileSync(values.reply, 'utf8')
  } catch (error) {
    throw new Error(`--reply ${values.reply}: ${error.message}`)
  }
  const checked = checkIngestReply(text, {
    stale: input.stale,
    changedFiles: workingChanges(root).filter((f) => f !== relativeTo(root, file)),
    knowledgePaths: input.knowledge.paths,
    logPaths: input.knowledge.log,
    exists: (path) => existsSync(join(root, path))
  })
  return { ok: checked.valid, valid: checked.valid, errors: checked.errors, log: checked.valid ? ingestLogInput(checked.reply) : null, reply: checked.reply }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(usage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
