#!/usr/bin/env node
// Dev tool: compares the English check (plugins/adf-english-check/scripts/lib/english.mjs) with the
// origin's .claude/scripts/check-english.mjs over the origin's own tree. The origin's HEAD is
// exported with `git archive` into a temporary directory; nothing is written in the origin.
//
//   node scripts/parity/origin-english.mjs <origin project root>
//
// Every md, mjs, yaml, yml and json file of the export is checked twice: by the origin's CLI
// (repository-relative paths, cwd the export) and by our scope and scanner with a configuration
// that mirrors the origin's scope (its regexes as globs, its three extensions). The per-file
// sets of `line: text` findings are compared. No deliberate difference shows up under that
// configuration, so every difference is unexplained.
//
// The origin's tree is clean by design, so a second pass appends one foreign line to every
// exported file (in the temporary copy) and compares again: that pass compares the two scopes
// file by file.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findForeign, inScope, resolveConfig } from '../../plugins/adf-english-check/scripts/lib/english.mjs'

const origin = process.argv[2]
if (!origin || !existsSync(join(origin, '.claude', 'scripts', 'check-english.mjs'))) {
  console.error('usage: origin-english.mjs <origin project root with .claude/scripts/check-english.mjs>')
  process.exit(2)
}

// The origin's IN_SCOPE and OUT_OF_SCOPE regexes, one glob per extension alternative.
export const ORIGIN_CONFIG = resolveConfig({
  include: [
    '.claude/CLAUDE.md',
    '.claude/scripts/*.mjs',
    '.claude/scripts/__tests__/*.mjs',
    '.claude/commands/opsx/**/*.md',
    '.claude/skills/openspec-sync-specs/**/*.md',
    'openspec/config.yaml',
    'openspec/schemas/**/*.md',
    'openspec/schemas/**/*.yaml',
    'openspec/specs/**/*.md',
    'openspec/changes/**/*.yaml',
    'openspec/changes/**/*.md'
  ],
  exclude: [
    '.claude/scripts/__tests__/check-english.spec.mjs',
    'openspec/changes/*/plan.md',
    'openspec/changes/archive/*/plan.md'
  ],
  extensions: ['md', 'mjs', 'yaml']
})

// The real path: the origin's CLI runs only when argv[1] equals its module URL, and the macOS
// temp directory is reached through a symbolic link.
const tree = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-english-')))
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-english-bin-')))
try {
  execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar HEAD | tar -x -C "$2"', 'sh', origin, tree])
  const files = execFileSync('git', ['-C', origin, 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter((f) => /\.(md|mjs|yaml|yml|json)$/.test(f) && existsSync(join(tree, f)))
  // A copy outside the tree, so the seeded pass does not seed the script it runs.
  const script = join(bin, 'check-english.mjs')
  copyFileSync(join(tree, '.claude', 'scripts', 'check-english.mjs'), script)

  const compare = (pass) => {
    // The origin's CLI prints `<file>:<line>: <text>` for each finding of its in-scope arguments.
    const theirs = new Map()
    for (let i = 0; i < files.length; i += 500) {
      const run = spawnSync('node', [script, ...files.slice(i, i + 500)], { cwd: tree, encoding: 'utf8', maxBuffer: 1 << 28 })
      if ((run.status !== 0 && run.status !== 1) || run.stderr) throw new Error(`origin check failed: ${run.stderr.trim()}`)
      for (const line of run.stdout.split('\n')) {
        const match = /^(.+?):(\d+): (.*)$/s.exec(line)
        if (!match) continue
        if (!theirs.has(match[1])) theirs.set(match[1], new Set())
        theirs.get(match[1]).add(`${match[2]}: ${match[3]}`)
      }
    }
    const ours = new Map()
    for (const f of files) {
      if (!inScope(f, ORIGIN_CONFIG)) continue
      const found = findForeign(readFileSync(join(tree, f), 'utf8'))
      if (found.length) ours.set(f, new Set(found.map((x) => `${x.line}: ${x.text}`)))
    }
    const count = (map) => [...map.values()].reduce((n, s) => n + s.size, 0)
    findings[pass] = { origin: count(theirs), ours: count(ours) }
    for (const f of files) {
      const a = [...(theirs.get(f) ?? [])].sort()
      const b = [...(ours.get(f) ?? [])].sort()
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ pass, file: f, origin: a, ours: b, explained: null })
    }
  }

  const findings = {}
  const differences = []
  compare('tree')
  for (const f of files) appendFileSync(join(tree, f), '\nseeded \u0436\u3001\n')
  compare('seeded')

  const unexplained = differences.filter((d) => d.explained === null)
  console.log(JSON.stringify({
    compared: files.length,
    findings: {
      origin: findings.tree.origin + findings.seeded.origin,
      ours: findings.tree.ours + findings.seeded.ours
    },
    passes: findings,
    differences: differences.length,
    explained: {},
    unexplained
  }, null, 2))
  process.exitCode = unexplained.length === 0 ? 0 : 1
} finally {
  rmSync(tree, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
}
