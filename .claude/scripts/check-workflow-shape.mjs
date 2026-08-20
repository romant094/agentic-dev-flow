#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Documentation that contradicts the workflow's real shape, found by deriving the
// shape from the files that define it rather than remembering it. A check carrying
// "eight artifacts" as a constant would go stale exactly like the prose it hunts —
// that is the defect this exists to end, not a shortcut to it.
//
// This does not scan prose for stray numbers. A first version did, matching any
// digit or English-word count next to "artifact", "command" or "check" anywhere in
// a wide scope of files. Run against the real repository, it produced findings
// dominated by ordinary sentences that count a subset ("four commands call `git
// status --porcelain`"), quote a past state ("it still said \"six checks\""), or
// use the ids as the common English words they are ("the change artifacts (specs,
// tasks, design)") — not a claim about the workflow's total shape. A rule that
// cries wolf that often gets switched off, which leaves less protection than none.
// This version instead compares the derived shape against three specific
// declaration sites — the places where the shape is stated as such, not merely
// mentioned — and touches nothing else.

const SCHEMA = 'openspec/schemas/sdd-plus-superpowers/schema.yaml'
const TEMPLATE = 'openspec/schemas/sdd-plus-superpowers/templates/verify.md'
const COMMANDS = '.claude/commands/opsx'
const CLAUDE_MD = '.claude/CLAUDE.md'
const VERIFY_MD = '.claude/commands/opsx/verify.md'

// `.claude/commands/opsx/` holds six files and the cycle has five stages: sync is a
// read-only preview, not a stage. Deriving from the directory alone would flag every
// correct "five commands" in the repository. Adding a non-cycle command later means
// adding it here — a smaller and more visible obligation than the count going quietly
// wrong.
export const NON_CYCLE_COMMANDS = ['sync.md']

const WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
}

const toNumber = (token) => (/^\d+$/.test(token) ? Number(token) : WORDS[token.toLowerCase()])

const lineAt = (text, index) => text.slice(0, index).split('\n').length

// One record per `- id:` entry in `schema.yaml`'s `artifacts:` list, carrying what
// it generates (compared against `.claude/CLAUDE.md`'s table) and what it requires
// (used to derive which artifact may be missing from the schema description's
// sequence).
function parseArtifactRecords(schemaText) {
  const idMatches = [...schemaText.matchAll(/^ {2}- id:\s*(\S+)/gm)]
  return idMatches.map((m, i) => {
    const start = m.index
    const end = i + 1 < idMatches.length ? idMatches[i + 1].index : schemaText.length
    const block = schemaText.slice(start, end)
    const generatesMatch = block.match(/generates:\s*"?([^"\n]+?)"?\s*$/m)
    const requiresMatch = block.match(/requires:\s*(\[\s*\]|(?:\n\s*-\s*\S+)+)/)
    const requires = requiresMatch ? [...requiresMatch[1].matchAll(/-\s*(\S+)/g)].map((x) => x[1]) : []
    return { id: m[1], generates: generatesMatch ? generatesMatch[1].trim() : '', requires }
  })
}

// The one artifact the schema description's sequence is allowed to skip, derived
// from the `requires` graph rather than named in code. The schema's last artifact
// (today `review`) is the pipeline's terminal stage; walking `requires` back from it
// traces the mandatory chain that must all appear. Any artifact not on that chain —
// today only `design`, which `requires: [brainstorm]` but nothing lists as its own
// requirement — is a side branch the sequence may legitimately omit. (This walk
// assumes a single-parent chain, true of every artifact in the schema today; a real
// fork in `requires` would need a different rule, visibly, when it happens.)
function mandatoryChain(records) {
  const byId = new Map(records.map((r) => [r.id, r]))
  const chain = new Set()
  let current = records[records.length - 1]?.id
  while (current && !chain.has(current)) {
    chain.add(current)
    current = byId.get(current)?.requires[0]
  }
  return chain
}

