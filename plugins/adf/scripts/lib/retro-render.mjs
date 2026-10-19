// The retrospective's report, `.adf/retro/<date>-<mode>.md`, rendered by script from the sidecar
// (lib/window.mjs buildSidecar) and the computed reply (lib/retro.mjs compute). The agent writes
// no number: every figure here is a value the sidecar carries or a key the reply cited, resolved
// by compute to `{ key, value }`. Deciding nothing: it renders.
//
// `retroDocument` is the committed sidecar, `.adf/retro/<date>-<mode>.json`: the sidecar with the
// computed reply's fields added, so the next window reads its cut-off and aggregates from it and
// the `upstream` role reads the findings from it.
const HEADING = { window: 'Window', change: 'Change', period: 'Period' }

const shown = (v) => (v === null || v === undefined ? 'n/a' : String(v))
const cell = (v) => shown(v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const keyed = ({ key, value }) => `\`${key}\` = ${shown(value)}`
const keys = (list) => (list.length === 0 ? 'none' : list.map(keyed).join('; '))
const short = (sha) => String(sha ?? '').slice(0, 7)
const day = (at) => (at ? String(at).slice(0, 10) : 'n/a')

export function retroDocument(sidecar, computed) {
  const { nothingFound, findings, decisions, removalCandidate, improvements } = computed
  return { ...sidecar, nothingFound, findings, decisions, removalCandidate, improvements }
}

function scopeLine(s) {
  if (s.mode === 'change') return `the change \`${s.scope.change}\``
  if (s.mode === 'period') return `the changes merged from ${s.scope.from} to ${s.scope.to}`
  if (!s.scope?.since) return 'every archived change: no earlier window retrospective'
  return `the changes merged after \`${short(s.scope.since)}\`${s.previous ? `, where the ${s.previous.date} window retrospective ended` : ''}`
}

function header(s) {
  const lines = [
    `- Ref: \`${s.ref}\`, ${s.fetchedAt ? `fetched ${s.fetchedAt}` : 'not fetched'}; fix commits counted up to ${s.asOf}`,
    `- Scope: ${scopeLine(s)}`,
    `- Records: ${s.coverage.records} of ${s.coverage.changes} changes`
  ]
  if (s.mode === 'window') lines.push(`- Next window: ${s.cutoff ? `starts after \`${short(s.cutoff.mergeSha)}\`, merged ${s.cutoff.mergedAt}` : 'starts at the first archived change'}`)
  if (s.flowVersions?.length) lines.push(`- Flow versions: ${s.flowVersions.map((v) => `${v.generator} (${v.changes.join(', ')})`).join('; ')}`)
  return lines
}

function changesTable(changes) {
  if (changes.length === 0) return ['No change is in this retrospective.']
  return [
    '| Change | Merged | Tasks | Diff lines | Fixes after | Record |',
    '|---|---|---|---|---|---|',
    ...changes.map((c) => `| ${cell(c.change)} | ${day(c.mergedAt)} | ${cell(c.tasks)} | ${cell(c.git?.diffLines)} | ${cell(c.git?.fixesAfter)} | ${cell(c.record === 'record' ? 'record' : `none: ${c.record?.none}`)} |`)
  ]
}

function findingLines(f) {
  return [
    `### ${f.id}: ${f.title}`,
    '',
    `- Class: ${f.class}`,
    `- Changes: ${f.changes.join(', ')}`,
    `- Could have been caught: ${f.caughtWhere}`,
    `- Plugin: ${f.plugin === null ? 'none' : `${f.plugin} ${shown(f.version)}`}`,
    `- Evidence: ${keys(f.evidence)}`,
    `- Cost: ${f.cost === null ? 'none' : keyed(f.cost)}`,
    '',
    f.body,
    ''
  ]
}

function decisionsTable(decisions) {
  if (decisions.length === 0) return ['No item was waiting for data.']
  return ['| Item | Decision | Basis | Reason |', '|---|---|---|---|', ...decisions.map((d) => `| ${cell(d.item)} | ${d.decision} | ${cell(keys(d.basis))} | ${cell(d.reason)} |`)]
}

function candidateLines(c) {
  if (c.name === 'none') return [`**none**: ${c.reason}`]
  return [`**${c.name}** (${c.kind}): ${c.reason}`, '', `Basis: ${keys(c.basis)}`]
}

function improvementLines(list) {
  if (list.length === 0) return ['none']
  return list.map((m, i) => `${i + 1}. ${m.what}: \`${m.file}\`. Expected effect: ${m.expectedEffect}. Saving: ${keyed(m.saving)}.`)
}

function deltaLines(d) {
  if (!d) return ['No previous window retrospective to compare with.']
  const row = (r) => `- \`${r.metric}\` ${r.stat}: ${shown(r.previous)} to ${shown(r.current)}`
  return [
    `Improved ${d.improved.length}, worsened ${d.worsened.length}, unchanged ${d.unchanged.length}, not compared ${d.notCompared.length}.`,
    ...(d.worsened.length ? ['', '**Worsened:**', '', ...d.worsened.map(row)] : []),
    ...(d.improved.length ? ['', '**Improved:**', '', ...d.improved.map(row)] : [])
  ]
}

// The Markdown of one retrospective.
export function renderRetro(sidecar, computed) {
  const lines = [
    `# ${HEADING[sidecar.mode] ?? sidecar.mode} retrospective ${sidecar.date}`,
    '',
    ...header(sidecar),
    '',
    '## Changes',
    '',
    ...changesTable(sidecar.changes),
    '',
    '## Findings',
    '',
    ...(computed.nothingFound ? ['Nothing found.', ''] : computed.findings.flatMap(findingLines)),
    '## Decisions on the items waiting for data',
    '',
    ...decisionsTable(computed.decisions),
    '',
    '## Removal candidate',
    '',
    ...candidateLines(computed.removalCandidate),
    '',
    '## Improvements',
    '',
    ...improvementLines(computed.improvements),
    '',
    '## Delta against the previous window',
    '',
    ...deltaLines(sidecar.delta),
    ''
  ]
  return lines.join('\n')
}
