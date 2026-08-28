// Detects a normative rule (MUST / SHALL / NEVER / ALWAYS / "Do NOT") stated in full on
// two or more of the flow-defining files, rather than in full on exactly one surface with
// pointers elsewhere. `adf-normative-single-source` relocated phase procedure so each rule
// lives on one surface; this check is what stops that result from decaying back into two
// independently-edited copies of the same rule.
//
// `FILES` is a constant array, not read from `.claude/CLAUDE.local.md` (gitignored,
// personal) — a check whose scope came from an untracked file would pass or fail
// differently on each machine.
export const FILES = [
  '.claude/CLAUDE.md',
  'openspec/schemas/sdd-plus-superpowers/schema.yaml',
  '.claude/commands/opsx/propose.md',
  '.claude/commands/opsx/apply.md',
  '.claude/commands/opsx/verify.md',
  '.claude/commands/opsx/review.md',
  '.claude/commands/opsx/archive.md',
  '.claude/commands/opsx/sync.md',
  'openspec/schemas/sdd-plus-superpowers/templates/brainstorm.md',
  'openspec/schemas/sdd-plus-superpowers/templates/design.md',
  'openspec/schemas/sdd-plus-superpowers/templates/plan.md',
  'openspec/schemas/sdd-plus-superpowers/templates/proposal.md',
  'openspec/schemas/sdd-plus-superpowers/templates/review.md',
  'openspec/schemas/sdd-plus-superpowers/templates/spec.md',
  'openspec/schemas/sdd-plus-superpowers/templates/tasks.md',
  'openspec/schemas/sdd-plus-superpowers/templates/verify.md',
  '.gitlab/merge_request_templates/opsx.md',
  '.gitlab-ci.yml',
  '.lefthook.json'
]

// A sentence carries normative force only if it contains one of these modals, matched
// case-insensitively: `MUST`, `SHALL`, `NEVER`, `ALWAYS` or `DO NOT`, in any capitalisation
// (`MUST`, `Must`, `must`; `Never` at a sentence start as much as mid-sentence `never`).
// The original pattern matched the all-caps forms plus only the fully-lowercase `never` and
// `always`, which let a sentence-initial `Never`/`Always` (capitalised first letter only)
// through uncaught — code review on this task caught it with `NORMATIVE.test('Always let
// the user choose.') === false`. Case-insensitivity is deliberately blunt rather than
// pattern-matching "sentence-initial capitalised" specifically: any capitalisation of these
// five words is normative-shaped in this corpus, and a narrower pattern would reopen the
// same kind of hole for a form nobody has hit yet.
const NORMATIVE = /\b(MUST|SHALL|NEVER|ALWAYS)\b|\bDO NOT\b/i

