// The `upstream` role on GitHub, through the `gh` CLI: `check` reports whether gh can be used
// and whether it may push to the flow's repository, `file` files a retrospective's flow
// findings and the open ADF debt as issues in that repository.
//
// Every operation returns one result object with `state`: `done`, `degraded` (gh is missing or
// not logged in: nothing was sent, and `hint` and `fallback` say what to run first) or
// `refused` (with `error`, which says what was and was not sent). The plugin never reads or
// stores a token: `gh auth login` or GH_TOKEN gives gh its credentials.
//
// Titles, bodies and labels are rendered here from the items' fields; nothing else is sent.
// Every issue body carries a marker, so an issue already filed is found and returned, never
// filed again, and a rerun after a partial failure completes the work.
//
// Every gh call goes through the injected `run(cmd, args, opts)`, which returns
// { status, stdout, stderr }, so no test touches the network.

const NOTHING_SENT = 'nothing was sent'
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

const ok = (result) => result?.status === 0
const output = (result) => `${result?.stderr ?? ''}${result?.stdout ?? ''}`.trim()
const refused = (error) => ({ state: 'refused', error })

export const COLORS = { 'adf-retro': '5319e7', 'adf-debt': 'b60205', class: 'c5def5', plugin: '0e8a16' }

export function installHint(platform) {
  if (platform === 'win32') return 'winget install -e --id GitHub.cli'
  return 'brew install gh'
}

export const LOGIN_HINT = 'gh auth login'

export function detectTool({ run, root, platform }) {
  if (!ok(run('gh', ['--version'], { cwd: root }))) {
    const hint = installHint(platform)
    return { state: 'degraded', tool: 'missing', hint, fallback: [hint, LOGIN_HINT], message: `gh is not installed, so ${NOTHING_SENT}.` }
  }
  if (!ok(run('gh', ['auth', 'status'], { cwd: root }))) {
    return {
      state: 'degraded',
      tool: 'unauthenticated',
      hint: LOGIN_HINT,
      fallback: [LOGIN_HINT],
      message: `gh is installed but not authenticated: run gh auth login, or set GH_TOKEN; ${NOTHING_SENT}.`
    }
  }
  return { state: 'done', tool: 'ready' }
}

// ---------------------------------------------------------------- rendering

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function findingMarker(host, retro, id) {
  return `<!-- adf: ${host}/${retro}/${id} -->`
}

// Debt is keyed without the retrospective: a later retrospective may file the same record.
export function debtMarker(host, id) {
  return `<!-- adf: ${host}/debt/${id} -->`
}

const pluginFact = (plugin, version) => (plugin ? [plugin, version].filter(Boolean).join(' ') : 'none')
const pair = ({ key, value }) => `${key}: ${value}`

export function renderFinding(finding, { host, retro }) {
  const facts = [
    `- Class: ${finding.class}`,
    `- Changes: ${finding.changes.length ? finding.changes.join(', ') : 'none'}`,
    finding.evidence.length ? `- Evidence:\n${finding.evidence.map((e) => `  - ${pair(e)}`).join('\n')}` : '- Evidence: none',
    `- Cost: ${finding.cost ? pair(finding.cost) : 'none'}`,
    `- Caught where: ${finding.caughtWhere}`,
    `- Plugin: ${pluginFact(finding.plugin, finding.version)}`,
    `- Host: ${host}`,
    `- Retrospective: ${retro}`
  ]
  const labels = ['adf-retro', slug(finding.class), ...(finding.plugin ? [`plugin:${finding.plugin}`] : [])]
  return {
    item: finding.id,
    kind: 'finding',
    title: `[${finding.plugin ?? 'adf'}] ${finding.title}`,
    body: `${finding.body.trim()}\n\n${facts.join('\n')}\n\n${findingMarker(host, retro, finding.id)}\n`,
    labels: [...new Set(labels)],
    marker: findingMarker(host, retro, finding.id)
  }
}

