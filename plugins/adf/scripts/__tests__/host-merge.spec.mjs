// The host files' three versions (lib/host-merge.mjs): listing them from two clones, classifying
// each and merging an edited file. The flow's settings are no host file (#23).
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { classify, hostFiles, mergeKeep } from '../lib/host-merge.mjs'

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

test('hostFiles reads each plugin declaration from both clones, and no core file', () => {
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
    { path: '.gitlab/mr.md', base: 'm1\n', theirs: 'm2\n' },
  ])
  assert.deepEqual(hostFiles(oldClone, newClone, {}), [])
})

test('mergeKeep throws on a git error instead of reporting conflicts', () => {
  const failing = () => {
    throw Object.assign(new Error('failed'), { status: 255, stdout: Buffer.from(''), stderr: Buffer.from('Could not stat') })
  }
  assert.throws(() => mergeKeep('a\n', 'b\n', 'c\n', failing), /Could not stat/)
})

test('hostFiles names a malformed extension declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-hf-'))
  put(join(root, 'old'), 'plugins/adf-gitlab/adf-extension.json', '{')
  assert.throws(
    () => hostFiles(join(root, 'old'), join(root, 'new'), { extensions: [{ plugin: 'adf-gitlab@agentic-dev-flow' }] }),
    /adf-extension\.json is not valid JSON/
  )
})

