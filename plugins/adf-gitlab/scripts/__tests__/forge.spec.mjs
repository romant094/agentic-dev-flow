import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOST_TEMPLATE,
  detectTool,
  hostFromRemote,
  installHint,
  loginHint,
  markerFor,
  mergeDescription,
  parseBody,
  placeholder,
  pushArgs,
  readTemplate,
  runOperation,
  templateSections
} from '../lib/forge.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', '..')
const cli = join(pluginDir, 'scripts', 'forge.mjs')
const ROOT = '/work/host'
const REQUIRED = ['What', 'Why', 'QA']

// Records every call as "cmd arg1 arg2 ..." and answers with the first handler whose prefix
// matches, so a test can assert on the order as well as on which calls happened.
const record = (handlers) => {
  const calls = []
  const run = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    const hit = handlers.find(([prefix]) => key.startsWith(prefix))
    return hit ? hit[1] : { status: 1, stdout: '', stderr: 'no handler' }
  }
  return { run, calls }
}
const yes = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const no = (stderr = 'failed') => ({ status: 1, stdout: '', stderr })

const ready = [
  ['glab --version', yes('glab 1.113.0')],
  ['glab auth status', yes('Logged in')]
]
const mrList = (items) => ['glab mr list', yes(JSON.stringify(items))]
const existing = mrList([{ iid: 7, web_url: 'https://gitlab.example.com/g/p/-/merge_requests/7' }])

const saved = []
const fs = (files = {}) => ({
  exists: (path) => Object.hasOwn(files, path) || existsSync(path),
  readFile: (path) => files[path] ?? readFileSync(path, 'utf8'),
  saveInput: (payload) => {
    saved.push(payload)
    return '/tmp/adf-forge-x/finalize.json'
  }
})

const op = (operation, input, handlers, { config = { host: 'gitlab.example.com' }, platform = 'darwin', files } = {}) => {
  const { run, calls } = record(handlers)
  const { code, result } = runOperation(operation, { root: ROOT, config, input }, { run, platform, pluginDir, ...fs(files) })
  return { code, result, calls }
}

const good = '## What\n- did a thing\n\n## Why\nbecause.\n\n## QA\n1. open the page\n'
const openInput = { change: 'my-change', branch: 'feat/x', base: 'release/2', title: 't', protected: ['develop', 'main'] }
const finalInput = { ...openInput, body: good }
const touched = (calls) => calls.filter((c) => c.startsWith('git push') || c.startsWith('git -C') || c.startsWith('glab mr'))

// ---------------------------------------------------------------- tool check

test('installHint names Homebrew on macOS and Linux', () => {
  assert.match(installHint('darwin'), /brew install glab/)
  assert.match(installHint('linux'), /brew install glab/)
})

test('installHint names a Windows-specific route', () => {
  assert.match(installHint('win32'), /winget|WSL/)
})

test('check reports missing when the binary is absent', () => {
  const { code, result } = op('check', {}, [])
  assert.equal(code, 0)
  assert.equal(result.state, 'degraded')
  assert.equal(result.tool, 'missing')
  assert.match(result.hint, /brew install glab/)
})

test('check reports unauthenticated with a login hint for the configured host', () => {
  const { code, result } = op('check', {}, [['glab --version', yes()]])
  assert.equal(code, 0)
  assert.equal(result.tool, 'unauthenticated')
  assert.equal(result.hint, 'glab auth login --hostname gitlab.example.com')
})

test('the login hint falls back to the host of the origin remote', () => {
  const { result, calls } = op('check', {}, [['glab --version', yes()], ['git -C /work/host remote get-url origin', yes('git@git.corp.example:g/p.git\n')]], {
    config: {}
  })
  assert.equal(result.hint, 'glab auth login --hostname git.corp.example')
  assert.ok(calls.includes('git -C /work/host remote get-url origin'))
})

test('hostFromRemote reads ssh, scp-like and https remotes', () => {
  assert.equal(hostFromRemote('git@gitlab.example.com:g/p.git'), 'gitlab.example.com')
  assert.equal(hostFromRemote('ssh://git@gitlab.example.com:2222/g/p.git'), 'gitlab.example.com')
  assert.equal(hostFromRemote('https://gitlab.example.com/g/p.git'), 'gitlab.example.com')
  assert.equal(hostFromRemote('https://gitlab.example.com:8443/g/p.git'), 'gitlab.example.com:8443')
  assert.equal(hostFromRemote('/local/path'), null)
  assert.equal(loginHint(null), 'glab auth login')
})

