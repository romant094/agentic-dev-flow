#!/usr/bin/env node
// Dev tool, not part of the plugin: proves plugins/adf/scripts/lib/specs.mjs agrees with
// `openspec validate --all --json`. It copies a project's openspec/specs and openspec/changes
// (archived changes flattened in as active ones, so their deltas are validated too) into a
// temporary directory, adds mutated copies of real specs and deltas that break each rule the
// CLI checks, runs both validators there, in default and in --strict mode, and reports every
// difference in validity and in the issue list (level, path, line, message, in order).
//
//   node scripts/parity/openspec-validate.mjs <project-root> [--keep]
//
// Needs `openspec` on PATH. Never writes inside <project-root>. Exit 1 on any difference.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProject } from '../../plugins/adf/scripts/lib/specs.mjs'

const dirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()

// ---- Line helpers for mutations ----

const REQ = /^###\s+Requirement:/
const isTopLevel = (l) => /^##\s+/.test(l)

// [start, end) of the first requirement block that has a #### header, or of the first block.
function firstBlock(lines) {
  const starts = lines.map((l, i) => (REQ.test(l) ? i : -1)).filter((i) => i !== -1)
  const span = (s) => {
    let e = s + 1
    while (e < lines.length && !REQ.test(lines[e]) && !isTopLevel(lines[e])) e++
    return [s, e]
  }
  for (const s of starts) {
    const [a, b] = span(s)
    if (lines.slice(a, b).some((l) => /^####\s/.test(l))) return [a, b]
  }
  return starts.length ? span(starts[0]) : null
}

// Index of the first non-blank body line of the block, before its first #### header.
function bodyLine(lines, [s, e]) {
  for (let i = s + 1; i < e; i++) {
    if (/^####\s/.test(lines[i])) return -1
    if (lines[i].trim()) return i
  }
  return -1
}

function editBlock(content, edit) {
  const lines = content.split('\n')
  const block = firstBlock(lines)
  if (!block) return null
  const out = edit(lines, block)
  return out ? out.join('\n') : null
}

function sectionSpan(lines, pattern) {
  const s = lines.findIndex((l) => pattern.test(l))
  if (s === -1) return null
  let e = s + 1
  while (e < lines.length && !isTopLevel(lines[e])) e++
  return [s, e]
}

const deshall = (l) => l.replace(/\b(SHALL|MUST)\b/g, 'will').replace(/SHALL|MUST/g, 'will')
const LONG = ' The system SHALL keep this sentence going.'.repeat(14)
const STRAY = ['### Requirement: Stray requirement', 'The system SHALL be stray.', '', '#### Scenario: Stray', '- **WHEN** x', '- **THEN** y', '']

// Mutations shared by main specs and delta specs: each returns the new content or null.
const blockMutations = {
  'no-shall': (c) => editBlock(c, (lines, b) => {
    const i = bodyLine(lines, b)
    if (i === -1) return null
    lines[i] = deshall(lines[i])
    return lines
  }),
  'shall-in-header-only': (c) => editBlock(c, (lines, b) => {
    const i = bodyLine(lines, b)
    if (i === -1) return null
    lines[b[0]] = `${lines[b[0]]} SHALL work`
    lines[i] = deshall(lines[i])
    return lines
  }),
  'mustard-substring': (c) => editBlock(c, (lines, b) => {
    const i = bodyLine(lines, b)
    if (i === -1) return null
    lines[i] = 'The MUSTARD jar is yellow.'
    return lines
  }),
  'no-scenario': (c) => editBlock(c, (lines, [s, e]) => {
    const first = lines.findIndex((l, i) => i > s && i < e && /^####\s/.test(l))
    if (first === -1) return null
    return [...lines.slice(0, first), ...lines.slice(e)]
  }),
  'scenario-level-3': (c) => editBlock(c, (lines, [s, e]) => lines.map((l, i) => (i > s && i < e ? l.replace(/^####\s/, '### ') : l))),
  'scenario-level-5': (c) => editBlock(c, (lines, [s, e]) => lines.map((l, i) => (i > s && i < e ? l.replace(/^####\s/, '##### ') : l))),
  'scenario-bullet': (c) => editBlock(c, (lines, [s, e]) => lines.map((l, i) => (i > s && i < e ? l.replace(/^####\s+(.*)$/, '- **$1**') : l))),
  'scenario-in-fence': (c) => editBlock(c, (lines, [s, e]) => {
    const first = lines.findIndex((l, i) => i > s && i < e && /^####\s/.test(l))
    if (first === -1) return null
    return [...lines.slice(0, first), '```', ...lines.slice(first, e), '```', ...lines.slice(e)]
  }),
  'no-body-text': (c) => editBlock(c, (lines, [s, e]) => {
    const first = lines.findIndex((l, i) => i > s && i < e && /^####\s/.test(l))
    if (first === -1) return null
    return [...lines.slice(0, s + 1), '', ...lines.slice(first)]
  }),
  'no-body-shall-header': (c) => editBlock(c, (lines, [s, e]) => {
    const first = lines.findIndex((l, i) => i > s && i < e && /^####\s/.test(l))
    if (first === -1) return null
    return [...lines.slice(0, s), `${lines[s]} SHALL hold`, '', ...lines.slice(first)]
  }),
  'metadata-first': (c) => editBlock(c, (lines, [s]) => [...lines.slice(0, s + 1), '**ID**: REQ-1', ...lines.slice(s + 1)]),
  'blank-header': (c) => editBlock(c, (lines, [s]) => {
    lines[s] = '###   '
    return lines
  }),
  'blank-header-no-body': (c) => editBlock(c, (lines, [s, e]) => [...lines.slice(0, s), '###   ', '', ...lines.slice(e)]),
  'header-no-space': (c) => editBlock(c, (lines, [s]) => {
    lines[s] = lines[s].replace(/^###\s+/, '###')
    return lines
  }),
  'long-text': (c) => editBlock(c, (lines, b) => {
    const i = bodyLine(lines, b)
    if (i === -1) return null
    lines[i] += LONG
    return lines
  }),
  'duplicate-block': (c) => editBlock(c, (lines, [s, e]) => [...lines.slice(0, e), '', ...lines.slice(s, e), ...lines.slice(e)]),
  'duplicate-name-padded': (c) => editBlock(c, (lines, [s, e]) => {
    const copy = lines.slice(s, e)
    copy[0] = `${copy[0]}   `
    return [...lines.slice(0, e), '', ...copy, ...lines.slice(e)]
  }),
  crlf: (c) => c.replace(/\n/g, '\r\n'),
  'empty-file': () => ''
}

const mainMutations = {
  ...blockMutations,
  'no-purpose-header': (c) => (/^## Purpose/m.test(c) ? c.replace(/^## Purpose.*\n/m, '') : null),
  'empty-purpose': (c) => {
    const lines = c.split('\n')
    const span = sectionSpan(lines, /^##\s+Purpose/i)
    return span ? [...lines.slice(0, span[0] + 1), '', ...lines.slice(span[1])].join('\n') : null
  },
  'short-purpose': (c) => {
    const lines = c.split('\n')
    const span = sectionSpan(lines, /^##\s+Purpose/i)
    return span ? [...lines.slice(0, span[0] + 1), 'Too short.', '', ...lines.slice(span[1])].join('\n') : null
  },
  'purpose-level-3': (c) => (/^## Purpose/m.test(c) ? c.replace(/^## Purpose/m, '### Purpose') : null),
  'no-requirements-header': (c) => (/^## Requirements/m.test(c) ? c.replace(/^## Requirements.*$/m, '## Reqs') : null),
  'requirements-level-1': (c) => (/^## Requirements/m.test(c) ? c.replace(/^## Requirements/m, '# Requirements') : null),
  'requirements-level-3': (c) => (/^## Requirements/m.test(c) ? c.replace(/^## Requirements/m, '### Requirements') : null),
  'empty-requirements': (c) => {
    const lines = c.split('\n')
    const span = sectionSpan(lines, /^##\s+Requirements\s*$/i)
    return span ? [...lines.slice(0, span[0] + 1), '', ...lines.slice(span[1])].join('\n') : null
  },
  'delta-header-in-main': (c) => `${c.trimEnd()}\n\n## ADDED Requirements\n`,
  'delta-header-in-fence': (c) => `${c.trimEnd()}\n\n\`\`\`\n## ADDED Requirements\n### Requirement: Fenced\n\`\`\`\n`,
  'requirement-outside': (c) => {
    const lines = c.split('\n')
    const i = lines.findIndex((l) => /^##\s+Requirements\s*$/i.test(l))
    return i === -1 ? null : [...lines.slice(0, i), ...STRAY, ...lines.slice(i)].join('\n')
  },
  'requirement-after-section': (c) => `${c.trimEnd()}\n\n## Notes\n\n${STRAY.join('\n')}`,
  'non-requirement-child': (c) => {
    const lines = c.split('\n')
    const i = lines.findIndex((l) => /^##\s+Requirements\s*$/i.test(l))
    return i === -1 ? null : [...lines.slice(0, i + 1), '', '### Notes', 'Plain notes here.', ...lines.slice(i + 1)].join('\n')
  },
  'unclosed-fence': (c) => `\`\`\`\n${c}`
}

const deltaMutations = {
  ...blockMutations,
  'empty-added-section': () => '## ADDED Requirements\n\nNothing parsed here.\n',
  'empty-two-sections': () => '## ADDED Requirements\n\n## REMOVED Requirements\n\n- not a header\n',
  'empty-three-sections': () => '## MODIFIED Requirements\n\n## REMOVED Requirements\n\n## RENAMED Requirements\n\n- FROM: nothing\n',
  'no-delta-headers': (c) => c.replace(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/gim, '## Notes'),
  'lowercase-headers': (c) => c.replace(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/gim, (m) => m.toLowerCase()),
  'level-3-headers': (c) => c.replace(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/gim, (m) => `#${m}`),
  'as-modified': (c) => c.replace(/^##\s+ADDED\s+Requirements/gim, '## MODIFIED Requirements')
}

// Whole-change fixtures: capability directory -> spec.md content (null: directory without spec.md).
const req = (name, body = 'The system SHALL do it.') => `### Requirement: ${name}\n${body}\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n`
const syntheticChanges = {
  'removed-bullets': { a: '## REMOVED Requirements\n\n- `### Requirement: Old one`\n- ### Requirement: Old two\n### Requirement: Old three\n' },
  'removed-duplicate': { a: '## REMOVED Requirements\n\n- `### Requirement: Old`\n- `### Requirement: Old `\n' },
  'renamed-ok': { a: '## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n' },
  'renamed-no-dash': { a: '## RENAMED Requirements\n\nFROM: ### Requirement: Old\nTO: ### Requirement: New\n' },
  'renamed-from-only': { a: '## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n' },
  'renamed-to-only': { a: '## RENAMED Requirements\n\n- TO: `### Requirement: New`\n' },
  'renamed-no-requirement-prefix': { a: '## RENAMED Requirements\n\n- FROM: `Old`\n- TO: `New`\n' },
  'renamed-duplicates': { a: '## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n' },
  'renamed-to-twice': { a: '## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n- TO: `### Requirement: C`\n' },
  'modified-and-removed': { a: `## MODIFIED Requirements\n\n${req('Same')}\n## REMOVED Requirements\n\n### Requirement: Same\n` },
  'modified-and-added': { a: `## ADDED Requirements\n\n${req('Same')}\n## MODIFIED Requirements\n\n${req('Same')}` },
  'added-and-removed': { a: `## ADDED Requirements\n\n${req('Same')}\n## REMOVED Requirements\n\n- \`### Requirement: Same\`\n` },
  'modified-old-renamed-name': { a: `## RENAMED Requirements\n\n- FROM: \`### Requirement: Old\`\n- TO: \`### Requirement: New\`\n\n## MODIFIED Requirements\n\n${req('Old')}` },
  'renamed-to-collides-added': { a: `## RENAMED Requirements\n\n- FROM: \`### Requirement: Old\`\n- TO: \`### Requirement: New\`\n\n## ADDED Requirements\n\n${req('New')}` },
  'duplicate-across-files': { a: `## ADDED Requirements\n\n${req('Same')}`, b: `## ADDED Requirements\n\n${req('Same')}` },
  'one-empty-one-full': { a: `## ADDED Requirements\n\n${req('Fine')}`, b: '## ADDED Requirements\n' },
  'notes-file': { a: `## ADDED Requirements\n\n${req('Fine')}`, b: '# Just notes\n\nNo deltas.\n' },
  'capability-without-spec': { a: `## ADDED Requirements\n\n${req('Fine')}`, b: null },
  'only-capability-without-spec': { a: null },
  'repeated-section': { a: `## ADDED Requirements\n\n${req('First')}\n## ADDED Requirements\n\n${req('Second', 'No keyword here.')}` },
  'scenario-heading-in-text': { a: `## ADDED Requirements\n\n### Requirement: X\n#### Scenario: first\nThe system SHALL x.\n` },
  'header-line-trailing-text': { a: '## ADDED Requirements extra\n\n' + req('X') },
  'h1-and-h3-noise': { a: `# Title\n\n## ADDED Requirements\n\n${req('X')}\n### Not a requirement\nSHALL text\n` },
  'no-specs-dir': {},
  'specs-file-not-dir': { 'spec.md': 'FILE' }
}

// ---- Corpus ----

function buildCorpus(project, work) {
  const source = join(project, 'openspec')
  const target = join(work, 'openspec')
  const specsDir = join(target, 'specs')
  const changesDir = join(target, 'changes')
  cpSync(join(source, 'specs'), specsDir, { recursive: true })
  mkdirSync(changesDir, { recursive: true })
  const realChanges = []
  for (const name of dirs(join(source, 'changes'))) {
    if (name === 'archive') continue
    cpSync(join(source, 'changes', name), join(changesDir, name), { recursive: true })
    realChanges.push(name)
  }
  const archive = join(source, 'changes', 'archive')
  for (const name of existsSync(archive) ? dirs(archive) : []) {
    cpSync(join(archive, name), join(changesDir, name), { recursive: true })
    realChanges.push(name)
  }
  const specs = dirs(specsDir).filter((id) => existsSync(join(specsDir, id, 'spec.md')))
  const counts = { specs: specs.length, changes: realChanges.length, specMutations: 0, deltaMutations: 0, syntheticChanges: 0 }
  const kinds = new Set()

  for (const id of specs) {
    const content = readFileSync(join(specsDir, id, 'spec.md'), 'utf8')
    for (const [kind, mutate] of Object.entries(mainMutations)) {
      const out = mutate(content)
      if (out === null || out === content) continue
      const dir = join(specsDir, `zz-${kind}--${id}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'spec.md'), out)
      counts.specMutations++
      kinds.add(`spec:${kind}`)
    }
  }
  for (const name of realChanges) {
    const changeSpecs = join(changesDir, name, 'specs')
    if (!existsSync(join(changesDir, name, 'proposal.md')) || !existsSync(changeSpecs)) continue
    const capability = dirs(changeSpecs).find((c) => existsSync(join(changeSpecs, c, 'spec.md')))
    if (!capability) continue
    const content = readFileSync(join(changeSpecs, capability, 'spec.md'), 'utf8')
    for (const [kind, mutate] of Object.entries(deltaMutations)) {
      const out = mutate(content)
      if (out === null || out === content) continue
      const dir = join(changesDir, `zz-${kind}--${name}`)
      cpSync(join(changesDir, name), dir, { recursive: true })
      writeFileSync(join(dir, 'specs', capability, 'spec.md'), out)
      counts.deltaMutations++
      kinds.add(`delta:${kind}`)
    }
  }
  for (const [kind, files] of Object.entries(syntheticChanges)) {
    const dir = join(changesDir, `zz-synthetic-${kind}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'proposal.md'), '## Why\n\nParity fixture.\n')
    if (kind !== 'no-specs-dir') mkdirSync(join(dir, 'specs'))
    for (const [capability, content] of Object.entries(files)) {
      if (capability === 'spec.md') {
        writeFileSync(join(dir, 'specs', 'spec.md'), content)
        continue
      }
      mkdirSync(join(dir, 'specs', capability))
      if (content !== null) writeFileSync(join(dir, 'specs', capability, 'spec.md'), content)
    }
    counts.syntheticChanges++
    kinds.add(`change:${kind}`)
  }
  return { counts, kinds: [...kinds].sort() }
}

// ---- Comparison ----

function runCli(work, strict) {
  const args = ['validate', '--all', '--json', ...(strict ? ['--strict'] : [])]
  const env = { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  let stdout
  try {
    stdout = execFileSync('openspec', args, { cwd: work, env, encoding: 'utf8', maxBuffer: 1 << 30 })
  } catch (error) {
    if (!error.stdout) throw error
    stdout = error.stdout
  }
  return JSON.parse(stdout)
}

// The one deliberate difference: the CLI's no-deltas message ends with a tip naming an openspec
// command the flow no longer has; ours drops it.
const CLI_TIP = / Tip: run "openspec change show <change-id> --json --deltas-only" to inspect parsed deltas\.$/
const issueKey = (i) => JSON.stringify({ level: i.level, path: i.path, line: i.line, message: i.message.replace(CLI_TIP, '') })

function compare(cli, ours) {
  const differences = []
  const byId = (items) => new Map(items.map((i) => [`${i.type}/${i.id}`, i]))
  const a = byId(cli.items)
  const b = byId(ours.items)
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key)
    const y = b.get(key)
    if (!x || !y) {
      differences.push({ item: key, kind: x ? 'missing in ours' : 'missing in cli' })
      continue
    }
    if (x.valid !== y.valid) differences.push({ item: key, kind: 'validity', cli: x.valid, ours: y.valid })
    const xs = x.issues.map(issueKey)
    const ys = y.issues.map(issueKey)
    if (JSON.stringify(xs) === JSON.stringify(ys)) continue
    const sorted = (list) => JSON.stringify([...list].sort())
    differences.push({
      item: key,
      kind: sorted(xs) === sorted(ys) ? 'issue order' : 'issues',
      onlyCli: xs.filter((k) => !ys.includes(k)),
      onlyOurs: ys.filter((k) => !xs.includes(k))
    })
  }
  if (JSON.stringify(cli.items.map((i) => i.id)) !== JSON.stringify(ours.items.map((i) => i.id))) {
    differences.push({ item: '*', kind: 'item order' })
  }
  if (JSON.stringify(cli.summary) !== JSON.stringify(ours.summary)) {
    differences.push({ item: '*', kind: 'summary', cli: cli.summary, ours: ours.summary })
  }
  return differences
}

export function parity(project, { keep = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'openspec-parity-'))
  try {
    const { counts, kinds } = buildCorpus(resolve(project), work)
    const runs = [false, true].map((strict) => {
      const cli = runCli(work, strict)
      const ours = validateProject(work, { strict })
      const issues = cli.items.reduce((n, i) => n + i.issues.length, 0)
      return {
        strict,
        items: cli.items.length,
        invalid: cli.summary.totals.failed,
        issues,
        differences: compare(cli, ours)
      }
    })
    const version = execFileSync('openspec', ['--version'], { encoding: 'utf8' }).trim()
    const ok = runs.every((r) => r.differences.length === 0)
    return { ok, openspec: version, corpus: counts, mutationKinds: kinds.length, kinds, runs, ...(keep ? { work } : {}) }
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const [project] = args.filter((a) => a !== '--keep')
  if (!project) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'usage: openspec-validate.mjs <project-root> [--keep]' })}\n`)
    process.exit(1)
  }
  const result = parity(project, { keep })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
