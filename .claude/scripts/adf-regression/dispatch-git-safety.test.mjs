import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, meta } from './dispatch-git-safety.mjs'

// Every fixture is served through injected `read`/`list`; no test here touches the real
// filesystem, so the check is exercised against exactly the text each case states.
function harness(files) {
  const read = async (p) => {
    if (!(p in files)) {
      const err = new Error(`ENOENT: ${p}`)
      err.code = 'ENOENT'
      throw err
    }
    return files[p]
  }
  const list = async (d) => {
    const prefix = d.endsWith('/') ? d : `${d}/`
    const names = new Set()
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue
      names.add(p.slice(prefix.length).split('/')[0])
    }
    return [...names]
  }
  return { read, list }
}

const fence = (body) => `Some prose.\n\n\`\`\`bash\n${body}\n\`\`\`\n`

test('meta names the concrete incident and reports never having fired', () => {
  assert.match(meta.incident, /adf-flow-improvements/)
  assert.match(meta.incident, /known-issues\.md/)
  assert.equal(meta.lastFired, null)
})

test('flags an unscoped `git add -A` inside a fenced block', async () => {
  const { read, list } = harness({
    '.claude/commands/opsx/apply.md': fence('git add -A\ngit commit -m "x"'),
    '.claude/skills/x/SKILL.md': 'nothing here\n'
  })
  const result = await check({ read, list })
  assert.equal(result.ok, false)
  assert.match(result.detail, /apply\.md/)
  assert.match(result.detail, /git add -A/)
})

test('flags an unscoped `git add .`', async () => {
  const { read, list } = harness({ '.claude/commands/opsx/apply.md': fence('git add .') })
  const result = await check({ read, list })
  assert.equal(result.ok, false)
  assert.match(result.detail, /git add \./)
})

test('does not flag a path-scoped `git add -A <path>`, which the flow uses deliberately', async () => {
  const { read, list } = harness({
    '.claude/commands/opsx/archive.md': fence('git add -A "<planningHome.changesDir>"\ngit add -A .claude/memory')
  })
  const result = await check({ read, list })
  assert.equal(result.ok, true, result.detail)
})

test('does not flag a prohibition written in prose, the false positive that makes a keyword scan useless', async () => {
  const { read, list } = harness({
    '.claude/commands/opsx/propose.md':
      'Never run `git stash`, never run `git checkout` or `git clean` in the developer tree.\n' +
      'A dispatched agent must not run `git add -A` or `git add .` anywhere.\n'
  })
  const result = await check({ read, list })
  assert.equal(result.ok, true, result.detail)
})

test('flags destructive discards inside a fenced block', async () => {
  for (const command of ['git checkout -- .', 'git restore apps/server', 'git stash', 'git clean -fd']) {
    const { read, list } = harness({ '.claude/commands/opsx/apply.md': fence(command) })
    const result = await check({ read, list })
    assert.equal(result.ok, false, `expected ${command} to be flagged`)
    assert.match(result.detail, /apply\.md/)
  }
})

test('does not flag read-only stash inspection, which apply.md legitimately runs', async () => {
  const { read, list } = harness({
    '.claude/commands/opsx/apply.md': fence('git stash list  # confirm nothing of yours is stashed first')
  })
  const result = await check({ read, list })
  assert.equal(result.ok, true, result.detail)
})

test('scans skill instruction files too', async () => {
  const { read, list } = harness({ '.claude/skills/some-skill/SKILL.md': fence('git add -A') })
  const result = await check({ read, list })
  assert.equal(result.ok, false)
  assert.match(result.detail, /some-skill\/SKILL\.md/)
})

test('tolerates a skill directory with no SKILL.md', async () => {
  const { read, list } = harness({
    '.claude/commands/opsx/apply.md': 'clean\n',
    '.claude/skills/no-skill-file/README.md': 'just a readme\n'
  })
  const result = await check({ read, list })
  assert.equal(result.ok, true, result.detail)
})
