# AI Code Review Record

> Produced by `/opsx:review` after verification completes, and read by `/opsx:archive`.
> It records dispositions, not finding bodies: what was fixed is in the fix commits and
> what was dismissed is marked in the code with a `// review-ignore` comment. The
> disposition is the only part that lives nowhere else in decided form.

**Change**: `<change-name>`
**Reviewed at**: `YYYY-MM-DD HH:mm`
**Reviewed commit**: `<full SHA of HEAD at the time of the review>`
**Verdict**: `PASS` | `BLOCKED`

<!--
Replace the line above with exactly one of the two tokens, and nothing else on it:

    **Verdict**: PASS

`/opsx:archive` extracts that line and compares it for equality, so any commentary
beside the token — `PASS — nothing blocked` — reads as neither value and stops the
archive. Put the reasoning in the findings table, where it belongs. Both tokens left
on one line is how this template detects a record nobody filled in, which is why the
comparison is exact rather than a search for a mentioned word.
-->

**Rounds**: `<how many review rounds ran, 1-3>`

**Counts**: CRITICAL `<n>` | HIGH `<n>` | MEDIUM `<n>` | LOW `<n>`

---

## Findings

| # | Severity | Where | Disposition |
|---|---|---|---|
| 1 | HIGH | `path/to/file.ts:42` | fixed in `<SHA>` |
| 2 | HIGH | `path/to/other.tsx:17` | dismissed — `<reason>`; `// review-ignore: CWE-20` added |
| 3 | MEDIUM | `path/to/third.ts:88` | recorded, non-blocking |

<!--
Disposition is one of:
- `fixed in <SHA>`
- `dismissed — <reason>; // review-ignore: CWE-XXX added` (requires an explicit
  developer decision; silence never resolves a finding)
- `recorded, non-blocking` (MEDIUM and LOW)
- `outstanding` (only in a BLOCKED record)

If nothing was found, keep the table header and write a single row: `| — | — | — | no
findings |`.
-->

## Developer overrides

<!--
Only when the verdict would otherwise be BLOCKED. One entry per overridden finding:
which finding, who decided, and the reasoning. An override with no reasoning is not an
override. Omit this section entirely when there are none.
-->

## Not reviewed

<!--
Present when the filtered diff was empty — a change that touched no reviewable source
file. State that, and that no reviewer was dispatched.
-->
