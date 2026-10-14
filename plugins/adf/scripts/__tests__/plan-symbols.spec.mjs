import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  baseRef,
  checkPlanSymbols as checkObjects,
  parseArgs,
  parseNameStatus,
  parsePlanTasks
} from '../lib/plan-symbols.mjs'

// Ported from the origin's check-plan-symbols.spec.mjs. The origin returned prose lines; this
// module returns finding objects, and `checkPlanSymbols` below renders each as the origin's
// line ("Task N: <message>") so the origin's expectations carry over unchanged. The finding
// objects themselves are asserted in 'each finding kind is reported and well-formed lines pass'.
const render = (f) => (f.task === null ? f.message : `Task ${f.task}: ${f.message}`)
const checkPlanSymbols = async (w) => (await checkObjects(w)).map(render)

// Fixtures are excerpts of two archived plans, copied here so the test never reads them.

// Suffix ranges, an inline "Resolved with" continuation, and `tasks.md` in backticks.
const ALIGN = `### Task 1: Apply execution ledger intro prose matches its requirements

> Implements \`tasks.md\` 1.1.

**Files:**
- Modify: \`openspec/specs/apply-execution-ledger/spec.md:3-16\`. This is the \`## Purpose\`
  section, the two paragraphs between line 3 and the \`## Requirements\` heading at line 18.
  Resolved with \`grep -n "^## " openspec/specs/apply-execution-ledger/spec.md\`.

**Interfaces:** none.

**Level:** mechanical.

### Task 2: The retrospective skill stops claiming an archived \`ledger.md\` is read

> Implements \`tasks.md\` 2.1.

**Files:**
- Modify: \`.claude/skills/adf-retro/SKILL.md:29-32\` — the extractor reads no archived
  \`ledger.md\`; sessions are found by branch.
- Modify: \`.claude/skills/adf-retro/README.md:10\` — a change run covers every session.

**Interfaces:** none.
`

// Parenthetical ranges, Revert by commit, Move, Test, Consumes and Produces.
const DISCOVERY = `### Task 1: The panel holds only this browser's jobs

> Implements tasks.md 1.1.

**Files:**
- Modify: \`apps/client/src/hooks/useDiscoveryProgressListener.ts\` (\`applyDiscoveryProgress\`, lines 36-62)
- Modify: \`apps/client/src/store/useDiscoveryProgressStore.ts\` (\`onRehydrateStorage\`, line 793)
- Modify: \`apps/client/src/components/organisms/GlobalDiscoveryNotifications.tsx\` (delete 148-255 — \`shortClientId\`, the orphan JSDoc; simplify 711-717)
- Test: \`apps/client/src/hooks/__tests__/useDiscoveryProgressListener.spec.ts\`

**Interfaces:**
- Consumes: \`getBrowserId()\` from \`@/lib\`; \`startDiscovery(payload: DiscoveryStartPayload)\` (unchanged, still accepts \`startedByMe\`/\`clientId\`).
- Produces: \`applyDiscoveryProgress\` returns without touching the store for any frame.

Acceptance: the foreign-frame tests assert the job is absent.

### Task 2: Running discoveries come from the server's job list

> Implements tasks.md 2.1.

**Files:**
- Revert: commits \`bef47607\` and \`e86fdad6\` (newest first), which restores \`useDiscoveryProgressStore.ts\` and their specs
- Move: \`apps/client/src/pages/Developer/hooks/useDiscoveryJobs.ts\` → \`apps/client/src/hooks/api-queries/useDiscoveryJobs.ts\` (export it from \`hooks/api-queries/index.ts\`)
- Modify: \`apps/client/src/pages/Developer/__tests__/Developer.spec.tsx\`, \`DiscoveryScansTable.spec.tsx\` (the \`vi.mock\` path of the moved hook)
- Create: \`apps/client/src/hooks/useRunningDiscoveries.ts\` (export it from \`hooks/index.ts\`)

**Interfaces:**
- Produces: \`export const useRunningDiscoveries: () => { mine: number; others: number }\`.
- Consumes: \`getWebSocket()\` and \`getBrowserId()\` from \`@/lib\`; \`WebsocketEvents.discoveryProgress\`; \`socket.io.on('reconnect', …)\`, the Manager event.

Acceptance: the indicator counts.
`