export function renderDebt(debt, { host }) {
  const facts = [
    `- Class: ${debt.class}`,
    `- Plugin: ${pluginFact(debt.plugin, debt.pluginVersion)}`,
    ...(isText(debt.change) ? [`- Change: ${debt.change}`] : []),
    ...(isText(debt.source) ? [`- Source: ${debt.source}`] : []),
    `- Host: ${host}`
  ]
  return {
    item: debt.id,
    kind: 'debt',
    title: `[${debt.plugin}] ${debt.title}`,
    body: `${debt.body.trim()}\n\n${facts.join('\n')}\n\n${debtMarker(host, debt.id)}\n`,
    labels: [...new Set(['adf-debt', slug(debt.class), `plugin:${debt.plugin}`])],
    marker: debtMarker(host, debt.id)
  }
}

export function labelColor(name) {
  if (Object.hasOwn(COLORS, name)) return COLORS[name]
  return name.startsWith('plugin:') ? COLORS.plugin : COLORS.class
}

// `gh api` sends each `-f key[]=value` as one element of the array `key`.
export function createArgs(repository, { title, body, labels }) {
  return ['api', `repos/${repository}/issues`, '-f', `title=${title}`, '-f', `body=${body}`, ...labels.flatMap((l) => ['-f', `labels[]=${l}`])]
}

// One compact JSON object per line, so the pages of --paginate never have to be joined.
export const LIST_JQ = '.[] | select(.pull_request == null) | {number, url: .html_url, body}'

export function listArgs(repository, label) {
  return ['api', '--paginate', `repos/${repository}/issues?state=all&labels=${label}&per_page=100`, '--jq', LIST_JQ]
}

// ---------------------------------------------------------------- input

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const isValue = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
const isPair = (value) => isObject(value) && exactKeys(value, ['key', 'value']) === null && isText(value.key) && isValue(value.value)

function exactKeys(object, fields) {
  const unknown = Object.keys(object).filter((k) => !fields.includes(k))
  if (unknown.length) return `unknown field ${unknown[0]}`
  const missing = fields.filter((k) => !Object.hasOwn(object, k))
  if (missing.length) return `missing field ${missing[0]}`
  return null
}

// A marker part ends up inside an HTML comment on one line.
const markerSafe = (value) => isText(value) && !/[\r\n]/.test(value) && !value.includes('--')

const FINDING = ['id', 'title', 'class', 'changes', 'evidence', 'cost', 'caughtWhere', 'plugin', 'version', 'body']
const DEBT = ['id', 'title', 'plugin', 'pluginVersion', 'class', 'body']
// A debt record may have no source change and no source: null, absent or empty.
const DEBT_OPTIONAL = ['change', 'source']

function validateFinding(f, at) {
  if (!isObject(f)) return `${at} must be an object`
  const keys = exactKeys(f, FINDING)
  if (keys) return `${at}: ${keys}`
  if (!markerSafe(f.id)) return `${at}.id must be one line without "--"`
  for (const field of ['title', 'class', 'caughtWhere', 'body']) if (!isText(f[field])) return `${at}.${field} is required`
  if (!Array.isArray(f.changes) || !f.changes.every(isText)) return `${at}.changes must be a list of change names`
  if (!Array.isArray(f.evidence) || !f.evidence.every(isPair)) return `${at}.evidence must be a list of { key, value }`
  if (f.cost !== null && !isPair(f.cost)) return `${at}.cost must be { key, value } or null`
  if (f.plugin !== null && !isText(f.plugin)) return `${at}.plugin must be a name or null`
  if (f.version !== null && !isText(f.version)) return `${at}.version must be a version or null`
  return null
}