test('check reports ready when both succeed', () => {
  const { code, result } = op('check', {}, ready)
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', tool: 'ready' })
})

test('detectTool never asks for the remote when the host is configured', () => {
  const { run, calls } = record([['glab --version', yes()]])
  detectTool({ run, root: ROOT, platform: 'darwin', config: { host: 'h' } })
  assert.deepEqual(calls, ['glab --version', 'glab auth status'])
})

test('pushArgs pushes only the given branch, never forced', () => {
  const args = pushArgs(ROOT, 'feat/x')
  assert.deepEqual(args, ['-C', ROOT, 'push', '--set-upstream', 'origin', 'feat/x'])
  assert.equal(args.includes('--force'), false)
  assert.equal(args.includes('-f'), false)
})

// ---------------------------------------------------------------- description

test('parseBody accepts all three sections filled', () => {
  const r = parseBody(good, REQUIRED)
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.empty, [])
})

test('parseBody names a missing section', () => {
  const r = parseBody('## What\n- x\n\n## Why\ny\n', REQUIRED)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['QA'])
})

test('parseBody treats a comment-only section as empty', () => {
  const r = parseBody('## What\n- x\n\n## Why\n<!-- todo -->\n\n## QA\n1. y\n', REQUIRED)
  assert.equal(r.ok, false)
  assert.deepEqual(r.empty, ['Why'])
})

test('markerFor builds a matched open/close pair', () => {
  assert.deepEqual(markerFor('my-change'), { open: '<!-- adf:my-change -->', close: '<!-- /adf:my-change -->' })
})

test('mergeDescription appends when the marker is absent', () => {
  const out = mergeDescription('Written by a human.', 'other-change', 'BLOCK')
  assert.match(out, /Written by a human\./)
  assert.match(out, /<!-- adf:other-change -->\nBLOCK\n<!-- \/adf:other-change -->/)
})

test('mergeDescription replaces its own block and leaves a sibling block alone', () => {
  const existingText = ['<!-- adf:first -->', 'FIRST', '<!-- /adf:first -->', '<!-- adf:second -->', 'OLD', '<!-- /adf:second -->'].join('\n')
  const out = mergeDescription(existingText, 'second', 'NEW')
  assert.match(out, /<!-- adf:first -->\nFIRST\n<!-- \/adf:first -->/)
  assert.match(out, /<!-- adf:second -->\nNEW\n<!-- \/adf:second -->/)
  assert.equal(out.includes('OLD'), false)
})

test('mergeDescription preserves prose written outside every marker', () => {
  const out = mergeDescription('Please read the ticket first.\n\n<!-- adf:a -->\nA\n<!-- /adf:a -->', 'a', 'A2')
  assert.match(out, /Please read the ticket first\./)
})

test('mergeDescription refuses an unclosed marker rather than guessing', () => {
  assert.throws(() => mergeDescription('<!-- adf:a -->\nA', 'a', 'A2'), /unclosed/i)
})

test('the placeholder sits inside the change marker and names no command', () => {
  const text = placeholder('my-change')
  assert.match(text, /^<!-- adf:my-change -->\n.*my-change.*\n<!-- \/adf:my-change -->\n$/)
  assert.equal(/\/\w+:\w+|opsx/.test(text.replace(/<!--[^>]*-->/g, '')), false)
  assert.equal(mergeDescription(text, 'my-change', 'FINAL').includes('Draft for change'), false)
})

// ---------------------------------------------------------------- template

test('the shipped template has exactly the sections the validator reads', () => {
  const tpl = readTemplate({ root: ROOT, pluginDir, exists: () => false, readFile: (p) => readFileSync(p, 'utf8') })
  assert.deepEqual(templateSections(tpl), REQUIRED)
  const { result } = op('finalize', { ...finalInput, body: '## What\n- x\n' }, ready)
  assert.match(result.error, /Missing: \[Why, QA\]/)
})

test('the template carries an adf marker pair for description scoping', () => {
  const tpl = readFileSync(join(pluginDir, 'templates', 'merge_request.md'), 'utf8')
  assert.match(tpl, /<!-- adf:/)
  assert.match(tpl, /<!-- \/adf:/)
})