// Strips fenced code blocks (``` … ```) and markdown table rows (a line starting with
// `|`), so a command or a table cell repeated verbatim across files — neither of them a
// restated rule — never reaches the sentence split.
function stripNonProse(text) {
  const lines = text.split('\n')
  const kept = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*\|/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

// Splits prose into sentences on `.`, `!` or `?` followed by whitespace (or end of
// string), keeping the terminator attached to the sentence it ends.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Normalises a sentence for cross-file comparison: strips markdown emphasis (`**bold**`,
// `*italic*`, `_italic_`) and inline backticks, drops a leading list marker, collapses
// whitespace, and lowercases — so "- A change **MUST** run `foo`   now." and "A change
// MUST run foo now." compare equal, and so do a `**MUST**` copy of a rule and a `*MUST*`
// copy of the same rule.
export function normalise(sentence) {
  return sentence
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/[*_]/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export const meta = {
  incident: 'adf-normative-single-source: guards the result of relocating phase procedure onto one surface per rule',
  lastFired: null
}

// A restated normative sentence this task looked at and could not resolve by editing text —
// each entry is either a `wording` row from `normative-inventory.md` section 4 (deferred
// because collapsing it into a pointer means rewording it) or a "post-relocation discovery"
// from section 10 (deferred because relocating it means authoring new canonical content, or
// it is out of this change's four-surface scope entirely). Each key is the exact
// `normalise()` output of the sentence, pinned to the specific recorded row so a
// *different*, unrelated sentence that happened to collide would still be caught — this
// does not touch the discriminator above, so a new restatement anywhere else still fires.
//
// Self-expiring debt: this allowlist exists only because the rows it names are still
// unresolved. When a follow-up change resolves one of `normative-inventory.md`'s eight
// `wording` rows or one of section 10's discoveries into a single surface plus pointers,
// remove its entry here too — an entry left behind after its row is fixed would silently
// mask any *new* restatement that happened to normalise to the same key. Section 10 and
// this README's Members-table footnote (the `*` on the `normative-duplication.mjs` row)
// both point back here for that reason.
const KNOWN_DEFERRED_DUPLICATES = new Set([
  // G1 — normative-inventory.md §4/§9 — apply.md, archive.md, sync.md, verify.md
  'if vague or ambiguous you must prompt for available changes.',
  // G9 (first sentence) — normative-inventory.md §4/§9 — apply.md, archive.md, sync.md, verify.md
  'important: do not guess or auto-select a change.',
  // G9 (second sentence, same recorded row) — apply.md, archive.md, sync.md, verify.md
  'always let the user choose.',
  // D1 — normative-inventory.md §10 — the store-selection paragraph, six command files
  'other commands do not take the flag.',
  // D2 — normative-inventory.md §10 — the Superpowers pre-flight check, four command files
  'pre-flight — superpowers must be available if either exits non-zero, stop.',
  // D3 — normative-inventory.md §10 — check-opsx-commands degraded-surface reaction
  'do not restore the files yourself, and do not continue with a degraded command surface.',
  // D4 — normative-inventory.md §10 — the single-candidate confirmation rule
  'if exactly one candidate exists in total, do not take it silently: name it and ask for confirmation.',
  // D5 — normative-inventory.md §10 — the single-candidate auto-select rule
  'do not auto-select because only one candidate exists — a count taken from the wrong repository root means nothing.',
  // D6 — normative-inventory.md §10 — the worktree-path-not-rederived rule
  'do not re-derive it from the branch name: step 2 established that a branch name is a guess, and a renamed branch matches no change while its worktree still holds one.',
  // D7 — normative-inventory.md §10 — the worktree sanity-check rule
  'then: the second command must print the worktree path.'
])

// `index.mjs` always calls `check({ read, list })`, the shared regression-script contract,
// but this script's scope is the constant `FILES` array above (or the `files` override
// used by its own tests) rather than a directory listing, so `list` is never destructured.
export async function check({ read, files }) {
  const targets = files ?? FILES

  // Maps each normalised normative sentence to the set of files it was found in.
  const seen = new Map()
  let readCount = 0
  const unreadable = []

  for (const path of targets) {
    let text
    try {
      text = await read(path)
      readCount += 1
    } catch (err) {
      unreadable.push(`${path} (${err.message})`)
      continue
    }
    if (!text) continue

    for (const sentence of splitSentences(stripNonProse(text))) {
      if (!NORMATIVE.test(sentence)) continue
      const key = normalise(sentence)
      if (!key) continue
      if (!seen.has(key)) seen.set(key, { sentence: sentence.trim(), files: new Set() })
      seen.get(key).files.add(path)
    }
  }

  const findings = [...seen.entries()]
    .filter(([key, entry]) => entry.files.size > 1 && !KNOWN_DEFERRED_DUPLICATES.has(key))
    .map(([, entry]) => `"${entry.sentence}" in ${[...entry.files].sort().join(', ')}`)

  if (unreadable.length > 0) {
    return {
      ok: false,
      detail: `could not read every file in scope, so coverage is incomplete:\n  ${unreadable.join('\n  ')}`
    }
  }
  if (findings.length > 0) {
    return {
      ok: false,
      detail: `normative rule restated on more than one surface:\n  ${findings.join('\n  ')}`
    }
  }
  return { ok: true, detail: `no normative rule restated across ${readCount} flow-defining files` }
}
