// The host files' three versions (lib/host-merge.mjs): listing them from two clones, classifying
// each, keeping the project's managed sections and merging an edited file.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { MANAGED, classify, hostFiles, keepFromUpdate, mergeKeep, replaceFromUpdate } from '../lib/host-merge.mjs'

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

test('an unedited file is replace', () => {
  assert.equal(classify({ base: 'a\n', ours: 'a\n', theirs: 'b\n' }), 'replace')
  assert.equal(classify({ base: 'a\n', ours: 'x\n', theirs: 'b\n' }), 'edited')
  assert.equal(classify({ base: 'a\n', ours: 'b\n', theirs: 'b\n' }), 'same')
  assert.equal(classify({ base: 'a\n', ours: null, theirs: 'b\n' }), 'new')
  assert.equal(classify({ base: 'a\n', ours: 'a\n', theirs: null }), 'absent')
})

test('an unchanged template is kept, whatever the project did', () => {
  assert.equal(classify({ base: 'a\n', ours: 'filled\n', theirs: 'a\n' }), 'kept')
})

test('a null base never matches', () => {
  assert.equal(classify({ base: null, ours: 'x\n', theirs: 'b\n' }), 'edited')
})

test('replace keeps the managed sections', () => {
  const ours = '# Guide\n\n## Whole-suite command\n\nnpm run mine\n\n## Other\n\nold\n'
  const theirs = '# Guide\n\n## Whole-suite command\n\nTODO\n\n## Other\n\nnew\n'
  const text = replaceFromUpdate('openspec/planning.md', ours, theirs)
  assert.equal(text, '# Guide\n\n## Whole-suite command\n\nnpm run mine\n\n## Other\n\nnew\n')
  assert.equal(replaceFromUpdate('openspec/review-prompt.md', ours, theirs), theirs)
})

test('replace appends a managed section the new template lacks', () => {
  const ours = '## Format command\n\nnpm run fmt\n'
  const text = replaceFromUpdate('openspec/planning.md', ours, '# Guide\n\n## Other\n\nnew\n')
  assert.equal(text, '# Guide\n\n## Other\n\nnew\n\n## Format command\n\nnpm run fmt\n')
  assert.equal(MANAGED.length, 4)
})

test('mergeKeep carries a template change and keeps a project edit', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n'
  const ours = 'one\ntwo\nthree\nfour\nmine\n'
  const theirs = 'new\ntwo\nthree\nfour\nfive\n'
  assert.deepEqual(mergeKeep(base, ours, theirs), { text: 'new\ntwo\nthree\nfour\nmine\n', conflicts: false })
})

test('mergeKeep reports conflicts on the same line', () => {
  const result = mergeKeep('a\n', 'mine\n', 'theirs\n')
  assert.equal(result.conflicts, true)
  assert.match(result.text, /<<<<<<< /)
  assert.match(result.text, /mine/)
  assert.match(result.text, /theirs/)
})

test('mergeKeep treats a null base as empty', () => {
  assert.equal(mergeKeep(null, 'x\n', 'x\n').conflicts, false)
})

test('hostFiles reads the core files and each plugin declaration from both clones', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-hf-'))
  const [oldClone, newClone] = [join(root, 'old'), join(root, 'new')]
  put(oldClone, 'plugins/adf/host/planning.md', 'p1\n')
  put(newClone, 'plugins/adf/host/planning.md', 'p2\n')
  put(newClone, 'plugins/adf/host/review-prompt.md', 'r2\n')
  const declaration = JSON.stringify({ hostFiles: [{ from: 'templates/mr.md', to: '.gitlab/mr.md' }] })
  put(oldClone, 'plugins/adf-gitlab/adf-extension.json', declaration)
  put(newClone, 'plugins/adf-gitlab/adf-extension.json', declaration)
  put(oldClone, 'plugins/adf-gitlab/templates/mr.md', 'm1\n')
  put(newClone, 'plugins/adf-gitlab/templates/mr.md', 'm2\n')
  const registry = {
    review: { prompt: 'docs/review.md' },
    extensions: [{ plugin: 'adf-gitlab@agentic-dev-flow' }, { plugin: 'other@elsewhere' }, { path: 'local' }],
  }
  assert.deepEqual(hostFiles(oldClone, newClone, registry), [
    { path: 'openspec/planning.md', base: 'p1\n', theirs: 'p2\n' },
    { path: 'docs/review.md', base: null, theirs: 'r2\n' },
    { path: '.gitlab/mr.md', base: 'm1\n', theirs: 'm2\n' },
  ])
  assert.equal(hostFiles(oldClone, newClone, {})[1].path, 'openspec/review-prompt.md')
})

