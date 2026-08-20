import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  arg,
  detectTool,
  ensureDraft,
  finalize,
  installHint,
  markerFor,
  mergeDescription,
  parseBody,
  protectedBranchRefusal,
  pushArgs
} from './mr.mjs'

// Import only what this step's GREEN defines. A named import of an export that does not
// exist yet is an ESM link-time error, which fails every test in the file rather than the
// one under construction — extend this import in Steps 4 and 6, not now.

const runner = (results) => (cmd, args) => results[`${cmd} ${args.join(' ')}`] ?? { ok: false, stdout: '' }

test('installHint names Homebrew on macOS and Linux', () => {
  assert.match(installHint('darwin'), /brew install glab/)
  assert.match(installHint('linux'), /brew install glab/)
})

test('installHint names a Windows-specific route', () => {
  const hint = installHint('win32')
  assert.match(hint, /winget|WSL/)
})

test('detectTool reports missing when the binary is absent', () => {
  const run = runner({})
  const r = detectTool({ run, platform: 'darwin' })
  assert.equal(r.state, 'missing')
  assert.match(r.message, /brew install glab/)
})

test('detectTool reports unauthenticated when auth status fails', () => {
  const run = runner({ 'which glab': { ok: true, stdout: '/opt/homebrew/bin/glab' } })
  const r = detectTool({ run, platform: 'darwin' })
  assert.equal(r.state, 'unauthenticated')
  assert.match(r.message, /glab auth login --hostname /)
})

test('detectTool reports ready when both succeed', () => {
  const run = runner({
    'which glab': { ok: true, stdout: '/opt/homebrew/bin/glab' },
    'glab auth status': { ok: true, stdout: 'Logged in' }
  })
  assert.equal(detectTool({ run, platform: 'darwin' }).state, 'ready')
})

test('pushArgs pushes only the current branch, never forced', () => {
  const args = pushArgs('feat/PROJ-123/ai-flow-upgrade')
  assert.deepEqual(args, ['push', '--set-upstream', 'origin', 'feat/PROJ-123/ai-flow-upgrade'])
  assert.equal(args.includes('--force'), false)
  assert.equal(args.includes('-f'), false)
  assert.equal(args.includes('develop'), false)
})

const good = `## What
- did a thing

## Why
because.

## QA
1. open the page
`

test('parseBody accepts all three sections filled', () => {
  const r = parseBody(good)
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.empty, [])
})

test('parseBody names a missing section', () => {
  const r = parseBody('## What\n- x\n\n## Why\ny\n')
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['QA'])
})

test('parseBody treats a comment-only section as empty', () => {
  const r = parseBody('## What\n- x\n\n## Why\n<!-- todo -->\n\n## QA\n1. y\n')
  assert.equal(r.ok, false)
  assert.deepEqual(r.empty, ['Why'])
})

test('markerFor builds a matched open/close pair', () => {
  assert.deepEqual(markerFor('my-change'), {
    open: '<!-- opsx:my-change -->',
    close: '<!-- /opsx:my-change -->'
  })
})

test('mergeDescription appends when the marker is absent', () => {
  const out = mergeDescription('Written by a human.', 'other-change', 'BLOCK')
  assert.match(out, /Written by a human\./)
  assert.match(out, /<!-- opsx:other-change -->\nBLOCK\n<!-- \/opsx:other-change -->/)
})

test('mergeDescription replaces its own block and leaves a sibling block alone', () => {
  const existing = [
    '<!-- opsx:first -->',
    'FIRST',
    '<!-- /opsx:first -->',
    '<!-- opsx:second -->',
    'OLD',
    '<!-- /opsx:second -->'
  ].join('\n')
  const out = mergeDescription(existing, 'second', 'NEW')
  assert.match(out, /<!-- opsx:first -->\nFIRST\n<!-- \/opsx:first -->/)
  assert.match(out, /<!-- opsx:second -->\nNEW\n<!-- \/opsx:second -->/)
  assert.equal(out.includes('OLD'), false)
})

test('mergeDescription preserves prose written outside every marker', () => {
  const existing = 'Please read the ticket first.\n\n<!-- opsx:a -->\nA\n<!-- /opsx:a -->'
  const out = mergeDescription(existing, 'a', 'A2')
  assert.match(out, /Please read the ticket first\./)
})

test('mergeDescription refuses an unclosed marker rather than guessing', () => {
  assert.throws(() => mergeDescription('<!-- opsx:a -->\nA', 'a', 'A2'), /unclosed/i)
})

// Records every call as "cmd arg1 arg2 ..." and answers with the first handler whose
// prefix matches, so tests can assert on ordering as well as on which calls happened.
const record = (handlers) => {
  const calls = []
  const run = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    const hit = handlers.find(([prefix]) => key.startsWith(prefix))
    return hit ? hit[1] : { ok: false, stdout: '' }
  }
  return { run, calls }
}

