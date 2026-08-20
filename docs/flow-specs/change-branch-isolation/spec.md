# Change Branch Isolation

## Purpose

Defines how a change gets a workspace of its own: the branch it is named after, the
worktree it is authored in, how that worktree obtains its dependencies, and how both are
cleaned up.

The requirements below fix the boundaries that keep parallel changes from contending for
one checkout — `develop` is never checked out and never committed to directly, the main
checkout is never switched, and integration ends at a merge request the developer merges.

## Requirements

### Requirement: Branch naming convention

A branch created for a change SHALL be named `<type>/<TASK-ID>/<short-description>`, for
example `feat/PROJ-123/add-licensing`. `<type>` is derived from the change name
(`add-` → `feat`, `fix-` → `fix`, `restructure-`/`refactor-` → `refactor`, otherwise the
developer is asked); `<short-description>` is the change name verbatim, so branch and
change remain findable from each other. The proposed name MUST be confirmed or edited by
the developer, and branch names MUST NOT be validated by regular expression — a confirmed
name is a decision.

#### Scenario: Name proposed from the change name

- **WHEN** `/opsx:propose add-licensing` runs and the developer supplies task ID
  `PROJ-123`
- **THEN** the branch name `feat/PROJ-123/add-licensing` is proposed for confirmation

#### Scenario: Developer edits the proposed name

- **WHEN** the developer supplies a different name at the confirmation prompt
- **THEN** that name is used as given, without validation

### Requirement: Explicit confirmation before any branch operation

Branch setup SHALL run before any artifact is created, and after the pre-flight check, and
SHALL require explicit developer confirmation without proceeding silently. Three cases are
covered: the developer supplies a task ID, so the branch
name is proposed and the worktree is created; the developer chooses to stay on the current
branch, so work proceeds in place with no worktree and no name validation; or the working
tree carries uncommitted changes to tracked files at branch creation time, in which case
the command stops and shows `git status`. Untracked files MUST NOT stop it: the branch
operation cannot affect them. The workflow MUST NOT stash or commit on the developer's
behalf.

#### Scenario: Developer stays on the current branch

- **WHEN** the developer states they are mid-feature and want to continue on the current
  branch
- **THEN** no branch and no worktree are created, and the change is authored in place

#### Scenario: Dirty working tree

- **WHEN** branch creation is requested and the working tree has uncommitted changes to
  tracked files
- **THEN** the command stops, shows `git status`, and changes nothing

#### Scenario: Only untracked files are present

- **WHEN** branch creation is requested and the working tree holds untracked files but no
  uncommitted changes to tracked ones
- **THEN** the command proceeds, because `git worktree add` cannot affect them

### Requirement: The main checkout is never switched

Branch creation SHALL fetch and branch from `origin/develop` without checking it out:

```
git fetch origin develop
git worktree add .claude/worktrees/<TASK-ID> -b <branch> origin/develop
```

The workflow MUST NOT run `git checkout` or `git switch` in the main checkout, and MUST
NOT commit to `develop` directly — all work reaches `develop` through a merge request.

#### Scenario: Developer has uncommitted work elsewhere

- **WHEN** the worktree is created while the main checkout is on an unrelated branch with
  uncommitted changes
- **THEN** the main checkout is unaffected: same branch, same working tree state

### Requirement: The worktree is created at propose and holds the whole cycle

The worktree SHALL be created at `/opsx:propose` under `.claude/worktrees/<TASK-ID>/`,
which MUST be gitignored, and every subsequent stage — brainstorm through archive —
runs inside it. Creating it at apply is not permitted, because the artifacts authored
before apply would then be committed to `develop`.

Group worktrees, defined by the `parallel-group-execution` capability, are an explicit,
scoped exception to this requirement: they exist only inside the apply phase's
group-dispatch step, at the sibling path `.claude/worktrees/<TASK-ID>--group-<N>/`,
and MUST be merged into the main worktree's change branch and removed before apply
concludes. They MUST NOT survive past apply, and archive MUST NOT observe one. The main
worktree remains the only worktree that holds the whole cycle and the only one that
persists past apply.

#### Scenario: Two changes in parallel

- **WHEN** two changes are proposed with different task IDs
- **THEN** each has its own worktree and branch, and agents can run in both without
  interference

#### Scenario: Apply confirms it is already isolated

- **WHEN** `/opsx:apply` runs and compares the repository root of the current working
  directory with the repository root the main checkout owns, using `git rev-parse`
- **THEN** it reports which of the two workspaces it is standing in and creates nothing
  further

#### Scenario: Apply does not delegate the isolation check

