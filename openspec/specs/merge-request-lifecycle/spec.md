# Merge Request Lifecycle

## Purpose

Defines how the change workflow carries a branch to a merge request: when it pushes, when
the merge request is opened as a Draft and when it leaves Draft, what its description
contains and where that content comes from, and how the flow behaves when the merge request
tool is missing or unauthenticated.

The requirements below cover the three commands that touch a merge request — propose, apply
and archive — and fix the one boundary the flow never crosses: it opens and describes a
merge request, and the developer merges it.

## Requirements

### Requirement: Propose pushes the branch and opens a Draft merge request

`/opsx:propose` SHALL push the change branch to `origin` and open a Draft merge request
targeting `develop` after it commits the change artifacts. The merge request MUST be created
with squash-on-merge and delete-source-branch enabled, and its title MUST follow Conventional
Commits behind the `Draft:` prefix.

#### Scenario: Propose finishes on a branch with no merge request

- **WHEN** `/opsx:propose` has committed the change artifacts and the branch has no open
  merge request
- **THEN** the branch is pushed to `origin` and a Draft merge request against `develop`
  exists, with squash-on-merge and delete-source-branch set

#### Scenario: Propose finishes on a branch that already has an open merge request

- **WHEN** `/opsx:propose` has committed the change artifacts and an open merge request
  already exists for the branch
- **THEN** the branch is pushed, no second merge request is created, and the existing one is
  reported by number

### Requirement: Apply pushes after each task group merges

`/opsx:apply` SHALL push the change branch once a task group's branch has merged into it and
that group's scoped re-review has passed. The push MUST run in the main change worktree and
MUST NOT run in a group worktree.

#### Scenario: A task group completes

- **WHEN** a group's branch has merged into the change branch and its scoped re-review passed
- **THEN** the change branch is pushed to `origin` from the main change worktree

#### Scenario: Groups ran in parallel waves

- **WHEN** wave-1 groups ran concurrently in sibling worktrees and each merged back into the
  change branch
- **THEN** a push follows each merge, and no push originates from a group worktree

### Requirement: Archive leaves Draft before it pushes the final commit

`/opsx:archive` SHALL take the merge request out of Draft and set its description **before**
pushing the final commit. Changing a merge request title starts no pipeline, so pushing first
would run the final commit's pipeline under a Draft title and permanently skip the
`ai_claude_inspect` job for that commit. The order MUST NOT be reversed.

#### Scenario: Archive completes with an authenticated tool

- **WHEN** `/opsx:archive` reaches its merge request step
- **THEN** the merge request leaves Draft and receives its description first, and only then
  is the final commit pushed

#### Scenario: The final pipeline sees a non-Draft title

- **WHEN** the final commit's pipeline is created by the archive push
- **THEN** the merge request title carries no `Draft:` prefix, so `ai_claude_inspect` is
  eligible to run

### Requirement: One fixed description template, enforced mechanically

The merge request description SHALL follow a single template stored at
`.gitlab/merge_request_templates/`, carrying exactly the sections `## What`, `## Why` and
`## QA`, written in English and kept brief. The tooling MUST reject a description whose
headings do not match the template or that leaves a section empty, and MUST send nothing when
it rejects. Storing the template under `.gitlab/` is required so that the GitLab UI offers the
same shape to a developer opening a merge request by hand.

#### Scenario: A well-formed description is submitted

- **WHEN** a description carrying all three sections, each non-empty, is submitted
- **THEN** it is set on the merge request

#### Scenario: A section is missing or empty

- **WHEN** a description omits one of the three sections, or leaves one empty
- **THEN** the tooling exits non-zero, reports which section is at fault, and the merge
  request description is left unchanged

### Requirement: QA steps are derived from existing artifacts

The `## QA` section SHALL be derived from the change's own `#### Scenario` blocks in
`specs/**/*.md` and from what `verify.md` records as actually run. No additional artifact is
introduced to hold them, and the cycle's artifact count is unchanged.

#### Scenario: Archive assembles the description

- **WHEN** `/opsx:archive` assembles the `## QA` section
- **THEN** its steps trace to the change's spec scenarios and its `verify.md` record, and no
  new artifact file is created

### Requirement: An existing merge request is reused, scoped by a change marker

When the branch already carries an open merge request, the flow SHALL reuse it rather than
attempting to create a second one. Each change's contribution to the description MUST be
delimited by an `<!-- opsx:<change-name> -->` marker: when the marker is present its block is
replaced, and when it is absent the block is appended. Text outside every marker MUST be left
untouched.

#### Scenario: A second change archives on the same branch

- **WHEN** a second change archives on a branch whose merge request description already
  carries a different change's marked block
- **THEN** the second change's block is appended and the first change's block is unchanged

#### Scenario: The same change archives again

- **WHEN** a change archives on a branch whose merge request description already carries that
  change's own marker
- **THEN** the marked block is replaced in place and no duplicate block is added

#### Scenario: The description carries hand-written prose

- **WHEN** the description contains text outside any `<!-- opsx:... -->` marker
- **THEN** that text is preserved verbatim

### Requirement: A missing or unauthenticated tool degrades without blocking

The merge request steps SHALL NOT block the change cycle when `glab` is absent or
unauthenticated. When the binary is absent, the flow MUST name the install command for the
host operating system, derived from the platform rather than asked for. When the binary is
present but `glab auth status` fails, the flow MUST say so explicitly and ask the developer to
authenticate against the project's self-hosted host. In both cases the flow MUST print the
merge request command the developer can run later, MUST report the degraded outcome in the
command's own summary rather than closing with an unqualified success line, and MUST continue.

#### Scenario: The binary is not installed

- **WHEN** a merge request step runs and no `glab` binary is on `PATH`
- **THEN** the install command for the host operating system is named, the merge request
  command is printed for later use, the degraded outcome is reported in the summary, and the
  command continues and exits 0

#### Scenario: The binary is installed but not authenticated

- **WHEN** a merge request step runs, `glab` is on `PATH`, and `glab auth status` fails
- **THEN** the flow states that the tool is installed but not authenticated, asks for
  `glab auth login` against the project's host, prints the merge request command for later
  use, and continues and exits 0

### Requirement: The flow opens and describes, but never merges

The flow SHALL NOT merge a merge request, and SHALL NOT assign reviewers, labels or
milestones. Integration remains the developer's action, and `develop` is reached only through
a merge request the developer merges.

#### Scenario: Archive finishes

- **WHEN** `/opsx:archive` has undrafted the merge request and pushed the final commit
- **THEN** the merge request is open and unmerged, carries no assigned reviewer set by the
  flow, and the command names it as ready for the developer to merge
