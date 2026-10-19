// The `spec-merge <capability>` dispatch at archive: an agent adjudicates the conflicts the
// three-way check of lib/specs.mjs found in one capability, and replies; it writes no file. The
// script writes the three texts of each conflict for the agent to read by path, checks the reply
// against `schema/spec-merge-resolution.schema.json` and against the conflicts, and the merge
// applies the reply as `--resolutions`. A refused reply goes back once (`dispatch.mjs attempt`:
// the second attempt is the retry); a second refused reply stops archive.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sddDir } from './dispatch.mjs'
import { parseReply, readSchema, validateJson } from './review.mjs'
import { checkResolutions, normalizeRequirementName } from './specs.mjs'

export const SPEC_MERGE_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'spec-merge-resolution.schema.json')

export const conflictDir = (root, change, capability) => join(sddDir(root, change), 'spec-merge', capability)

// Writes the base, current and delta texts of every conflict of one capability under
// conflictDir, numbered in order, and returns each conflict with the paths in place of the
// texts: { requirement, operation, to?, side, base, current, delta }. A text that is null (the
// requirement is absent there) stays null and gets no file.
export function writeConflictTexts(root, change, capability, conflicts) {
  const dir = conflictDir(root, change, capability)
  mkdirSync(dir, { recursive: true })
  return conflicts.map((c, i) => {
    const out = { requirement: c.requirement, operation: c.operation, ...(c.to ? { to: c.to } : {}), side: c.side }
    for (const which of ['base', 'current', 'delta']) {
      if (c[which] === null || c[which] === undefined) {
        out[which] = null
        continue
      }
      const path = join(dir, `${i + 1}-${which}.md`)
      writeFileSync(path, `${c[which].replace(/\n*$/, '')}\n`)
      out[which] = path
    }
    return out
  })
}

// The agent's reply: { valid, errors, fenced, reply }. Valid under the schema, under
// checkResolutions, every resolution of `capability`, and, when `conflicts` is given (the
// capability's unresolved conflicts, each with `requirement`), exactly one resolution per
// conflict and none for a requirement that is not in conflict.
export function checkSpecMergeReply(text, { capability, conflicts, schema = readSchema(SPEC_MERGE_SCHEMA_PATH) } = {}) {
  const parsed = parseReply(text)
  if (parsed.errors.length > 0) return { valid: false, ...parsed }
  const errors = validateJson(schema, parsed.reply)
  if (errors.length === 0) {
    try {
      checkResolutions(parsed.reply)
    } catch (error) {
      errors.push(`$: ${error.message}`)
    }
  }
  if (errors.length === 0) {
    const key = normalizeRequirementName
    parsed.reply.forEach((r, i) => {
      if (capability !== undefined && r.capability !== capability) errors.push(`$[${i}]: capability "${r.capability}" is not the dispatched ${capability}`)
    })
    if (conflicts) {
      const wanted = new Set(conflicts.map((c) => key(c.requirement)))
      const answered = new Set(parsed.reply.map((r) => key(r.requirement)))
      parsed.reply.forEach((r, i) => {
        if (!wanted.has(key(r.requirement))) errors.push(`$[${i}]: "${r.requirement}" is not a conflict of ${capability}`)
      })
      for (const name of wanted) if (!answered.has(name)) errors.push(`$: the conflict "${name}" has no resolution`)
    }
  }
  return { valid: errors.length === 0, ...parsed, errors }
}
