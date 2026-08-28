# The Code Reuse Sweep

The flow's one gate that can see the repository, added by `adf-maintainability-gates`
(archived 2026-08-27). Capability: `docs/flow-specs/code-reuse-sweep/spec.md`, nine requirements.

## What it is

`/opsx:apply` issues exactly one bounded read-only dispatch per change, after
`superpowers:subagent-driven-development` returns with every task complete and every wave group
merged, after `tasks.md` is ticked, before the whole-suite run. It reads the branch diff **and
the working tree** — the only dispatch in this flow with repository read access — and asks one
question: does this branch introduce a symbol, helper, validator, mapper, constant set or pattern
whose behaviour the repository already has.

Verdict shape: `CLEAN`, or one finding per line naming `introduced: <path>:<line-or-symbol>`,
`existing: <path>:<line-or-symbol>`, and one sentence on what the two share. A finding that
cannot name a pre-existing location is dropped rather than reported at lower confidence.

It is issued at a judgement-capable level — integration or above, never the cheapest. See
"what a future implementer gets wrong" below for why that sentence exists.

## The invariant no single file states

**Exactly one maintainability class blocks, and it blocks locally at apply — never at the CI
gate.** That shape exists only across three surfaces and no one of them carries it:

- `infra/claude/review-prompt.md` shows only a widened suppression key (`DUP` beside `CWE-XXX`).
  It says "You never produce such a finding, because you see a diff and not the repository".
- `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `apply:` block carries the sweep, the
  block and the dismissal — but not why the gate is not in CI.
- `docs/flow-specs/ai-review-ci-gate/spec.md` carries the prohibition: the prompt MUST NOT gain a
  duplication category while the job's input is a diff.

The reason is mechanical, not stylistic. The `ai_claude_inspect` job fetches a merge request diff
over the GitLab API and holds no checkout, so "does this already exist in the repository" is a
question it could only guess at. `ai-review-flow-stage` independently requires the `/opsx:review`
reviewer to see a filtered diff and forbids free exploration. A duplication item in that prompt
would therefore be unenforceable or a false-positive generator — and the prompt's low
false-positive rate is the reason it can be trusted as a CI gate at all.

This corrects the change's own brainstorm, whose Key Decision 4 had the prompt and the CI-gate
spec moving their thresholds together. The specs are what made the error visible.

## What a future implementer would most plausibly get wrong

**Citing the sweep's tree access as precedent for letting a reviewer read the tree.** The sweep
is the one dispatch with repository access because its question is unanswerable from a diff — not
because the diff-only rule was a mistake. Both the capability and the schema pre-refute this, and
the capability carries a scenario whose THEN is literally "the citation fails".

**Second, and it nearly shipped:** dispatching the sweep at the cheapest capability level.
`schema.yaml` tells the orchestrator to dispatch at the cheapest level that can execute a task;
the sweep is not a `plan.md` task, so no `**Level:**` line covers it and nothing named a floor.
A cheap dispatch's honest answer to "does this behaviour already exist" is `CLEAN` almost always
— a gate green forever and indistinguishable from a working one. The whole-branch review caught
it and called it the finding closest to Critical. The floor is now a requirement.

## What this change did NOT establish

Recorded because `openspec/specs/` now states the capability as fact:

- **The sweep has never run inside the flow.** All four verdicts in the change's
  `notes/sweep-exercise.md` came from a hand-constructed dispatch carrying the schema's question,
  in a throwaway worktree. The first change to actually reach apply's sweep step is its first
  real test.
- **The block has never been exercised.** Nothing has tested apply refusing to conclude, the
  developer being asked, a `DUP` marker being placed, a ledger debt line written, `/opsx:archive`
  resolving it, or a later sweep honouring an existing marker. Four of the nine requirements have
  no evidence behind them.
- **`**Code Disposition:**` has never been authored by a real change.** The change's own deltas
  carry only `ADDED` and `MODIFIED`, and `openspec validate` cannot detect the field's absence —
  by design; the sweep's triggered second question is the only thing that asks.
- **The sweep's false-negative rate is unmeasured.** The exercise's Case 1 duplicate was
  maximally obvious (identical normalisation, identical set literal). No case tested a
  semantically equivalent duplicate written differently, which is the realistic case.

## The suppression marker's structural limit

The grammar is `// review-ignore: <key> — reason`, a C-style comment, honoured by both
`review-prompt.md` and the CI review. No YAML or markdown surface can carry it. So a finding
raised against `schema.yaml` — as the tuned review's own HIGH on this change was — has **no
durable dismissal path**: the reasoning could only live in `review.md`, and CI would raise it
again on the merge request. This change widened the key set; it did not widen the comment
syntaxes the marker can live in.

## Related

- [[normative-surface-map]] — which surface owns which rule, and the duplication check's blind
  spots, both of which this change exercised for real
- [[opsx-workflow]] — the flow this gate sits inside
- [[adf-deferred-findings]] — the two findings this change recorded and did not fix
