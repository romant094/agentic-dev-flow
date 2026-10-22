// Dev tool: the replies of a replay (iteration 14, step 4). Every place an agent writes in the
// port's cycle is filled from the origin's records only, never invented:
//
//   propose  the artifacts: from the change directory as the branch first committed each file
//            (the propose commit, when the branch is kept), else from the archive directory, with
//            tasks.md's ticks cleared; the scope is empty unless keys are given (the origin had no
//            scope step), and a scope key has no recorded check
//   apply    `T<n> impl` from the branch commit whose subject is the plan's Commit step of Task n;
//            `T<n> review` clean when the task is ticked and no ledger ruling names it; `merge-review
//            <G>` clean at the merge of the group's branch; `final-review` clean when no commit
//            but the apply record follows the last task commit; `sweep` clean when no ledger record
//            names the sweep, its dispositions the deltas' Code Disposition lines; the ledger's
//            deviation, debt and ruling records as the orchestrator's writes
//   verify   `verify c4` from verify.md's coherence section; `verify c8` from its stale-skill
//            section, answered per candidate the replay lists (c8Reply); a ruling on a numbered
//            check also in the port's shape, the check named by the section's title
//   review   `ai-review r<k>` from review.md's findings table and rounds line; `ai-fix F<n> r1`
//            from a `fixed in <sha>` disposition and the finding's paragraph
//   archive  `ingest` from the memory diff of the ingest commit (or the squash) and its log
//            entry; the ledger's resolve records; `spec-merge <capability>` per conflict the
//            replay finds (specMergeReply), from the origin's main spec after the merge
//
// Each built reply is checked by the port's own schema or check function and carries `source`:
// the commit and file (and line) it came from, or `why` for a reply built from the absence of a
// record. A field the records cannot give but the replay supplies is listed under `injected`, so a
// difference it causes is classified `injected`. A reply the records cannot give is
// `{ missing: <why> }`, with `partial` holding what they do give.
//
// Git is read from the sandbox's cache (it holds every object of the origin; the origin's local
// branches are its refs/remotes/origin/*); the port's check functions that read files run on a
// scratch copy under the sandbox's TMPDIR, and the git they run themselves only reads the cache or
// that copy. Nothing is read from the origin itself.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateJson } from '../../../plugins/adf/scripts/lib/json-schema.mjs'
import { checkReply, schemaOf } from '../../../plugins/adf/scripts/lib/reply.mjs'
import { dispatchName, parseGraph, parseName, taskBody } from '../../../plugins/adf/scripts/lib/dispatch.mjs'
import { parsePlan, parseTaskItems } from '../../../plugins/adf/scripts/lib/plan.mjs'
import { checkFindings, checkFix } from '../../../plugins/adf/scripts/lib/review.mjs'
import { checkVerifyReply } from '../../../plugins/adf/scripts/lib/verify-reply.mjs'
import { checkIngestReply } from '../../../plugins/adf/scripts/lib/ingest.mjs'
import { checkSpecMergeReply } from '../../../plugins/adf/scripts/lib/spec-merge.mjs'
import { extractRequirementsSection, parseProposalCapabilities, validateChangeDeltaSpecs } from '../../../plugins/adf/scripts/lib/specs.mjs'
import { removalsIn } from '../../../plugins/adf/scripts/lib/sweep.mjs'
import { buildRecord } from '../../../plugins/adf/scripts/lib/ledger.mjs'
import { recordName, TESTS_DIR } from '../../../plugins/adf/scripts/lib/suite.mjs'
import { assertIsolated } from './sandbox.mjs'

export const PHASES = ['propose', 'apply', 'verify', 'review', 'archive']
export const ARCHIVE = 'openspec/changes/archive'
export const MEMORY = '.claude/memory/'
export const MEMORY_LOG = ['.claude/memory/log.md', '.claude/memory/log-archive/']
export const DEBT_TREE = '.claude/memory/tech-debt/'
// The artifacts the propose phase writes; verify.md, review.md and the records come later.
const PROPOSE_FILES = /^(brainstorm\.md|proposal\.md|design\.md|tasks\.md|plan\.md|specs\/.+\.md)$/
// The origin's numbered verify checks by their title, and the port's check id for each.
export const VERIFY_TITLES = {
  'structural validation': 'validation',
  'task completion': 'tasks',
  'delta spec sync state': 'deltas',
  'implementation signal': 'tree',
  'tests for what this change touched': 'test-record',
  'no leftover group worktree': 'worktrees',
  'out-of-plan commits': 'out-of-plan',
  'migration ordering': 'ext:adf-prisma:migration-order'
}

// ---------------------------------------------------------------- git on the cache

function reader(sandbox) {
  const run = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: sandbox.cache, env: sandbox.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
  const orNull = (...args) => {
    try {
      return run(...args)
    } catch {
      return null
    }
  }
  return {
    run,
    show: (rev, path) => orNull('show', `${rev}:${path}`),
    resolve: (rev) => orNull('rev-parse', '--verify', '--quiet', `${rev}^{commit}`)?.trim() ?? null,
    files: (rev, path) => (orNull('ls-tree', '-r', '--name-only', rev, '--', `${path}/`) ?? '').split('\n').filter(Boolean).map((f) => f.slice(path.length + 1)),
    // First-parent commits of base..tip, oldest first: { sha, subject, parents, files }.
    commits(base, tip) {
      const out = run('log', '--first-parent', '--reverse', '--no-renames', '--name-only', '--format=%x1e%H%x1f%P%x1f%s', `${base}..${tip}`)
      return out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((chunk) => {
        const [head, ...files] = chunk.split('\n')
        const [sha, parents, subject] = head.split('\x1f')
        return { sha, parents: parents.split(' ').filter(Boolean), subject, files: files.map((f) => f.trim()).filter(Boolean) }
      })
    },
    // Every non-merge commit of base..tip, group branches included: { sha, subject, files }.
    nonMerge(base, tip) {
      const out = run('log', '--no-merges', '--reverse', '--no-renames', '--name-only', '--format=%x1e%H%x1f%s', `${base}..${tip}`)
      return out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((chunk) => {
        const [head, ...files] = chunk.split('\n')
        const [sha, subject] = head.split('\x1f')
        return { sha, subject, files: files.map((f) => f.trim()).filter(Boolean) }
      })
    },
    isAncestor: (a, b) => orNull('merge-base', '--is-ancestor', a, b) !== null,
    // The new side's line numbers each hunk of `a..b -- path` added.
    added(a, b, path) {
      const out = new Set()
      for (const m of run('diff', '--no-color', '--no-ext-diff', '-U0', a, b, '--', path).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        for (let i = 0; i < count; i++) out.add(start + i)
      }
      return out
    },
    changed: (a, b, path) => run('diff', '--name-status', '--no-renames', a, b, '--', path).split('\n').filter(Boolean).map((l) => {
      const [status, file] = l.split('\t')
      return { status, file }
    })
  }
}

