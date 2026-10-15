The procedure `/adf:propose` executes. The command file carries the step order and the
imperative of each step; the rules below are stated here in full and the command points at them.

**Nothing is created before the gate passes.**

If the preflight refuses, create no worktree, no branch, no change directory and no artifact,
by hand or otherwise. Brainstorm and plan are Superpowers skills; without them there is nothing
to run.

**One branch and one worktree per change, made before the first artifact.**

Every change gets its own branch and its own worktree, so changes run in parallel and none
touches the developer's checkout. `propose.mjs create` makes both before the change directory.
The worktree is made before any artifact is written: a change directory created first lands on
whatever branch the main checkout has. Never run `git checkout` or `git switch` in the main
checkout.

The change forks from one of two bases, and the developer chooses:

- the integration branch, fetched first when the host has a remote: a new piece of work;
- the current branch, when the developer is mid-feature and this change belongs to it. The
  preflight lists it only when it is neither protected nor a detached HEAD.

The merge request targets the base; with no forge plugin, archive offers to merge the change
back into it, and merges only on the developer's yes.

**The developer confirms the branch name.**

The preflight proposes `<type>/<change>`; when it has no type, ask which type applies. Show the
name and wait for an explicit answer; the developer may edit it. Do NOT validate a confirmed
name with a regular expression: a confirmed name is a decision, and convention compliance is the
developer's responsibility. No branch operation happens without that answer.

**Uncommitted tracked work stops the proposal.**

The preflight refuses it. Show `git status` in full and ask the developer to deal with it. Never
run `git stash`, never commit on their behalf, and never pass `--force` to anything: uncommitted
work is theirs to decide about.

**Every later step runs in the worktree.**

Pass the worktree root as `--root` to every core script. Install nothing at propose. The change
holds only markdown until apply; whether and how the worktree is provisioned is decided there.

**Each artifact's gates bind it.**

`schema.json` declares the gates of an artifact; `changes.mjs done` runs them, `next` refuses a
later artifact while a written one fails them, and `propose.mjs commit` runs them all again. A
gate's findings are yours to fix in the artifact, never to argue past. The `specs` gates validate
this change's specs only, the proposal's capabilities against the spec folders, and each delta
against the main spec archive will apply it to. A requirement's `SHALL` or `MUST` MUST be on the
first line of its body: the validator does not scan past it.

**Context, rules and guides guide the author and never reach the artifact.**

The `context`, `rules` and `guides` fields of the instructions are constraints for you. Copied
in, they ship the instructions as if they were the deliverable; `done` refuses an artifact that
holds a passage of them.

**Only the change directory is committed.**

`propose.mjs commit` stages only `openspec/changes/<change>/`. If anything else is staged, stop
and show it: the commit refuses, and that is the developer's work, not yours to commit.
Formatting and linting are not run: the commit holds only markdown the change generated.

**The merge request is the forge's, and only after the commit.**

When the artifacts are committed, the `forge` role pushes the branch and opens a Draft merge
request into the change's base; the title's type comes from the branch, and the forge marks the
draft itself. With no forge plugin enabled nothing is pushed and the report says that no merge
request exists. A degraded forge (its tool missing or not logged in) does not stop the proposal:
the report carries its `hint` and `fallback` commands, and no merge request is claimed. A refusal
is reported as it is; the committed artifacts stay.
