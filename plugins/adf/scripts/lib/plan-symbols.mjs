// A plan names paths, line ranges and symbols it has not yet resolved against the tree.
// Writing "resolve what the plan names" as a duty leaves it to an agent's diligence; this
// module does the part a machine can: every path a Files bullet names exists (or, for
// Create, does not), no line range runs past its file, and every symbol a Consumes bullet
// names is found. Produces is never checked: it names what the task will create.
//
// All I/O is injected (read, exists, lineCount, grep, branchChanges), so the checks run
// against an in-memory tree in tests and against the host repository from the CLI.

export const VERBS = ['Create', 'Modify', 'Test', 'Move', 'Delete', 'Revert']
export const EXTENSIONS = 'mjs|cjs|js|ts|tsx|jsx|json|md|yaml|yml|sh|css|html|sql'
export const PHASES = ['propose', 'apply']

const TICK = (item) => new RegExp(`^\\s*-\\s*\\[[xX]\\]\\s+${item.replace(/\./g, '\\.')}(?:\\s|$)`, 'm')

// ---------------------------------------------------------------- parsing

const tokensOf = (text) =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => ({ text: m[1], start: m.index, end: m.index + m[0].length }))

const splitSuffix = (token) => {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(token)
  if (!m) return { path: token }
  const start = Number(m[2])
  return { path: m[1], range: [start, m[3] ? Number(m[3]) : start] }
}

const isPathLike = (token) => {
  const { path } = splitSuffix(token)
  return /^[^\s()`]+$/.test(path) && (path.includes('/') || new RegExp(`\\.(?:${EXTENSIONS})$`).test(path))
}

const IDENT = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*(?:\(.*\)|:\s.*)?$/s

// A parenthetical right after the path: "(`fn`, lines 36-62)", "(…, line 793)", "(251-267; imports)".
const parenRange = (rest) => {
  const group = /\(([^)]*)\)/.exec(rest)
  if (!group) return undefined
  const m = /\blines?\s+~?(\d+)(?:-(\d+))?\b|(?<![\w.])(\d+)-(\d+)\b/.exec(group[1])
  if (!m) return undefined
  if (m[3]) return [Number(m[3]), Number(m[4])]
  return [Number(m[1]), Number(m[2] ?? m[1])]
}

const parseFileBullet = (text) => {
  const m = /^-\s+(\w+):\s*(.*)$/s.exec(text)
  if (!m || !VERBS.includes(m[1])) return null
  const [, verb, body] = m
  // "- Modify: none." names nothing: a no-op bullet, not an unparsed one.
  if (/^none\.?\s*$/i.test(body)) return { skip: true }
  // A revert of commits names no path to check.
  if (verb === 'Revert' && /^commits?\b/i.test(body)) return { skip: true }
  const tokens = tokensOf(body)
  if (!tokens.length || !isPathLike(tokens[0].text)) return null
  const first = splitSuffix(tokens[0].text)
  if (verb === 'Move') {
    const between = body.slice(tokens[0].end, tokens[1]?.start ?? 0)
    if (!tokens[1] || !/^\s*(?:→|->)\s*$/.test(between) || !isPathLike(tokens[1].text)) return null
    return { files: [{ verb, path: first.path, to: splitSuffix(tokens[1].text).path }] }
  }
  // Every path the bullet lists: "`a.ts`, `b.ts` and `c.ts`". The list ends at the first
  // prose, parenthesis or dash.
  const listed = [tokens[0]]
  for (const t of tokens.slice(1)) {
    const gap = body.slice(listed.at(-1).end, t.start)
    if (!isPathLike(t.text) || !/^[\s,+&]*(?:and\s+)?$/.test(gap)) break
    listed.push(t)
  }
  // Known, deliberate parity-kept behaviour: a bare filename (no directory) in a multi-path
  // bullet resolves against the first path's directory, even when that is not where the file
  // lives. Kept as the origin does it, so both tools report the same findings.
  const dir = first.path.includes('/') ? first.path.slice(0, first.path.lastIndexOf('/') + 1) : ''
  const paren = parenRange(body.slice(listed.at(-1).end))
  const files = listed.map((t) => {
    const { path, range } = splitSuffix(t.text)
    const file = { verb, path: path.includes('/') ? path : dir + path }
    const found = range ?? paren
    if (found) file.range = found
    return file
  })
  return { files }
}

const parseConsumesBullet = (text) => {
  const tokens = tokensOf(text)
  const clauses = []
  let prevEnd = 0
  for (const t of tokens) {
    const gap = text.slice(prevEnd, t.start)
    if (!clauses.length || gap.includes(';')) clauses.push([])
    clauses.at(-1).push({ ...t, gap })
    prevEnd = t.end
  }
  const out = []
  const seen = new Set()
  for (const clause of clauses) {
    clause.forEach((t, i) => {
      if (isPathLike(t.text)) return
      const id = IDENT.exec(t.text)
      if (!id) return
      const target = clause.slice(i + 1).find((c) => isPathLike(c.text) && /\b(?:from|in)\s*$/i.test(c.gap))
      const entry = { symbol: id[1] }
      if (target) entry.path = splitSuffix(target.text).path
      const key = `${entry.symbol}|${entry.path ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(entry)
    })
  }
  return out
}