const task = (n, files, extra = '') =>
  `### Task ${n}: t\n\n> Implements \`tasks.md\` ${n}.1.\n\n**Files:**\n${files}\n\n**Interfaces:** none.\n${extra}`

// In-memory fakes. `fs` maps path -> text.
const world = ({
  fs = {},
  grep = [],
  added = [],
  modified = [],
  removed = [],
  plan,
  tasks = '',
  changeName = 'c',
  phase
} = {}) => {
  const files = { ...fs }
  if (plan !== undefined) files[`openspec/changes/${changeName}/plan.md`] = plan
  files[`openspec/changes/${changeName}/tasks.md`] = tasks
  return {
    changeName,
    phase,
    read: (f) => {
      if (!(f in files)) throw Object.assign(new Error(`ENOENT ${f}`), { code: 'ENOENT' })
      return files[f]
    },
    exists: (f) => f in files,
    lineCount: (f) => files[f].split('\n').length,
    grep: async (s) => grep.includes(s),
    branchChanges: async () => ({ added: new Set(added), modified: new Set(modified), removed: new Set(removed) })
  }
}

test('archived align-flow-specs fixture parses with suffix ranges and no unparsed lines', () => {
  const tasks = parsePlanTasks(ALIGN)
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].number, 1)
  assert.equal(tasks[0].implements, '1.1')
  assert.deepEqual(tasks[0].files, [
    { verb: 'Modify', path: 'openspec/specs/apply-execution-ledger/spec.md', range: [3, 16] }
  ])
  assert.deepEqual(
    tasks[1].files.map((f) => [f.path, f.range]),
    [
      ['.claude/skills/adf-retro/SKILL.md', [29, 32]],
      ['.claude/skills/adf-retro/README.md', [10, 10]]
    ]
  )
  assert.deepEqual(
    tasks.flatMap((t) => t.unparsed),
    []
  )
})

test('archived discovery fixture parses parenthetical ranges, Move, Revert and Consumes', () => {
  const [t1, t2] = parsePlanTasks(DISCOVERY)
  assert.equal(t1.implements, '1.1')
  assert.deepEqual(
    t1.files.map((f) => [f.verb, f.range]),
    [
      ['Modify', [36, 62]],
      ['Modify', [793, 793]],
      ['Modify', [148, 255]],
      ['Test', undefined]
    ]
  )
  assert.deepEqual(t1.consumes, [
    { symbol: 'getBrowserId', path: '@/lib' },
    { symbol: 'startDiscovery' },
    // Backticked identifiers inside the prose parenthetical are claims too.
    { symbol: 'startedByMe' },
    { symbol: 'clientId' }
  ])
  const move = t2.files.find((f) => f.verb === 'Move')
  assert.equal(move.path, 'apps/client/src/pages/Developer/hooks/useDiscoveryJobs.ts')
  assert.equal(move.to, 'apps/client/src/hooks/api-queries/useDiscoveryJobs.ts')
  assert.deepEqual(
    t2.files.map((f) => f.verb),
    ['Move', 'Modify', 'Modify', 'Create']
  )
  assert.deepEqual(
    t2.consumes.map((c) => c.symbol),
    ['getWebSocket', 'getBrowserId', 'WebsocketEvents', 'socket']
  )
  assert.deepEqual([...t1.unparsed, ...t2.unparsed], [])
})

test('a Consumes entry without an identifier-like symbol yields no symbol', () => {
  const plan = task(1, '- Create: `a.mjs` — x').replace(
    '**Interfaces:** none.',
    '**Interfaces:**\n- Consumes: none.\n- Consumes: `node .claude/scripts/x.mjs --flag` (Task 2) and `check-reply.mjs` CLI.\n- Produces: `export const Z`'
  )
  assert.deepEqual(parsePlanTasks(plan)[0].consumes, [])
})

test('a Consumes symbol takes the path of its "in" or "from" target, stripping a line suffix', () => {
  const plan = task(1, '- Create: `a.mjs` — x').replace(
    '**Interfaces:** none.',
    '**Interfaces:**\n- Consumes: the style of `KINDS` in `.claude/scripts/ledger.mjs:18` (pattern only).'
  )
  assert.deepEqual(parsePlanTasks(plan)[0].consumes, [{ symbol: 'KINDS', path: '.claude/scripts/ledger.mjs' }])
})

