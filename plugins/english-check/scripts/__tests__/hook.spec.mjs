import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Every case runs the real hook entry as Claude Code does: the PreToolUse input JSON on stdin,
// against a real git repository in the system temp directory.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs')
const RU = '\u043f\u0440\u0438\u0432\u0435\u0442'

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'english-check-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write('README.md', 'base\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  return { root, git, write }
}

function hook(command, cwd, extra = {}) {
  const input = { session_id: 's', hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command }, ...extra }
  const run = spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' })
  return { code: run.status, stderr: run.stderr, stdout: run.stdout }
}

test('a staged foreign line in a change artifact blocks the commit with path and line', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `# Why\n\nok\n${RU} text\n`)
  r.git('add', '.')
  const out = hook('git commit -m "docs: propose x"', r.root)
  assert.equal(out.code, 2)
  assert.match(out.stderr, new RegExp(`openspec/changes/x/proposal.md:4: ${RU} text`))
  assert.match(out.stderr, /Rewrite those lines in English, then run the command again\./)
  assert.equal(out.stdout, '')
})

test('every offending line of every file is reported', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\nok\n${RU}\n`)
  r.write('openspec/specs/cap/spec.md', `${RU}\n`)
  r.git('add', '.')
  const out = hook('git commit -m x', r.root)
  assert.equal(out.code, 2)
  assert.match(out.stderr, /proposal\.md:1: /)
  assert.match(out.stderr, /proposal\.md:3: /)
  assert.match(out.stderr, /openspec\/specs\/cap\/spec\.md:1: /)
})

test('a clean commit passes silently', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', '# Why\n\nAn em dash \u2014 fine.\n')
  r.git('add', '.')
  assert.deepEqual(hook('git commit -m x', r.root), { code: 0, stderr: '', stdout: '' })
})

test('a Bash call that does not commit passes without looking at the tree', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git status && ls', r.root).code, 0)
  assert.equal(hook('git commit -m x', r.root, { tool_name: 'Read' }).code, 0)
})

test('the env prefix and a chain are seen', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('LEFTHOOK=0 git commit -m x', r.root).code, 2)
  assert.equal(hook('git status; git commit -m x && git push', r.root).code, 2)
})

test('git -C and cd point the check at another repository', (t) => {
  const r = repo()
  const outside = mkdtempSync(join(tmpdir(), 'english-check-cwd-'))
  t.after(() => {
    rmSync(r.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git commit -m x', outside).code, 0)
  assert.equal(hook(`git -C ${r.root} commit -m x`, outside).code, 2)
  assert.equal(hook(`cd ${r.root} && git commit -m x`, outside).code, 2)
})

test('git -C relative to cwd, from a subdirectory', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git -C ../.. commit -m x', join(r.root, 'openspec', 'changes')).code, 2)
  assert.equal(hook('git commit -m x', join(r.root, 'openspec')).code, 2)
})

test('outside a repository the hook passes', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'english-check-norepo-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.deepEqual(hook('git commit -m x', outside), { code: 0, stderr: '', stdout: '' })
  assert.equal(hook('git -C does-not-exist commit -m x', outside).code, 0)
})

test('an unstaged change counts only when the line also runs git add', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  assert.equal(hook('git commit -m x', r.root).code, 0)
  const out = hook('git add openspec && git commit -m x', r.root)
  assert.equal(out.code, 2)
  assert.match(out.stderr, /openspec\/changes\/x\/proposal\.md:1: /)
})

test('-am and --all take the modified tracked files', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/specs/cap/spec.md', 'ok\n')
  r.git('add', '.')
  r.git('commit', '-q', '-m', 'spec')
  r.write('openspec/specs/cap/spec.md', `ok\n${RU}\n`)
  assert.equal(hook('git commit -m x', r.root).code, 0)
  assert.equal(hook('git commit -am x', r.root).code, 2)
  assert.equal(hook('git commit --all -m x', r.root).code, 2)
})

test('a staged deletion is never a finding', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  r.git('commit', '-q', '--no-verify', '-m', 'seed')
  r.git('rm', '-q', 'openspec/changes/x/proposal.md')
  assert.deepEqual(hook('git commit -m x', r.root), { code: 0, stderr: '', stdout: '' })
})

test('a file out of scope is ignored', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('.claude/memory/index.md', `${RU}\n`)
  r.write('src/app.mjs', `// ${RU}\n`)
  r.write('openspec/changes/x/image.png', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git commit -m x', r.root).code, 0)
})

