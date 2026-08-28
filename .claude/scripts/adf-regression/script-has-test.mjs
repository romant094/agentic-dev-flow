// Detects an `.mjs` file under `.claude/scripts/` with no `.test.mjs` sibling. Test files
// are never subjects of the rule themselves (`mr-template.test.mjs` has no source sibling
// and is not a finding).
//
// Why prose could not catch this: "every script ships with a test" was already the
// established convention of this directory — `adf-metrics.mjs` arrived with a 29-case
// suite, and every other script has a sibling — and the convention still did not hold for
// the one script a verification check grades on. Nothing was written down that a reader
// could have violated knowingly; the file was simply added and nobody counted. A missing
// sibling is a pure filename fact, so the count belongs in a script, not in a paragraph
// asking an agent to remember to count.
//
// Judgement call — regression scripts are held to the same rule as any other script. A
// regression script is itself a check, so it is tempting to exempt it: who tests the
// tester. The exemption is rejected because the discriminating logic in these scripts is
// where the risk actually lives. Both members of this set turn on a non-obvious
// discriminator (a fenced-block vs prose distinction; a test-file exclusion), and a check
// that silently matches nothing reports `ok: true` forever and looks like a passing guard.
// The originating incident is the proof: writing the missing test for `index.mjs`
// immediately exposed a second real defect, its file filter picking up its own test file as
// a check. Only `index.mjs`-style plumbing and real checks exist here, and both benefit.
const SCRIPTS_DIR = '.claude/scripts'
const REGRESSION_DIR = '.claude/scripts/adf-regression'

async function scriptsIn(list, dir) {
  let names
  try {
    names = await list(dir)
  } catch {
    return []
  }
  const all = new Set(names)
  return names
    .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
    .filter((n) => !all.has(`${n.slice(0, -'.mjs'.length)}.test.mjs`))
    .map((n) => `${dir}/${n}`)
}

export const meta = {
  incident:
    "adf-flow-improvements: .claude/scripts/adf-regression/index.mjs shipped with no test file while its sibling adf-metrics.mjs shipped with a full suite; the branch AI review raised it as HIGH, and writing the missing test immediately exposed a second defect — the runner's file filter treated its own test file as a check",
  lastFired: null
}

export async function check({ list }) {
  const missing = [...(await scriptsIn(list, SCRIPTS_DIR)), ...(await scriptsIn(list, REGRESSION_DIR))].sort()

  if (missing.length > 0) {
    return { ok: false, detail: `script with no .test.mjs sibling:\n  ${missing.join('\n  ')}` }
  }
  return { ok: true, detail: 'every .mjs script under .claude/scripts/ has a .test.mjs sibling' }
}
