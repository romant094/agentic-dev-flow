# AI Review Flow Stage

## Purpose

Defines the local review stage of the change workflow — the `/opsx:review` command that runs
the same review CI runs, before the merge request exists. It fixes what the reviewer sees,
how blocking findings are fixed and re-reviewed, how a false positive is dismissed, and the
commit-anchored record archiving depends on.

## Requirements

### Requirement: The local review runs the same prompt file as CI

The local review stage SHALL read `infra/claude/review-prompt.md` at run time and MUST NOT
hold a copy of it. The prompt encodes this stack's Confidence Gate, false-positive
suppression list, SNMP/Prisma/NestJS/React CWE table and `// review-ignore` markers; a
second copy drifts, and its failure mode is the worst available — the local stage passes a
branch that CI then blocks.

The stage MAY append instructions about the shape of its own output, because it needs the
findings in a form it can dispatch fixes from. It MUST NOT restate, reorder or reword what
the prompt asks the reviewer to look for.

#### Scenario: Prompt is edited

- **WHEN** a finding category is added to `infra/claude/review-prompt.md`
- **THEN** the next local review applies it with no other file changed

#### Scenario: Local review runs

- **WHEN** the stage dispatches a review
- **THEN** the prompt it sends is the current content of `infra/claude/review-prompt.md`

### Requirement: The reviewer sees a filtered diff and nothing else

The stage SHALL send the change branch's diff against the integration branch and SHALL NOT
grant the reviewer free exploration of the repository. `review-prompt.md` already instructs
the reviewer to base findings only on what is visible in the diff, so this enforces the
prompt rather than narrowing it, and it is the difference between one review and an agent
loop that reads files across dozens of turns.

The diff SHALL exclude what the prompt orders the reviewer to skip and what it can draw no
conclusion from: `.md` files, `.gitlab-ci.yml` and `.gitlab-ci-playbook.yml`, and the
generated and vendored paths `infra/claude/review.sh` already filters — lock files,
`dist/`, minified bundles, source maps, snapshots and coverage output. For an OpenSpec
change markdown is most of the diff, so this exclusion is where most of the saving is.

The reviewer SHALL run at the highest available capability level. The stage exists to catch
what the generic per-task reviews do not, and a review that misses findings has no value;
cost is reduced by sending less, never by reviewing less carefully.

#### Scenario: Change touches only markdown

- **WHEN** the filtered diff is empty
- **THEN** the stage records that there was nothing to review and completes without
  dispatching a reviewer

#### Scenario: Change touches source and documentation

- **WHEN** the branch diff contains both TypeScript files and OpenSpec artifacts
- **THEN** only the TypeScript files reach the reviewer

### Requirement: The reviewer's response is validated before anything is recorded

The stage SHALL check the reviewer's response for the same structure the CI job requires —
the presence of `### Executive Summary`, a verdict that is one of the three the prompt
defines, and structured findings that parse — before dispatching any fix subagent and before
writing any record. A response failing any of those checks SHALL stop the stage with the
reason, and the stage MUST NOT write `review.md`.

The stage writes the record `/opsx:archive` trusts. Without this check the stage accepts
anything the reviewer returns, so a truncated or garbled response yields a record whose
verdict was never actually read from a review — and a `PASS` record opens archive. CI already
refuses such a response; the surface that records the outcome must refuse it too, or the
strictness in CI protects nothing locally.

The stage MUST NOT retry the reviewer, and MUST NOT write a partial record. A retry hides an
unstable reviewer behind a green stage. A partial record is the malformed-record case
`/opsx:archive` already refuses, reached by a longer path and with a less obvious remedy than
no record at all.

#### Scenario: The response is truncated before its verdict

- **WHEN** the reviewer returns text carrying no recognisable verdict
- **THEN** the stage stops with the reason, dispatches no fix subagent, and writes no
  `review.md`

#### Scenario: The response carries no Executive Summary