// Collect a labelled block: every line up to the next bold field label, step checkbox,
// heading or rule. Blank lines inside the block do not end it.
const blockLines = (lines, from) => {
  const out = []
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*<!--.*-->\s*$/.test(line) || !line.trim()) continue
    if (/^(?:\*\*|#|---|- \[[ xX]\])/.test(line)) break
    out.push(line)
  }
  return out
}

const groupBullets = (lines) => {
  const bullets = []
  const stray = []
  for (const line of lines) {
    if (/^-\s/.test(line)) bullets.push(line.trimEnd())
    else if (/^\s+\S/.test(line) && bullets.length) bullets[bullets.length - 1] += `\n${line.trim()}`
    else stray.push(line.trim())
  }
  return { bullets, stray }
}

export function parsePlanTasks(planText) {
  const lines = planText.split('\n')
  const starts = []
  lines.forEach((line, i) => {
    const m = /^###\s+Task\s+(\d+)\b/.exec(line)
    if (m) starts.push({ number: Number(m[1]), i })
  })
  return starts.map(({ number, i }, k) => {
    const body = lines.slice(i + 1, k + 1 < starts.length ? starts[k + 1].i : lines.length)
    const impl = /^>\s*Implements\s+`?tasks\.md`?\s+(\d+\.\d+)/m.exec(body.join('\n'))
    const task = { number, implements: impl ? impl[1] : null, files: [], consumes: [], produces: [], unparsed: [] }

    const filesAt = body.findIndex((l) => /^\*\*Files:\*\*/.test(l))
    if (filesAt >= 0) {
      const { bullets, stray } = groupBullets(blockLines(body, filesAt + 1))
      for (const bullet of bullets) {
        const parsed = parseFileBullet(bullet)
        if (!parsed) task.unparsed.push(bullet.split('\n')[0])
        else if (parsed.files) task.files.push(...parsed.files)
      }
      task.unparsed.push(...stray)
    }

    const ifaceAt = body.findIndex((l) => /^\*\*Interfaces:\*\*/.test(l))
    if (ifaceAt >= 0) {
      let section = null
      const consumes = []
      const produces = []
      for (const line of blockLines(body, ifaceAt + 1)) {
        const top = /^-\s+(Consumes|Produces)?/.exec(line)
        if (top) {
          section = top[1] ?? 'other'
          if (section === 'Consumes') consumes.push(line.replace(/^-\s+Consumes:?/, ''))
          if (section === 'Produces') produces.push(line.replace(/^-\s+Produces:?/, ''))
        } else if (!/^\s/.test(line)) break
        else if (section === 'Consumes') consumes[consumes.length - 1] += `\n${line.trim()}`
        else if (section === 'Produces') produces[produces.length - 1] += `\n${line.trim()}`
      }
      // Produces is never checked; its symbols only excuse a later task's Consumes.
      for (const p of produces) task.produces.push(...parseConsumesBullet(p).map((e) => e.symbol))
      for (const c of consumes) task.consumes.push(...parseConsumesBullet(c))
    }
    return task
  })
}

// ---------------------------------------------------------------- checking

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasWord = (text, word) => new RegExp(`(?<![\\w$])${escapeRe(word)}(?![\\w$])`).test(text)
const rangeText = ([s, e]) => (s === e ? `${s}` : `${s}-${e}`)

export const NO_TASKS = 'no `### Task N` heading found'