// ---------------------------------------------------------------- shapes

const lineOf = (text, re) => {
  const i = String(text ?? '').split('\n').findIndex((l) => re.test(l))
  return i === -1 ? null : i + 1
}
const src = (commit, file, line = null, extra = {}) => ({ commit, file, ...(line ? { line } : {}), ...extra })
const missing = (phase, kind, name, why, partial) => ({ phase, kind, name, missing: why, ...(partial ? { partial } : {}) })
const built = (phase, kind, name, fields) => ({ phase, kind, name, ...fields })

// A JSON reply checked by `check(text)` returning { valid, errors }.
function replyItem(phase, name, reply, source, check, extra = {}) {
  const role = parseName(name)?.role ?? name.split(' ')[0]
  const text = JSON.stringify(reply)
  let result
  try {
    result = check(text)
  } catch (error) {
    result = { valid: false, errors: [error.message] }
  }
  return built(phase, 'reply', name, { role, reply, source, check: { by: extra.by, valid: result.valid === true, errors: result.errors ?? [] }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'by')) })
}

// ---------------------------------------------------------------- records of the origin

// The ledger's records, each with the phase of the session before it.
function ledgerRecords(text) {
  let phase = null
  const out = []
  String(text ?? '').split('\n').forEach((l, i) => {
    if (!l.trim()) return
    const r = JSON.parse(l)
    if (r.kind === 'session') phase = r.phase
    out.push({ ...r, phase: r.kind === 'session' ? r.phase : phase, line: i + 1 })
  })
  return out
}