- **WHEN** the reviewer returns findings without the section the prompt's output format
  requires
- **THEN** the stage stops with the reason and writes no `review.md`

#### Scenario: The structured findings do not parse

- **WHEN** the reviewer's markdown is well-formed but its structured findings cannot be read
- **THEN** the stage stops with the reason rather than proceeding on the markdown alone

#### Scenario: The response is well-formed

- **WHEN** the response carries the Executive Summary, a recognised verdict and parseable
  findings
- **THEN** the stage proceeds to its fix round as before

### Requirement: Blocking findings are fixed within the stage

The stage SHALL dispatch one fix subagent per CRITICAL or HIGH finding, at a capability
level matched to the work rather than to the reviewer's. Each fix subagent receives one
finding and the file it names — not the review text, and not the other findings. Findings
in different files MAY be dispatched concurrently; findings in the same file MUST be
serialised.

Each fix subagent MUST state, with its fix, what happens if the code it added fails. That
statement is part of the fix's output, not a comment in the source, and it exists because
the fix is the only participant that knows what it assumed.

MEDIUM and LOW findings SHALL be recorded and MUST NOT trigger a fix round, matching the
thresholds the CI gate applies.

#### Scenario: Review returns two HIGH findings in different files

- **WHEN** the reviewer reports one finding in a server file and one in a client file
- **THEN** two fix subagents are dispatched concurrently, each seeing only its own finding

#### Scenario: Review returns two findings in one file

- **WHEN** both findings name the same file
- **THEN** the fixes are applied one after the other, not concurrently

#### Scenario: Review returns only MEDIUM findings

- **WHEN** the reviewer reports MEDIUM findings and no CRITICAL or HIGH
- **THEN** no fix subagent is dispatched and the findings are recorded as non-blocking

#### Scenario: A fix adds a fallback path

- **WHEN** a fix subagent resolves a finding by adding a fallback for a call that may fail
- **THEN** its output states what happens when that fallback itself fails

### Requirement: Later rounds re-review only the fixes, and rounds are capped

After a fix round the stage SHALL send the reviewer only the diff of the fixes together
with the list of findings those fixes were meant to close, and the failure-mode statement
each fix produced. The re-review SHALL check that stated failure mode rather than
rediscovering it: two of three permitted rounds in the measured session went to defects in
round one's own fix, which the fix itself was best placed to have named. Re-reviewing the
whole branch diff each round costs as much as the first review and buys a regression check
that the CI review already performs against the full merge request diff.

The stage SHALL stop after three rounds and record BLOCKED. A loop that has not converged
in three rounds is a design problem and MUST be handed to the developer rather than
retried, by the same reasoning as the round-limit breaker in
`superpowers:subagent-driven-development`.

#### Scenario: Fixes resolve every blocking finding

- **WHEN** the second review of the fix diff reports no CRITICAL or HIGH findings
- **THEN** the stage records a passing verdict and stops

#### Scenario: Fixes introduce a new blocking finding

- **WHEN** the second review of the fix diff reports a new HIGH finding
- **THEN** a third round runs

#### Scenario: The re-review checks the stated failure mode

- **WHEN** a fix stated that its fallback silently returns an empty result when the
  underlying call fails
- **THEN** the re-review evaluates that stated behaviour rather than deriving the fix's
  failure modes from scratch

#### Scenario: Three rounds do not converge

- **WHEN** the third round still reports a blocking finding
- **THEN** the stage records BLOCKED, names the outstanding findings, and stops without a
  fourth round

### Requirement: A dismissal is the developer's decision and lands in the code

A fix subagent that judges a finding to be a false positive SHALL report that judgement
with its reasoning and MUST NOT act on it alone. The stage SHALL put the dismissal to the
developer, and silence MUST NOT be treated as approval.

