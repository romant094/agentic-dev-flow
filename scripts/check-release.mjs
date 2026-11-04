#!/usr/bin/env node
// Checks the package version in .claude-plugin/marketplace.json (`metadata.version`). Run by
// `npm test`:
//
// - `metadata.version` is x.y.z;
// - each plugin entry's version equals its `plugins/<name>/.claude-plugin/plugin.json`;
// - a `v<x.y.z>` tag on HEAD equals `v<metadata.version>`;
// - the files `manifests.mjs` generates for Codex match `manifests.mjs --check`;
// - CHANGELOG.md has a `## [<metadata.version>]` section;
// - every tag pinned in README.md and docs/guide/getting-started/*.md is `v<metadata.version>`.
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'
import { syncManifests } from './manifests.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const semver = /^\d+\.\d+\.\d+$/

// The x.y.z of every `## [x.y.z]` heading; `## [Unreleased]` is not a version.
export function changelogVersions(text) {
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1])
}

// Every tag an install command pins: `--ref v<x.y.z>`, `"ref": "v<x.y.z>"` or `#v<x.y.z>`.
export function pinnedTags(text) {
  return [...text.matchAll(/(?:--ref |"ref": ?"|#)(v\d+\.\d+\.\d+)\b/g)].map((match) => match[1])
}

export function checkRelease({ marketplace, manifests, headTags, differ = [], changelog, pinned = [] }) {
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
  if (changelog !== undefined && !changelogVersions(changelog).includes(version)) {
    errors.push(`CHANGELOG.md has no section for ${version}`)
  }
  for (const { file, tags } of pinned) {
    for (const tag of tags) {
      if (tag !== `v${version}`) errors.push(`${file}: pinned tag ${tag} must be v${version}`)
    }
  }
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
  const gettingStarted = join('docs', 'guide', 'getting-started')
  const pinFiles = readdirSync(join(root, gettingStarted))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(gettingStarted, name))
  const pinned = ['README.md', ...pinFiles].map((file) => ({ file, tags: pinnedTags(readFileSync(join(root, file), 'utf8')) }))
  const errors = checkRelease({
    marketplace,
    manifests,
    headTags,
    differ: syncManifests({ check: true }).differ,
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    pinned,
  })
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors }, null, 2)}\n`)
  process.exitCode = errors.length === 0 ? 0 : 1
}
