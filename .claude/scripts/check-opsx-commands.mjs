#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Adaptations that `openspec update` deletes. Each is a literal substring of the
// command file that carries it. Keep this list in step with the commands.
//
// What qualifies as a marker: a string that is present in the adapted file AND
// provably absent from the stock template `openspec update` would write in its place.
// Both halves are required. A string the regenerated file also contains reports the
// adaptation present after it is gone — false comfort, which is worse than no marker,
// because the check exits 0 over a surface that has lost what the marker stood for.
// Prefer strings only the adaptation could have produced: a project path, a project
// script, a commit message this project writes, a shell variable this project
// introduced. Avoid generic workflow vocabulary the stock template also uses.
//
// How to check a candidate against the installed CLI before adding it here:
//
//   t="$(npm root -g)/@fission-ai/openspec/dist/core/templates/workflows"
//   grep -cF '<candidate>' .claude/commands/opsx/<command>.md   # must be >= 1
//   grep -cF '<candidate>' "$t/<template>.js"                   # must be 0
//
// The template file per command is: propose.md -> propose.js, apply.md ->
// apply-change.js, verify.md -> verify-change.js, archive.md -> archive-change.js,
// sync.md -> sync-specs.js. review.md has no stock template — `openspec update`
// does not regenerate it, it removes it, and every marker below then reports missing.
// If the second count is not 0, the candidate is not a marker — pick another string
// from the same adaptation.
export const MARKERS = {
  '.claude/commands/opsx/propose.md': [
    'check-superpowers.mjs',
    'git worktree add',
    'origin/develop',
    'check-english.mjs',
    'docs(openspec): propose'
  ],
  '.claude/commands/opsx/apply.md': [
    'check-superpowers.mjs',
    'npm ci',
    'rev-parse --show-toplevel',
    'subagent-driven-development'
  ],
  '.claude/commands/opsx/verify.md': [
    'check-superpowers.mjs',
    'instructions verify',
    'rev-parse --show-toplevel',
    '<changeRoot>/verify.md'
  ],
  '.claude/commands/opsx/archive.md': [
    'git worktree remove',
    'rev-parse --show-toplevel',
    '$repo_root/openspec/specs',
    '.claude/memory'
  ],
  '.claude/commands/opsx/sync.md': [
    'read-only preview',
    'Do not create, edit or delete any file',
    'Nothing was written'
  ],
  '.claude/commands/opsx/review.md': [
    'check-superpowers.mjs',
    'instructions review',
    'ai-code-review',
    '<changeRoot>/review.md'
  ]
}

export const RECOVERY =
  'The opsx commands have lost their project adaptations, which is what `openspec update` does to them.\n' +
  'That command is prohibited in this project. Restore the files from git yourself — the workflow will not do it for you.'

export function checkCommands({ read }) {
  const missing = []
  for (const [file, markers] of Object.entries(MARKERS)) {
    let text
    try {
      text = read(file)
    } catch {
      for (const marker of markers) missing.push({ file, marker })
      continue
    }
    for (const marker of markers) {
      if (!text.includes(marker)) missing.push({ file, marker })
    }
  }
  return { ok: missing.length === 0, missing }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const { ok, missing } = checkCommands({ read: (f) => readFileSync(f, 'utf8') })
  if (!ok) {
    console.error('STOP: the opsx command surface has been regenerated.')
    for (const { file, marker } of missing) console.error(`  ${file}: missing ${marker}`)
    console.error(RECOVERY)
    process.exit(1)
  }
}
