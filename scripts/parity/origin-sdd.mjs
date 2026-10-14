#!/usr/bin/env node
// Dev tool: compares the SDD workspace check (plugins/adf/scripts/sdd.mjs) with the origin's
// .claude/scripts/check-sdd-workspace.mjs. Each workspace layout is built in its own temporary
// directory under the system temp directory; nothing is written in the origin project.
//
//   node scripts/parity/origin-sdd.mjs <origin project root>
//
// A matrix of layouts — no workspace, an empty one, other workspaces only, the shared `plan`
// workspace empty, holding this change's ledger, another plan's, one whose header names no
// plan or names it off the first line, a directory or an unreadable file where the ledger
// should be, the workspace root or `plan` as a plain file — crossed with several change
// names. For each case both scripts run as child processes in that directory, and both
// checkSddWorkspace functions are called on it: the exit code, the refusal text and the
// `{ ok, foreign }` result are compared. The origin takes the change name as its one argument;
// ours takes it as --change <name>, with --root naming the directory (or, in a second run,
// without --root from the working directory). The one deliberate difference is the output
// form:
//   json-output   the origin prints nothing when clean and four lines on stderr on a refusal;
//                 ours prints one JSON object on stdout ({ ok, change, foreign } / plus `error`,
//                 the same four lines joined by spaces / { ok, error, usage }); its usage line
//                 names sdd.mjs, --change and --root
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkSddWorkspace as ourCheck } from '../../plugins/adf/scripts/lib/sdd.mjs'

const origin = process.argv[2]
const originScript = origin && join(origin, '.claude', 'scripts', 'check-sdd-workspace.mjs')
if (!originScript || !existsSync(originScript)) {
  console.error('usage: origin-sdd.mjs <origin project root with .claude/scripts/check-sdd-workspace.mjs>')
  process.exit(2)
}
const { checkSddWorkspace: theirCheck } = await import(pathToFileURL(originScript).href)
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'sdd.mjs')
const base = mkdtempSync(join(tmpdir(), 'adf-parity-sdd-'))
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

const header = (plan, dash = '—') => `# SDD ledger ${dash} plan: ${plan}\n`
const ledger = (text) => (root) => {
  mkdirSync(join(root, '.superpowers', 'sdd', 'plan'), { recursive: true })
  writeFileSync(join(root, '.superpowers', 'sdd', 'plan', 'progress.md'), text)
}
const layouts = {
  'no workspace': () => {},
  'superpowers only': (r) => mkdirSync(join(r, '.superpowers')),
  'empty sdd root': (r) => mkdirSync(join(r, '.superpowers', 'sdd'), { recursive: true }),
  'other workspaces only': (r) => {
    for (const name of ['my-change', 'other', 'planned']) {
      mkdirSync(join(r, '.superpowers', 'sdd', name), { recursive: true })
      writeFileSync(join(r, '.superpowers', 'sdd', name, 'progress.md'), header(`openspec/changes/${name === 'my-change' ? 'other' : name}/plan.md`))
    }
  },
  'plan empty': (r) => mkdirSync(join(r, '.superpowers', 'sdd', 'plan'), { recursive: true }),
  'own ledger': ledger(header('openspec/changes/my-change/plan.md')),
  'own ledger, hyphen': ledger(header('openspec/changes/my-change/plan.md', '-')),
  'own ledger, extra lines': ledger(`${header('openspec/changes/my-change/plan.md')}\n- [x] Task 1\n`),
  'foreign ledger': ledger(header('openspec/changes/other/plan.md')),
  'foreign ledger, prefix name': ledger(header('openspec/changes/my-change-2/plan.md')),
  'ledger, no leading slash': ledger(header('my-change/plan.md')),
  'ledger, absolute plan': ledger(header('/work/openspec/changes/my-change/plan.md')),
  'header on line two': ledger(`# Progress\n${header('openspec/changes/my-change/plan.md')}`),
  'header indented': ledger(`  ${header('openspec/changes/my-change/plan.md')}`),
  'header without plan': ledger('# SDD ledger — plan:\n'),
  'header spacing': ledger('#SDD ledger—plan:openspec/changes/other/plan.md\n'),
  'no header': ledger('# Progress ledger (v2)\n\n- [x] Task 1\n'),
  'empty ledger': ledger(''),
  'crlf ledger': ledger(header('openspec/changes/my-change/plan.md').replace('\n', '\r\n')),
  'ledger is a directory': (r) => mkdirSync(join(r, '.superpowers', 'sdd', 'plan', 'progress.md'), { recursive: true }),
  'dangling ledger link': (r) => {
    mkdirSync(join(r, '.superpowers', 'sdd', 'plan'), { recursive: true })
    symlinkSync(join(r, 'nowhere.md'), join(r, '.superpowers', 'sdd', 'plan', 'progress.md'))
  },
  'sdd root is a file': (r) => {
    mkdirSync(join(r, '.superpowers'))
    writeFileSync(join(r, '.superpowers', 'sdd'), 'x')
  },
  'plan is a file': (r) => {
    mkdirSync(join(r, '.superpowers', 'sdd'), { recursive: true })
    writeFileSync(join(r, '.superpowers', 'sdd', 'plan'), 'x')
  },
  ...(asRoot
    ? {}
    : {
        'ledger unreadable': (r) => {
          ledger(header('openspec/changes/my-change/plan.md'))(r)
          chmodSync(join(r, '.superpowers', 'sdd', 'plan', 'progress.md'), 0o000)
        }
      })
}
const changes = ['my-change', 'other', 'my', 'plan', 'changes', 'openspec', 'planned']

