// Helpers for the user guide in docs/guide/ (used by scripts/check-guide.mjs).
//
// - `parseSources` reads the `<!-- sources: ... -->` comment on a page's first lines;
// - `matchGlob` matches a path against a source pattern (`*` and `**` only);
// - `readPages` reads every page of the guide;
// - `listFiles` lists the files under some directories.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function parseSources(text) {
  const match = /^\s*<!--\s*sources:([\s\S]*?)-->/.exec(text)
  if (!match) return []
  return match[1]
    .split('\n')
    .map((line) => /^\s*-\s+(.+?)\s*$/.exec(line)?.[1])
    .filter(Boolean)
}

// `*` is the characters of one path segment; `**` is any number of segments.
export function matchGlob(pattern, path) {
  let source = ''
  const parts = pattern.split('/')
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    if (part === '**') {
      source += last ? '.*' : '(?:[^/]+/)*'
    } else {
      source += part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
      if (!last) source += '/'
    }
  })
  return new RegExp(`^${source}$`).test(path)
}

export function listFiles(root, dirs) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else out.push(path)
    }
  }
  for (const dir of dirs) {
    if (statSync(join(root, dir), { throwIfNoEntry: false })?.isDirectory()) walk(dir.replace(/\/+$/, ''))
  }
  return out.sort()
}

export function readPages(root) {
  return listFiles(root, ['docs/guide'])
    .filter((path) => path.endsWith('.md'))
    .map((path) => {
      const text = readFileSync(join(root, path), 'utf8')
      return { path, text, sources: parseSources(text) }
    })
}
