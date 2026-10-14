The procedure `/adf:propose` executes. The command file carries the step order and the
imperative of each step; the rules below are stated here in full and the command points at them.

**Nothing is created before the gate passes.**

If the Superpowers gate fails, create no worktree, no branch, no change directory and no
artifact. Brainstorm and plan are Superpowers skills; without them there is nothing to run.

**One branch and one worktree per change, made before the first artifact.**

Every change gets its own branch and its own worktree under `.claude/worktrees/<change>/`, so
changes run in parallel and none touches the developer's checkout. The worktree is made before
any artifact is written: a change directory created first lands on whatever branch the main
checkout has. Never run `git checkout` or `git switch` in the main checkout.

The change forks from one of two bases, and the developer chooses:

- the integration branch, fetched first when the host has a remote: a new piece of work;
- the current branch, when the developer is mid-feature and this change belongs to it. Not
  offered when the current branch is protected or HEAD is detached.

The base is recorded in the change's metadata. The merge request targets it; with no forge
plugin, the change is merged back into it at the end.

**The developer confirms the branch name.**

The proposed name is `<type>/<change>`: `add-` gives `feat`, `fix-` gives `fix`, `refactor-`
and `restructure-` give `refactor`; otherwise ask which type applies. Show the name and wait for
an explicit answer; the developer may edit it. Do NOT validate a confirmed name with a regular
expression: a confirmed name is a decision, and convention compliance is the developer's
responsibility. No branch operation happens without that answer.

A protected branch is never the change's branch, and nothing is committed or pushed to one
directly. The host's protected branches are set by `/adf:init`.

**Uncommitted tracked work stops the proposal.**

Show `git status` in full and ask the developer to deal with it. Never run `git stash`, never
commit on their behalf, and never pass `--force` to anything: uncommitted work is theirs to
decide about. Untracked files do not stop it: `git worktree add` cannot lose or carry one.

**Every later step runs in the worktree.**

Pass the worktree root as `--root` to every core script, and run git there with `git -C`. The
workspace script checks that the worktree resolves to its own path; if it does not, stop before
writing anything.

Install nothing at propose. The change holds only markdown until apply; whether and how the
worktree is provisioned is decided there.

**Spec validation gates `tasks` and `plan`.**

Right after `specs` is done, validate this change's specs only. Every item MUST report
`"valid": true`. If any item is invalid, fix the requirement text in place (the requirement's
`SHALL` or `MUST` MUST be on the first line of its body: the validator does not scan past it)
and re-run validation. Do NOT continue to `tasks` or `plan` on an invalid spec.

**Context, rules and guides guide the author and never reach the artifact.**

The `context`, `rules` and `guides` fields of the instructions are constraints for you. Do NOT
copy them into the artifact: copied in, they ship the instructions as if they were the
deliverable.

**The plan symbol check gates the commit.**

After `plan.md` is written, run the symbol check. Exit 0 is clean. Exit 1 lists the findings:
correct the plan and re-run, and do NOT commit the artifacts while it reports a finding. Exit 2
means a usage error or no `plan.md`; fix that and re-run. What the check covers, and the duties
it leaves to the author, are stated in the `plan` artifact instruction.

**Only the change directory is committed.**

Stage only `openspec/changes/<change>/`, then read `git status --porcelain` before the commit.
If anything else is staged, stop and show it: that is the developer's work, not yours to commit.
The commit message is `docs(openspec): propose <change>`. Formatting and linting are not run:
the commit holds only markdown the change generated.

**The merge request is the forge's, and only after the commit.**

When the artifacts are committed, the `forge` role pushes the branch and opens a Draft merge
request into the change's base. The title follows Conventional Commits and carries no draft
prefix: the forge marks the draft itself. With no forge plugin enabled nothing is pushed and the
report says that no merge request exists. A degraded forge (its tool missing or not logged in)
does not stop the proposal: report its `hint` and `fallback` commands and do not claim a merge
request exists. A refusal is reported as it is; the committed artifacts stay.