test('an unknown Files bullet shape is reported as unparsed, never dropped', () => {
  const plan = task(1, '- Modify: `a.ts`\n- Rename `b.ts` to `c.ts`\n- Modify: no path here\n- Move: `x.ts` somewhere')
  const [t] = parsePlanTasks(plan)
  assert.deepEqual(
    t.files.map((f) => f.path),
    ['a.ts']
  )
  assert.equal(t.unparsed.length, 3)
  assert.match(t.unparsed[0], /Rename/)
})

test('each finding kind is reported and well-formed lines pass', async () => {
  const plan = [
    task(
      1,
      '- Test: `src/ok.ts:1-3` — fine, and not a Modify so it defers nothing\n- Test: `src/ok.test.ts`\n- Create: `src/new.ts`',
      ''
    ),
    task(
      2,
      '- Modify: `src/gone.ts` — x\n- Test: `src/gone.test.ts`\n- Move: `src/gone2.ts` → `src/n.ts`\n- Create: `src/ok.ts`\n- Modify: `src/ok.ts:1-99`\n- Frobnicate `x`'
    ).replace(
      '**Interfaces:** none.',
      '**Interfaces:**\n- Consumes: `missingFn()` from `src/ok.ts`; `presentFn` in `src/ok.ts`; `elsewhere` from `@/lib`.'
    )
  ].join('\n')
  const w = world({
    plan,
    fs: { 'src/ok.ts': 'a\nb\nc\nd\n// presentFn', 'src/ok.test.ts': 'x' },
    grep: ['elsewhere']
  })
  const findings = await checkPlanSymbols(w)
  assert.deepEqual(findings, [
    'Task 2: Modify src/gone.ts — path does not exist',
    'Task 2: Test src/gone.test.ts — path does not exist',
    'Task 2: Move src/gone2.ts — path does not exist',
    'Task 2: Create src/ok.ts — path already exists',
    "Task 2: Modify src/ok.ts — range 1-99 ends beyond the file's 5 lines",
    'Task 2: Consumes missingFn — not found in src/ok.ts or anywhere in the repository',
    'Task 2: Files line cannot be parsed — - Frobnicate `x`'
  ])
  // The same findings as objects: the fields of each kind, the message without the task.
  const objects = (await checkObjects(w)).map(({ message, ...rest }) => rest)
  assert.deepEqual(objects, [
    { task: 2, kind: 'path-missing', verb: 'Modify', path: 'src/gone.ts' },
    { task: 2, kind: 'path-missing', verb: 'Test', path: 'src/gone.test.ts' },
    { task: 2, kind: 'path-missing', verb: 'Move', path: 'src/gone2.ts' },
    { task: 2, kind: 'path-exists', verb: 'Create', path: 'src/ok.ts' },
    { task: 2, kind: 'range-beyond', verb: 'Modify', path: 'src/ok.ts', range: [1, 99], lines: 5 },
    { task: 2, kind: 'symbol-missing', symbol: 'missingFn', path: 'src/ok.ts' },
    { task: 2, kind: 'unparsed', line: '- Frobnicate `x`' }
  ])
})

test('the remaining finding kinds carry their fields', async () => {
  assert.deepEqual(await checkObjects(world({ plan: '# Plan\n' })), [
    { task: null, kind: 'no-tasks', message: 'no `### Task N` heading found' }
  ])
  const plan = task(1, '- Modify: `src/dir:1-5` — x').replace('**Interfaces:** none.', '**Interfaces:**\n- Consumes: `ghost()`.')
  const w = world({ plan, fs: { 'src/dir': '' } })
  w.lineCount = () => {
    throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
  }
  assert.deepEqual(await checkObjects(w), [
    { task: 1, kind: 'path-is-directory', verb: 'Modify', path: 'src/dir', message: 'Modify src/dir — src/dir is a directory' },
    { task: 1, kind: 'symbol-missing', symbol: 'ghost', message: 'Consumes ghost — not found in the repository' }
  ])
})

