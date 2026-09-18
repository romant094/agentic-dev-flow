# AI Code Review Record

> Produced by `/opsx:review` after verification completes, and read by `/opsx:archive`.
> Give every finding a disposition row below. Write a body only for a finding that was
> neither fixed nor dismissed: a finding left in place has no home in the code, so its body
> is written here.

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
- `recorded, non-blocking` (MEDIUM and LOW; its body goes in `## Recorded findings`)
- `accepted — <reason>` (the developer decided the finding is real but acceptable as it
  stands, where `dismissed` means the reviewer was wrong and a marker in the code says so;
  nothing is marked for an accepted finding, so its body goes in `## Recorded findings`. A
  CRITICAL or HIGH carries this token only alongside its entry in `## Developer overrides`,
  which is what keeps the verdict from being BLOCKED; a MEDIUM or LOW needs no override.)
- `outstanding` (only in a BLOCKED record)

If nothing was found, keep the table header and write a single row: `| — | — | — | no
findings |`.
-->

## Recorded findings

<!--
One entry per finding whose disposition is `recorded, non-blocking` or `accepted — <reason>`
— the findings nobody fixed and nobody dismissed. Each entry names the finding number and
where it is, states what is wrong, and states why it was left, written so a reader who never
saw the review can act on it without rediscovering the finding — `/opsx:archive` acts on
these entries, and where each one is carried is stated in full in `schema.yaml`'s `archive`
block. Omit this section
entirely when there are none, so that an empty section is never mistaken for a review whose
findings nobody bothered to write down.

### 3. `path/to/third.ts:88` — recorded, non-blocking

One paragraph: what is wrong, and why it was left.
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
