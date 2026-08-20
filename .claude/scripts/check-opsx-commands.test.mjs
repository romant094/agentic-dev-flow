import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { checkCommands, MARKERS } from './check-opsx-commands.mjs'

const intact = {
  '.claude/commands/opsx/propose.md':
    'check-superpowers.mjs git worktree add origin/develop check-english.mjs docs(openspec): propose',
  '.claude/commands/opsx/apply.md':
    'check-superpowers.mjs npm ci rev-parse --show-toplevel subagent-driven-development',
  '.claude/commands/opsx/verify.md':
    'check-superpowers.mjs instructions verify rev-parse --show-toplevel <changeRoot>/verify.md',
  '.claude/commands/opsx/archive.md':
    'git worktree remove rev-parse --show-toplevel $repo_root/openspec/specs .claude/memory',
  '.claude/commands/opsx/sync.md': 'read-only preview Do not create, edit or delete any file Nothing was written',
  '.claude/commands/opsx/review.md': 'check-superpowers.mjs instructions review ai-code-review <changeRoot>/review.md'
}

test('passes when every marker is present', () => {
  const r = checkCommands({ read: (f) => intact[f] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
})

test('reports the file and marker that vanished', () => {
  const gutted = {
    ...intact,
    '.claude/commands/opsx/propose.md': 'git worktree add origin/develop check-english.mjs docs(openspec): propose'
  }
  const r = checkCommands({ read: (f) => gutted[f] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, [{ file: '.claude/commands/opsx/propose.md', marker: 'check-superpowers.mjs' }])
})

test('reports every missing marker, not just the first', () => {
  const r = checkCommands({ read: () => '' })
  assert.equal(r.ok, false)
  assert.equal(r.missing.length, Object.values(MARKERS).flat().length)
})

test('an unreadable command file counts as fully missing', () => {
  const r = checkCommands({
    read: (f) => {
      if (f.endsWith('archive.md')) throw new Error('ENOENT')
      return intact[f]
    }
  })
  assert.equal(r.ok, false)
  assert.ok(r.missing.some((m) => m.file.endsWith('archive.md')))
})

test('the review command is guarded', () => {
  assert.ok(
    MARKERS['.claude/commands/opsx/review.md'],
    'review.md must be covered by MARKERS — openspec update deletes files it has no template for'
  )
})

test('a deleted review command is reported', () => {
  const { ok, missing } = checkCommands({
    read: (f) => {
      if (f === '.claude/commands/opsx/review.md') throw new Error('ENOENT')
      return MARKERS[f].join(' ')
    }
  })
  assert.equal(ok, false)
  assert.ok(
    missing.every((m) => m.file === '.claude/commands/opsx/review.md'),
    'only the missing file should be reported'
  )
  assert.equal(missing.length, MARKERS['.claude/commands/opsx/review.md'].length)
})

test('every marker is present in the command file it names', () => {
  const r = checkCommands({ read: (f) => readFileSync(f, 'utf8') })
  assert.deepEqual(r.missing, [])
  assert.equal(r.ok, true)
})