function validateDebt(d, at) {
  if (!isObject(d)) return `${at} must be an object`
  const unknown = Object.keys(d).find((k) => !DEBT.includes(k) && !DEBT_OPTIONAL.includes(k))
  if (unknown !== undefined) return `${at}: unknown field ${unknown}`
  const missing = DEBT.find((k) => !Object.hasOwn(d, k))
  if (missing !== undefined) return `${at}: missing field ${missing}`
  if (!markerSafe(d.id)) return `${at}.id must be one line without "--"`
  for (const field of DEBT.slice(1)) if (!isText(d[field])) return `${at}.${field} is required`
  for (const field of DEBT_OPTIONAL) {
    if (d[field] !== undefined && d[field] !== null && typeof d[field] !== 'string') return `${at}.${field} must be text, empty or null`
  }
  return null
}

const duplicate = (items) => items.map((i) => i.id).find((id, n, ids) => ids.indexOf(id) !== n)

export function validateCheck(input) {
  if (!isObject(input)) return 'input must be an object'
  const keys = exactKeys(input, ['repository'])
  if (keys) return `input: ${keys}`
  if (typeof input.repository !== 'string' || !REPOSITORY.test(input.repository)) return 'input.repository must be "owner/name"'
  return null
}

export function validateFile(input) {
  if (!isObject(input)) return 'input must be an object'
  const keys = exactKeys(input, ['repository', 'host', 'retro', 'findings', 'debt'])
  if (keys) return `input: ${keys}`
  if (typeof input.repository !== 'string' || !REPOSITORY.test(input.repository)) return 'input.repository must be "owner/name"'
  if (!markerSafe(input.host)) return 'input.host must be one line without "--"'
  if (!markerSafe(input.retro)) return 'input.retro must be one line without "--"'
  if (!Array.isArray(input.findings)) return 'input.findings must be a list'
  if (!Array.isArray(input.debt)) return 'input.debt must be a list'
  for (const [n, f] of input.findings.entries()) {
    const problem = validateFinding(f, `input.findings[${n}]`)
    if (problem) return problem
  }
  for (const [n, d] of input.debt.entries()) {
    const problem = validateDebt(d, `input.debt[${n}]`)
    if (problem) return problem
  }
  const twice = duplicate(input.findings) ?? duplicate(input.debt)
  if (twice !== undefined) return `the id ${twice} appears twice`
  return null
}

// ---------------------------------------------------------------- operations

function ready(ctx, repository) {
  const { run, root } = ctx
  const tool = detectTool(ctx)
  if (tool.state !== 'done') return tool
  const repo = run('gh', ['api', `repos/${repository}`], { cwd: root })
  if (!ok(repo)) return refused(`could not read the repository ${repository}: ${output(repo)}; ${NOTHING_SENT}.`)
  let view
  try {
    view = JSON.parse(repo.stdout)
  } catch {
    return refused(`could not read the repository ${repository}; ${NOTHING_SENT}.`)
  }
  if (view?.permissions?.push !== true) return refused(`no push permission on ${repository}; ${NOTHING_SENT}.`)
  return { state: 'done', tool: 'ready', repository }
}

export function check(ctx) {
  const problem = validateCheck(ctx.input)
  if (problem) return refused(`${problem}; ${NOTHING_SENT}.`)
  return ready(ctx, ctx.input.repository)
}

function ensureLabel({ run, root }, repository, name) {
  const made = run('gh', ['api', `repos/${repository}/labels`, '-f', `name=${name}`, '-f', `color=${labelColor(name)}`], { cwd: root })
  // 422: the label exists already.
  return ok(made) || /HTTP 422/.test(output(made)) ? null : `could not create the label ${name} on ${repository}: ${output(made)}`
}

function listMarked({ run, root }, repository, label) {
  const listed = run('gh', listArgs(repository, label), { cwd: root })
  if (!ok(listed)) return { error: `could not list the ${label} issues of ${repository}: ${output(listed)}` }
  try {
    const issues = listed.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
    return { issues }
  } catch {
    return { error: `could not read the ${label} issue list of ${repository}` }
  }
}

const describe = (issue) => `${issue.kind} ${issue.item} (#${issue.number} ${issue.url})`