test('plan.md is exempt, also under the archive', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/plan.md', `${RU}\n`)
  r.write('openspec/changes/archive/2026-08-03-y/plan.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git commit -m x', r.root).code, 0)
})

test('the registry entry for the plugin sets include and exclude', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write(
    '.claude/adf-extensions.json',
    JSON.stringify({
      contract: '1.1',
      extensions: [
        { plugin: 'other@agentic-dev-flow', config: { include: ['nothing/**'] } },
        { plugin: 'english-check@agentic-dev-flow', config: { include: ['docs/**'], exclude: ['docs/raw/**'] } }
      ]
    })
  )
  r.write('docs/guide.md', `${RU}\n`)
  r.write('docs/raw/quote.md', `${RU}\n`)
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  const out = hook('git commit -m x', r.root)
  assert.equal(out.code, 2)
  assert.match(out.stderr, /docs\/guide\.md:1: /)
  assert.doesNotMatch(out.stderr, /quote\.md|proposal\.md/)
})

test('a path entry whose declaration is named english-check gives the configuration', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('vendor/ec/adf-extension.json', JSON.stringify({ name: 'english-check', contract: '1.1', provides: {} }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [{ path: 'vendor/ec', config: { include: ['notes/**'] } }] }))
  r.write('notes/a.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git commit -m x', r.root).code, 2)
})

test('a registry without an entry for the plugin keeps the defaults', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [] }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  assert.equal(hook('git commit -m x', r.root).code, 2)
})

test('a check that cannot run fails open: exit 1 and a warning, never a block', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('.claude/adf-extensions.json', '{ not json')
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  r.git('add', '.')
  const out = hook('git commit -m x', r.root)
  assert.equal(out.code, 1)
  assert.match(out.stderr, /^english-check: the check could not run \(.*\); this commit was not checked\.\n$/)
  const garbled = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' })
  assert.equal(garbled.status, 1)
})

// The ADF core commits through its own scripts, which run `git commit` out of the hook's sight.
const COMMIT = 'node "/plugins/adf/scripts/commit.mjs"'

test('commit.mjs with a foreign line in an --only path in scope blocks', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `ok\n${RU}\n`)
  const out = hook(`${COMMIT} --root "${r.root}" --only openspec/changes/x/proposal.md --message 'docs: x'`, '/')
  assert.equal(out.code, 2)
  assert.match(out.stderr, /openspec\/changes\/x\/proposal\.md:2: /)
})

test('commit.mjs with a clean --only path passes', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', 'ok\n')
  r.write('openspec/changes/x/design.md', `${RU}\n`)
  const out = hook(`${COMMIT} --root ${r.root} --only openspec/changes/x/proposal.md --message m`, r.root)
  assert.deepEqual([out.code, out.stderr], [0, ''])
})

test('commit.mjs with an --only path out of scope passes', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('src/notes.md', `${RU}\n`)
  const out = hook(`${COMMIT} --only src --message m`, r.root)
  assert.deepEqual([out.code, out.stderr], [0, ''])
})

test('commit.mjs with a quoted directory path holding spaces, from cd into the root, blocks', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/my change/specs/a b.md', `${RU}\n`)
  const out = hook(`cd "${r.root}" && node ./x/commit.mjs --only "openspec/changes/my change" --message m`, '/')
  assert.equal(out.code, 2)
  assert.match(out.stderr, /openspec\/changes\/my change\/specs\/a b\.md:1: /)
})

test('tasks.mjs tick --commit checks the change tasks file; without --commit it passes', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/tasks.md', `- [ ] 1.1 ${RU}\n`)
  const tick = `node /p/scripts/tasks.mjs tick 1.1 --change x --root ${r.root}`
  const blocked = hook(`${tick} --commit`, '/')
  assert.equal(blocked.code, 2)
  assert.match(blocked.stderr, /openspec\/changes\/x\/tasks\.md:1: /)
  assert.deepEqual([hook(tick, '/').code, hook(tick, '/').stderr], [0, ''])
})

