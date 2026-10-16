# Verification Report

<!-- Rendered by `verify.mjs assemble` from .superpowers/sdd/<change>/verify/ (run.json and the
     section files), the verdict, the rulings and the approved skill edits; the rules are in the
     verify instruction. Assemble reads only the title and the `## ` headings here: their order
     is the record's order, and a heading it does not know is refused. Each check's section is
     `**Result:** <verdict>: <summary>` (an accepted failure shows the developer's reason), its
     extra fields, then the verbatim content of its output file in a text fence. Re-running
     verify overwrites this file. -->

**Change:** `<change-name>`
**Verified at:** `YYYY-MM-DD HH:mm`
**Verifier:** <git user.name; checks by verify.mjs run; each section and the dispatch or script that wrote it>
**Range:** `<base>..<head>`

## Structural validation

**Result:** <!-- verdict and summary of `validation` -->

```text
<!-- verbatim output of validation -->
```

## Task completion

**Result:** <!-- verdict and summary of `tasks` -->

```text
<!-- verbatim output of tasks -->
```

## Delta spec sync state

**Result:** <!-- verdict and summary of `deltas`: synced, needs sync or conflict per capability -->

```text
<!-- verbatim output of deltas -->
```

## Design and specs coherence

**Result:** <!-- verdict and summary of `c4`, which says the case that applied -->

**Hand-edited capability prose:** <!-- the c4 section's `proseEdits` -->

**Removal accounting:** <!-- the c4 section's `removalAccounting` -->

```text
<!-- verbatim output of c4 -->
```

## Implementation signal

**Result:** <!-- verdict and summary of `tree` -->

```text
<!-- verbatim output of tree -->
```

## Apply test record

**Result:** <!-- verdict and summary of `test-record` -->

**Scope that ran:** <!-- the whole suite, re-run by suite.mjs: the record was stale; or the
record cited, not re-run -->

**Pre-existing failures, separate work:** <!-- from the re-run's section or the cited record; or none -->

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

**Approved skill edits:** <!-- the ledger's skill-edit records: sha and message; or none -->

**Declined edits:** <!-- the rulings on c8: reason and record id; or none -->

```text
<!-- verbatim output of c8 -->
```

## Out-of-plan commits

**Result:** <!-- verdict and summary of `out-of-plan` -->

```text
<!-- verbatim output of out-of-plan -->
```

## Checks run with the developer

<!-- Any section the template does not name goes first, under its own title. Then the
`developer` section from verify.mjs developer, with developer.txt verbatim; or none -->

## Exercised and not exercised

<!-- The c4 section's `exercised` -->

## Rulings

<!-- Each developer ruling: the check, the reason, the ledger record id; a ruling the verdict
ignored, with why; or none -->

## Next step

<!-- PASS or PASS WITH WARNINGS: run /adf:review. FAIL: each failing check with its summary, then
verify again. -->

Verdict: <!-- the verdict file's line, unchanged: PASS, PASS WITH WARNINGS or FAIL -->