const ready = [
  ['which glab', { ok: true, stdout: '/opt/homebrew/bin/glab' }],
  ['glab auth status', { ok: true, stdout: 'Logged in' }],
  ['git rev-parse', { ok: true, stdout: 'feat/PROJ-123/ai-flow-upgrade\n' }]
]

test('finalize updates the merge request to ready before pushing', () => {
  const { run, calls } = record([
    ...ready,
    ['glab mr view', { ok: true, stdout: JSON.stringify({ description: '' }) }],
    ['glab mr update', { ok: true, stdout: '' }],
    ['git push', { ok: true, stdout: '' }]
  ])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 0)
  const updateIndex = calls.findIndex((c) => c.startsWith('glab mr update'))
  const pushIndex = calls.findIndex((c) => c.startsWith('git push'))
  assert.notEqual(updateIndex, -1)
  assert.notEqual(pushIndex, -1)
  assert.ok(updateIndex < pushIndex, 'ready must be set before the push, or the AI review never runs')
})

test('finalize reports the half-applied state when the push fails after undraft succeeds', () => {
  const { run, calls } = record([
    ...ready,
    ['glab mr view', { ok: true, stdout: JSON.stringify({ description: '' }) }],
    ['glab mr update', { ok: true, stdout: '' }],
    ['git push', { ok: false, stdout: '' }]
  ])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 1)
  assert.ok(
    calls.some((c) => c.startsWith('glab mr update')),
    'the merge request must have been taken out of draft before the push was attempted'
  )
})

test('finalize with a body missing a section sends nothing', () => {
  const { run, calls } = record(ready)
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => '## What\n- x\n\n## Why\ny\n'
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('finalize does not push when glab is absent', () => {
  const { run, calls } = record([['git rev-parse', { ok: true, stdout: 'feat/x\n' }]])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 0)
  assert.equal(
    calls.some((c) => c.startsWith('git push')),
    false
  )
})

test('ensureDraft exits clean when glab is absent', () => {
  const { run } = record([['git rev-parse', { ok: true, stdout: 'feat/x\n' }]])
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  assert.equal(code, 0)
})

test('ensureDraft reuses an existing open merge request instead of creating one', () => {
  const { run, calls } = record([
    ...ready,
    ['git push', { ok: true, stdout: '' }],
    ['glab mr list', { ok: true, stdout: '[{"iid":1}]' }]
  ])
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  assert.equal(code, 0)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr create')),
    false
  )
})

test('ensureDraft refuses non-JSON on the merge request list instead of reading it as "one exists"', () => {
  const { run, calls } = record([
    ...ready,
    ['git push', { ok: true, stdout: '' }],
    ['glab mr list', { ok: true, stdout: 'warning: a new version of glab is available\n' }]
  ])
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  assert.equal(code, 1)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr create')),
    false
  )
})

test('ensureDraft refuses when the merge request list call itself fails', () => {
  const { run, calls } = record([
    ...ready,
    ['git push', { ok: true, stdout: '' }],
    ['glab mr list', { ok: false, stdout: '' }]
  ])
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  assert.equal(code, 1)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr create')),
    false
  )
})

test('ensureDraft names the change in the placeholder description', () => {
  const { run, calls } = record([
    ...ready,
    ['git push', { ok: true, stdout: '' }],
    ['glab mr list', { ok: true, stdout: '[]' }],
    ['glab mr create', { ok: true, stdout: '' }]
  ])
  ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  const created = calls.find((c) => c.startsWith('glab mr create'))
  assert.match(created, /my-change/)
})

const onProtected = (branch) => [
  ['git rev-parse', { ok: true, stdout: `${branch}\n` }],
  ['which glab', { ok: true, stdout: '/opt/homebrew/bin/glab' }],
  ['glab auth status', { ok: true, stdout: 'Logged in' }],
  ['glab', { ok: true, stdout: '{}' }],
  ['git push', { ok: true, stdout: '' }]
]

const touchedTheForge = (calls) => calls.some((c) => c.startsWith('glab') || c.startsWith('which glab'))

test('protectedBranchRefusal names the branch it refuses, and passes a change branch', () => {
  assert.match(protectedBranchRefusal('develop'), /develop/)
  assert.match(protectedBranchRefusal('main'), /main/)
  assert.equal(protectedBranchRefusal('feat/PROJ-123/ai-flow-upgrade'), null)
})

