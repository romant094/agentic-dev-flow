# AI Review CI Gate

## Purpose

Defines how the AI code review behaves as a merge request gate: which verdicts fail the
`ai_claude_inspect` job, what happens when the verdict cannot be read, when the exit code is
returned relative to publishing the review, and how the full review reaches the developer
from a failed job.

## Requirements

### Requirement: A blocking review verdict fails the merge request pipeline

The `ai_claude_inspect` job SHALL exit non-zero when the review verdict is BLOCK or
REQUEST CHANGES, and zero when it is APPROVE. The verdict is read from the
`| Overall |` row of the Executive Summary, which `infra/claude/review-prompt.md`
already mandates and whose three values it already defines — BLOCK on any CRITICAL
finding, REQUEST CHANGES on any HIGH finding, APPROVE otherwise. The prompt MUST NOT be
modified to produce a separate machine-readable verdict: a second statement of a fact the
prompt already states can disagree with the first, and leaves the gate no principled
choice between them.

MEDIUM and LOW findings MUST NOT affect the exit code. MEDIUM is the Performance bucket
and the most false-positive-prone category the prompt defines; a gate that fires on it
trains reviewers to step over the verdict, which destroys the gate on the day a failure is
real.

#### Scenario: Review reports a CRITICAL finding

- **WHEN** the review's Executive Summary reports `🔴 BLOCK`
- **THEN** the job exits non-zero and the pipeline fails

#### Scenario: Review reports a HIGH finding and no CRITICAL

- **WHEN** the review's Executive Summary reports `🟡 REQUEST CHANGES`
- **THEN** the job exits non-zero and the pipeline fails

#### Scenario: Review reports only MEDIUM and LOW findings

- **WHEN** the review's Executive Summary reports `🟢 APPROVE` alongside non-zero MEDIUM
  or LOW counts
- **THEN** the job exits zero and the findings remain visible in the posted comment

#### Scenario: Review reports nothing at all

- **WHEN** the review contains no findings and reports `🟢 APPROVE`
- **THEN** the job exits zero

### Requirement: An unreadable verdict fails the job rather than passing it

The job SHALL exit non-zero when the `| Overall |` row is absent, or present with a value
that is none of BLOCK, REQUEST CHANGES or APPROVE. A review whose verdict cannot be read is
a review that did not happen, and MUST NOT be treated as an approval.

This extends the validation `infra/claude/review.sh` already performs on the presence of
`### Executive Summary`, and uses the same failure mode: a diagnostic on stderr and a
non-zero exit.

#### Scenario: Response truncated before the verdict

- **WHEN** the model's response is cut short and carries no `| Overall |` row
- **THEN** the job reports the missing verdict and exits non-zero

#### Scenario: Verdict value not recognised

- **WHEN** the `| Overall |` row carries a value outside the three the prompt defines
- **THEN** the job reports the unrecognised verdict and exits non-zero

### Requirement: A transport failure is distinguished from a review outcome

The job SHALL exit 2 when the review could not be produced or published for reasons outside
the code under review, and the pipeline SHALL treat exit 2 as an allowed failure. Every other
non-zero exit stays 1 and fails the pipeline.

Transport failures are: the merge-request diff could not be fetched, the Anthropic API call
failed, the API returned an application error, the response carried no content, and the
review could not be posted as a comment. None of these say anything about the branch, and
failing the pipeline on them teaches developers to re-run rather than to read.

The two `curl --fail` invocations MUST map their own exit status onto 2 explicitly. Under
`set -e` they terminate the script with curl's status — 22 for an HTTP error — which the
pipeline's allowed-failure list would not match, so the distinction would silently not apply
to the two most likely transport failures.

#### Scenario: The Anthropic API is unreachable

- **WHEN** the API call fails and no review is produced
- **THEN** the job exits 2, the pipeline is not failed, and the job's log carries the error

#### Scenario: The merge-request diff cannot be fetched

- **WHEN** the GitLab API call for the diff fails
- **THEN** the job exits 2 rather than with curl's own status

#### Scenario: The review is produced but the comment cannot be posted

- **WHEN** the review is written to the artifact and the comment POST fails
- **THEN** the job exits 2, and the review remains available as the job artifact

### Requirement: A review that ran and returned unusable output stays a hard failure

The job SHALL exit 1, not 2, when the response is present but its structure is unusable — a
missing `### Executive Summary`, or a verdict that is none of the three the prompt defines.
These MUST NOT be treated as allowed failures.