test('a Revert whose path is absent is reported; a Revert of commits is not', async () => {
  const plan = task(1, '- Revert: `src/a.ts` — x\n- Revert: commits `bef47607` and `e86fdad6`')
  assert.deepEqual(await checkPlanSymbols(world({ plan })), ['Task 1: Revert src/a.ts — path does not exist'])
})

// Missing from the origin's suite: Revert takes the same earlier-Create deferral as Modify.
test('a Revert on a file an earlier task creates is not reported; one in the creating task is', async () => {
  const plan = [task(1, '- Create: `src/made.ts` — x'), task(2, '- Revert: `src/made.ts` — y')].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan })), [])
  const same = task(1, '- Create: `src/made.ts` — x\n- Revert: `src/made.ts` — y')
  assert.deepEqual(await checkPlanSymbols(world({ plan: same })), ['Task 1: Revert src/made.ts — path does not exist'])
})

test('a range on an absent path yields one path finding and no crash', async () => {
  const plan = task(1, '- Modify: `src/gone.ts:809-820` — x')
  assert.deepEqual(await checkPlanSymbols(world({ plan })), ['Task 1: Modify src/gone.ts — path does not exist'])
})

test('Produces is never checked', async () => {
  const plan = task(1, '- Create: `a.mjs` — x').replace(
    '**Interfaces:** none.',
    '**Interfaces:**\n- Produces: `export function nowhere()` from `src/none.ts`'
  )
  assert.deepEqual(await checkPlanSymbols(world({ plan })), [])
})

test('a symbol named only by a path the plan itself creates earlier is deferred, not reported', async () => {
  const plan = [
    task(1, '- Create: `src/lib.mjs` — x'),
    task(2, '- Create: `src/use.mjs` — y').replace(
      '**Interfaces:** none.',
      '**Interfaces:**\n- Consumes: `helper(x)` from `src/lib.mjs`.'
    )
  ].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan })), [])
  // Still deferred once the file exists: what it holds is that earlier task's to deliver.
  const landed = world({ plan, fs: { 'src/lib.mjs': 'nothing here' }, added: ['src/lib.mjs'], phase: 'apply' })
  assert.deepEqual(await checkPlanSymbols(landed), [])
})

test('a symbol an earlier task Produces is not reported; one no earlier task names still is', async () => {
  const withIface = (n, files, iface) => task(n, files).replace('**Interfaces:** none.', `**Interfaces:**\n${iface}`)
  const plan = [
    withIface(1, '- Create: `a.mjs` — x', '- Produces: `helper()` in `src/lib.ts`'),
    withIface(2, '- Create: `b.mjs` — y', '- Consumes: `helper()` from `src/lib.ts`; `ghost()`.')
  ].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs: { 'src/lib.ts': 'nothing' } })), [
    'Task 2: Consumes ghost — not found in the repository'
  ])
  // Strictly earlier: a later task does not excuse it.
  const later = [
    withIface(1, '- Create: `b.mjs` — y', '- Consumes: `helper()`.'),
    withIface(2, '- Create: `a.mjs` — x', '- Produces: `helper()`')
  ].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan: later })), [
    'Task 1: Consumes helper — not found in the repository'
  ])
})

test('a range on a file an earlier task modifies is not reported; with no earlier Modify it still is', async () => {
  const fs = { 'src/lib.ts': 'one\ntwo' }
  const plan = [task(1, '- Modify: `src/lib.ts:1-2` — grow'), task(2, '- Modify: `src/lib.ts:250-300` — y')].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs })), [])
  const alone = task(2, '- Modify: `src/lib.ts:250-300` — y')
  assert.deepEqual(await checkPlanSymbols(world({ plan: alone, fs })), [
    "Task 2: Modify src/lib.ts — range 250-300 ends beyond the file's 2 lines"
  ])
})