test('the declaration installs the shipped template where the validator reads it', () => {
  const declaration = JSON.parse(readFileSync(join(pluginDir, 'adf-extension.json'), 'utf8'))
  assert.deepEqual(declaration.hostFiles, [{ from: 'templates/merge_request.md', to: HOST_TEMPLATE }])
  assert.deepEqual(declaration.provides.forge.operations, ['check', 'open', 'push', 'finalize'])
  assert.ok(existsSync(join(pluginDir, declaration.provides.forge.script)))
})

test("finalize validates against the host's installed template when there is one", () => {
  const files = { [join(ROOT, HOST_TEMPLATE)]: '## Summary\n\n## Testing\n' }
  const { code, result, calls } = op('finalize', finalInput, ready, { files })
  assert.equal(code, 1)
  assert.match(result.error, /Missing: \[Summary, Testing\]/)
  assert.deepEqual(calls, [])
})

// ---------------------------------------------------------------- open

test('open refuses when glab is absent: degraded, nothing pushed', () => {
  const { code, result, calls } = op('open', openInput, [])
  assert.equal(code, 0)
  assert.equal(result.state, 'degraded')
  assert.equal(touched(calls).length, 0)
})

test("open's degraded fallback names the push the create depends on, against the base", () => {
  const { result } = op('open', openInput, [])
  assert.equal(result.fallback[0], `cd '${ROOT}'`)
  assert.equal(result.fallback[1], "git push --set-upstream origin 'feat/x'")
  assert.match(result.fallback[2], /^glab mr create --draft --source-branch 'feat\/x' --target-branch 'release\/2' --squash-before-merge --remove-source-branch --title 't'/)
  assert.equal(result.fallback.join(' ').includes('develop'), false)
})

test('open pushes, then creates a Draft against the base with squash and source-branch removal', () => {
  const { code, result, calls } = op('open', openInput, [
    ...ready,
    ['git -C /work/host push', yes()],
    mrList([]),
    ['glab mr create', yes('Creating merge request...\nhttps://gitlab.example.com/g/p/-/merge_requests/12\n')]
  ])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', number: 12, url: 'https://gitlab.example.com/g/p/-/merge_requests/12', reused: false })
  assert.deepEqual(touched(calls).slice(0, 2), ['git -C /work/host push --set-upstream origin feat/x', 'glab mr list --source-branch feat/x --output json'])
  const create = calls.find((c) => c.startsWith('glab mr create'))
  assert.match(create, /^glab mr create --draft --source-branch feat\/x --target-branch release\/2 --squash-before-merge --remove-source-branch --title t --description <!-- adf:my-change -->/)
})

test('open names the change in the placeholder description', () => {
  const { calls } = op('open', openInput, [...ready, ['git -C', yes()], mrList([]), ['glab mr create', yes()]])
  assert.match(calls.find((c) => c.startsWith('glab mr create')), /Draft for change my-change/)
})

test('open with draft false and options off creates a plain merge request', () => {
  const { calls } = op('open', { ...openInput, draft: false }, [...ready, ['git -C', yes()], mrList([]), ['glab mr create', yes()]], {
    config: { host: 'h', squash: false, removeSourceBranch: false }
  })
  const create = calls.find((c) => c.startsWith('glab mr create'))
  assert.equal(/--draft|--squash-before-merge|--remove-source-branch/.test(create), false)
})

test('open reuses an existing open merge request and reports it', () => {
  const { code, result, calls } = op('open', openInput, [...ready, ['git -C', yes()], existing])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', number: 7, url: 'https://gitlab.example.com/g/p/-/merge_requests/7', reused: true })
  assert.equal(calls.some((c) => c.startsWith('glab mr create')), false)
})

test('open refuses non-JSON on the merge request list instead of reading it as "one exists"', () => {
  const { code, result, calls } = op('open', openInput, [...ready, ['git -C', yes()], ['glab mr list', yes('warning: a new version of glab is available\n')]])
  assert.equal(code, 1)
  assert.equal(result.state, 'refused')
  assert.equal(calls.some((c) => c.startsWith('glab mr create')), false)
})

test('open refuses when the merge request list call itself fails', () => {
  const { code, calls } = op('open', openInput, [...ready, ['git -C', yes()], ['glab mr list', no()]])
  assert.equal(code, 1)
  assert.equal(calls.some((c) => c.startsWith('glab mr create')), false)
})

