# Code Reuse Sweep

## Purpose

Defines the one gate in the change workflow that can see the repository: a bounded
read-only sweep the apply phase issues once over the merged branch, asking whether the
branch introduces a symbol, helper, validator, mapper, constant set or pattern whose
behaviour the tree already carries. That question cannot be answered from a diff, which is
why it lives in a dispatch of its own rather than as another line in a reviewer's prompt.

The requirements below fix what keeps the sweep cheap and its finding class defensible —
when it is issued and that it is issued exactly once, the capability level it is dispatched
at, the tree access it holds and the reviewer scopes that access does not widen, the single
question it asks and the code-quality questions it refuses, and the shape a finding must
have to count. A confirmed duplicate is the first and only maintainability class in this
workflow that blocks apply from concluding, cleared by consolidating on the existing code or
by an explicit developer dismissal that leaves a `DUP` marker in the code and a debt line in
the ledger. The sweep also carries a second, triggered question — whether a `REMOVED` or
`RENAMED` delta operation's stated `**Code Disposition:**` is true of the code — which is
recorded as debt and never blocks.

## Requirements

### Requirement: The branch is swept once against the tree before apply concludes

`/opsx:apply` SHALL issue exactly one code reuse sweep per change, after
`superpowers:subagent-driven-development` returns with every task complete and every wave
group merged, and before the whole-suite run. The sweep MUST NOT be issued per task group.

A duplicate introduced by two different groups is invisible to either group's own sweep, and
that is the case most worth catching; a single sweep over the merged branch is also the
cheaper of the two. The placement is after the merge because that is the first moment the
branch exists in the form the merge request will carry, and before the suite run because a
confirmed duplicate is work the branch still owes.

The sweep is not a workflow phase and MUST NOT be counted as one. It adds no artifact, no
verify check and no command.

#### Scenario: A single-group change reaches the end of apply

- **WHEN** `subagent-driven-development` returns for a change whose plan had one task group
- **THEN** apply issues one sweep before running the whole suite

#### Scenario: A fanned-out change merges three wave groups

- **WHEN** three group worktrees have been merged into the change branch
- **THEN** one sweep is issued over the merged branch, and no sweep was issued inside any
  group

#### Scenario: Two groups each introduce the same helper

- **WHEN** two groups independently add a helper with the same behaviour in different files
- **THEN** the single post-merge sweep reports the pair, which neither group's own review
  could have seen

### Requirement: The sweep is issued at a judgement-capable level

The sweep SHALL be issued at a judgement-capable capability level — the integration level or
above — and MUST NOT be issued at the cheapest level that can run a dispatch. The level is
named in the dispatch, as every other dispatch in this workflow names its own.

The sweep is not a `plan.md` task, so no `**Level:**` line covers it and the cheapest-capable
rule would otherwise route it to the bottom. Its question is the one question in this flow
that cannot be answered by reading the diff, and a cheap dispatch's honest answer to "does
this behaviour already exist" is `CLEAN` almost always. That makes the gate green forever and
indistinguishable from a working one — the same failure shape as a tool exercised only on
empty input.

No model or vendor is ever named, here or in the dispatch; only the capability level is.

#### Scenario: The sweep is dispatched for a change

- **WHEN** apply issues the sweep after the last wave group has merged
- **THEN** it is dispatched at the integration level or above, and the dispatch names that
  level

#### Scenario: The cheapest-capable rule is applied to the sweep

- **WHEN** the orchestrator reaches for the cheapest level that could run the dispatch
- **THEN** the sweep is issued at a judgement-capable level regardless, because a cheap
  `CLEAN` is indistinguishable from a working gate

### Requirement: The sweep reads the repository, and no review's scope changes because it does

The sweep SHALL be a read-only dispatch with read access to the working tree in addition to
the branch diff, and it MUST NOT hold write access, fix authority, or the ability to dispatch
further agents. Its question is unanswerable from a diff, which is the entire reason it exists
as a separate dispatch rather than as an instruction added to a reviewer.

The sweep MUST NOT be cited as precedent for widening what any reviewer may read. The filtered
diff `ai-review-flow-stage` requires of the `/opsx:review` reviewer, and the diff-only rule
`infra/claude/review-prompt.md` states, are unchanged by this capability and remain in force
for both the local stage and the merge-request gate.

#### Scenario: The sweep needs a file the diff does not contain

