#!/usr/bin/env node
// Checks the package version in .claude-plugin/marketplace.json (`metadata.version`). Run by
// `npm test`:
//
// - `metadata.version` is x.y.z;
// - each plugin entry's version equals its `plugins/<name>/.claude-plugin/plugin.json`;
// - a `v<x.y.z>` tag on HEAD equals `v<metadata.version>`;
// - the files `manifests.mjs` generates for Codex match `manifests.mjs --check`.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'
import { syncManifests } from './manifests.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const semver = /^\d+\.\d+\.\d+$/

export function checkRelease({ marketplace, manifests, headTags, differ = [] }) {
  const errors = []
  const version = marketplace.metadata?.version
  if (typeof version !== 'string' || !semver.test(version)) errors.push('metadata.version must be x.y.z')
  for (const { name, version: entry } of marketplace.plugins ?? []) {
    if (manifests[name] !== entry) {
      errors.push(`plugin ${name}: marketplace.json says ${entry}, plugin.json says ${manifests[name]}`)
    }
  }
  for (const tag of headTags) {
    if (tag !== `v${version}`) errors.push(`tag ${tag} on HEAD must equal v${version}`)
  }
  for (const path of differ) errors.push(`${path} differs from .claude-plugin/: run node scripts/manifests.mjs`)
  return errors
}

if (isMain(import.meta.url)) {
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const manifests = {}
  for (const { name, source } of marketplace.plugins ?? []) {
    manifests[name] = JSON.parse(readFileSync(join(root, source, '.claude-plugin', 'plugin.json'), 'utf8')).version
  }
  const headTags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  const errors = checkRelease({ marketplace, manifests, headTags, differ: syncManifests({ check: true }).differ })
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`)
  process.exitCode = errors.length === 0 ? 0 : 1
}