test('open stops before any merge request call when the push fails', () => {
  const { code, result, calls } = op('open', openInput, [...ready, ['git -C', no()]])
  assert.equal(code, 1)
  assert.match(result.error, /no merge request was touched/)
  assert.equal(calls.some((c) => c.startsWith('glab mr')), false)
})

test('open refuses with the tool output when the create fails', () => {
  const { code, result } = op('open', openInput, [...ready, ['git -C', yes()], mrList([]), ['glab mr create', no('403 Forbidden')]])
  assert.equal(code, 1)
  assert.match(result.error, /403 Forbidden/)
})

for (const field of ['change', 'branch', 'base', 'title']) {
  test(`open requires ${field}, before any push or glab call`, () => {
    for (const value of [undefined, '', '  ']) {
      const { code, result, calls } = op('open', { ...openInput, [field]: value }, ready)
      assert.equal(code, 1)
      assert.match(result.error, new RegExp(`input.${field} is required; nothing was pushed`))
      assert.deepEqual(calls, [])
    }
  })
}

test('open requires the protected list and a boolean draft', () => {
  assert.equal(op('open', { ...openInput, protected: undefined }, ready).code, 1)
  assert.equal(op('open', { ...openInput, draft: 'yes' }, ready).code, 1)
})

for (const branch of ['develop', 'main']) {
  for (const operation of ['open', 'finalize']) {
    test(`${operation} refuses on ${branch} without pushing or calling glab`, () => {
      const { code, result, calls } = op(operation, { ...finalInput, branch }, ready)
      assert.equal(code, 1)
      assert.match(result.error, new RegExp(branch))
      assert.deepEqual(calls, [])
    })
  }
}

// ---------------------------------------------------------------- finalize

const viewOf = (description) => ['glab mr view', yes(JSON.stringify({ iid: 7, web_url: 'https://gitlab.example.com/g/p/-/merge_requests/7', description }))]

test('finalize updates the merge request to ready before pushing', () => {
  const { code, result, calls } = op('finalize', finalInput, [...ready, existing, viewOf(''), ['glab mr update', yes()], ['git -C', yes()]])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', number: 7, url: 'https://gitlab.example.com/g/p/-/merge_requests/7', created: false })
  const update = calls.findIndex((c) => c.startsWith('glab mr update feat/x --ready --description'))
  const push = calls.findIndex((c) => c.startsWith('git -C /work/host push'))
  assert.ok(update !== -1 && push > update, 'ready must be set before the push, or the CI review never runs')
})