test('propose.mjs commit checks the change directory; create passes', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/proposal.md', `${RU}\n`)
  const blocked = hook(`node /p/scripts/propose.mjs commit --change x --root ${r.root}`, '/')
  assert.equal(blocked.code, 2)
  assert.match(blocked.stderr, /openspec\/changes\/x\/proposal\.md:1: /)
  assert.equal(hook(`node /p/scripts/propose.mjs commit --root ${r.root}`, '/').code, 2)
  assert.equal(hook(`node /p/scripts/propose.mjs create --change x --root ${r.root}`, '/').code, 0)
})

test('verify.mjs assemble --commit checks the record; without --commit, and run, pass', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/verify.md', `${RU}\n`)
  const assemble = `node /p/scripts/verify.mjs assemble --change x --root ${r.root}`
  const blocked = hook(`${assemble} --commit`, '/')
  assert.equal(blocked.code, 2)
  assert.match(blocked.stderr, /openspec\/changes\/x\/verify\.md:1: /)
  assert.equal(hook(assemble, '/').code, 0)
  assert.equal(hook(`node /p/scripts/verify.mjs run --change x --root ${r.root}`, '/').code, 0)
})

test('verify.mjs skill-edit checks the host skills when the registry puts them in scope', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('vendor/ec/adf-extension.json', JSON.stringify({ name: 'english-check', contract: '1.1', provides: {} }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [{ path: 'vendor/ec', config: { include: ['.claude/skills/**'] } }] }))
  r.write('.claude/skills/deploy/SKILL.md', `${RU}\n`)
  const out = hook(`node /p/scripts/verify.mjs skill-edit --change x --message 'docs(skills): x' --root ${r.root}`, '/')
  assert.equal(out.code, 2)
  assert.match(out.stderr, /\.claude\/skills\/deploy\/SKILL\.md:1: /)
})

test('verify.mjs skill-edit --diff-file checks the lines the diff adds, by their new line number', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('vendor/ec/adf-extension.json', JSON.stringify({ name: 'english-check', contract: '1.1', provides: {} }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [{ path: 'vendor/ec', config: { include: ['.claude/skills/**'] } }] }))
  r.write('.claude/skills/deploy/SKILL.md', 'one\ntwo\nthree\n')
  const diff = (added) =>
    ['--- a/.claude/skills/deploy/SKILL.md', '+++ b/.claude/skills/deploy/SKILL.md', '@@ -1,3 +1,4 @@', ' one', ' two', `+${added}`, ' three', ''].join('\n')
  r.write('edit.diff', diff(RU))
  r.write('clean.diff', diff('plain English'))
  const cmd = (file) => `node /p/scripts/verify.mjs skill-edit --change x --message 'docs(skills): x' --diff-file ${file} --root ${r.root}`
  const blocked = hook(cmd('edit.diff'), r.root)
  assert.equal(blocked.code, 2)
  assert.match(blocked.stderr, /\.claude\/skills\/deploy\/SKILL\.md:3: /)
  assert.equal(hook(cmd('clean.diff'), r.root).code, 0)
})

test('review.mjs assemble and mark check what they commit only with --commit', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/x/review.md', `${RU}\n`)
  r.write('openspec/changes/x/notes.md', `${RU}\n`)
  const assemble = `node /p/scripts/review.mjs assemble --change x --root ${r.root}`
  assert.match(hook(`${assemble} --commit`, '/').stderr, /openspec\/changes\/x\/review\.md:1: /)
  assert.equal(hook(assemble, '/').code, 0)
  const mark = `node /p/scripts/review.mjs mark --file openspec/changes/x/notes.md --line 1 --key CWE-79 --reason r --root ${r.root}`
  assert.match(hook(`${mark} --commit`, '/').stderr, /openspec\/changes\/x\/notes\.md:1: /)
  assert.equal(hook(mark, '/').code, 0)
  assert.equal(hook(`node /p/scripts/review.mjs start --change x --commit --root ${r.root}`, '/').code, 0)
})