test('a Modify, Test or Move source, and a range, on a file an earlier task creates are not reported', async () => {
  const plan = [
    task(1, '- Create: `src/made.ts` — x'),
    task(
      2,
      '- Modify: `src/made.ts:1-80` — y\n- Test: `src/made.ts`\n- Move: `src/made.ts` → `src/moved.ts`\n- Modify: `src/never.ts:1-5`'
    )
  ].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan })), ['Task 2: Modify src/never.ts — path does not exist'])
  // The same Modify in the creating task itself, or before it, is still reported.
  const before = [task(1, '- Modify: `src/made.ts` — y'), task(2, '- Create: `src/made.ts` — x')].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan: before })), [
    'Task 1: Modify src/made.ts — path does not exist'
  ])
})

test("every backticked path of a Files bullet is checked, a bare name beside the first path's directory", async () => {
  const plan = task(1, '- Modify: `src/a/x.ts`, `y.ts` and `src/b/z.ts` (the vi.mock path of `ledger.md`)')
  assert.deepEqual(
    parsePlanTasks(plan)[0].files.map((f) => f.path),
    ['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts']
  )
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs: { 'src/a/x.ts': '', 'src/b/z.ts': '' } })), [
    'Task 1: Modify src/a/y.ts — path does not exist'
  ])
})

test('bullets separated by a blank line are all read, and stray prose in the block is unparsed', async () => {
  const plan = task(1, '- Modify: `src/ok.ts`\n\n- Modify: `src/bad.ts`\n\nsome prose\n- Test: `src/ok.ts`')
  const [t] = parsePlanTasks(plan)
  assert.deepEqual(
    t.files.map((f) => f.path),
    ['src/ok.ts', 'src/bad.ts', 'src/ok.ts']
  )
  assert.deepEqual(t.unparsed, ['some prose'])
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs: { 'src/ok.ts': '' } })), [
    'Task 1: Modify src/bad.ts — path does not exist',
    'Task 1: Files line cannot be parsed — some prose'
  ])
})

test('an Interfaces block ends at an unindented prose line such as Acceptance', () => {
  const plan = task(1, '- Create: `a.mjs` — x').replace(
    '**Interfaces:** none.',
    '**Interfaces:**\n- Consumes: `one()` from `@/lib`.\n\nAcceptance: uses `two()` from `@/lib`.'
  )
  assert.deepEqual(parsePlanTasks(plan)[0].consumes, [{ symbol: 'one', path: '@/lib' }])
})

test('a ticked task is skipped only under --phase apply', async () => {
  const plan = task(1, '- Modify: `src/gone.ts` — x')
  const tasks = '- [x] 1.1 done\n- [ ] 1.2 open'
  assert.equal((await checkPlanSymbols(world({ plan, tasks, phase: 'propose' }))).length, 1)
  assert.equal((await checkPlanSymbols(world({ plan, tasks }))).length, 1)
  assert.equal((await checkPlanSymbols(world({ plan, tasks, phase: 'apply' }))).length, 0)
  const open = world({ plan, tasks: '- [ ] 1.1 open', phase: 'apply' })
  assert.equal((await checkPlanSymbols(open)).length, 1)
})

test("apply exempts a Create in the branch's added files and a range on its modified files; propose does not", async () => {
  const plan = task(
    1,
    '- Create: `src/new.ts` — x\n- Modify: `src/big.ts:1-500` — y\n- Modify: `src/other.ts:1-500` — z'
  )
  const fs = { 'src/new.ts': 'a', 'src/big.ts': 'a\nb', 'src/other.ts': 'a\nb' }
  const base = { plan, fs, added: ['src/new.ts'], modified: ['src/big.ts'] }
  const propose = await checkPlanSymbols(world({ ...base, phase: 'propose' }))
  assert.equal(propose.length, 3)
  const apply = await checkPlanSymbols(world({ ...base, phase: 'apply' }))
  assert.deepEqual(apply, ["Task 1: Modify src/other.ts — range 1-500 ends beyond the file's 2 lines"])
})

test('apply also exempts a range on a file the branch added', async () => {
  const plan = task(1, '- Modify: `src/made.ts:1-500` — x')
  const base = { plan, fs: { 'src/made.ts': 'a\nb' }, added: ['src/made.ts'] }
  assert.equal((await checkPlanSymbols(world({ ...base, phase: 'propose' }))).length, 1)
  assert.deepEqual(await checkPlanSymbols(world({ ...base, phase: 'apply' })), [])
})

