#!/usr/bin/env node
// Writes the manifests Codex reads from the Claude Code ones, so the versions stay in one place
// (`.claude-plugin/`):
//
// - `plugins/<name>/plugin.json`, in the agent-plugins.org schema;
// - `.agents/plugins/marketplace.json`, the Codex marketplace.
//
// `--check` writes nothing and exits 1 when a generated file differs. Run by check-release.mjs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const COPIED = ['author', 'homepage', 'repository', 'license', 'keywords']

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export function pluginManifest(claude) {
  const manifest = { $schema: SCHEMA, name: claude.name, version: claude.version, description: claude.description }
  for (const key of COPIED) if (claude[key] !== undefined) manifest[key] = claude[key]
  manifest.extensions = {
    'com.openai': { interface: { displayName: claude.name, shortDescription: claude.description } },
  }
  return manifest
}

export function codexMarketplace(entries) {
  return {
    name: 'agentic-dev-flow',
    interface: { displayName: 'Agentic Dev Flow' },
    plugins: entries.map(({ name, version, description }) => ({
      name,
      version,
      description,
      source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    })),
  }
}

export function syncManifests({ root: base = root, check = false } = {}) {
  const marketplace = readJson(join(base, '.claude-plugin', 'marketplace.json'))
  const files = {}
  const entries = []
  for (const { name, source } of marketplace.plugins ?? []) {
    const claude = readJson(join(base, source, '.claude-plugin', 'plugin.json'))
    files[`${source.replace(/^\.\//, '')}/plugin.json`] = pluginManifest(claude)
    entries.push({ name, version: claude.version, description: claude.description })
  }
  files['.agents/plugins/marketplace.json'] = codexMarketplace(entries)

  const written = []
  const differ = []
  for (const [path, value] of Object.entries(files)) {
    const text = `${JSON.stringify(value, null, 2)}\n`
    const file = join(base, path)
    if (existsSync(file) && readFileSync(file, 'utf8') === text) continue
    if (check) {
      differ.push(path)
    } else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
      written.push(path)
    }
  }
  return { ok: differ.length === 0, written, differ }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--check')) {
    process.stderr.write('usage: manifests.mjs [--check]\n')
    process.exit(2)
  }
  const result = syncManifests({ check: args.includes('--check') })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