- **WHEN** `/opsx:apply` needs to confirm workspace isolation
- **THEN** it does not invoke the worktree-isolation skill, whose own first step installs
  dependencies unconditionally and would write through this project's `node_modules`
  symlink into the main checkout, and whose authored-in-place path offers to create a
  second worktree under a directory this repository does not ignore

#### Scenario: A group worktree exists during apply

- **WHEN** apply is running a wave of parallel groups
- **THEN** each group's worktree exists at `.claude/worktrees/<TASK-ID>--group-<N>/`,
  distinct from the main worktree, and this does not violate the one-worktree-per-change
  invariant because it is scoped to apply and removed before apply concludes

#### Scenario: A group worktree outlives a successful apply

- **WHEN** apply completes every wave with no group left `BLOCKED`
- **THEN** no `.claude/worktrees/<TASK-ID>--group-*` worktree remains — a surviving one
  is a defect this requirement's exception does not permit

#### Scenario: A blocked group's worktree is a known, checked exception

- **WHEN** a group is `BLOCKED` and apply has stopped to report it
- **THEN** that group's worktree is deliberately not removed, pending human resolution
  — this is not a violation of the exception, but it is exactly what
  `parallel-group-execution`'s verify check is designed to catch if the change is
  taken to archive without resolving it first

### Requirement: Worktree dependency provisioning

Provisioning SHALL be decided at `/opsx:apply`, when the change's file list is known. When
the change touches `prisma/`, `package.json` or `package-lock.json`, `npm ci` SHALL run
inside the worktree. Otherwise `node_modules`, `apps/client/node_modules`,
`apps/server/node_modules`, `packages/shared/node_modules` and the root `.env` SHALL be
symlinked from the main checkout. The worktree created at propose contains only markdown
and SHALL be provisioned with nothing.

#### Scenario: Change touches the Prisma schema

- **WHEN** the change's file list includes `prisma/`
- **THEN** `npm ci` runs inside the worktree so that `prisma generate` writes a private
  client rather than the main checkout's

#### Scenario: Change touches no dependency-defining file

- **WHEN** the change's file list includes none of `prisma/`, `package.json` or
  `package-lock.json`
- **THEN** the four `node_modules` directories and the root `.env` are symlinked from the
  main checkout

### Requirement: Dependency installation is out of scope inside a worktree

`npm install` and `npm ci` SHALL NOT run inside a worktree except in the provisioning case
above, and this rule SHALL be stated in `openspec/config.yaml` so that every generated
instruction carries it. A dependency update is a separate task and a separate merge
request.

#### Scenario: A missing package is discovered mid-implementation

- **WHEN** implementation inside a worktree finds a dependency it needs
- **THEN** the agent stops and reports it as separate work, rather than installing it into
  the shared `node_modules`

### Requirement: Worktree cleanup at archive

`/opsx:archive` SHALL remove the change's worktree by the path `git worktree list` reports
for it, run from the main checkout, and MUST NOT reconstruct that path from a task ID it
was not given. Symlinks are removed as symlinks and their targets are left untouched. If
the worktree is dirty the removal refuses, and the workflow MUST NOT force it.

#### Scenario: Clean worktree at archive

- **WHEN** the change is archived and its worktree has no uncommitted changes
- **THEN** the worktree is removed and the main checkout's `node_modules` is intact

#### Scenario: Dirty worktree at archive

- **WHEN** the worktree still has uncommitted changes
- **THEN** removal fails, the failure is reported, and nothing is forced or discarded

### Requirement: Integration is the developer's action

The workflow MUST NOT merge a branch into `develop` and MUST NOT merge a merge request:
`develop` is reached only through a merge request the developer merges. The workflow SHALL
push the change branch and SHALL open and describe a merge request against `develop`, as
specified by the `merge-request-lifecycle` capability. `/opsx:archive` MUST leave the branch
and every commit on it intact, and MUST NOT merge into `develop` locally.

#### Scenario: Archive completes

- **WHEN** `/opsx:archive` finishes its last step
- **THEN** the branch is pushed, an open merge request against `develop` exists and is out of
  Draft, and the command names it as ready for the developer to merge

#### Scenario: Archive completes without the merge request tool

- **WHEN** `/opsx:archive` finishes its last step and `glab` is absent or unauthenticated
- **THEN** the archive still completes, the degraded outcome is reported, and the command
  names the branch and prints the merge request command for the developer to run

#### Scenario: A local merge is offered

- **WHEN** any skill or command offers to merge the change's branch into `develop` locally
- **THEN** the workflow refuses it and reports the refusal, rather than switching the main
  checkout
