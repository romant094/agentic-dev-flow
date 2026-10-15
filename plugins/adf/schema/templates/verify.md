# Verification Report

<!-- Written by `verify assemble` from the section files under
     .superpowers/sdd/<change>/verify/ and the verdict file; the rules are in the verify
     instruction. Each section: the verdict as the verdict file displays it (an accepted
     failure with the developer's reason), the summary, and the verbatim content of the
     section's output file. Re-running verify overwrites this file. -->

**Change:** `<change-name>`
**Verified at:** `YYYY-MM-DD HH:mm`
**Verifier:** `<who, and which agent ran each dispatch>`
**Range:** `<base>..<head>`

## Structural validation

**Result:** <!-- verdict and summary of `validation` -->

```text
<!-- verbatim output of validation -->
```

## Task completion

**Result:** <!-- verdict and summary of `tasks`; each open task with why it stays open -->

```text
<!-- verbatim output of tasks -->
```

## Delta spec sync state

**Result:** <!-- verdict and summary of `deltas`: synced, needs sync or conflict per capability -->

```text
<!-- verbatim output of deltas -->
```

## Design and specs coherence

**Result:** <!-- verdict and summary of `c4`; which case applied: design and specs, no delta
specs, or no design -->

**Hand-edited capability prose:** <!-- the capabilities whose prose above `## Requirements`
the change edited, and why; or none -->

**Removal accounting:** <!-- each REMOVED or RENAMED requirement's Code Disposition against
the code; or N/A: no REMOVED or RENAMED requirement -->

```text
<!-- verbatim output of c4 -->
```

## Implementation signal

**Result:** <!-- verdict and summary of `tree` -->

```text
<!-- verbatim output of tree -->
```

## Apply test record

**Result:** <!-- verdict and summary of `test-record`: the record cited as current, or the
suite re-run by `verify c6` -->

**Scope that ran:** <!-- whole suite, from the planning guide; or the record cited, not re-run -->

**Pre-existing failures, separate work:** <!-- failures that also fail on the base; or none -->

**Test count warnings:** <!-- the reconciliation warnings; or none -->

```text
<!-- verbatim output of test-record: the runner's own pass, fail, file or suite counts -->
```

## No leftover worktrees

**Result:** <!-- verdict and summary of `worktrees` -->

```text
<!-- verbatim output of worktrees -->
```

## Stale skills

**Result:** <!-- verdict and summary of `c8`: CONFIRMED, PLAUSIBLE or none, per skill -->

**Approved skill edits:** <!-- the sha of each approved edit's commit; or none -->

**Declined edits:** <!-- each decline with the developer's reason; or none -->

```text
<!-- verbatim output of c8 -->
```

## Out-of-plan commits

**Result:** <!-- verdict and summary of `out-of-plan` -->

```text
<!-- verbatim output of out-of-plan -->
```

## Checks run with the developer

<!-- The checks the plan assigns to verify that needed the developer, with what was run and
what it showed, verbatim from developer.txt; or none -->

## Exercised and not exercised

<!-- From c4: for each new mechanism, the paths a test or a recorded run exercised and the
paths nothing exercised -->

## Rulings

<!-- Each developer ruling: the check, the reason, the ledger record id; or none -->

## Next step

<!-- PASS or PASS WITH WARNINGS: the review. FAIL: what to fix, by failing check, then verify
again. -->

Verdict: <!-- the verdict file's line, unchanged: PASS, PASS WITH WARNINGS or FAIL -->