// The `## <n>. <title>` sections of a record: { number, title, start, end } (1-based lines).
function numberedSections(text) {
  const lines = String(text ?? '').split('\n')
  const heads = []
  lines.forEach((l, i) => {
    const m = /^##\s+(\d+)\.\s+(.+?)\s*(?:\(.*\))?\s*$/.exec(l)
    if (m) heads.push({ number: Number(m[1]), title: m[2].replace(/`/g, '').trim(), start: i + 1 })
  })
  return heads.map((h, k) => ({ ...h, end: k + 1 < heads.length ? heads[k + 1].start - 1 : lines.length, text: lines.slice(h.start, k + 1 < heads.length ? heads[k + 1].start - 1 : lines.length).join('\n') }))
}

// The bullets under a bold label (`**Label** ...`) up to the next bold label or heading.
function bulletsAfter(text, label) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.startsWith(`**${label}`))
  if (at === -1) return null
  const out = []
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\*\*|^#|^---/.test(lines[i])) break
    const m = /^-\s+(.*)$/.exec(lines[i])
    if (m) out.push({ text: m[1].trim(), offset: i - at })
    else if (out.length && lines[i].startsWith('  ')) out.at(-1).text += ` ${lines[i].trim()}`
  }
  return { line: at + 1, bullets: out }
}

const isNone = (text) => /^(none\b|—|-\s*$)/i.test(text.replace(/[`*]/g, '').trim())

// ---------------------------------------------------------------- the candidate's history

function history(git, candidate) {
  const archive = `${ARCHIVE}/${candidate.dir}`
  const change = `openspec/changes/${candidate.name}`
  const tip = candidate.history === 'branch' && candidate.branch ? git.resolve(`refs/remotes/origin/${candidate.branch}`) ?? git.resolve(`refs/heads/${candidate.branch}`) : null
  const commits = tip ? git.commits(candidate.base.commit, tip) : []
  const all = tip ? git.nonMerge(candidate.base.commit, tip) : []
  const firstAdding = (file) => commits.find((c) => c.files.includes(`${change}/${file}`))?.sha ?? null
  const archiveCommit = commits.find((c) => c.files.some((f) => f.startsWith(`${archive}/`)))?.sha ?? null
  return { archive, change, tip, commits, all, firstAdding, archiveCommit, merge: candidate.merge }
}

// ---------------------------------------------------------------- propose

function proposePhase(git, h, scratch, candidate, scope) {
  const out = []
  const files = git.files(h.merge, h.archive).filter((f) => PROPOSE_FILES.test(f)).sort()
  const texts = {}
  for (const file of files) {
    const first = h.firstAdding(file)
    let text
    let source
    const injected = []
    if (first) {
      text = git.show(first, `${h.change}/${file}`)
      source = [src(first, `${h.change}/${file}`)]
    } else {
      text = git.show(h.merge, `${h.archive}/${file}`)
      source = [src(h.merge, `${h.archive}/${file}`)]
      if (file === 'tasks.md') {
        text = text.replace(/^(\s*- \[)[xX](\])/gm, '$1 $2')
        injected.push({ field: 'text', why: 'the archived tasks.md is ticked; its ticks are cleared, as propose writes it' })
      }
    }
    texts[file] = text
    out.push(built('propose', 'artifact', file, { text, source, ...(injected.length ? { injected } : {}) }))
  }
  // The port's own readers over the artifacts, on a scratch copy of the change directory.
  const dir = join(scratch, 'openspec', 'changes', candidate.name)
  for (const [file, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const specs = Object.keys(texts).some((f) => f.startsWith('specs/')) ? validateChangeDeltaSpecs(dir) : null
  for (const item of out) {
    if (item.name.startsWith('specs/')) {
      const issues = specs.issues.filter((i) => String(i.path).includes(item.name.split('/')[1]) || i.path === 'file')
      item.check = { by: 'specs.mjs validateChangeDeltaSpecs', valid: specs.valid, errors: issues.filter((i) => i.level === 'ERROR').map((i) => `${i.path}: ${i.message}`) }
    } else if (item.name === 'plan.md') {
      const plan = parsePlan(item.text)
      item.check = { by: 'plan.mjs parsePlan', valid: plan.tasks.length > 0, errors: plan.tasks.length ? [] : ['no ### Task N section'] }
    } else if (item.name === 'tasks.md') {
      const items = parseTaskItems(item.text)
      item.check = { by: 'plan.mjs parseTaskItems', valid: items.length > 0 && items.every((i) => !i.done), errors: items.length ? items.filter((i) => i.done).map((i) => `${i.id} is ticked`) : ['no task item'] }
    } else if (item.name === 'proposal.md') {
      const caps = parseProposalCapabilities(item.text)
      item.check = { by: 'specs.mjs parseProposalCapabilities', valid: caps.section, errors: caps.section ? [] : ['no Capabilities section'] }
    } else item.check = { by: 'none', valid: true, errors: [], note: 'prose; its gates run in the propose driver' }
  }
  for (const key of scope) out.push(missing('propose', 'reply', `scope-check ${key}`, `the origin had no scope step, so no check of ${key} is recorded`))
  return { items: out, texts }
}

// ---------------------------------------------------------------- apply

const COMMIT_STEP = /\*\*Step\s+\d+:\s*Commit\*\*\s*[—–-]+\s*`([^`]+)`/

function applyPhase(git, h, archived, ledger, candidate) {
  const out = []
  const planText = archived['plan.md']
  if (!planText) return [missing('apply', 'reply', 'apply', 'the archive holds no plan.md')]
  const { tasks } = parsePlan(planText)
  const tasksText = archived['tasks.md'] ?? ''
  const items = parseTaskItems(tasksText)
  const commits = h.commits.filter((c) => c.parents.length === 1)
  const applyRecord = commits.find((c) => c.files.some((f) => f.endsWith('/.apply-test-record.md')) || /record apply of/.test(c.subject))
  const taskCommit = new Map()

  for (const task of tasks) {
    const body = taskBody(planText, task.number) ?? ''
    const step = /\*\*Step\s+\d+:\s*Commit\*\*\s*[—–-]+\s*(.*)$/m.exec(body)?.[1]?.trim() ?? null
    const message = COMMIT_STEP.exec(body)?.[1]?.trim() ?? null
    const commitsNothing = step !== null && /^none\b/i.test(step)
    const implemented = String(task.implements ?? '').match(/\b\d+\.\d+\b/g) ?? []
    const own = items.filter((i) => implemented.includes(i.id))
    const ticked = own.length > 0 && own.every((i) => i.done)
    const tickSource = own.map((i) => src(h.merge, `${h.archive}/tasks.md`, i.line))
    const name = dispatchName({ role: 'impl', task: task.number })
    if (!ticked) out.push(missing('apply', 'reply', name, `tasks.md does not tick every item Task ${task.number} implements (${implemented.join(', ') || 'none named'})`))
    else if (!h.tip) out.push(missing('apply', 'reply', name, 'no per-commit history: the change was squash-merged and no local branch survives, so one squash commit holds every task', { outcome: 'done', source: tickSource }))
    else {
      // A task whose Commit step says none commits nothing: its done reply names no commit.
      const matched = commitsNothing ? [] : message ? h.all.filter((c) => c.subject.trim() === message) : []
      if (matched.length === 0 && !commitsNothing) out.push(missing('apply', 'reply', name, message ? `no branch commit has the subject of Task ${task.number}'s Commit step ("${message}")` : `Task ${task.number} has no Commit step naming its message`))
      else {
        if (matched.length) taskCommit.set(task.number, matched.at(-1).sha)
        if (matched.some((c) => !commits.some((f) => f.sha === c.sha))) matched.forEach((c) => (c.group = true))
        const reply = { role: 'impl', outcome: 'done', commits: matched.map((c) => c.sha), concerns: [], summary: commitsNothing ? `Task ${task.number}: ${step}` : matched.map((c) => c.subject).join('; ') }
        const slot = `.superpowers/sdd/${candidate.name}/${TESTS_DIR}/${recordName(name)}-replay.json`
        out.push(replyItem('apply', name, reply, [...matched.map((c) => src(c.sha, null, null, { subject: c.subject })), src(h.merge, `${h.archive}/plan.md`, task.line), ...tickSource], (text) => {
          const errors = validateJson(schemaOf('impl'), { ...JSON.parse(text), testRuns: [slot] })
          return { valid: errors.length === 0, errors }
        }, {
          by: 'impl.schema.json (with the testRuns slot filled)',
          injected: [{ field: 'testRuns', value: [slot], why: 'the origin keeps no per-task test-run record; the driver writes one through suite.mjs covering and names it here (completeImpl)' }],
          context: 'the commits are origin commits; the driver names each one\'s cherry-pick, and dispatch.mjs reply checks them in the replay worktree'
        }))
      }
    }
    // The task's review: clean when the task is ticked and no ruling names it.
    const reviewName = dispatchName({ role: 'review', task: task.number })
    const rulings = ledger.filter((r) => r.kind === 'ruling' && String(r.task ?? '') === String(task.number))
    if (!ticked) out.push(missing('apply', 'reply', reviewName, `Task ${task.number} is not ticked`))
    else if (rulings.length) out.push(missing('apply', 'reply', reviewName, `${rulings.map((r) => r.id).join(', ')} names a finding of Task ${task.number} whose severity, kind, category, file and line the records lack`, { rulings: rulings.map((r) => ({ id: r.id, finding: r.finding, decision: r.decision })) }))
    else {
      const reply = { role: 'review', summary: `Task ${task.number}: no finding; the origin ticked it and no ruling names it`, findings: [], unverifiable: [] }
      out.push(replyItem('apply', reviewName, reply, [...tickSource, { why: `no ledger ruling names Task ${task.number}` }], (text) => checkReply('review', text, { parts: parseName(reviewName), history: [], rulings: [] }), { by: 'reply.mjs checkReply review' }))
    }
  }

  // Merge reviews: one per group, clean at the merge of the group's branch.
  const groups = parseGraph(planText)
  const deviations = ledger.filter((r) => r.kind === 'deviation')
  const groupRefs = {}
  for (const g of groups) {
    const name = dispatchName({ role: 'merge-review', group: g.letter })
    // The group's branch, merged by a merge commit or fast-forwarded into the change branch.
    const ref = candidate.branch ? git.resolve(`refs/remotes/origin/${candidate.branch}--group-${g.letter}`) ?? git.resolve(`refs/heads/${candidate.branch}--group-${g.letter}`) : null
    const merge = h.commits.find((c) => c.parents.length > 1 && c.subject.includes(`--group-${g.letter}'`)) ?? (ref && h.tip && git.isAncestor(ref, h.tip) ? { sha: ref, subject: `the tip of ${candidate.branch}--group-${g.letter}, fast-forwarded` } : null)
    if (ref) groupRefs[g.letter] = ref
    const ruled = ledger.some((r) => r.kind === 'ruling' && new RegExp(`\\bgroup ${g.letter}\\b`, 'i').test(`${r.finding} ${r.decision}`))
    // Commits of the group's branch after its last task commit that touch code: a fix round.
    const own = ref ? git.nonMerge(candidate.base.commit, ref) : []
    const lastTask = Math.max(-1, ...g.tasks.map((n) => own.findIndex((c) => c.sha === taskCommit.get(n))))
    const fixes = lastTask === -1 ? [] : own.slice(lastTask + 1).filter((c) => c.files.some((f) => !f.startsWith(`${h.change}/`)))
    if (!h.tip) out.push(missing('apply', 'reply', name, 'no per-commit history to show the group\'s merge'))
    else if (!merge) out.push(missing('apply', 'reply', name, `the origin merged no branch of group ${g.letter}${deviations.length ? ` (${deviations.map((d) => `${d.id}: ${d.rule}`).join('; ')})` : ''}`))
    else if (ruled) out.push(missing('apply', 'reply', name, `a ledger ruling names group ${g.letter}`))
    else if (fixes.length) out.push(missing('apply', 'reply', name, `group ${g.letter}'s branch has commits after its last task commit that touch files outside the change directory (${fixes.map((c) => c.sha.slice(0, 8)).join(', ')}): the merge review's findings are not recorded`))
    else out.push(replyItem('apply', name, { role: 'merge-review', summary: `group ${g.letter} merged with no finding`, findings: [], unverifiable: [] }, [src(merge.sha, null, null, { subject: merge.subject }), { why: `no ledger ruling names group ${g.letter} and no commit follows its last task commit on its branch` }], (text) => checkReply('merge-review', text, { parts: parseName(name), history: [], rulings: [] }), { by: 'reply.mjs checkReply merge-review' }))
  }

  // The reuse sweep.
  const deltas = Object.entries(archived).filter(([f]) => f.startsWith('specs/'))
  const removals = deltas.flatMap(([f, text]) => removalsIn(text).map((r) => ({ ...r, spec: f })))
  const sweepRecords = ledger.filter((r) => r.kind !== 'session' && /\bsweep\b/i.test(JSON.stringify(r)))
  if (sweepRecords.length) out.push(missing('apply', 'reply', 'sweep', `${sweepRecords.map((r) => r.id).join(', ')} names the sweep; its findings are not recorded`))
  else if (removals.some((r) => r.codeDisposition === null)) out.push(missing('apply', 'reply', 'sweep', `a REMOVED or RENAMED requirement has no Code Disposition: ${removals.filter((r) => r.codeDisposition === null).map((r) => r.requirement ?? r.from).join(', ')}`))
  else {
    const reply = { role: 'sweep', findings: [], ...(removals.length ? { dispositions: removals.map((r) => ({ requirement: r.requirement ?? r.from, disposition: r.codeDisposition })) } : {}) }
    // The DUP markers dupFilter reads: none apply to an empty finding list, so an empty repository.
    const ctx = { root: join(dirname(h.scratch), 'empty'), sweep: { removedOrRenamed: removals, secondQuestion: removals.length > 0 } }
    mkdirSync(ctx.root, { recursive: true })
    execFileSync('git', ['init', '-q', ctx.root], { env: h.env, stdio: 'ignore' })
    out.push(replyItem('apply', 'sweep', reply, [{ why: 'no ledger record names the sweep: the origin recorded a sweep only by a dismissal or a consolidating commit' }, ...removals.map((r) => src(h.merge, `${h.archive}/${r.spec}`))], (text) => checkReply('sweep', text, ctx), { by: 'reply.mjs checkReply sweep' }))
  }

  // The final review: clean when no commit but the apply record follows the last task commit.
  // The first-parent commit that brought each task commit in: itself, or a group branch's merge.
  const fp = h.commits
  const position = (sha) => fp.findIndex((c) => c.sha === sha || (c.parents.length > 1 && git.isAncestor(sha, c.sha)))
  const lastAt = Math.max(-1, ...[...taskCommit.values()].map(position))
  const last = lastAt === -1 ? undefined : lastAt
  const finalName = dispatchName({ role: 'final-review' })
  if (!h.tip) out.push(missing('apply', 'reply', finalName, 'no per-commit history to show whether a fix followed the final review'))
  else if (last === undefined || !applyRecord) out.push(missing('apply', 'reply', finalName, applyRecord ? 'no task commit was found' : 'no apply record commit on the branch'))
  else {
    // A group branch's own fix commits belong to its merge review, not to the final review.
    const inGroup = (sha) => Object.values(groupRefs).some((ref) => git.isAncestor(sha, ref))
    const between = fp.slice(last + 1, fp.findIndex((c) => c.sha === applyRecord.sha)).filter((c) => c.parents.length === 1 && c.files.some((f) => !f.startsWith(`${h.change}/`)) && !inGroup(c.sha))
    if (between.length) out.push(missing('apply', 'reply', finalName, `commits after the last task commit touch files outside the change directory: ${between.map((c) => c.sha.slice(0, 8)).join(', ')}; the final review's findings are not recorded`))
    else out.push(replyItem('apply', finalName, { role: 'final-review', summary: 'no finding: the apply record follows the last task commit directly', findings: [], unverifiable: [] }, [src(fp[last].sha, null, null, { subject: fp[last].subject }), src(applyRecord.sha, null, null, { subject: applyRecord.subject })], (text) => checkReply('final-review', text, { parts: parseName(finalName), history: [], rulings: [] }), { by: 'reply.mjs checkReply final-review' }))
  }
  return out
}

