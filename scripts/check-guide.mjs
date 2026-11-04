#!/usr/bin/env node
// Checks the user guide in docs/guide/ against the repository. Run by `npm test` (once the
// guide exists):
//
// - every skill (`/<plugin>:<name>`), plugin, extension point and registry key appears
//   in backticks on some page;
// - every file under plugins/*/skills/, contract/ and hooks/ matches a `sources:` entry of some page;
// - every `sources:` entry matches at least one file;
// - every link in a page, in README.md and in CHANGELOG.md resolves to a file or a directory.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'
import { listFiles, matchGlob, readPages } from './lib/guide.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The top level and the entry fields of the registry (plugins/adf/contract/README.md `## The registry`).
export const REGISTRY_KEYS = ['contract', 'branches', 'extensions', 'metrics', 'plugin', 'path', 'points', 'config', 'version']

const external = /^(?:[a-z][a-z0-9+.-]*:|#)/i

function links(text) {
  const out = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const m of line.matchAll(/\]\(([^)\s]+)[^)]*\)/g)) out.push(m[1])
  }
  return out
}

export function checkGuide({ pages, extraLinkPages = [], skills, plugins, points, registryKeys, coveredFiles, files, exists }) {
  const errors = []
  const all = pages.map((p) => p.text).join('\n')
  const named = (token) => all.includes(`\`${token}\``)

  for (const skill of skills) if (!named(`/${skill}`)) errors.push(`no page names the skill \`/${skill}\``)
  for (const plugin of plugins) if (!named(plugin)) errors.push(`no page names the plugin \`${plugin}\``)
  for (const point of points) if (!named(point)) errors.push(`no page names the extension point \`${point}\``)
  for (const key of registryKeys) if (!named(key)) errors.push(`no page names the registry key \`${key}\``)

  const globs = pages.flatMap((p) => p.sources)
  for (const file of coveredFiles) {
    if (!globs.some((g) => matchGlob(g, file))) errors.push(`${file} is covered by no page's sources`)
  }
  for (const page of pages) {
    for (const glob of page.sources) {
      if (!files.some((f) => matchGlob(glob, f))) errors.push(`${page.path}: source ${glob} matches no file`)
    }
  }

  for (const page of [...pages, ...extraLinkPages]) {
    for (const link of links(page.text)) {
      if (external.test(link)) continue
      const target = link.split('#')[0]
      if (!target) continue
      if (!exists(posix.normalize(posix.join(posix.dirname(page.path), target)))) {
        errors.push(`${page.path}: link ${link} does not resolve`)
      }
    }
  }
  return errors
}

if (isMain(import.meta.url)) {
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'))
  const plugins = (marketplace.plugins ?? []).map((p) => p.name)
  const skills = readdirSync(join(root, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      listFiles(root, [`plugins/${d.name}/skills`])
        .map((f) => new RegExp(`^plugins/${d.name}/skills/([^/]+)/SKILL\\.md$`).exec(f)?.[1])
        .filter(Boolean)
        .map((name) => `${d.name}:${name}`),
    )
  const points = [...read('plugins/adf/contract/README.md').matchAll(/^### `([^`]+)`/gm)].map((m) => m[1])
  const pluginDirs = readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const coveredFiles = listFiles(root, pluginDirs.flatMap((p) => ['skills', 'contract', 'hooks'].map((s) => `plugins/${p}/${s}`)))
  const topFiles = readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
  const files = [...new Set([...listFiles(root, ['plugins', 'scripts', '.claude-plugin', 'docs']), ...topFiles])]
  const extraLinkPages = ['README.md', 'CHANGELOG.md']
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: read(path) }))
  const errors = checkGuide({
    pages: readPages(root),
    extraLinkPages,
    skills,
    plugins,
    points,
    registryKeys: REGISTRY_KEYS,
    coveredFiles,
    files,
    exists: (path) => existsSync(join(root, path)),
  })
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`)
  process.exitCode = errors.length === 0 ? 0 : 1
}