test('archive.mjs commit-specs checks the change, the archive and the specs; commit-memory every uncommitted file', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('openspec/changes/archive/2026-10-19-x/proposal.md', `${RU}\n`)
  r.write('openspec/specs/cap/spec.md', `${RU}\n`)
  const specs = hook(`node /p/scripts/archive.mjs commit-specs --change x --root ${r.root}`, '/')
  assert.equal(specs.code, 2)
  assert.match(specs.stderr, /openspec\/changes\/archive\/2026-10-19-x\/proposal\.md:1: /)
  assert.match(specs.stderr, /openspec\/specs\/cap\/spec\.md:1: /)
  const memory = hook(`node /p/scripts/archive.mjs commit-memory --change x --root ${r.root}`, '/')
  assert.equal(memory.code, 2)
  assert.match(memory.stderr, /openspec\/specs\/cap\/spec\.md:1: /)
  assert.equal(hook(`node /p/scripts/archive.mjs check --change x --root ${r.root}`, '/').code, 0)
  rmSync(join(r.root, 'openspec'), { recursive: true, force: true })
  assert.equal(hook(`node /p/scripts/archive.mjs commit-memory --change x --root ${r.root}`, '/').code, 0)
})

test('retro.mjs record checks the retrospective it commits, under the retro worktree --root names', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  r.write('vendor/ec/adf-extension.json', JSON.stringify({ name: 'english-check', contract: '1.1', provides: {} }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [{ path: 'vendor/ec', config: { include: ['.adf/**'] } }] }))
  r.write('.adf/retro/2026-10-19-window.md', `${RU}\n`)
  const record = hook(`node /p/scripts/retro.mjs record --date 2026-10-19 --root ${r.root}`, '/')
  assert.equal(record.code, 2)
  assert.match(record.stderr, /\.adf\/retro\/2026-10-19-window\.md:1: /)
  assert.equal(hook(`node /p/scripts/retro.mjs render --root ${r.root}`, '/').code, 0)
})

test('suite.mjs, dup.mjs and plan.mjs check what they commit only with --commit', (t) => {
  const r = repo()
  t.after(() => rmSync(r.root, { recursive: true, force: true }))
  // planning.md is out of the default scope and plan.md is in the default exclusion.
  r.write('vendor/ec/adf-extension.json', JSON.stringify({ name: 'english-check', contract: '1.1', provides: {} }))
  r.write('.claude/adf-extensions.json', JSON.stringify({ contract: '1.1', extensions: [{ path: 'vendor/ec', config: { include: ['openspec/**'], exclude: [] } }] }))
  r.write('openspec/changes/x/.apply-test-record.md', `${RU}\n`)
  r.write('openspec/planning.md', `${RU}\n`)
  r.write('openspec/changes/x/plan.md', `${RU}\n`)
  r.write('openspec/changes/x/notes.md', `${RU}\n`)
  const run = `node /p/scripts/suite.mjs run --change x --record --root ${r.root}`
  assert.match(hook(`${run} --commit`, '/').stderr, /openspec\/changes\/x\/\.apply-test-record\.md:1: /)
  assert.equal(hook(run, '/').code, 0)
  const set = `node /p/scripts/suite.mjs set --command 'npm test' --root ${r.root}`
  assert.match(hook(`${set} --commit`, '/').stderr, /openspec\/planning\.md:1: /)
  assert.equal(hook(set, '/').code, 0)
  const mark = `node /p/scripts/dup.mjs mark --change x --file openspec/changes/x/notes.md --existing a --why b --reason c --root ${r.root}`
  assert.match(hook(`${mark} --commit`, '/').stderr, /openspec\/changes\/x\/notes\.md:1: /)
  assert.equal(hook(mark, '/').code, 0)
  const added = `node /p/scripts/plan.mjs added --change x --path a.ts --why b --root ${r.root}`
  const blocked = hook(`${added} --commit`, '/')
  assert.match(blocked.stderr, /openspec\/changes\/x\/plan\.md:1: /)
  assert.doesNotMatch(blocked.stderr, /notes\.md/)
  assert.equal(hook(added, '/').code, 0)
})