for (const branch of ['develop', 'main']) {
  test(`finalize refuses on ${branch} without pushing or calling glab`, () => {
    const { run, calls } = record(onProtected(branch))
    const code = finalize({
      run,
      platform: 'darwin',
      argv: ['--body-file', 'body.md', '--change', 'my-change'],
      read: () => good
    })
    assert.equal(code, 1)
    assert.equal(
      calls.some((c) => c.startsWith('git push')),
      false
    )
    assert.equal(touchedTheForge(calls), false)
  })

  test(`ensureDraft refuses on ${branch} without pushing or calling glab`, () => {
    const { run, calls } = record(onProtected(branch))
    const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
    assert.equal(code, 1)
    assert.equal(
      calls.some((c) => c.startsWith('git push')),
      false
    )
    assert.equal(touchedTheForge(calls), false)
  })
}

test('finalize fails loudly when the existing description cannot be read as JSON', () => {
  const { run, calls } = record([
    ...ready,
    ['glab mr view', { ok: true, stdout: 'A new version of glab is available\n' }],
    ['glab mr update', { ok: true, stdout: '' }],
    ['git push', { ok: true, stdout: '' }]
  ])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 1)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr update')),
    false
  )
  assert.equal(
    calls.some((c) => c.startsWith('git push')),
    false
  )
})

test('finalize fails loudly when the existing description read itself fails', () => {
  const { run, calls } = record([
    ...ready,
    ['glab mr view', { ok: false, stdout: '' }],
    ['glab mr update', { ok: true, stdout: '' }],
    ['git push', { ok: true, stdout: '' }]
  ])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 1)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr update')),
    false
  )
  assert.equal(
    calls.some((c) => c.startsWith('git push')),
    false
  )
})

test('finalize treats a valid JSON description of null as genuinely empty, not an error', () => {
  const { run, calls } = record([
    ...ready,
    ['glab mr view', { ok: true, stdout: JSON.stringify({ description: null }) }],
    ['glab mr update', { ok: true, stdout: '' }],
    ['git push', { ok: true, stdout: '' }]
  ])
  const code = finalize({
    run,
    platform: 'darwin',
    argv: ['--body-file', 'body.md', '--change', 'my-change'],
    read: () => good
  })
  assert.equal(code, 0)
  assert.equal(
    calls.some((c) => c.startsWith('glab mr update')),
    true
  )
})

test("ensureDraft's degraded fallback names the branch and the push the create depends on", () => {
  const lines = []
  const log = console.log
  console.log = (line) => lines.push(line)
  try {
    const { run } = record([['git rev-parse', { ok: true, stdout: 'feat/x\n' }]])
    ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
  } finally {
    console.log = log
  }
  const printed = lines.join('\n')
  assert.match(printed, /feat\/x/)
  assert.match(printed, /git push --set-upstream origin feat\/x && glab mr create --draft/)
})

for (const [label, gitRevParse] of [
  ['git rev-parse fails', { ok: false, stdout: '' }],
  ['detached HEAD', { ok: true, stdout: 'HEAD\n' }]
]) {
  test(`finalize refuses when ${label}, without pushing or calling glab`, () => {
    const { run, calls } = record([['git rev-parse', gitRevParse]])
    const code = finalize({
      run,
      platform: 'darwin',
      argv: ['--body-file', 'body.md', '--change', 'my-change'],
      read: () => good
    })
    assert.equal(code, 1)
    assert.equal(
      calls.some((c) => c.startsWith('git push')),
      false
    )
    assert.equal(touchedTheForge(calls), false)
  })

  test(`ensureDraft refuses when ${label}, without pushing or calling glab`, () => {
    const { run, calls } = record([['git rev-parse', gitRevParse]])
    const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't', '--change', 'my-change'] })
    assert.equal(code, 1)
    assert.equal(
      calls.some((c) => c.startsWith('git push')),
      false
    )
    assert.equal(touchedTheForge(calls), false)
  })
}

test('ensureDraft requires --title, before any push or glab call', () => {
  const { run, calls } = record(ready)
  const readSpy = () => assert.fail('should not read a file')
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--change', 'my-change'], read: readSpy })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('ensureDraft requires --change, before any push or glab call', () => {
  const { run, calls } = record(ready)
  const code = ensureDraft({ run, platform: 'darwin', argv: ['--title', 't'] })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('finalize requires --body-file, before reading the body or touching the forge', () => {
  const { run, calls } = record(ready)
  const readSpy = () => assert.fail('should not read a file')
  const code = finalize({ run, platform: 'darwin', argv: ['--change', 'my-change'], read: readSpy })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('finalize requires --change, before reading the body or touching the forge', () => {
  const { run, calls } = record(ready)
  const readSpy = () => assert.fail('should not read a file')
  const code = finalize({ run, platform: 'darwin', argv: ['--body-file', 'body.md'], read: readSpy })
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('arg rejects a missing value and a value that is really the next flag', () => {
  assert.throws(() => arg(['--change'], 'change'), /--change needs a value/)
  assert.throws(() => arg(['--title', '--change', 'x'], 'title'), /--title needs a value/)
  assert.equal(arg(['--change', 'x'], 'change'), 'x')
  assert.equal(arg(['--title', 't'], 'change'), null)
})