test('finalize replaces the placeholder and keeps the other blocks and prose', () => {
  const other = '<!-- adf:other -->\nOTHER\n<!-- /adf:other -->'
  const { calls } = op('finalize', finalInput, [...ready, existing, viewOf(`Prose.\n\n${other}\n\n${placeholder('my-change')}`), ['glab mr update', yes()], ['git -C', yes()]])
  const update = calls.find((c) => c.startsWith('glab mr update'))
  assert.match(update, /Prose\./)
  assert.ok(update.includes(other))
  assert.match(update, /<!-- adf:my-change -->\n## What/)
  assert.equal(update.includes('Draft for change'), false)
})

test('finalize reports the half-applied state when the push fails after undraft succeeds', () => {
  const { code, result, calls } = op('finalize', finalInput, [...ready, existing, viewOf(''), ['glab mr update', yes()], ['git -C', no()]])
  assert.equal(code, 1)
  assert.match(result.error, /out of draft with the final description/)
  assert.ok(calls.some((c) => c.startsWith('glab mr update')))
})

test('finalize stops before the push when the undraft fails', () => {
  const { code, result, calls } = op('finalize', finalInput, [...ready, existing, viewOf(''), ['glab mr update', no()], ['git -C', yes()]])
  assert.equal(code, 1)
  assert.match(result.error, /the final commit was not pushed/)
  assert.equal(calls.some((c) => c.startsWith('git -C /work/host push')), false)
})

test('finalize with a body missing a section sends nothing', () => {
  const { code, result, calls } = op('finalize', { ...finalInput, body: '## What\n- x\n\n## Why\ny\n' }, ready)
  assert.equal(code, 1)
  assert.match(result.error, /Missing: \[QA\] Empty: \[\]/)
  assert.deepEqual(calls, [])
})

test('finalize with a comment-only section names it empty and sends nothing', () => {
  const { code, result, calls } = op('finalize', { ...finalInput, body: '## What\n- x\n\n## Why\n<!-- todo -->\n\n## QA\n1. y\n' }, ready)
  assert.equal(code, 1)
  assert.match(result.error, /Empty: \[Why\]/)
  assert.deepEqual(calls, [])
})

for (const field of ['change', 'body', 'branch', 'base', 'title']) {
  test(`finalize requires ${field}, before touching the forge`, () => {
    const { code, calls } = op('finalize', { ...finalInput, [field]: '' }, ready)
    assert.equal(code, 1)
    assert.deepEqual(calls, [])
  })
}

test('finalize does not push when glab is absent, and leaves a rerun of itself', () => {
  saved.length = 0
  const { code, result, calls } = op('finalize', finalInput, [])
  assert.equal(code, 0)
  assert.equal(result.state, 'degraded')
  assert.equal(touched(calls).length, 0)
  assert.equal(result.inputFile, '/tmp/adf-forge-x/finalize.json')
  assert.deepEqual(result.fallback, [`node '${join(pluginDir, 'scripts', 'forge.mjs')}' finalize --input-file '/tmp/adf-forge-x/finalize.json'`])
  assert.deepEqual(saved, [{ root: ROOT, config: { host: 'gitlab.example.com' }, input: finalInput }])
})

test('finalize fails loudly when the existing description cannot be read as JSON', () => {
  const { code, calls } = op('finalize', finalInput, [...ready, existing, ['glab mr view', yes('A new version of glab is available\n')], ['glab mr update', yes()], ['git -C', yes()]])
  assert.equal(code, 1)
  assert.equal(calls.some((c) => c.startsWith('glab mr update') || c.startsWith('git -C')), false)
})

test('finalize fails loudly when the existing description read itself fails', () => {
  const { code, calls } = op('finalize', finalInput, [...ready, existing, ['glab mr view', no()], ['glab mr update', yes()], ['git -C', yes()]])
  assert.equal(code, 1)
  assert.equal(calls.some((c) => c.startsWith('glab mr update') || c.startsWith('git -C')), false)
})

test('finalize refuses when the merge request list fails or is unreadable', () => {
  for (const list of [no(), yes('warning\n'), yes('{}')]) {
    const { code, calls } = op('finalize', finalInput, [...ready, ['glab mr list', list], ['git -C', yes()], ['glab mr create', yes()]])
    assert.equal(code, 1)
    assert.equal(calls.some((c) => c.startsWith('glab mr create') || c.startsWith('git -C')), false)
  }
})

test('finalize treats a valid JSON description of null as genuinely empty, not an error', () => {
  const { code, calls } = op('finalize', finalInput, [...ready, existing, viewOf(null), ['glab mr update', yes()], ['git -C', yes()]])
  assert.equal(code, 0)
  assert.ok(calls.some((c) => c.startsWith('glab mr update')))
})

test('finalize refuses an unclosed marker and changes nothing', () => {
  const { code, result, calls } = op('finalize', finalInput, [...ready, existing, viewOf('<!-- adf:my-change -->\nA'), ['glab mr update', yes()], ['git -C', yes()]])
  assert.equal(code, 1)
  assert.match(result.error, /unclosed marker/)
  assert.equal(calls.some((c) => c.startsWith('glab mr update') || c.startsWith('git -C')), false)
})

test('finalize opens a ready merge request when none exists, pushing the branch first', () => {
  const { code, result, calls } = op('finalize', finalInput, [
    ...ready,
    mrList([]),
    ['git -C', yes()],
    ['glab mr create', yes('https://gitlab.example.com/g/p/-/merge_requests/9\n')]
  ])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done', number: 9, url: 'https://gitlab.example.com/g/p/-/merge_requests/9', created: true })
  const push = calls.findIndex((c) => c.startsWith('git -C /work/host push'))
  const create = calls.findIndex((c) => c.startsWith('glab mr create'))
  assert.ok(push !== -1 && create > push)
  assert.equal(calls[create].includes('--draft'), false)
  assert.match(calls[create], /--target-branch release\/2 .*--description <!-- adf:my-change -->\n## What/s)
})

// ---------------------------------------------------------------- runOperation and the CLI

test('runOperation refuses an unknown operation and a non-object payload', () => {
  for (const name of ['merge', '__proto__', 'toString']) {
    const { code, result } = runOperation(name, { root: ROOT }, { run: () => assert.fail('no call') })
    assert.equal(code, 1)
    assert.match(result.error, /unknown operation/)
  }
  assert.equal(runOperation('check', [], { run: () => assert.fail('no call') }).code, 1)
  assert.equal(runOperation('check', { root: '' }, { run: () => assert.fail('no call') }).code, 1)
})

test('an unexpected error is a refusal that says what was already sent', () => {
  const before = runOperation('check', { root: ROOT }, { run: () => { throw new Error('boom') } })
  assert.deepEqual(before, { code: 1, result: { state: 'refused', error: 'boom; nothing was pushed and no merge request was touched.' } })
  const after = runOperation('open', { root: ROOT, config: { host: 'h' }, input: openInput }, {
    platform: 'darwin',
    run: (cmd, args) => {
      if (cmd === 'glab' && args[1] === 'list') throw new Error('boom')
      return yes()
    }
  })
  assert.equal(after.code, 1)
  assert.match(after.result.error, /^boom; the branch was pushed before the error\.$/)
})

const cliRun = (args, input) => {
  const proc = spawnSync('node', [cli, ...args], { input, encoding: 'utf8' })
  return { code: proc.status, out: JSON.parse(proc.stdout) }
}

test('the CLI reads the payload from stdin and exits 1 on a refusal', () => {
  const { code, out } = cliRun(['open'], JSON.stringify({ root: ROOT, input: { ...openInput, title: '' } }))
  assert.equal(code, 1)
  assert.equal(out.state, 'refused')
  assert.match(out.error, /nothing was pushed/)
})

test('the CLI reads the payload from --input-file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adf-forge-test-')), 'in.json')
  writeFileSync(file, JSON.stringify({ root: ROOT, input: { ...finalInput, branch: 'develop' } }))
  const { code, out } = cliRun(['finalize', '--input-file', file], '')
  assert.equal(code, 1)
  assert.match(out.error, /protected branch "develop"/)
})

