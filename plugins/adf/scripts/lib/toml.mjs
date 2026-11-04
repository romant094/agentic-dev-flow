// A small TOML reader for the two shapes Codex's config.toml needs here: `[table."key"]` headers
// and `key = value` lines with a string, boolean or number value. Anything else (arrays, inline
// tables, dotted keys, array-of-tables headers) is skipped, never an error.
//
// readToml(text) -> { [table]: { [key]: string | boolean | number } }, the table name joined by
// dots and unquoted (`plugins.adf@agentic-dev-flow`); top-level keys sit under the table ''.

const BARE = '[A-Za-z0-9_-]+'
const KEY = new RegExp(`^(${BARE}|"[^"]*"|'[^']*')\\s*=\\s*(.*)$`)

const unquote = (part) => (/^["'].*["']$/.test(part) ? part.slice(1, -1) : part)

// The parts of a header's name, or null when a part is not a bare or quoted key.
function headerName(inner) {
  const parts = []
  let rest = inner.trim()
  while (rest) {
    const m = rest.match(new RegExp(`^(${BARE}|"[^"]*"|'[^']*')\\s*(\\.\\s*|$)`))
    if (!m) return null
    parts.push(unquote(m[1]))
    rest = rest.slice(m[0].length)
  }
  return parts.length ? parts.join('.') : null
}

function scalar(raw) {
  const text = raw.trim()
  const quoted = text.match(/^"((?:[^"\\]|\\.)*)"/) ?? text.match(/^'([^']*)'/)
  if (quoted) return quoted[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  const bare = text.replace(/\s*#.*$/, '')
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(bare)) return Number(bare.replace(/_/g, ''))
  return undefined
}

// Bracket depth of a value's text, ignoring quoted strings and a trailing comment.
const depth = (text) => [...text.replace(/"[^"]*"|'[^']*'/g, '').replace(/#.*$/, '')].reduce((n, c) => n + ('[{'.includes(c) ? 1 : ']}'.includes(c) ? -1 : 0), 0)

export function readToml(text) {
  const tables = { '': {} }
  let current = tables['']
  let skipping = false
  let open = 0
  let closing = null // the delimiter that ends a multi-line string being skipped
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (closing) {
      if (line.includes(closing)) closing = null
      continue
    }
    if (skipping) {
      open += depth(trimmed)
      if (open <= 0) skipping = false
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) {
      const header = !trimmed.startsWith('[[') && trimmed.match(/^\[(.+)\]\s*(#.*)?$/)
      const name = header ? headerName(header[1]) : null
      // An unknown header skips its keys, so they are not filed under the table before it.
      current = name === null ? {} : (tables[name] ??= {})
      continue
    }
    const m = trimmed.match(KEY)
    if (!m) continue
    const multi = m[2].match(/^("""|''')(.*)$/)
    if (multi) {
      if (!multi[2].includes(multi[1])) closing = multi[1]
      continue
    }
    const value = scalar(m[2])
    if (value !== undefined) current[unquote(m[1])] = value
    else if (/^[[{]/.test(m[2])) {
      open = depth(m[2])
      skipping = open > 0
    }
  }
  return tables
}