- **WHEN** the sweep must open an existing file to confirm a pre-existing helper
- **THEN** it reads that file, and it writes nothing

#### Scenario: The sweep finds a defect outside its question

- **WHEN** the sweep notices a bug in code it read while answering its own question
- **THEN** it reports nothing about it and fixes nothing, because it has no fix authority and
  the bug is not its question

#### Scenario: A later change proposes letting the review reviewer read the tree

- **WHEN** the reuse sweep is cited as the precedent
- **THEN** the citation fails, because this capability states that the review stage's scope is
  unchanged by it

### Requirement: The sweep asks one bounded question and refuses the rest

The sweep's question SHALL be whether the branch introduces a symbol, helper, validator,
mapper, constant set or pattern whose behaviour already exists elsewhere in the repository.

In scope: a function, class, hook, validation schema in a shared package, adapter method,
mapper entry, constant table, or a repeated block of logic that the branch adds and the tree
already carries.

Out of scope, and MUST NOT be reported: code quality of any kind — naming, function length,
nesting depth, formatting, comment density, test coverage, correctness, performance and
security. Every one of those already has a home in `infra/claude/review-prompt.md`, and a
sweep that drifts into them becomes a second unbounded review.

The bound is what makes the sweep a cheap single dispatch and what makes its finding class
defensible as a blocking one: a duplicate is a fact about two locations, not a judgement about
one.

#### Scenario: The branch adds a second IP-range helper

- **WHEN** the branch introduces a CIDR-to-range function and an equivalent one already exists
- **THEN** the sweep reports it

#### Scenario: The branch adds a long function

- **WHEN** the branch introduces a function of ninety lines that duplicates nothing
- **THEN** the sweep reports nothing, and the function's length is left to the review prompt's
  own Code Quality section

#### Scenario: The branch adds a helper that resembles an existing one but behaves differently

- **WHEN** two functions share a name or a shape but not their behaviour
- **THEN** the sweep does not report them as a duplicate

### Requirement: A finding names both locations or is not a finding

Every sweep finding SHALL name the location the branch introduces and the pre-existing
location it duplicates, each as a file path with a line or a symbol name, and SHALL state in
one sentence what the two share. A finding that cannot name a pre-existing location MUST be
dropped rather than reported at a lower confidence.

The sweep SHALL return a verdict of `CLEAN` when it has no findings, and MUST NOT return a
verdict on anything other than its own question. A malformed or unparseable response is
handled as apply handles any dispatch whose answer cannot be read: the sweep is not recorded
as passed.

#### Scenario: The sweep finds nothing

- **WHEN** the branch introduces nothing the tree already carries
- **THEN** the sweep returns `CLEAN`, and apply proceeds to the suite run

#### Scenario: The sweep suspects a duplicate but cannot locate the original

- **WHEN** the sweep believes a helper exists somewhere but cannot name the file
- **THEN** it drops the finding rather than reporting it unlocated

#### Scenario: The sweep's response cannot be read

- **WHEN** the dispatch returns text carrying no recognisable verdict
- **THEN** apply records that the sweep did not produce a verdict and MUST NOT record it as
  `CLEAN`

### Requirement: A confirmed duplicate blocks apply from concluding

A sweep finding that names both locations SHALL block apply from concluding until it is
resolved, and this SHALL be the only maintainability class in this workflow that blocks. Every
other maintainability finding keeps the severity and the advisory standing
`infra/claude/review-prompt.md` gives it, and MEDIUM and LOW findings continue never to block.

Resolution is one of exactly two things: the duplication is removed by consolidating on the
existing code, or the finding is dismissed by the developer under the requirement below.
Apply MUST NOT conclude with an unresolved finding, and the block MUST NOT be cleared by
re-running the sweep.

A finding class that cannot block is a class that accumulates: this prompt has had a Code
Quality section from the beginning and the debt accumulated regardless. The narrowness is what
makes this one different — it survives the prompt's own Confidence Gate because it is
falsifiable by opening two files.

#### Scenario: The sweep reports one duplicate

- **WHEN** the sweep names a new helper and the existing one it duplicates
- **THEN** apply does not conclude until the duplication is consolidated or dismissed

#### Scenario: The sweep is re-run instead of resolving the finding

- **WHEN** a second sweep is issued and returns `CLEAN` on the same unchanged branch
- **THEN** the first finding is still unresolved and apply still does not conclude

