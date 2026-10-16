# AI Code Review Record

<!-- Rendered by `review.mjs assemble` from .superpowers/sdd/<change>/review/ (start.json, each
     round's findings, the fixes, dispositions.json, suite.json) and the ledger's rulings; the
     rules are in the review instruction. This file documents the record's shape; the script
     does not read it. The header lines are read back by `review.mjs check`, as archive reads
     them: the verdict token after the colon, PASS or BLOCKED, and the reviewed commit's sha.
     A finding's body is restated only when it was recorded or accepted. A section with nothing
     to show is left out. Re-running the review overwrites this file. -->

**Change**: `<change-name>`
**Reviewed at**: `YYYY-MM-DD HH:mm`
**Reviewed commit**: `<HEAD when the record was assembled>`
**Verdict**: PASS | BLOCKED

**Rounds**: `<rounds run; 0 when not reviewed>`
**Round cap**: <the cap, passed by the developer's ruling: round k (ruling id: reason); only when a round past the cap ran>
**Reviewer**: <`ai-review` at its capability level; fixes by `ai-fix` at theirs; or none dispatched>
**Range**: `<base>..<head>` (<the change's base `origin/<base>`, or an explicit range, ruling id: reason>)
**Excluded files**: `<n>` of <changed> by the review filter

**Counts**: CRITICAL `0` | HIGH `0` | MEDIUM `0` | LOW `0`

---

## Findings

| # | Round | Severity | Where | Title | Disposition |
|---|---|---|---|---|---|
| F<n> | <k> | <severity> | `<file:line>` | <title> | <fixed in `<sha>` · dismissed — <reason>; marker ADF IGNORE <key> at `<file:line>`, or no marker: <why> · accepted — <reason> · recorded, non-blocking · outstanding> |

<!-- With no findings, one row: | — | — | — | — | — | no findings | -->

## Outstanding

<!-- BLOCKED only: each open blocking finding, each fix not yet re-reviewed, and a failing suite
after the fixes with no ruling. -->

## Recorded findings

### F<n>. `<file:line>` — recorded, non-blocking | accepted

<severity>, <category>: <title>

<the reviewer's body>

Suggestion: <the reviewer's suggestion, when it gave one>

Why it was left: <the body written for a recorded finding, or the developer's ruling for an accepted one>

## Developer rulings

<!-- One line per ruling the record used: each dismissed or accepted finding, review-round-<k>,
review-range, review-slices, review-suite; with its reason and ledger record id. -->

## Suite after the fixes

<!-- When a fix landed: the command and the commit it ran at, the result and exit code, the
output file, the base check and the comparison, pre-existing and new failures. -->

## Not reviewed

<!-- The empty filtered diff only: no reviewer was dispatched, the reason given, and how many
changed files the filter excluded. -->