// ---------------------------------------------------------------- ledger writes

const FIELDS_OF = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'kind', 'at', 'sessionId', 'phase', 'line'].includes(k)).map(([k, v]) => [k, String(v)]))

// The orchestrator's ledger writes in the port's shapes, each checked by lib/ledger.mjs buildRecord
// in order (a resolve needs its debt record before it).
function ledgerWrites(h, ledger, verifyText) {
  const out = []
  const existing = []
  const sections = numberedSections(verifyText)
  for (const r of ledger) {
    if (r.kind === 'session') continue
    const source = [src(h.merge, `${h.archive}/ledger.jsonl`, r.line, { id: r.id })]
    const write = (kind, fields, extra = {}) => {
      let record = null
      const errors = []
      try {
        record = buildRecord(kind, fields, { existing, sessionId: 'replay', now: r.at })
        existing.push(record)
      } catch (error) {
        errors.push(error.message)
      }
      out.push(built(r.phase ?? 'apply', 'ledger', extra.name ?? `${kind} ${r.id}`, { record: { kind, fields }, source, check: { by: 'ledger.mjs buildRecord', valid: errors.length === 0, errors }, ...extra }))
    }
    const fields = FIELDS_OF(r)
    // The origin's resolution flow-debt is adf-debt here (scripts/parity/origin-ledger.mjs, renamed-resolution).
    if (r.kind === 'resolve' && fields.as === 'flow-debt') write('resolve', { ...fields, as: 'adf-debt' }, { renamed: 'the origin\'s --as flow-debt is adf-debt here (scripts/parity/origin-ledger.mjs: renamed-resolution)' })
    else write(r.kind, fields)
    // A ruling on a numbered verify check, in the port's shape too: the verdict reads that one.
    const m = r.kind === 'ruling' && !r.task ? /\bverify Check (\d+)\b/i.exec(r.finding ?? '') : null
    if (m) {
      const section = sections.find((s) => s.number === Number(m[1]))
      const id = section ? VERIFY_TITLES[section.title.toLowerCase()] : undefined
      if (id) write('ruling', { check: id, reason: r.decision }, {
        name: `ruling ${r.id} (check ${id})`, source: [...source, src(h.merge, `${h.archive}/verify.md`, section.start)], derived: `the port's check ruling for origin Check ${m[1]} (${section.title})` })
      else out.push(missing(r.phase ?? 'verify', 'ledger', `ruling ${r.id} (check)`, `origin Check ${m[1]} ${section ? `(${section.title}) ` : ''}has no port check id`))
    }
  }
  return out
}

