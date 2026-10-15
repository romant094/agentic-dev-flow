# Iteration 08 — Verify

## Goal

`/adf:verify` checks that a change was built as its artifacts say, with the mechanical checks and
the verdict computed by script, the judgement checks in read-only dispatches, and no project
specifics in the core. The rules and their reasons are in `docs/lessons/verify.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | The base check of the whole-suite run as a workspace operation (`workspace.mjs base-check-add`, `base-check-remove`); apply uses it | `apply-git.spec.mjs`, against real git repositories |
| 2 | The "Added during apply" line shows its path backticked, the only form the plan parser reads | `plan-symbols.spec.mjs` |
| 3 | The origin's flow regression checks as port tests: every script is named in a spec of its plugin; one normative rule in full on one surface; no surface states how many checks, steps or rules there are | `flow-regression.spec.mjs` |
| 4 | `verify.mjs run`: validation, tasks, deltas, tree, test record and test counts, leftover worktrees of this change, out-of-plan files; `--fresh` starts a session | `verify.spec.mjs`, against real git repositories |
| 5 | `verify.mjs verdict`: one `Verdict:` line from the checks, the dispatch sections and the developer's rulings (`ledger.mjs ruling`); the registry's optional `outsidePlan` globs | `verify.spec.mjs` |
| 6 | The verify instruction, template and command; the verify artifact in the schema; apply's test record names the `**Commit:**` field | `schema.spec.mjs`, `changes.spec.mjs` |
| 7 | A replay of verify's checks on the origin's archived changes | `scripts/parity/origin-verify-history.mjs` |

## Decisions

- With commits outside the change directory after apply's test record, verify re-runs the
  planning guide's whole-suite command (`verify c6`) and checks a failure on the base. Commits
  inside the change directory leave the record current.
- Verify offers no worktree removal: review runs next in that worktree, and archive removes it.
- Files a project keeps outside every plan are an optional `outsidePlan` list of globs in the
  registry; the core allows only the change's own directory.
- No `verify-check` contract point yet: no plugin needs one. The project stack plugin adds it in
  iteration 12, for migration order and the scoped test run.
- A developer ruling with a reason, recorded in the ledger, turns a failing check into a
  warning; silence never does. A dirty tree and a leftover worktree cannot be accepted.
- Test counts in the implementers' replies are reconciled with the apply record as warnings.
- Removal accounting runs inside `verify c4`, only for a `REMOVED` or `RENAMED` delta.
- The verdict is computed by script; review reads the `Verdict:` line (iteration 09).
- The origin's `script-has-test` and `normative-duplication` are tests of the port's own suite,
  checked on the real files; a count-literal test closes the drift the origin showed (eleven and
  eight for the same check).

## Result

- `npm test`: 357 tests, 0 failures; `check-lessons.mjs`: ok, no row pending on iteration 08.
- `npm run parity -- <origin>`: all ten tools PASS.
  - `origin-verify-history.mjs`: 64 archived changes, 10 compared per check (50 squash-merged
    with no history, 3 with no record, 1 free-form). The task and delta checks agree with the
    origin. Every out-of-plan difference is explained: `recorded` (the origin's allowlist and
    rulings), `prose-expansion` (a plan naming files only in prose, now a plan rule),
    `stale-section` and `skill-edit-outside-skills` (defects of the origin's verify), `no-plan`.
  - The first replay found three port defects in reading a plan's Files bullets: a path after a
    parenthesis was lost, a placeholder path never matched, and a prose reference named nothing.
    The first two are fixed in the check; the third is a plan rule.
- `claude plugin validate .`: not run to the end; it hung twice in this session with no output
  (it passed in iteration 07). The manifests changed only in their version.
- Not run: `/adf:verify` by an agent end to end. That is the behaviour check (iteration 14).
- Open: two rules of the origin's shape check have no port counterpart and no iteration: the
  artifact list and the cycle's commands compared with the schema description, and the
  description's optional artifacts derived from `requires`.
