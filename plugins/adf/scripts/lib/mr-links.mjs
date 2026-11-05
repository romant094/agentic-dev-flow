// The merge request links of a change: the scope's taken and partial items as data for the
// forge operations `open` and `finalize` (contract 1.10, `links`), and the lines the core
// writes itself for a provider written before 1.10. Built by script from scope.json; the
// agent never writes them.
import { spawnSync } from 'node:child_process'
import { atOrBelow } from './registry.mjs'
import { IN_SCOPE } from './scope.mjs'

export const LINKS_SINCE = '1.10'

const gitIn = (root) => (args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout ?? '' }
}

// The links of the scope, tracker items first, each group in the scope's order. A debt link
// carries the commit the forge holds, the merge base with origin/<base>, when the entry's block
// index is in it; archive may move the entry later, and gather reads the working tree, so the
// entry may be absent from that commit. `git(args)` runs in `root`.
export function buildLinks(root, scope, base, { git = gitIn(root) } = {}) {
  const items = (scope?.items ?? []).filter((i) => IN_SCOPE.includes(i.state))
  if (items.length === 0) return []
  const tracker = items.filter((i) => i.source === 'tracker')
  const debt = items.filter((i) => i.source === 'debt')
  let commit = null
  if (debt.length > 0) {
    const run = git(['merge-base', 'HEAD', `origin/${base}`])
    if (run.status === 0 && run.stdout.trim() !== '') commit = run.stdout.trim()
  }
  return [
    ...tracker.map((i) => ({ kind: 'tracker', key: i.key, title: i.title, url: i.url ?? null })),
    ...debt.map((i) => {
      const path = i.files?.[0]
      const held = commit !== null && path !== undefined && git(['cat-file', '-e', `${commit}:${path}`]).status === 0
      return { kind: 'debt', key: i.key, title: i.title, path, commit: held ? commit : null }
    })
  ]
}

// A title on one line, with `]` escaped so it cannot close a link early.
const oneLine = (title) => String(title).replace(/\]/g, '\\]').replace(/\r?\n|\r/g, ' ')

// The lines at the top of a description. A debt link has no URL here: the core makes no file URL.
export function renderLinks(links) {
  if (links.length === 0) return ''
  const lines = links.map((l) => {
    const label = l.kind === 'debt' ? 'Debt' : 'Issue'
    const key = l.kind === 'tracker' && l.url ? `[${l.key}](${l.url})` : l.key
    return `- ${label} ${key}: ${oneLine(l.title)}`
  })
  return `Scope:\n${lines.join('\n')}\n\n`
}

// The input of a forge call with the links. A provider of contract 1.10 or later takes `links`;
// an earlier one gets the lines at the top of `body` at finalize, and an `open` stays as it is.
export function linksInput(operation, input, links, providerContract) {
  if (links.length === 0) return input
  if (!atOrBelow(providerContract, '1.9')) return { ...input, links }
  if (operation === 'finalize') return { ...input, body: renderLinks(links) + input.body }
  return input
}