// ---------------------------------------------------------------- verify

function verifyPhase(git, h, archived, scratch, cache) {
  const out = []
  const text = archived['verify.md']
  if (!text) return [missing('verify', 'reply', 'verify c4', 'no verify.md'), missing('verify', 'reply', 'verify c8', 'no verify.md')]
  const sections = numberedSections(text)
  const file = `${h.archive}/verify.md`

  // c4
  const c4 = sections.find((s) => /coherence/i.test(s.title))
  const design = Boolean(archived['design.md'])
  const deltas = Object.keys(archived).some((f) => f.startsWith('specs/'))
  const kase = design && deltas ? 'both' : design ? 'no-deltas' : deltas ? 'no-design' : null
  const removals = Object.entries(archived).filter(([f]) => f.startsWith('specs/')).flatMap(([, t]) => removalsIn(t))
  const proseCommits = h.tip ? h.commits.filter((c) => c.parents.length === 1 && c.sha !== h.archiveCommit && h.commits.indexOf(c) < (h.commits.findIndex((x) => x.sha === h.archiveCommit) + 1 || Infinity) && c.files.some((f) => /^openspec\/specs\/[^/]+\/spec\.md$/.test(f))) : []
  if (!c4) out.push(missing('verify', 'reply', 'verify c4', 'verify.md has no coherence section'))
  else if (kase === null) out.push(missing('verify', 'reply', 'verify c4', 'the change has neither a design nor a delta'))
  else {
    const findings = []
    const problems = []
    for (const [label, kind] of [['Drift between two documents', 'doc-drift'], ['Contradiction between two executable surfaces', 'exec-contradiction']]) {
      const block = bulletsAfter(c4.text, label)
      for (const b of block?.bullets ?? []) {
        if (isNone(b.text)) continue
        const where = [...b.text.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`(?:\s*\((?:lines?|line)\s*(\d+)[^)]*\))?/g)].map((m) => ({ file: m[1], line: m[2] ? Number(m[2]) : null }))
        if (kind === 'doc-drift' && where.length < 2) problems.push(`a doc-drift item at verify.md:${c4.start + block.line + b.offset} names ${where.length} side(s); the port needs a file on each side`)
        else if (where.length === 0) problems.push(`an ${kind} item at verify.md:${c4.start + block.line + b.offset} names no file`)
        else findings.push({ kind, where, text: b.text })
      }
    }
    const unaccounted = removals.filter((r) => !c4.text.includes(r.requirement ?? r.from))
    if (unaccounted.length) problems.push(`the coherence section does not account for ${unaccounted.map((r) => `${r.op} ${r.requirement ?? r.from}`).join(', ')}`)
    const partial = { case: kase, findings, proseEdits: proseCommits.map((c) => ({ capability: c.files.find((f) => /^openspec\/specs\//.test(f)).split('/')[2], commit: c.sha, reason: null })) }
    if (problems.length) out.push(missing('verify', 'reply', 'verify c4', problems.join('; '), partial))
    else {
      const reply = {
        role: 'verify-c4',
        ...partial,
        removalAccounting: removals.map((r) => ({ requirement: r.requirement ?? r.from, op: r.op, disposition: r.codeDisposition, holds: true, oldPathReachable: false })),
        exercised: [],
        summary: c4.text.split('\n').find((l) => l.trim() && !l.startsWith('|') && !l.startsWith('**') && !l.startsWith('-'))?.trim() ?? c4.title
      }
      const ctx = { root: cache, case: kase, proseEdits: partial.proseEdits.map((p) => ({ ...p, position: 'above' })), removals: removals.map((r) => ({ op: r.op, requirement: r.requirement ?? r.from, codeDisposition: r.codeDisposition })) }
      out.push(replyItem('verify', 'verify c4', reply, [src(h.merge, file, c4.start)], (t) => checkVerifyReply('c4', t, ctx), {
        by: 'verify-reply.mjs checkVerifyReply c4',
        injected: [
          { field: 'exercised', why: 'the origin\'s coherence section lists no mechanism paths; empty' },
          ...(removals.length ? [{ field: 'removalAccounting', why: 'holds and oldPathReachable read from the section naming each removal with no contradiction' }] : []),
          ...(h.tip ? [] : [{ field: 'proseEdits', why: 'no per-commit history: the squash\'s openspec/specs changes are the origin archive\'s spec merge, which the driver leaves to the port\'s archive' }])
        ],
        context: 'proseEdits name origin commits with no stated reason (the record states none); the driver maps each to its cherry-pick'
      }))
    }
  }

  // c8: the rows of the stale-skill section; the reply answers the candidates the replay lists.
  const c8 = sections.find((s) => /stale-skill|stale skill/i.test(s.title))
  if (!c8) out.push(missing('verify', 'reply', 'verify c8', 'verify.md has no stale-skill section'))
  else {
    const rows = c8Rows(c8, file, h.merge)
    const approved = /\*\*Approved skill-edit commit\(s\)\*\*:\s*(.+)$/m.exec(c8.text)?.[1]?.trim() ?? null
    const item = { rows, approvedEdits: approved && !isNone(approved) ? [...approved.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]) : [] }
    const reply = c8Reply(item, [])
    out.push(replyItem('verify', 'verify c8', reply.reply ?? { role: 'verify-c8', candidates: [], summary: 'none' }, [src(h.merge, file, c8.start)], (t) => checkVerifyReply('c8', t, { root: scratch, candidates: [] }), {
      by: 'verify-reply.mjs checkVerifyReply c8 (no candidate)',
      rows,
      approvedEdits: item.approvedEdits,
      context: 'the candidates come from verify.mjs prompts in the replay; c8Reply(item, candidates) answers each from the rows'
    }))
  }
  return out
}

// The stale-skill table rows: { skill, file, lines, class, detail, line }.
function c8Rows(section, file, merge) {
  const rows = []
  section.text.split('\n').forEach((l, i) => {
    if (!l.startsWith('|') || /^\|\s*-/.test(l) || /^\|\s*Skill\s*\|/i.test(l)) return
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    if (cells.length < 3) return
    const refs = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    rows.push({ skill: cells[0].replace(/\s*\(.*$/, '').trim(), refs, class: cells[1].replace(/`/g, ''), detail: cells[2], source: src(merge, file, section.start + i + 1) })
  })
  return rows
}