#### Scenario: The sweep reports a long function and nothing else

- **WHEN** the only maintainability observation is one the review prompt tags 🔵LOW
- **THEN** nothing blocks, exactly as today

### Requirement: A duplicate is dismissed only by the developer, and the dismissal lands in the code

The sweep MUST NOT dismiss its own finding, and apply MUST NOT dismiss one on the developer's
behalf. A finding judged to be a false positive SHALL be put to the developer with its
reasoning, and silence MUST NOT be treated as approval — the rule `/opsx:review` applies to a
false positive and verify's stale-skill check applies to a skill finding, for the same reason:
an automatic dismissal is indistinguishable from a missed finding.

On approval, apply SHALL place a suppression marker with the `DUP` key on the introduced
location, in the form `infra/claude/review-prompt.md` defines, and SHALL record a code-debt
line with its reason in the change's apply ledger. The marker is what stops the next change's
sweep re-reporting an acceptance already made; the ledger line is what stops the acceptance
being forgotten, because `/opsx:archive` already refuses to leave a debt line unresolved.

#### Scenario: The developer accepts a duplicate deliberately

- **WHEN** the developer judges that the two implementations must stay separate and says so
- **THEN** a `DUP` marker with the reason is placed on the introduced location, a code-debt
  line is written to the ledger, and apply concludes

#### Scenario: The developer rejects the dismissal

- **WHEN** the developer says the duplication is real
- **THEN** the branch consolidates on the existing code and no marker is added

#### Scenario: The developer is not asked

- **WHEN** apply reaches its conclusion with a finding neither consolidated nor put to the
  developer
- **THEN** apply does not conclude

#### Scenario: A previously accepted duplicate is swept again

- **WHEN** a later change's sweep reads a location already carrying a `DUP` marker naming that
  duplication
- **THEN** it does not report it again

### Requirement: A change that removes or renames a requirement is asked whether its code followed

When a change's delta specs carry a `REMOVED` or `RENAMED` operation, the sweep SHALL carry a
second bounded question: is the `**Code Disposition:**` the delta states actually true of the
code, and is the removed behaviour's old path still reachable. A change whose delta specs
carry neither operation SHALL NOT be asked this question and pays nothing for it.

The question rides the sweep that is already being issued rather than becoming a verify check.
The dispatch already has the tree access the question needs, and the workflow's measured
failure mode is monotonic gate growth — a twelfth check would cost every change an N/A line
and an edit at every site stating the check count.

The trigger is the delta operation, not a judgement about whether dead code might exist.
`REMOVED` already carries mandatory `**Reason:**` and `**Migration:**` fields, so the question
asked is whether a stated claim holds, which is narrower and more answerable than hunting for
dead code in general.

#### Scenario: A change removes a requirement and deletes its code

- **WHEN** the delta carries a `REMOVED` operation whose stated disposition is that the code
  was deleted, and it was
- **THEN** the sweep confirms it and reports no finding

#### Scenario: A change removes a requirement and leaves its code reachable

- **WHEN** the delta states the behaviour was removed but the old path is still called
- **THEN** the sweep reports the stated disposition and the reachable path it contradicts

#### Scenario: A change carries no removal

- **WHEN** the delta specs carry only `ADDED` and `MODIFIED` operations
- **THEN** the second question is not asked

#### Scenario: A removal states no disposition

- **WHEN** a `REMOVED` operation carries no `**Code Disposition:**` field
- **THEN** the sweep reports the missing field as the finding

### Requirement: The removal finding is recorded and never blocks

A finding from the removal question SHALL be recorded as a code-debt line in the change's
apply ledger with its reason, and MUST NOT block apply from concluding. Exactly one
maintainability class blocks, and it is the confirmed duplicate.

A duplicate is a fact about two locations. Whether a path is still reachable rests on a
judgement about callers, which is the kind of claim the review prompt's Confidence Gate exists
to keep out of the blocking tier. The finding is not merely noted, though: as a ledger debt
line it is one `/opsx:archive` must see resolved, which is the difference between this and a
note in a review comment.

#### Scenario: The removal question finds a reachable old path

- **WHEN** the sweep reports that a removed behaviour's path is still called
- **THEN** a code-debt line is written with the reason, and apply concludes

#### Scenario: Both questions find something

- **WHEN** the sweep reports one duplicate and one removal finding
- **THEN** the duplicate blocks apply and the removal finding is recorded