function theirOutcome(proc) {
  if (proc.status === 0) return { code: 0, form: 'silent' }
  const text = proc.stderr.trimEnd().split('\n').join(' ')
  return { code: proc.status, error: proc.status === 2 ? 'usage' : text, form: 'stderr-prose' }
}
function ourOutcome(proc) {
  const out = JSON.parse(proc.stdout)
  if (proc.status === 0 && out.ok === true) return { code: 0, form: 'stdout-json' }
  return { code: proc.status, error: proc.status === 2 && /^usage: /.test(out.error) ? 'usage' : out.error, form: 'stdout-json' }
}
// The library result, with the filesystem bound to the layout's directory.
const lib = (check, root, changeName) =>
  check({ changeName, read: (f) => readFileSync(join(root, f), 'utf8'), list: (d) => readdirSync(join(root, d)) })

const differences = []
let compared = 0
let refused = 0
const compare = (caseInfo, root, theirArgv, ourArgv, changeName) => {
  compared++
  const their = theirOutcome(spawnSync('node', [originScript, ...theirArgv], { cwd: root, encoding: 'utf8' }))
  const ours = ourOutcome(spawnSync('node', [ourScript, ...ourArgv], { cwd: root, encoding: 'utf8' }))
  if (their.code !== 0) refused++
  const theirLib = changeName ? lib(theirCheck, root, changeName) : null
  const ourLib = changeName ? lib(ourCheck, root, changeName) : null
  const { form: theirForm, ...theirContent } = their
  const { form: ourForm, ...ourContent } = ours
  const sameContent = JSON.stringify(theirContent) === JSON.stringify(ourContent) && JSON.stringify(theirLib) === JSON.stringify(ourLib)
  if (sameContent && theirForm === ourForm) return
  differences.push({ case: caseInfo, theirs: { ...their, lib: theirLib }, ours: { ...ours, lib: ourLib }, explained: sameContent ? 'json-output' : null })
}

for (const [layout, build] of Object.entries(layouts)) {
  const root = mkdtempSync(join(base, 'case-'))
  build(root)
  for (const change of changes) {
    compare({ layout, change }, root, [change], ['--change', change, '--root', root], change)
    compare({ layout, change, rootFlag: false }, root, [change], ['--change', change], change)
  }
  compare({ layout, change: null }, root, [], ['--root', root], null)
  compare({ layout, change: '' }, root, [''], ['--change', '', '--root', root], null)
}

const unexplained = differences.filter((d) => d.explained === null)
const byReason = {}
for (const d of differences) if (d.explained) byReason[d.explained] = (byReason[d.explained] ?? 0) + 1
console.log(JSON.stringify({ compared, clean: compared - refused, refused, differences: differences.length, explained: byReason, unexplained }, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