// The c8 reply for the candidates the replay lists ([{ file, line, text }]), each answered from
// the origin's row for its skill: CONFIRMED with the approved edit's patch, PLAUSIBLE or none,
// or, for a skill no row names, the row for "other skills" when the origin has one. A candidate
// no row answers makes the reply missing.
export function c8Reply(item, candidates, { patchOf } = {}) {
  const answers = []
  const unanswered = []
  const skillOf = (f) => /^\.claude\/skills\/([^/]+)\//.exec(f)?.[1] ?? f
  for (const c of candidates) {
    const row = item.rows.find((r) => r.refs.some((ref) => ref.includes(skillOf(c.file))) || r.skill.includes(skillOf(c.file))) ?? item.rows.find((r) => /^other skills?$/i.test(r.skill))
    if (!row) {
      unanswered.push(`${c.file}:${c.line}`)
      continue
    }
    const cls = /^CONFIRMED$/i.test(row.class) ? 'CONFIRMED' : /^PLAUSIBLE$/i.test(row.class) ? 'PLAUSIBLE' : 'none'
    const answer = { file: c.file, line: c.line, class: cls, fact: c.text?.trim() || row.detail, why: row.detail }
    if (cls === 'CONFIRMED') {
      const patch = patchOf?.(c.file)
      if (!patch) {
        unanswered.push(`${c.file}:${c.line} (CONFIRMED, no approved edit's patch)`)
        continue
      }
      answer.patch = patch
    }
    answers.push(answer)
  }
  if (unanswered.length) return { missing: `no row of the origin's stale-skill section answers ${unanswered.join(', ')}` }
  return { reply: { role: 'verify-c8', candidates: answers, summary: answers.length ? `${answers.length} candidate(s) answered from the origin's stale-skill section` : 'no candidate' } }
}

// ---------------------------------------------------------------- review

function reviewPhase(h, archived, records) {
  const out = []
  const text = archived['review.md']
  if (!text) return [missing('review', 'reply', 'ai-review r1', 'no review.md')]
  const file = `${h.archive}/review.md`
  const roundsLine = lineOf(text, /^\*\*Rounds\*\*/)
  const rounds = Number(/^\*\*Rounds\*\*:\s*`?(\d+)/m.exec(text)?.[1] ?? 1)
  const verdict = /^\*\*Verdict\*\*:\s*`?([A-Z ]+?)`?\s*$/m.exec(text)?.[1] ?? null
  const rows = []
  text.split('\n').forEach((l, i) => {
    const m = /^\|\s*(\d+)\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(l)
    if (m) rows.push({ n: Number(m[1]), severity: m[2], where: m[3], disposition: m[4], line: i + 1 })
  })
  const noFindings = lineOf(text, /^\|\s*—\s*\|.*no findings/i)
  // Round 1 holds every finding of the table: the origin numbers them once.
  if (rows.length === 0) {
    out.push(replyItem('review', 'ai-review r1', { summary: 'no findings', findings: [] }, [src(h.merge, file, noFindings ?? roundsLine)], (t) => checkFindings(t), { by: 'review.mjs checkFindings' }))
  } else {
    const partial = rows.map((r) => {
      const at = /`([^`]+?)(?::(\d+))?`/.exec(r.where)
      const para = findingParagraph(text, r.n)
      return { id: `F${r.n}`, severity: r.severity, file: at?.[1] ?? null, line: at?.[2] ? Number(at[2]) : null, ...(para ? { body: para.text } : {}) }
    })
    out.push(missing('review', 'reply', 'ai-review r1', 'the findings table records no category and no title for a finding', { findings: partial, source: rows.map((r) => src(h.merge, file, r.line)) }))
  }
  // A later round: the last one approves when the verdict is PASS; the rounds between are not recorded.
  for (let k = 2; k <= rounds; k++) {
    const name = dispatchName({ role: 'ai-review', round: k })
    if (k === rounds && verdict === 'PASS') out.push(replyItem('review', name, { summary: `round ${k}: no finding`, findings: [] }, [src(h.merge, file, roundsLine)], (t) => checkFindings(t), { by: 'review.mjs checkFindings' }))
    else out.push(missing('review', 'reply', name, `round ${k}'s findings are not recorded`))
  }
  for (const r of rows) {
    const fixed = /fixed in `?([0-9a-f]{7,40})`?/.exec(r.disposition)
    if (!fixed) continue
    const name = dispatchName({ role: 'ai-fix', finding: `F${r.n}`, round: 1 })
    const para = findingParagraph(text, r.n)
    const failureMode = para ? para.text.split(/(?<=\.)\s+The fix\b/)[0].trim() : null
    if (!failureMode) out.push(missing('review', 'reply', name, `review.md has no paragraph for finding ${r.n} to give its failure mode`, { sha: fixed[1] }))
    else out.push(replyItem('review', name, { finding: `F${r.n}`, outcome: 'fixed', sha: fixed[1], failureMode }, [src(h.merge, file, r.line), src(h.merge, file, para.line)], (t) => checkFix(t), { by: 'review.mjs checkFix', context: 'the sha is the origin\'s fix commit; the driver names its cherry-pick' }))
  }
  return out
}

