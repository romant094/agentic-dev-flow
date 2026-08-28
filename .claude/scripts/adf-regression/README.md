# ADF Regression Set

One deterministic script per confirmed flow defect — a mistake this workflow actually made
once, caught here so it cannot happen the same way again without a script failing. This
directory ships empty in the change that introduces it; a script is added only once an
incident confirms the defect, never speculatively.

`.claude/commands/opsx/verify.md` runs the whole set as a single verify check
(Check 11 — Flow Regression Set), reporting one line per item. The check count that
`.claude/scripts/check-workflow-shape.mjs` derives comes from the number of `## N.`
sections in `openspec/schemas/sdd-plus-superpowers/templates/verify.md`, so the set
growing by one script per incident does not move that count — it stays one check.

## Members

| Script | Detects | Incident |
|---|---|---|
| `dispatch-git-safety.mjs` | A dispatch-facing instruction file (`.claude/commands/opsx/*.md`, `.claude/skills/*/SKILL.md`) that tells an agent to RUN a repository-wide git mutation — unscoped `git add -A` / `git add .`, or a discarding `git checkout --`, `git restore`, `git stash`, `git clean` — inside a fenced code block. | `adf-flow-improvements`: a dispatched agent ran `git add -A` in the developer's shared dirty checkout and unrecoverably destroyed two uncommitted memory pages. |
| `script-has-test.mjs` | An `.mjs` file under `.claude/scripts/` with no `.test.mjs` sibling. | `adf-flow-improvements`: `adf-regression/index.mjs` shipped untested; the branch AI review raised it as HIGH, and the missing test then exposed a second real defect in the runner's file filter. |
| `normative-duplication.mjs` | A normative rule (MUST/SHALL/NEVER/ALWAYS/Do NOT) stated in full on more than one flow-defining file, rather than once with pointers.* | `adf-normative-single-source`: guards the result of relocating phase procedure onto one surface per rule. |

\* `normative-duplication.mjs` carries a `KNOWN_DEFERRED_DUPLICATES` allowlist pinning the
handful of restatements `openspec/changes/adf-normative-single-source/notes/
normative-inventory.md` sections 4 and 10 record as deliberately deferred — each pinned to
its exact sentence text, not a general exemption. This is debt, not permanent
configuration: when a follow-up change resolves one of those recorded rows into a single
surface plus pointers, its entry in the allowlist must be removed in the same change, or a
future *different* restatement that happens to normalise to the same text would go
undetected.

`dispatch-git-safety.mjs` discriminates structurally, not lexically: an instruction to run a
command lives inside a fenced block, a prohibition lives in prose. The same command strings
appear four times in the current tree as prohibitions, so a keyword scan would report four
findings and zero real violations — the failure mode the shape check already records, where
every finding is a false positive and the check gets switched off. Path-scoped mutations are
legitimate and are not flagged; so is read-only inspection such as `git stash list`, which
`apply.md` runs on purpose.

## Recorded but not scriptable

A confirmed defect whose detection depends on judgment no script can evaluate is recorded
here rather than given a script that cannot detect it, per
`docs/flow-specs/flow-regression-checks/spec.md` ("A defect that no script can detect").

- **A new tool was never exercised on a non-empty real input before review**
  (`adf-flow-improvements`). Two defects stayed invisible to verification and to two review
  rounds because the only input the tool ever saw was empty, which made wrong code look
  correct: `deriveProjectKey` returned a directory that does not exist, and `parseTokens`
  read a field the real transcript never carries. Not scriptable: no script can tell whether
  the input a tool was exercised on was representative — that judgement needs the domain, the
  real data shape and the intent of the run, and a script asserting "a non-empty fixture
  exists" would pass on a fabricated fixture that repeats the same wrong assumption.
  What a reviewer should ask instead: for any new tool that reads external data, on what real
  non-empty input was it run, and what did the output actually say?

## Writing a script

Each sibling script (anything under this directory except `index.mjs`) exports:

- `export const meta = { incident: string, lastFired: string | null }` — `incident`
  names or links the confirmed defect the script exists to catch; `lastFired` is the date
  (or `null` if it has never fired since being written) the check last found the defect
  again.
- `export function check({ read, list })` — returns `{ ok: boolean, detail: string }`.
  `read` and `list` are injected, following the same shape used by
  `check-workflow-shape.mjs`, so a script never touches the filesystem directly.

`index.mjs` exports `runRegressionSet({ read, list })`, which discovers every sibling
`.mjs` script, runs its `check`, and returns one
`{ name, ok, detail, incident, lastFired }` record per script — `[]` when the directory
holds no scripts yet, which is a PASS, not a skipped check.

A script that throws while loading or checking — including one missing or malforming its
`meta` export — does not take down the rest of the set: `runRegressionSet` catches it,
reports that one item as `{ ok: false, detail: "script failed to run: <error>", incident:
null, lastFired: null }`, and continues with the remaining scripts.

## Removal

Every retrospective that touches this set names a removal candidate — a script whose
defect class no longer applies — per the change that adds the removal rule; this file
does not restate that rule.