A response that arrived and could not be read is not a transport problem: it means the review
ran and produced garbage. Marking that allowed-to-fail would let a prompt regression or a
model change switch the gate off with every pipeline green — the job amber, nobody told that
reviews stopped blocking. A false red costs a re-run; a silent gate costs what the gate was
for.

#### Scenario: The response is missing its Executive Summary

- **WHEN** the model returns text without `### Executive Summary`
- **THEN** the job exits 1 and the pipeline fails

#### Scenario: The verdict is present but unrecognised

- **WHEN** the `| Overall |` row carries a value outside the three the prompt defines
- **THEN** the job exits 1 and the pipeline fails

### Requirement: The gate fires after the review is published

The exit code SHALL be returned only after `claude-review.md` is written and after the
review is posted as a merge request comment. `infra/claude/review.sh` runs under `set -e`,
so a gate placed before publication would abort the script and remove the review from
exactly the pipelines that produced a finding.

#### Scenario: Blocking verdict on a merge request

- **WHEN** the review returns BLOCK
- **THEN** the comment is posted to the merge request and `claude-review.md` is written
  before the job exits non-zero

### Requirement: The full review is downloadable from a failed job

The `claude-review.md` artifact SHALL be uploaded regardless of job outcome, and SHALL be
linked directly from the merge request. Uploading only on success would withhold the file
on every run that found something.

The artifact declares `when: always` so a failing job still uploads it, and
`expose_as: 'AI code review'` so the merge request widget links to the file itself rather
than to the pipeline. Retention stays at 7 days.

#### Scenario: Job fails on a blocking verdict

- **WHEN** the job exits non-zero because the verdict was BLOCK
- **THEN** `claude-review.md` is uploaded and reachable in one click from the merge
  request

#### Scenario: Job succeeds

- **WHEN** the job exits zero
- **THEN** `claude-review.md` is uploaded and linked exactly as it is on a failure

#### Scenario: Job fails before the review is produced

- **WHEN** the Anthropic API call fails and no review text exists
- **THEN** the job exits non-zero, the failure is described in the job log, and the
  absence of the artifact is not treated as a passing review

### Requirement: The gate is not given a question its input cannot answer

`infra/claude/review-prompt.md` MUST NOT gain a duplication or reuse finding category while
the `ai_claude_inspect` job's input is a merge request diff. The job fetches the diff over the
GitLab API and holds no checkout to compare it against, so "does this already exist in the
repository" is a question the reviewer would have to guess at — and a guessed finding in a
category with no evidence available is the false-positive rate this prompt's Confidence Gate
and `## Do NOT Flag These` list were written to protect.

The gate's verdict thresholds SHALL NOT change: BLOCK on CRITICAL, REQUEST CHANGES on HIGH,
APPROVE otherwise, with MEDIUM and LOW never affecting the exit code. The one maintainability
class that blocks in this workflow is confirmed locally by the code reuse sweep, which has the
repository access the question needs, and it blocks there rather than here.

Should the job ever be given a checkout, this requirement is what must be revisited first, in
its own change — the reviewer's input, this prompt's blast radius across every merge request
in the repository, and the cost model of the job all move together.

#### Scenario: A duplication category is proposed for the prompt

- **WHEN** a change would add a "does this helper already exist" item to `review-prompt.md`
- **THEN** it is refused while the job's input is a diff, and the question stays with the
  local sweep

#### Scenario: A branch duplicates existing code and is otherwise clean

- **WHEN** the merge request diff introduces a helper the tree already carries and contains no
  CRITICAL or HIGH finding
- **THEN** the job exits zero, because the duplicate was the local sweep's block to hold and
  not this gate's

### Requirement: The gate honours every suppression key the prompt defines

The CI review SHALL honour the suppression markers `infra/claude/review-prompt.md` defines,
for every key that file permits and not only for CWE keys. The job runs that prompt verbatim,
which is what makes this automatic — and it is stated as a requirement because it is the
property that lets a dismissal accepted locally survive the merge request, which is the whole
purpose of putting the marker in the code.

A marker whose key the reviewer does not recognise MUST NOT be reported as a finding of any
kind. An unrecognised marker read as an unexplained comment turns an accepted dismissal into a
new finding on the next diff that touches the line.

#### Scenario: A diff carries a marker with a non-CWE key

- **WHEN** the diff contains a line preceded by a `// review-ignore` marker whose key is one
  the prompt permits but is not a CWE identifier
- **THEN** the reviewer suppresses that class on that line and reports nothing about the
  marker itself

#### Scenario: A marker suppresses one class and not another

- **WHEN** a line carries a marker naming one key and also has a genuine finding of a
  different class
- **THEN** the other finding is still reported, exactly as it is for a CWE key today