// The paragraph `Finding <n>: ...` of a review record: { text, line }.
function findingParagraph(text, n) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => new RegExp(`^Finding ${n}:`).test(l))
  if (at === -1) return null
  const out = []
  for (let i = at; i < lines.length && lines[i].trim(); i++) out.push(lines[i].trim())
  return { text: out.join(' ').replace(new RegExp(`^Finding ${n}:\\s*`), ''), line: at + 1 }
}

// ---------------------------------------------------------------- archive

// The added paragraphs of a page (consecutive non-blank lines, a bold-led line starting one):
// [{ text, line, added }], `added` when every line of it was added.
function paragraphs(text, added) {
  const lines = text.split('\n')
  const out = []
  let cur = null
  lines.forEach((l, i) => {
    if (!l.trim() || /^#/.test(l) || (cur && /^\*\*/.test(l))) {
      if (cur) out.push(cur)
      cur = null
      if (!l.trim() || /^#/.test(l)) return
    }
    cur ??= { lines: [], line: i + 1, added: true }
    cur.lines.push(l.trim())
    if (!added.has(i + 1)) cur.added = false
  })
  if (cur) out.push(cur)
  return out.map((p) => ({ text: p.lines.join(' '), line: p.line, added: p.added }))
}

function ingestPhase(git, h, candidate) {
  // The ingest: the branch commit that adds the log entry after the archive commit, else the squash.
  let a
  let b
  if (h.tip) {
    const after = h.commits.slice(h.commits.findIndex((c) => c.sha === h.archiveCommit) + 1)
    // The first commit after the archive that names the ingest, else the first that changes the memory.
    const touches = (c) => c.files.some((f) => f.startsWith(MEMORY))
    const commit = after.find((c) => touches(c) && /\bingest\b/i.test(c.subject)) ?? after.find(touches)
    if (!commit) return missing('archive', 'reply', 'ingest', h.archiveCommit ? 'no commit after the archive commit changes the memory' : 'no archive commit on the branch')
    ;[a, b] = [`${commit.sha}^`, commit.sha]
  } else [a, b] = [`${h.merge}^1`, h.merge]
  const changed = git.changed(a, b, MEMORY)
  const pages = changed.filter((c) => !MEMORY_LOG.some((l) => c.file.startsWith(l)) && !c.file.startsWith(DEBT_TREE))
  // The log entry the ingest added.
  const log = git.show(b, MEMORY_LOG[0]) ?? ''
  const addedLog = git.added(a, b, MEMORY_LOG[0])
  const logLines = log.split('\n')
  const head = logLines.findIndex((l, i) => addedLog.has(i + 1) && /^## \[[^\]]+\] ingest \|/.test(l))
  const commitOf = (rev) => git.resolve(rev)
  const at = commitOf(b)
  if (head === -1) return missing('archive', 'reply', 'ingest', `the ingest adds no "ingest" entry to ${MEMORY_LOG[0]}`, { pages: pages.map((p) => p.file) })
  const title = /^## \[[^\]]+\] ingest \| (.+?) \| [^|]+$/.exec(logLines[head])?.[1] ?? null
  const bullets = []
  for (let i = head + 1; i < logLines.length && addedLog.has(i + 1) && !/^## /.test(logLines[i]); i++) {
    const m = /^- (.*)$/.exec(logLines[i])
    if (m) bullets.push({ text: m[1].trim(), line: i + 1 })
    else if (logLines[i].trim() && bullets.length) bullets.at(-1).text += ` ${logLines[i].trim()}`
  }
  const source = [src(at, MEMORY_LOG[0], head + 1)]
  // Each page's why: the log's words about it, the parenthesis after its [[name]] when there is one.
  const whys = []
  const unnamed = []
  for (const p of pages) {
    const base = p.file.split('/').pop().replace(/\.md$/, '')
    const bullet = bullets.find((x) => x.text.includes(`[[${base}]]`) || x.text.includes(p.file))
    if (!bullet && p.file === `${MEMORY}index.md`) {
      const lines = (git.show(b, p.file) ?? '').split('\n')
      const added = [...git.added(a, b, p.file)].map((n) => lines[n - 1]?.trim()).filter(Boolean)
      if (added.length) {
        whys.push({ path: p.file, why: `the index lines the ingest added: ${added.join(' ')}`, line: null, own: true })
        continue
      }
    }
    if (!bullet) {
      unnamed.push(p.file)
      continue
    }
    const paren = new RegExp(`\\[\\[${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`).exec(bullet.text)?.[1]
    whys.push({ path: p.file, why: paren ? paren.trim() : bullet.text, line: bullet.line })
  }
  // The two fixed answers, as the origin wrote them on a page.
  let invariant = null
  let likelyMistake = null
  for (const p of pages.filter((x) => x.status !== 'D')) {
    const text = git.show(b, p.file) ?? ''
    const paras = paragraphs(text, git.added(a, b, p.file))
    paras.forEach((para, k) => {
      if (!para.added) return
      if (!likelyMistake && /most plausibly get wrong/i.test(para.text)) {
        likelyMistake = { text: para.text.replace(/^\*\*[^*]*\*\*:?\s*/, ''), source: src(at, p.file, para.line) }
        const before = paras[k - 1]
        if (!invariant && before?.added && /^\*\*/.test(before.text)) invariant = { text: before.text, source: src(at, p.file, before.line) }
      }
      if (!invariant && /\binvariant\b/i.test(para.text) && !/most plausibly/i.test(para.text)) invariant = { text: para.text, source: src(at, p.file, para.line) }
    })
  }
  const partial = { pages: whys.map(({ path, why }) => ({ path, why })), log: { title, bullets: bullets.map((x) => x.text) }, invariant: invariant?.text ?? null, likelyMistake: likelyMistake?.text ?? null }
  const lacks = [unnamed.length ? `no log bullet names ${unnamed.join(', ')}` : null, invariant ? null : 'no added paragraph states the invariant', likelyMistake ? null : 'no added paragraph states what a future implementer would most plausibly get wrong', title ? null : 'the log entry has no title'].filter(Boolean)
  if (lacks.length) return missing('archive', 'reply', 'ingest', lacks.join('; '), partial)
  const reply = { nothingLearned: false, pages: partial.pages, stale: [], invariant: invariant.text, likelyMistake: likelyMistake.text, log: partial.log }
  return replyItem('archive', 'ingest', reply, [...source, ...whys.map((w) => (w.own ? src(at, w.path) : src(at, MEMORY_LOG[0], w.line, { page: w.path }))), invariant.source, likelyMistake.source], (t) => checkIngestReply(t, { stale: [], changedFiles: pages.map((p) => p.file), knowledgePaths: [`${MEMORY}**`], logPaths: [MEMORY_LOG[0], `${MEMORY_LOG[1]}**`], exists: () => true }), {
    by: 'ingest.mjs checkIngestReply (the changed pages of the record)',
    context: 'stale is answered per path ingest.mjs stale lists in the replay (ingestStaleAnswers)',
    deleted: pages.filter((p) => p.status === 'D').map((p) => p.file)
  })
}

// The stale answers of an ingest reply for the paths the replay's `ingest.mjs stale` lists:
// `updated` for a page the origin's ingest changed, `removed` for one it deleted; a stale page it
// left as it was has no recorded argument, so the answers are missing.
export function ingestStaleAnswers(item, stale) {
  const pages = new Set(item.reply?.pages?.map((p) => p.path) ?? [])
  const deleted = new Set(item.deleted ?? [])
  const answers = []
  const unanswered = []
  for (const s of stale) {
    if (deleted.has(s.path)) answers.push({ path: s.path, outcome: 'removed' })
    else if (pages.has(s.path)) answers.push({ path: s.path, outcome: 'updated' })
    else unanswered.push(s.path)
  }
  return unanswered.length ? { missing: `the origin's ingest left ${unanswered.join(', ')} as it was and recorded no argument that it still holds` } : { stale: answers }
}

// The spec-merge reply for one capability's conflicts ([{ requirement, operation }]): each
// requirement's block as the origin's main spec holds it after the merge, an empty text for a
// REMOVED requirement the main spec no longer holds. Checked by spec-merge.mjs checkSpecMergeReply.
export function specMergeReply(sandbox, candidate, capability, conflicts) {
  const git = reader(sandbox)
  const file = `openspec/specs/${capability}/spec.md`
  const text = git.show(candidate.merge, file)
  if (text === null) return { missing: `${file} does not exist after the origin's merge` }
  const blocks = extractRequirementsSection(text).bodyBlocks
  const reply = []
  const unresolved = []
  for (const c of conflicts) {
    const name = c.operation === 'RENAMED' ? c.to : c.requirement
    const block = blocks.find((b) => b.name === name)
    if (block) reply.push({ capability, requirement: c.requirement, text: block.raw, reason: `the origin's main spec after its merge ${candidate.merge.slice(0, 8)}` })
    else if (c.operation === 'REMOVED') reply.push({ capability, requirement: c.requirement, text: '', reason: `the origin's main spec after its merge ${candidate.merge.slice(0, 8)} no longer holds it` })
    else unresolved.push(c.requirement)
  }
  if (unresolved.length) return { missing: `${file} after the merge holds no requirement ${unresolved.join(', ')}` }
  const checked = checkSpecMergeReply(JSON.stringify(reply), { capability, conflicts })
  return { reply, source: [src(candidate.merge, file)], check: { by: 'spec-merge.mjs checkSpecMergeReply', valid: checked.valid, errors: checked.errors } }
}

// The impl reply with the test-run records the driver wrote for it.
export function completeImpl(item, testRuns) {
  return { ...item.reply, testRuns }
}

// ---------------------------------------------------------------- all phases

// Every reply of the candidate's cycle. `candidate` is a findCandidates record; `scope` the
// tracker keys the replay's scope takes (none by default: the origin had no scope step).
// Returns { candidate, history, phases: { <phase>: [item] }, counts: { built, missing, invalid,
// byPhase }, onDemand }.
export function buildReplies(sandbox, candidate, { scope = [] } = {}) {
  assertIsolated(sandbox)
  const git = reader(sandbox)
  const h = history(git, candidate)
  const scratch = join(sandbox.env.TMPDIR, `replies-${candidate.name}`)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  h.scratch = join(scratch, 'tree')
  h.env = sandbox.env
  mkdirSync(h.scratch, { recursive: true })
  const archived = {}
  for (const f of git.files(h.merge, h.archive)) archived[f] = git.show(h.merge, `${h.archive}/${f}`)
  const ledger = ledgerRecords(archived['ledger.jsonl'])

  const propose = proposePhase(git, h, h.scratch, candidate, scope)
  const writes = ledgerWrites(h, ledger, archived['verify.md'])
  const phases = {
    propose: propose.items,
    apply: [...applyPhase(git, h, archived, ledger, candidate), ...writes.filter((w) => w.phase === 'apply' || w.phase === 'propose')],
    verify: [...verifyPhase(git, h, archived, h.scratch, sandbox.cache), ...writes.filter((w) => w.phase === 'verify')],
    review: [...reviewPhase(h, archived), ...writes.filter((w) => w.phase === 'review')],
    archive: [ingestPhase(git, h, candidate), ...writes.filter((w) => w.phase === 'archive')]
  }
  const byPhase = {}
  for (const [phase, items] of Object.entries(phases)) {
    byPhase[phase] = { built: items.filter((i) => !i.missing).length, missing: items.filter((i) => i.missing).length, invalid: items.filter((i) => i.check && !i.check.valid).length }
  }
  const sum = (key) => Object.values(byPhase).reduce((n, p) => n + p[key], 0)
  return {
    candidate: candidate.name,
    history: { kind: candidate.history, base: candidate.base, merge: candidate.merge, branch: candidate.branch, tip: h.tip, commits: h.commits.length },
    phases,
    counts: { built: sum('built'), missing: sum('missing'), invalid: sum('invalid'), byPhase },
    onDemand: {
      'T<n> impl testRuns': 'completeImpl(item, testRuns): the records suite.mjs covering writes in the replay',
      'verify c8': 'c8Reply(item, candidates): the candidates verify.mjs prompts lists',
      'ingest stale': 'ingestStaleAnswers(item, stale): the paths ingest.mjs stale lists',
      'spec-merge <capability>': 'specMergeReply(sandbox, candidate, capability, conflicts): the conflicts of archive\'s three-way check'
    }
  }
}

// One line per item: phase, name, built or missing, and why.
export function replyReport(result) {
  const lines = [`${result.candidate}: ${result.counts.built} built, ${result.counts.missing} missing, ${result.counts.invalid} invalid`]
  for (const phase of PHASES) {
    for (const i of result.phases[phase]) {
      const state = i.missing ? `missing: ${i.missing}` : i.check && !i.check.valid ? `INVALID (${i.check.by}): ${i.check.errors.join('; ')}` : `built${i.injected ? ` (injected: ${i.injected.map((x) => x.field).join(', ')})` : ''}`
      lines.push(`${phase.padEnd(8)} ${i.kind.padEnd(8)} ${i.name}: ${state}`)
    }
  }
  return lines.join('\n')
}

