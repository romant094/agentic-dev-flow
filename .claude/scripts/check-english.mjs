#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Cyrillic, CJK punctuation, ideographs, and fullwidth forms. Deliberately does not
// match em dashes, arrows or typographic quotes — those are fine in English prose.
// Written with escapes, not literals, so this file does not trip its own check.
const FOREIGN = /[\u0400-\u04ff\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

export function findForeignLines(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (FOREIGN.test(line)) out.push({ line: i + 1, text: line })
  })
  return out
}

// Repository-relative paths the English-only rule governs: the OpenSpec/Superpowers
// workflow's own artifacts and machinery. Everything else (.claude/memory/, other
// skills' READMEs with functional non-English trigger phrases, general src/ code) is
// deliberately out of scope: those files legitimately carry non-English text.
const IN_SCOPE = [
  /^\.claude\/CLAUDE\.md$/,
  /^\.claude\/scripts\/[^/]+\.mjs$/,
  /^\.claude\/commands\/opsx\/.*\.md$/,
  /^\.claude\/skills\/openspec-sync-specs\/.*\.md$/,
  /^openspec\/config\.yaml$/,
  /^openspec\/schemas\/.*\.(md|yaml)$/,
  /^openspec\/specs\/.*\.md$/,
  /^openspec\/changes\/.*\.(yaml|md)$/
]

// Excluded even though they'd otherwise match IN_SCOPE: this script's own test
// fixtures are deliberately foreign text, and a change's filled-in plan.md quotes
// literal code/fixture snippets (including this script's own foreign-text examples).
// The plan keeps that exemption after `/opsx:archive` moves it under archive/<date>-<name>/ —
// the move does not change a byte of the file, so it must not change the verdict.
const OUT_OF_SCOPE = [
  /^\.claude\/scripts\/check-english\.test\.mjs$/,
  /^openspec\/changes\/[^/]+\/plan\.md$/,
  /^openspec\/changes\/archive\/[^/]+\/plan\.md$/
]

export function isInScope(path) {
  if (OUT_OF_SCOPE.some((re) => re.test(path))) return false
  return IN_SCOPE.some((re) => re.test(path))
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  let bad = 0
  for (const file of process.argv.slice(2).filter(isInScope)) {
    for (const { line, text } of findForeignLines(readFileSync(file, 'utf8'))) {
      console.log(`${file}:${line}: ${text}`)
      bad += 1
    }
  }
  process.exit(bad > 0 ? 1 : 0)
}