test('the CLI refuses invalid JSON and stray arguments', () => {
  assert.equal(cliRun(['check'], 'not json').code, 1)
  assert.equal(cliRun(['check', '--force'], '{}').code, 1)
  assert.match(cliRun(['check', '--input-file', '/nonexistent/adf.json'], '').out.error, /nothing was pushed/)
})

// ---------------------------------------------------------------- push

const pushInput = { change: 'my-change', branch: 'feat/x', protected: ['develop', 'main'] }
const onBranch = (name) => ['git -C /work/host branch --show-current', yes(`${name}\n`)]

test('push pushes the checked-out change branch, never forced, and calls no glab', () => {
  const { code, result, calls } = op('push', pushInput, [onBranch('feat/x'), ['git -C /work/host push', yes()]])
  assert.equal(code, 0)
  assert.deepEqual(result, { state: 'done' })
  assert.deepEqual(calls, ['git -C /work/host branch --show-current', 'git -C /work/host push --set-upstream origin feat/x'])
})

test('push never degrades on glab: it needs only git', () => {
  const handlers = [['glab', no('not found')], onBranch('feat/x'), ['git -C /work/host push', yes()]]
  const { result, calls } = op('push', pushInput, handlers)
  assert.equal(result.state, 'done')
  assert.equal(calls.some((c) => c.startsWith('glab')), false)
})

test('push refuses an empty branch, a missing or invalid protected list, and a protected branch', () => {
  const cases = [
    [{ ...pushInput, branch: '' }, /input\.branch is required/],
    [{ ...pushInput, change: ' ' }, /input\.change is required/],
    [{ change: 'my-change', branch: 'feat/x' }, /input\.protected must be a list/],
    [{ ...pushInput, protected: 'develop' }, /input\.protected must be a list/],
    [{ ...pushInput, protected: [1] }, /input\.protected must be a list/],
    [{ ...pushInput, branch: 'develop' }, /protected branch "develop"/]
  ]
  for (const [input, error] of cases) {
    const { code, result, calls } = op('push', input, [])
    assert.equal(code, 1)
    assert.equal(result.state, 'refused')
    assert.match(result.error, error)
    assert.match(result.error, /nothing was pushed and nothing else changed/)
    assert.deepEqual(calls, [])
  }
})