On approval the stage SHALL place a `// review-ignore: <key> — reason` marker on the line
the finding names, and SHALL record the reasoning in the change's review record. The key
SHALL be the one `infra/claude/review-prompt.md` defines for the finding's kind — a CWE
identifier for a finding this stage produced, and `DUP` for the duplicate class the code reuse
sweep produces, which is dismissed at apply. The marker syntax and its permitted keys are
stated in full in that file and MUST NOT be restated here, for the same reason the prompt
itself is not copied.

The marker is the durable half: both `review-prompt.md` and the CI review honour it, so a
dismissal accepted locally is also accepted on the merge request, and it travels with the
code rather than with the session. That is also why a finding with no CWE needs a key of its
own rather than a record in a session — a dismissal only one surface honours reproduces the
local-pass-then-CI-block drift.

#### Scenario: Fix subagent judges a finding to be a false positive

- **WHEN** a subagent reports that the flagged pattern is handled upstream
- **THEN** the stage presents the judgement to the developer and applies nothing until an
  answer is given

#### Scenario: Developer accepts the dismissal

- **WHEN** the developer agrees the finding is a false positive
- **THEN** a `// review-ignore` marker naming the finding's key and the reason is added to
  the line, and the dismissal with its reasoning is recorded in the review record

#### Scenario: Developer rejects the dismissal

- **WHEN** the developer says the finding is real
- **THEN** the finding is fixed and no suppression marker is added

#### Scenario: The finding has no CWE

- **WHEN** an accepted dismissal is for a finding class that carries no CWE identifier
- **THEN** the marker carries the key the prompt defines for that class rather than being
  omitted or recorded only in the session

### Requirement: The stage records a commit-anchored verdict

The stage SHALL write `review.md` in the change directory recording the reviewed commit
SHA, the finding counts by severity, and one row per finding giving its disposition —
fixed in a named commit, dismissed with the recorded reason, or non-blocking.

The record MUST NOT restate the bodies of the findings. What was fixed is in the fix
commits and what was dismissed is marked in the code; the disposition is the only part that
lives nowhere else in decided form, which is why it is what the record carries.

#### Scenario: Review passes with findings fixed

- **WHEN** two HIGH findings are fixed and the re-review is clean
- **THEN** `review.md` records a passing verdict, the reviewed commit SHA, and one row per
  finding naming the commit that fixed it

#### Scenario: Review passes with nothing found

- **WHEN** the reviewer reports no findings
- **THEN** `review.md` records a passing verdict, the reviewed commit SHA, and zero counts

### Requirement: Archiving refuses a change that was not reviewed at its current commit

`/opsx:archive` SHALL refuse to archive when `review.md` is absent, when it records
BLOCKED, or when the commit it names is not the current HEAD. Without the commit anchor the
gate is bypassed by reviewing a clean branch and then committing again before archiving.

The staleness scan SHALL cover the whole repository and exclude only `review.md` itself.
Scoping it to the change directory cannot work: the record's own commit always lands
inside that directory, so such a scan always finds at least one commit and never
short-circuits — the defect already recorded for `.apply-test-record.md` and
`/opsx:verify` check 6.

A BLOCKED verdict SHALL be resolvable by an explicit developer decision recorded in
`review.md` with its reasoning. Silence MUST NOT resolve it. Without this a false blocking
finding would strand a branch permanently.

#### Scenario: Change was never reviewed

- **WHEN** `/opsx:archive` runs and no `review.md` exists
- **THEN** it stops, names `/opsx:review` as the remedy, and archives nothing

#### Scenario: Commits landed after the review

- **WHEN** `review.md` records a passing verdict at a commit that is no longer HEAD
- **THEN** `/opsx:archive` stops and requires the review to be re-run

#### Scenario: Review passed at the current commit

- **WHEN** `review.md` records a passing verdict at the current HEAD
- **THEN** `/opsx:archive` proceeds

#### Scenario: Developer overrides a blocking finding

- **WHEN** the developer records in `review.md` that a BLOCKED finding is a false positive,
  with reasoning
- **THEN** `/opsx:archive` proceeds and the reasoning stays in the record