export function file(ctx) {
  const { run, root, input } = ctx
  const problem = validateFile(input)
  if (problem) return refused(`${problem}; ${NOTHING_SENT}.`)
  const { repository, host, retro } = input
  const items = [...input.findings.map((f) => renderFinding(f, { host, retro })), ...input.debt.map((d) => renderDebt(d, { host }))]
  if (items.length === 0) return { state: 'done', issues: [] }

  const status = ready(ctx, repository)
  if (status.state !== 'done') return status

  const kinds = [...new Set(items.map((i) => i.labels[0]))]
  for (const name of [...new Set(items.flatMap((i) => i.labels))]) {
    const error = ensureLabel(ctx, repository, name)
    if (error) return refused(`${error}; no issue was created.`)
  }
  const known = new Map()
  for (const label of kinds) {
    const listed = listMarked(ctx, repository, label)
    if (listed.error) return refused(`${listed.error}; no issue was created.`)
    for (const issue of listed.issues) {
      for (const item of items) {
        if (!known.has(item.marker) && String(issue.body ?? '').includes(item.marker)) known.set(item.marker, issue)
      }
    }
  }

  const issues = []
  for (const [n, item] of items.entries()) {
    const found = known.get(item.marker)
    if (found) {
      issues.push({ item: item.item, kind: item.kind, number: found.number, url: found.url, existed: true })
      continue
    }
    const made = run('gh', createArgs(repository, item), { cwd: root })
    let issue = null
    if (ok(made)) {
      try {
        issue = JSON.parse(made.stdout)
      } catch {
        issue = null
      }
    }
    if (!Number.isInteger(issue?.number)) {
      const filed = issues.filter((i) => !i.existed)
      const left = items.slice(n).map((i) => `${i.kind} ${i.item}`)
      const created = filed.length ? `created: ${filed.map(describe).join(', ')}` : 'no issue was created'
      const unread = ok(made) ? '; the call succeeded but its answer was unreadable, so the issue may exist: the rerun finds it by its marker' : ''
      return {
        state: 'refused',
        error: `could not create the issue for ${item.kind} ${item.item} on ${repository}: ${output(made)}${unread}; ${created}; not created: ${left.join(', ')}. Rerun file: an issue already filed carries its marker and is not filed again.`,
        issues
      }
    }
    issues.push({ item: item.item, kind: item.kind, number: issue.number, url: issue.html_url ?? null, existed: false })
  }
  return { state: 'done', issues }
}

export const OPERATIONS = { check, file }

// Runs one operation on the payload the core writes: { root, config, input }. Returns the exit
// code and the result object. An unexpected error is a refusal that says what was already sent.
export function runOperation(operation, payload, ctx) {
  const sent = []
  const run = (cmd, args, opts) => {
    const result = ctx.run(cmd, args, opts)
    if (cmd === 'gh' && args[0] === 'api' && /\/issues$/.test(args[1] ?? '') && ok(result)) sent.push('an issue was created')
    return result
  }
  try {
    if (!Object.hasOwn(OPERATIONS, operation)) {
      return { code: 1, result: refused(`unknown operation "${operation}", expected ${Object.keys(OPERATIONS).join(', ')}; ${NOTHING_SENT}.`) }
    }
    if (!isObject(payload)) return { code: 1, result: refused(`the input must be a JSON object; ${NOTHING_SENT}.`) }
    const { root, config = {}, input = {} } = payload
    if (!isText(root)) return { code: 1, result: refused(`root is required; ${NOTHING_SENT}.`) }
    if (!isObject(config)) return { code: 1, result: refused(`config must be an object; ${NOTHING_SENT}.`) }
    const result = OPERATIONS[operation]({ ...ctx, run, root, config, input })
    return { code: result.state === 'refused' ? 1 : 0, result }
  } catch (error) {
    const what = sent.length ? `${sent.length} issue(s) were created before the error; rerun file to complete it` : NOTHING_SENT
    return { code: 1, result: refused(`${error.message}; ${what}.`) }
  }
}