export function deriveShape({ read, list }) {
  const schemaText = read(SCHEMA)
  const artifactRecords = parseArtifactRecords(schemaText)
  const artifacts = artifactRecords.map((a) => a.id)
  const commands = list(COMMANDS)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !NON_CYCLE_COMMANDS.includes(f))
    .map((f) => f.replace(/\.md$/, ''))
  const checks = [...read(TEMPLATE).matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]))
  const chain = mandatoryChain(artifactRecords)
  const optional = artifacts.filter((id) => !chain.has(id))
  return { artifactRecords, artifacts, commands, checkCount: checks.length, optional }
}

// Site 1: `.claude/CLAUDE.md`'s numbered OpenSpec Change Workflow section — scoped
// to that section alone so a table or sentence elsewhere in this large file can
// never coincidentally match.
//
// A missing anchor is a finding, never silence. Each site here recognises its
// declaration by a pattern, and the person most likely to move that pattern is the
// one changing the shape — precisely when the check must speak.
const NOT_FOUND = '(site not found)'

function claudeMdFindings(file, text, shape) {
  const heading = text.match(/^## \d+\.\s*OpenSpec Change Workflow\s*$/m)
  if (!heading) {
    return [
      {
        file,
        site: 'claude-md-section-missing',
        text: '(no `## <n>. OpenSpec Change Workflow` heading — the declaration site was not found)',
        expected: 'the workflow section, carrying the cycle line and the artifact table',
        actual: NOT_FOUND
      }
    ]
  }
  const sectionStart = heading.index + heading[0].length
  const rest = text.slice(sectionStart)
  const nextHeading = rest.search(/^## /m)
  const sectionEnd = sectionStart + (nextHeading === -1 ? rest.length : nextHeading)
  const section = text.slice(sectionStart, sectionEnd)
  const out = []

  const cycleMatch = section.match(/^Cycle:.*$/m)
  if (cycleMatch) {
    const named = [...cycleMatch[0].matchAll(/\/opsx:([a-zA-Z]+)/g)].map((m) => m[1])
    const namedSet = new Set(named)
    const missing = shape.commands.filter((c) => !namedSet.has(c))
    const extra = named.filter((c) => !shape.commands.includes(c))
    if (missing.length || extra.length) {
      out.push({
        file,
        line: lineAt(text, sectionStart + cycleMatch.index),
        site: 'claude-md-cycle',
        text: cycleMatch[0].trim(),
        expected: shape.commands.join(', '),
        actual: named.join(', ')
      })
    }
  } else {
    out.push({
      file,
      line: lineAt(text, sectionStart),
      site: 'claude-md-cycle-missing',
      text: '(no line beginning `Cycle:` in the workflow section — the declaration site was not found)',
      expected: shape.commands.join(', '),
      actual: NOT_FOUND
    })
  }

  const countMatch = section.match(/\b([A-Za-z]+) artifacts, in this order/)
  if (countMatch) {
    const found = toNumber(countMatch[1])
    if (found !== shape.artifacts.length) {
      out.push({
        file,
        line: lineAt(text, sectionStart + countMatch.index),
        site: 'claude-md-artifact-count',
        text: countMatch[0],
        expected: shape.artifacts.length,
        actual: found
      })
    }
  } else {
    out.push({
      file,
      line: lineAt(text, sectionStart),
      site: 'claude-md-artifact-count-missing',
      text: '(no `<N> artifacts, in this order` phrase in the workflow section — the declaration site was not found)',
      expected: shape.artifacts.length,
      actual: NOT_FOUND
    })
  }

  const rows = [...section.matchAll(/^\|\s*`([^`]+)`/gm)].map((m) => m[1])
  const derivedGenerates = shape.artifactRecords.map((a) => a.generates)
  const missingRows = derivedGenerates.filter((g) => !rows.includes(g))
  const extraRows = rows.filter((g) => !derivedGenerates.includes(g))
  if (missingRows.length || extraRows.length) {
    out.push({
      file,
      site: 'claude-md-artifact-table',
      text: rows.join(', ') || '(no table rows found)',
      expected: derivedGenerates.join(', '),
      actual: rows.join(', ')
    })
  }

  return out
}

// Site 2: `schema.yaml`'s top-level `description:` block — the arrow sequence of
// artifact ids it carries must name every artifact on the mandatory chain (design
// alone may be skipped, per `mandatoryChain` above).
function schemaDescriptionFindings(file, text, shape) {
  const descStart = text.indexOf('description:')
  if (descStart === -1) {
    return [
      {
        file,
        site: 'schema-description-missing',
        text: '(no `description:` key in the schema — the declaration site was not found)',
        expected: shape.artifacts.filter((a) => !shape.optional.includes(a)).join(' → '),
        actual: NOT_FOUND
      }
    ]
  }
  const afterHeader = text.indexOf('\n', descStart) + 1
  const rel = text.slice(afterHeader).search(/^\S/m)
  const descBlock = text.slice(afterHeader, afterHeader + (rel === -1 ? text.length : rel))

  const idAlternation = shape.artifacts.join('|')
  const seqMatch = descBlock.match(
    new RegExp(`\\b(?:${idAlternation})\\b(?:\\s*→\\s*\\b(?:${idAlternation})\\b)+`, 'i')
  )
  if (!seqMatch) {
    return [
      {
        file,
        site: 'schema-description-sequence',
        text: '(no artifact sequence found in description)',
        expected: shape.artifacts.filter((a) => !shape.optional.includes(a)).join(' → '),
        actual: ''
      }
    ]
  }

  const idPattern = new RegExp(`\\b(?:${idAlternation})\\b`, 'gi')
  const named = new Set([...seqMatch[0].matchAll(idPattern)].map((m) => m[0].toLowerCase()))
  const mandatory = shape.artifacts.filter((a) => !shape.optional.includes(a))
  const missing = mandatory.filter((a) => !named.has(a))
  if (missing.length === 0) return []

  return [
    {
      file,
      line: lineAt(text, afterHeader + seqMatch.index),
      site: 'schema-description-sequence',
      text: seqMatch[0],
      expected: mandatory.join(' → '),
      actual: [...named].join(' → ')
    }
  ]
}

// Site 3: `.claude/commands/opsx/verify.md`'s statement of how many sections the
// report template has and that they are the checks — one sentence, two numbers,
// both must equal the derived check count.
function verifyMdFindings(file, text, shape) {
  const m = text.match(/(\w+)\s+sections\s+are\s+the\s+(\w+)\s+checks/i)
  if (!m) {
    return [
      {
        file,
        site: 'verify-md-sections-missing',
        text: '(no `<N> sections are the <N> checks` sentence — the declaration site was not found)',
        expected: shape.checkCount,
        actual: NOT_FOUND
      }
    ]
  }
  const out = []
  const sections = toNumber(m[1])
  const checks = toNumber(m[2])
  const line = lineAt(text, m.index)
  if (sections !== shape.checkCount) {
    out.push({
      file,
      line,
      site: 'verify-md-sections',
      text: m[0],
      expected: shape.checkCount,
      actual: sections
    })
  }
  if (checks !== shape.checkCount) {
    out.push({
      file,
      line,
      site: 'verify-md-checks',
      text: m[0],
      expected: shape.checkCount,
      actual: checks
    })
  }
  return out
}

export function checkWorkflowShape({ read, list }) {
  const shape = deriveShape({ read, list })
  const findings = [
    ...claudeMdFindings(CLAUDE_MD, read(CLAUDE_MD), shape),
    ...schemaDescriptionFindings(SCHEMA, read(SCHEMA), shape),
    ...verifyMdFindings(VERIFY_MD, read(VERIFY_MD), shape)
  ]
  return { ok: findings.length === 0, findings }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const { ok, findings } = checkWorkflowShape({
    read: (f) => readFileSync(f, 'utf8'),
    list: (d) => readdirSync(d)
  })
  if (!ok) {
    console.error('STOP: documentation contradicts the workflow shape derived from its own sources.')
    for (const f of findings) {
      console.error(`  ${f.file}${f.line ? `:${f.line}` : ''} [${f.site}] expected ${f.expected}, got ${f.actual}`)
      console.error(`    ${f.text}`)
    }
    process.exit(1)
  }
}