test('mergeKeep throws on a git error instead of reporting conflicts', () => {
  const failing = () => {
    throw Object.assign(new Error('failed'), { status: 255, stdout: Buffer.from(''), stderr: Buffer.from('Could not stat') })
  }
  assert.throws(() => mergeKeep('a\n', 'b\n', 'c\n', failing), /Could not stat/)
})

test('replace carries a managed section from the middle of ours to the end of theirs', () => {
  const ours = '## Format command\n\nnpm run fmt\n\n## Other\n\nold\n'
  const theirs = '## Other\n\nnew\n\n## Format command\n\nTODO\n'
  assert.equal(
    replaceFromUpdate('openspec/planning.md', ours, theirs),
    '## Other\n\nnew\n\n## Format command\n\nnpm run fmt\n'
  )
})

test('hostFiles names a malformed extension declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-hf-'))
  put(join(root, 'old'), 'plugins/adf-gitlab/adf-extension.json', '{')
  assert.throws(
    () => hostFiles(join(root, 'old'), join(root, 'new'), { extensions: [{ plugin: 'adf-gitlab@agentic-dev-flow' }] }),
    /adf-extension\.json is not valid JSON/
  )
})

test('planning.md whose only edits are its managed sections is replace, and replace keeps them', () => {
  const base = '# Guide\n\nintro A\n\n## Whole-suite command\n\nTODO\n\n## Other\n\nold\n'
  const ours = '# Guide\n\nintro A\n\n## Whole-suite command\n\nnpm test\n\n## Other\n\nold\n\n## Format command\n\nnpm run fmt\n'
  const theirs = '# Guide\n\nintro B\n\n## Whole-suite command\n\nTODO\n\n## Other\n\nold\n'
  const path = 'openspec/planning.md'
  assert.equal(classify({ base, ours, theirs, path }), 'replace')
  assert.equal(classify({ base, ours, theirs }), 'edited')
  assert.equal(classify({ base, ours: ours.replace('old', 'mine'), theirs: base, path }), 'kept')
  assert.equal(classify({ base, ours: theirs.replace('TODO', 'npm test'), theirs, path }), 'same')
  assert.equal(replaceFromUpdate(path, ours, theirs), '# Guide\n\nintro B\n\n## Whole-suite command\n\nnpm test\n\n## Other\n\nold\n\n## Format command\n\nnpm run fmt\n')
})

test('keep on planning.md merges the rest and keeps the managed values, also where the template changed them', () => {
  const path = 'openspec/planning.md'
  const base = '# Guide\n\nintro A\n\n## Whole-suite command\n\nTODO\n\n## Other\n\none\ntwo\nthree\nfour\n'
  const ours = '# Guide\n\nintro A\n\n## Whole-suite command\n\nnpm test\n\n## Other\n\none\ntwo\nthree\nmine\n'
  const theirs = '# Guide\n\nintro B\n\n## Whole-suite command\n\nTODO: set it\n\n## Other\n\none\ntwo\nthree\nfour\n'
  assert.equal(classify({ base, ours, theirs, path }), 'edited')
  assert.deepEqual(keepFromUpdate(path, base, ours, theirs), {
    text: '# Guide\n\nintro B\n\n## Whole-suite command\n\nnpm test\n\n## Other\n\none\ntwo\nthree\nmine\n',
    conflicts: false
  })
  assert.deepEqual(keepFromUpdate('openspec/review-prompt.md', 'a\n', 'a\n', 'b\n'), { text: 'b\n', conflicts: false })
})
