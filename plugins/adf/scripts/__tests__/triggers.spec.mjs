// Trigger phrases (decision D16 of iteration 13, the rule in the root README's "Core and
// plugins"): every skill and command of every plugin writes its triggers in English and carries
// the note that a trigger may come in any language. Runs on the real files of this repository;
// the fixtures beside it only prove the check can fire.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const rel = (path) => relative(repo, path).split(sep).join('/')

export const NOTE = 'Triggers may be phrased in any language.'

// The Agent Skills limit on `description`; `claude plugin validate` enforces none.
const DESCRIPTION_MAX = 1024

// ASCII printable, plus the typographic punctuation these files already use.
const ALLOWED = /^[\x20-\x7E\t—–‘’“”→←…×−]*$/u

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

// Every SKILL.md under plugins/*/skills/ and every command under plugins/*/commands/.
function triggerFiles() {
  const plugins = join(repo, 'plugins')
  return readdirSync(plugins).flatMap((plugin) =>
    ['skills', 'commands'].flatMap((kind) => {
      const dir = join(plugins, plugin, kind)
      try {
        statSync(dir)
      } catch {
        return []
      }
      return walk(dir).filter((f) => (kind === 'skills' ? f.endsWith(`${sep}SKILL.md`) : f.endsWith('.md')))
    })
  )
}

// The trigger surface: the frontmatter `description`, which Claude Code matches a request on,
// and every body line that names a trigger or sits under a "Triggers"/"When to use" heading.
export function triggerSurface(text) {
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const description = front ? (/^description:\s*(.*)$/m.exec(front[1])?.[1] ?? '').replace(/^(['"])(.*)\1$/, '$2') : ''
  const body = front ? text.slice(front[0].length) : text
  const lines = []
  let underHeading = false
  for (const line of body.split('\n')) {
    if (/^#+\s/.test(line)) {
      underHeading = /trigger|when to use|use when/i.test(line)
      if (underHeading) lines.push(line)
      continue
    }
    if (underHeading || /\btrigger/i.test(line) || /\buse when\b/i.test(line)) lines.push(line)
  }
  return { description, lines }
}

// Returns the problems of one file's text, [] when it keeps the rule.
export function triggerProblems(text) {
  const { description, lines } = triggerSurface(text)
  const problems = []
  if (!description) problems.push('no frontmatter description')
  if (description.length > DESCRIPTION_MAX) problems.push(`description longer than ${DESCRIPTION_MAX} characters`)
  for (const line of [description, ...lines]) {
    const bad = [...line].filter((ch) => !ALLOWED.test(ch))
    if (bad.length) problems.push(`non-English characters ${[...new Set(bad)].join('')} in: ${line.slice(0, 80)}`)
  }
  if (!description.includes(NOTE)) problems.push(`description lacks the note "${NOTE}"`)
  return problems
}

// Non-Latin fixture text is escaped, as in the English check's own tests.
const RU = '\u0441\u0434\u0435\u043b\u0430\u0439'
const JA = '\u3092\u5b9f\u884c'

const skill = (description, body = '') => `---\nname: x\ndescription: ${description}\n---\n\n${body}`

test('the trigger check fires on a Cyrillic trigger, a missing note and a non-Latin body trigger', () => {
  assert.deepEqual(triggerProblems(skill(`Use to do x. Triggers on "do x" — the arrow →. ${NOTE}`)), [])
  const cyrillic = triggerProblems(skill(`Use to do x. Triggers on "do x", "${RU} x". ${NOTE}`))
  assert.equal(cyrillic.length, 1)
  assert.match(cyrillic[0], /^non-English characters/)
  assert.deepEqual(triggerProblems(skill('Use to do x. Triggers on "do x".')), [`description lacks the note "${NOTE}"`])
  const body = triggerProblems(skill(`Use to do x. ${NOTE}`, `## Triggers\n\n- "do x"\n- "x ${JA}"\n`))
  assert.equal(body.length, 1)
  assert.match(body[0], new RegExp(`x ${JA}`))
  assert.deepEqual(triggerProblems('no frontmatter'), ['no frontmatter description', `description lacks the note "${NOTE}"`])
})

test('every skill and command of every plugin writes its triggers in English and carries the note', () => {
  const files = triggerFiles()
  assert.ok(files.some((f) => f.endsWith(`${sep}SKILL.md`)), 'no SKILL.md was found')
  assert.ok(files.some((f) => f.includes(`${sep}commands${sep}`)), 'no command was found')
  const found = files.flatMap((f) => triggerProblems(readFileSync(f, 'utf8')).map((p) => `${rel(f)}: ${p}`))
  assert.deepEqual(found, [], found.join('\n'))
})