test('branchChanges is not called outside --phase apply', async () => {
  const w = world({ plan: task(1, '- Create: `src/new.ts` — x') })
  w.branchChanges = async () => {
    throw new Error('must not be called')
  }
  assert.deepEqual(await checkPlanSymbols(w), [])
})

test("parseNameStatus splits added and modified, taking a rename's new path as added", () => {
  const { added, modified } = parseNameStatus('A\ta.ts\nM\tb.ts\nD\tc.ts\nR100\told.ts\tnew.ts\n')
  assert.deepEqual([...added].sort(), ['a.ts', 'new.ts'])
  assert.deepEqual([...modified], ['b.ts'])
})

test('parseNameStatus returns deleted paths and rename sources as removed', () => {
  const { removed } = parseNameStatus('D\tc.ts\nR100\told.ts\tnew.ts\nA\ta.ts\n')
  assert.deepEqual([...removed].sort(), ['c.ts', 'old.ts'])
})

test('apply does not report a Move source or Delete path the branch already removed; propose does', async () => {
  const plan = task(1, '- Move: `src/a.ts` → `src/b.ts`\n- Delete: `src/old.ts`\n- Delete: `src/other.ts`')
  const base = { plan, fs: { 'src/b.ts': 'x' }, removed: ['src/a.ts', 'src/old.ts'] }
  assert.equal((await checkPlanSymbols(world({ ...base, phase: 'propose' }))).length, 3)
  assert.deepEqual(await checkPlanSymbols(world({ ...base, phase: 'apply' })), [
    'Task 1: Delete src/other.ts — path does not exist'
  ])
})

test('a Delete path must exist, unless an earlier task creates it', async () => {
  const plan = [
    task(1, '- Create: `src/tmp.ts` — x'),
    task(2, '- Delete: `src/tmp.ts`\n- Delete: `src/old.ts`\n- Delete: `src/gone.ts`')
  ].join('\n')
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs: { 'src/old.ts': '' } })), [
    'Task 2: Delete src/gone.ts — path does not exist'
  ])
})

test('a "<Verb>: none" bullet is a no-op, not unparsed', async () => {
  const plan = task(1, '- Modify: `src/ok.ts`\n- Create: none.\n- Test: none')
  const [t] = parsePlanTasks(plan)
  assert.deepEqual(t.unparsed, [])
  assert.deepEqual(
    t.files.map((f) => f.path),
    ['src/ok.ts']
  )
  assert.deepEqual(await checkPlanSymbols(world({ plan, fs: { 'src/ok.ts': '' } })), [])
})

test('a plan with no task heading is one finding, not a pass', async () => {
  const plan = '# Plan\n\n## Task 1: wrong level\n\n**Files:**\n- Modify: `src/gone.ts`\n'
  assert.deepEqual(await checkPlanSymbols(world({ plan })), ['no `### Task N` heading found'])
})

test('a range on a directory is a finding, not a crash', async () => {
  const plan = task(1, '- Modify: `src/dir:1-5` — x')
  const w = world({ plan, fs: { 'src/dir': '' } })
  w.lineCount = () => {
    throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
  }
  assert.deepEqual(await checkPlanSymbols(w), ['Task 1: Modify src/dir — src/dir is a directory'])
})

test('parseArgs takes the repository from --root, else from git, never from the cwd', () => {
  const noGit = () => {
    throw new Error('not a git repository')
  }
  assert.deepEqual(parseArgs(['c', '--phase', 'apply', '--root', '/w'], noGit), {
    changeName: 'c',
    phase: 'apply',
    root: '/w'
  })
  assert.deepEqual(
    parseArgs(['c'], () => '/top'),
    { changeName: 'c', phase: 'propose', root: '/top' }
  )
  assert.equal(parseArgs(['c'], noGit), null)
  assert.equal(
    parseArgs(['c', '--root'], () => '/top'),
    null
  )
  assert.equal(
    parseArgs(['c', '--phase', 'later'], () => '/top'),
    null
  )
  assert.equal(
    parseArgs([], () => '/top'),
    null
  )
})

// The origin read a trailing `--phase` as no flag at all and ran the propose phase.
test('a trailing --phase with no value is a usage error, not a propose run', () => {
  assert.equal(
    parseArgs(['c', '--phase'], () => '/top'),
    null
  )
  assert.equal(
    parseArgs(['--phase'], () => '/top'),
    null
  )
})

