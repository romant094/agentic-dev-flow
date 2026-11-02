// The sections of the host's planning guide, `<root>/openspec/planning.md`: a section runs from
// its `## ` heading to the next heading of level one or two. Here, not in lib/suite.mjs, so that
// lib/commit.mjs reads a section without importing suite.mjs, which imports it back through
// lib/verify.mjs.
export const PLANNING_FILE = 'openspec/planning.md'

// [start, end) line indexes of the section body, or null when the heading is absent.
export function sectionBounds(lines, heading) {
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at < 0) return null
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  if (end < 0) end = lines.length
  return { at, start: at + 1, end }
}

// The one line of a guide section: a fenced block, an inline code span or a plain line; null
// when the section is absent or empty.
export function sectionLine(text, heading, what) {
  const lines = String(text ?? '').split(/\r?\n/)
  const bounds = sectionBounds(lines, heading)
  if (!bounds) return null
  const body = lines.slice(bounds.start, bounds.end).join('\n').replace(/<!--[\s\S]*?-->/g, '')
  const fence = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1\s*$/m.exec(body)
  const candidates = (fence ? fence[2] : body).split('\n').map((l) => l.trim()).filter(Boolean)
  if (candidates.length === 0) return null
  if (candidates.length > 1) throw new Error(`the ${heading} section holds ${candidates.length} lines; it must hold one ${what}`)
  const line = candidates[0]
  const inline = /^`([^`]+)`\.?$/.exec(line)
  return (inline ? inline[1] : line).trim() || null
}