test('push refuses from a group worktree, where another branch is checked out', () => {
  const { code, result, calls } = op('push', pushInput, [onBranch('feat/x--group-2'), ['git -C /work/host push', yes()]])
  assert.equal(code, 1)
  assert.equal(result.state, 'refused')
  assert.match(result.error, /"feat\/x--group-2" checked out, not the change branch "feat\/x"/)
  assert.match(result.error, /a push from a group worktree pushes the group branch instead of the change branch/)
  assert.equal(calls.some((c) => c.includes(' push')), false)
})

test('push refuses on a detached HEAD and when the branch cannot be read', () => {
  const detached = op('push', pushInput, [['git -C /work/host branch --show-current', yes('')]])
  assert.equal(detached.code, 1)
  assert.match(detached.result.error, /\(detached HEAD\)/)
  const unreadable = op('push', pushInput, [['git -C /work/host branch --show-current', no('not a git repository')]])
  assert.equal(unreadable.code, 1)
  assert.match(unreadable.result.error, /not a git repository; nothing was pushed/)
  assert.equal(unreadable.calls.some((c) => c.includes(' push')), false)
})

test("a failed push is refused with git's output and nothing else changed", () => {
  const { code, result } = op('push', pushInput, [onBranch('feat/x'), ['git -C /work/host push', no('rejected: non-fast-forward')]])
  assert.equal(code, 1)
  assert.deepEqual(result, { state: 'refused', error: 'git push failed: rejected: non-fast-forward; nothing else changed.' })
})

test('the declaration names contract 1.4, which defines ci', () => {
  const declared = JSON.parse(readFileSync(join(pluginDir, 'adf-extension.json'), 'utf8'))
  assert.equal(declared.contract, '1.4')
})

// ---------------------------------------------------------------- ci

const SKIP = 'git -C /work/host push -o ci.skip --set-upstream origin feat/x'
const PLAIN = 'git -C /work/host push --set-upstream origin feat/x'
const pushes = (calls) => calls.filter((c) => c.startsWith('git -C /work/host push'))

test('pushArgs adds -o ci.skip only for ci false', () => {
  assert.deepEqual(pushArgs(ROOT, 'feat/x', false), ['-C', ROOT, 'push', '-o', 'ci.skip', '--set-upstream', 'origin', 'feat/x'])
  assert.deepEqual(pushArgs(ROOT, 'feat/x', true), pushArgs(ROOT, 'feat/x'))
  assert.deepEqual(pushArgs(ROOT, 'feat/x', undefined), ['-C', ROOT, 'push', '--set-upstream', 'origin', 'feat/x'])
})

for (const [ci, expected] of [[false, SKIP], [true, PLAIN], [undefined, PLAIN]]) {
  test(`every push of open, push and finalize with ci ${ci} is "${expected}"`, () => {
    const extra = ci === undefined ? {} : { ci }
    const opened = op('open', { ...openInput, ...extra }, [...ready, ['git -C /work/host push', yes()], mrList([]), ['glab mr create', yes()]])
    const pushed = op('push', { ...pushInput, ...extra }, [onBranch('feat/x'), ['git -C /work/host push', yes()]])
    const finalized = op('finalize', { ...finalInput, ...extra }, [...ready, existing, viewOf(''), ['glab mr update', yes()], ['git -C', yes()]])
    const created = op('finalize', { ...finalInput, ...extra }, [...ready, mrList([]), ['git -C', yes()], ['glab mr create', yes()]])
    for (const run of [opened, pushed, finalized, created]) {
      assert.equal(run.code, 0)
      assert.deepEqual(pushes(run.calls), [expected])
    }
  })
}

test("open's degraded fallback carries -o ci.skip for ci false", () => {
  const { result } = op('open', { ...openInput, ci: false }, [])
  assert.equal(result.fallback[1], "git push -o ci.skip --set-upstream origin 'feat/x'")
})

test('a ci that is not a boolean is refused with nothing sent', () => {
  for (const operation of ['open', 'push', 'finalize']) {
    const { code, result, calls } = op(operation, { ...finalInput, ci: 'no' }, ready)
    assert.equal(code, 1)
    assert.match(result.error, /input\.ci must be true or false/)
    assert.deepEqual(calls, [])
  }
})

test('the CLI dispatches push', () => {
  const { code, out } = cliRun(['push'], JSON.stringify({ root: ROOT, input: { ...pushInput, branch: 'main' } }))
  assert.equal(code, 1)
  assert.match(out.error, /protected branch "main"/)
})