test('baseRef prefers origin/<base>, falls back to the local branch, and refuses no base', () => {
  assert.equal(
    baseRef({ base: 'develop' }, (ref) => ref === 'refs/remotes/origin/develop'),
    'origin/develop'
  )
  assert.equal(
    baseRef({ base: 'develop' }, () => false),
    'develop'
  )
  for (const meta of [null, {}, { base: '' }, { base: 3 }]) assert.throws(() => baseRef(meta, () => true), /no "base" branch/)
})

// ---------------------------------------------------------------- CLI, against a real repository

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'plan-symbols.mjs')
const gitIn = (root, ...args) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const runCli = (args, cwd) => {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', cwd })
  return { code: r.status, out: JSON.parse(r.stdout) }
}

// develop holds src/old.ts; the feature branch adds src/new.ts and grows src/old.ts. The plan
// creates the one and names a range on the other that only the branch's version reaches.
function hostRepo(meta) {
  const root = mkdtempSync(join(tmpdir(), 'adf-plan-symbols-'))
  gitIn(root, 'init', '-q', '-b', 'develop')
  put(root, 'src/old.ts', 'a\nb\n')
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-q', '-m', 'base')
  gitIn(root, 'checkout', '-q', '-b', 'feat')
  put(root, 'src/new.ts', 'export const made = 1\n')
  put(root, 'src/old.ts', 'a\nb\nc\nd\n')
  put(root, 'openspec/changes/c/plan.md', task(1, '- Create: `src/new.ts` — x\n- Modify: `src/old.ts:1-40` — y'))
  put(root, 'openspec/changes/c/tasks.md', '- [ ] 1.1 open\n')
  if (meta) put(root, 'openspec/changes/c/.adf.json', `${JSON.stringify(meta)}\n`)
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-q', '-m', 'feature')
  return root
}

test('the CLI prints { ok, findings } and exits 1 on findings, 0 when clean', () => {
  const root = hostRepo({ base: 'develop' })
  const propose = runCli(['c', '--root', root])
  assert.equal(propose.code, 1)
  assert.equal(propose.out.ok, false)
  assert.deepEqual(
    propose.out.findings.map((f) => [f.task, f.kind, f.path]),
    [
      [1, 'path-exists', 'src/new.ts'],
      [1, 'range-beyond', 'src/old.ts']
    ]
  )
  // Without --root the repository is the cwd's git top level, even from a subdirectory.
  assert.deepEqual(runCli(['c'], join(root, 'src')).out, propose.out)
})

test('--phase apply reads the base from .adf.json and exempts what the branch did since it', () => {
  const root = hostRepo({ base: 'develop' })
  assert.deepEqual(runCli(['c', '--root', root, '--phase', 'apply']), { code: 0, out: { ok: true, findings: [] } })
  // origin/<base>, when it exists, is preferred: here it is the branch itself, so nothing is exempt.
  gitIn(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
  assert.equal(runCli(['c', '--root', root, '--phase', 'apply']).out.findings.length, 2)
})

test('--phase apply with no base in .adf.json, or no .adf.json, is exit 2', () => {
  for (const root of [hostRepo({ schema: 'adf' }), hostRepo(null)]) {
    const r = runCli(['c', '--root', root, '--phase', 'apply'])
    assert.equal(r.code, 2)
    assert.equal(r.out.ok, false)
    assert.match(r.out.error, /no "base" branch/)
    // The propose phase does not need a base.
    assert.equal(runCli(['c', '--root', root]).code, 1)
  }
})

test('a missing plan.md and a usage error are exit 2 with an error', () => {
  const root = hostRepo({ base: 'develop' })
  const none = runCli(['nope', '--root', root])
  assert.equal(none.code, 2)
  assert.match(none.out.error, /openspec\/changes\/nope\/plan\.md does not exist/)
  const usage = runCli(['c', '--root', root, '--phase'])
  assert.equal(usage.code, 2)
  assert.match(usage.out.error, /^usage:/)
  assert.deepEqual(usage.out.findings, [])
})
