// The eleven `adf` commands are skills (iteration 17, section 3): both Claude Code and Codex read
// `plugins/adf/skills/<name>/SKILL.md`, and a runtime that substitutes neither `${CLAUDE_PLUGIN_ROOT}`
// nor `$ARGUMENTS` is told what they mean by one line after the frontmatter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

// The first sentence names the two tokens; the second sends a runtime other than Claude Code to
// its tool map, which lives in the adf plugin, so the adf-jira skills carry the first sentence only.
const TOKEN_SENTENCE =
  'In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file\'s directory, and `$ARGUMENTS` is the text the developer wrote after this skill\'s name.'
const TOKEN_LINE = `${TOKEN_SENTENCE} Outside Claude Code, read \`\${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md\` first: it maps this text's dispatches and questions to your tools.`

const skillsOf = (plugin) =>
  readdirSync(join(repo, 'plugins', plugin, 'skills')).map((name) => ({ plugin, name, text: readFileSync(join(repo, 'plugins', plugin, 'skills', name, 'SKILL.md'), 'utf8') }))

const frontmatterOf = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)

test('every adf skill has name equal to its directory', () => {
  const skills = skillsOf('adf')
  assert.equal(skills.length, 11)
  for (const { name, text } of skills) {
    assert.equal(/^name:\s*(.+)$/m.exec(frontmatterOf(text)[1])?.[1], name, name)
  }
})

test('every skill that uses ${CLAUDE_PLUGIN_ROOT} or $ARGUMENTS carries the token line', () => {
  const skills = [...skillsOf('adf'), ...skillsOf('adf-jira')]
  let carrying = 0
  for (const { plugin, name, text } of skills) {
    if (!/\$\{CLAUDE_PLUGIN_ROOT\}|\$ARGUMENTS/.test(text)) continue
    carrying += 1
    const body = text.slice(frontmatterOf(text)[0].length)
    const first = body.split('\n', 1)[0]
    assert.ok(first.startsWith(TOKEN_SENTENCE), `${plugin}/${name}: the token sentence is not the first body line`)
    if (plugin === 'adf') assert.equal(first, TOKEN_LINE, `${plugin}/${name}: the full token line`)
    assert.equal(body.split('\n', 2)[1], '', `${plugin}/${name}: a blank line follows the token line`)
  }
  assert.ok(carrying >= 18, `only ${carrying} skills use a token`)
})

test('plugins/adf/commands/ does not exist', () => {
  assert.equal(existsSync(join(repo, 'plugins', 'adf', 'commands')), false)
})