// Findings are objects: { task, kind, message } plus the fields of their kind. Kinds:
//   no-tasks          the plan has no `### Task N` heading (task is null)
//   path-exists       a Create names a path that is already there        { verb, path }
//   path-missing      any other verb names a path that is not there       { verb, path }
//   path-is-directory a line range is given on a directory                { verb, path }
//   range-beyond      a line range ends past the file's last line         { verb, path, range, lines }
//   symbol-missing    a Consumes symbol is found nowhere                  { symbol, path? }
//   unparsed          a Files line has no shape this module reads         { line }
export async function checkPlanSymbols({ read, exists, lineCount, grep, branchChanges, changeName, phase = 'propose' }) {
  const dir = `openspec/changes/${changeName}`
  const tasks = parsePlanTasks(await read(`${dir}/plan.md`))
  // A plan with no task heading would otherwise pass with nothing checked.
  if (!tasks.length) return [{ task: null, kind: 'no-tasks', message: NO_TASKS }]
  const apply = phase === 'apply'

  let ticked = () => false
  let changes = { added: new Set(), modified: new Set(), removed: new Set() }
  if (apply) {
    let taskList = ''
    try {
      taskList = await read(`${dir}/tasks.md`)
    } catch {
      // no task list: nothing is ticked
    }
    ticked = (item) => TICK(item).test(taskList)
    changes = await branchChanges()
  }

  const findings = []
  const created = new Map() // path -> lowest task number that creates it
  for (const t of tasks)
    for (const f of t.files) if (f.verb === 'Create' && !created.has(f.path)) created.set(f.path, t.number)
  const modified = new Map() // path -> lowest task number that modifies it
  for (const t of tasks)
    for (const f of t.files) if (f.verb === 'Modify' && !modified.has(f.path)) modified.set(f.path, t.number)

  for (const t of tasks) {
    // Under --phase apply a task whose tasks.md item is ticked is done: skip it.
    if (apply && t.implements && ticked(t.implements)) continue
    const say = (kind, fields, what, why) => findings.push({ task: t.number, kind, ...fields, message: `${what} — ${why}` })
    // A file an earlier task of this plan creates is not there yet to be checked: its
    // path, its line ranges and the symbols it holds are all that task's to deliver.
    const byEarlierTask = (path) => created.get(path) < t.number
    // A file an earlier task modifies may have grown, so a line range on it is not yet checkable.
    const modifiedEarlier = (path) => modified.get(path) < t.number
    const producedEarlier = (symbol) => tasks.some((o) => o.number < t.number && o.produces.includes(symbol))

    for (const f of t.files) {
      if (f.verb !== 'Create' && byEarlierTask(f.path)) continue
      const present = await exists(f.path)
      const where = { verb: f.verb, path: f.path }
      if (f.verb === 'Create') {
        if (present && !(apply && changes.added.has(f.path))) say('path-exists', where, `Create ${f.path}`, 'path already exists')
        continue
      }
      if (!present) {
        // A resumed apply: the branch already moved or deleted this path.
        if (apply && (f.verb === 'Move' || f.verb === 'Delete') && changes.removed?.has(f.path)) continue
        say('path-missing', where, `${f.verb} ${f.path}`, 'path does not exist')
        continue
      }
      if (
        f.range &&
        !modifiedEarlier(f.path) &&
        !(apply && (changes.modified.has(f.path) || changes.added.has(f.path)))
      ) {
        let lines
        try {
          lines = await lineCount(f.path)
        } catch (err) {
          if (err.code !== 'EISDIR') throw err
          say('path-is-directory', where, `${f.verb} ${f.path}`, `${f.path} is a directory`)
          continue
        }
        if (f.range[1] > lines)
          say(
            'range-beyond',
            { ...where, range: f.range, lines },
            `${f.verb} ${f.path}`,
            `range ${rangeText(f.range)} ends beyond the file's ${lines} lines`
          )
      }
    }

    for (const c of t.consumes) {
      if (c.path && byEarlierTask(c.path)) continue
      if (producedEarlier(c.symbol)) continue
      if (c.path && (await exists(c.path))) {
        try {
          if (hasWord(await read(c.path), c.symbol)) continue
        } catch {
          // unreadable: fall through to the repository search
        }
      }
      if (await grep(c.symbol)) continue
      say(
        'symbol-missing',
        { symbol: c.symbol, ...(c.path ? { path: c.path } : {}) },
        `Consumes ${c.symbol}`,
        c.path ? `not found in ${c.path} or anywhere in the repository` : 'not found in the repository'
      )
    }

    for (const line of t.unparsed) say('unparsed', { line }, 'Files line cannot be parsed', line)
  }
  return findings
}

// `git diff --name-status` rows: "A\tpath", "M\tpath", "R100\told\tnew".
export function parseNameStatus(text) {
  const added = new Set()
  const modified = new Set()
  const removed = new Set()
  for (const row of text.split('\n')) {
    const [status, a, b] = row.split('\t')
    if (!status) continue
    if (status[0] === 'A') added.add(a)
    else if (status[0] === 'M') modified.add(a)
    else if (status[0] === 'D') removed.add(a)
    else if (status[0] === 'R') {
      removed.add(a)
      added.add(b)
    } else if (status[0] === 'C') added.add(b)
  }
  return { added, modified, removed }
}

// The apply phase diffs the branch against the change's base, a branch name kept in the
// change's metadata file (`base`). The remote-tracking `origin/<base>` is preferred when it
// exists, else the local `<base>`. No base is an error, never a guess.
export function baseRef(meta, hasRef) {
  const base = meta?.base
  if (typeof base !== 'string' || !base.trim()) {
    throw new Error('the change metadata (.adf.json) has no "base" branch; --phase apply needs it')
  }
  return hasRef(`refs/remotes/origin/${base}`) ? `origin/${base}` : base
}

// The plan is found from the repository root, never from the cwd: `--root <dir>` names it,
// otherwise `showToplevel` (git rev-parse --show-toplevel) resolves it. Null means usage
// error, and so does a flag given with no value: a trailing `--phase` is not a propose run.
export function parseArgs(argv, showToplevel) {
  const args = [...argv]
  const take = (flag) => {
    const at = args.indexOf(flag)
    if (at < 0) return undefined
    const value = args[at + 1]
    args.splice(at, 2)
    return value ?? null
  }
  const phase = take('--phase')
  let root = take('--root')
  if (phase === null || root === null || args.length !== 1) return null
  if (phase !== undefined && !PHASES.includes(phase)) return null
  if (root === undefined) {
    try {
      root = showToplevel()
    } catch {
      return null
    }
  }
  return { changeName: args[0], phase: phase ?? 'propose', root }
}
