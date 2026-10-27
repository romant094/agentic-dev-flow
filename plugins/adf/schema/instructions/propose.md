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

**The scope is gathered before the branch is named.**

Whatever the start, `scope.mjs gather` in the main checkout collects what fits the same change:
the technical debt store always, the tracker when a tracker plugin is enabled, and the changes in
flight whose scope already takes a gathered key. The start is the keys the developer named,
tracker keys or debt ids, and the description as the phrase, passed together. With a tracker enabled (`tracker.state` is `done`) and
neither a key nor a phrase, ask once for the keys, or none, and gather again with them. With no
tracker plugin and no debt match the result is `empty`: show its one-line `report`, and the
proposal goes on to the branch with no scope, as it did before scopes existed. Resolved debt the
same search finds comes back as `precedents`, never as items: each names the archived change
that fixed it, which the issue check reads and the proposal's `## Scope sources` lists.

A degraded tracker (its tool missing, not logged in, or not configured) sends nothing: show its
`hint` and ask whether the developer fixes it and gathers again, or works without the tracker
for this change, with the reason, given once as `--skip-tracker "<reason>"`. A refused tracker
stops the proposal with its error.

Show the gathered items with their state, status and flags, and propose which of them fit one
change; the developer decides. An item another change in flight takes is named with that change.
Every item ends taken, partial or excluded, and every one not taken carries the developer's
reason; the tracker's own exclusions (a suspended or closed issue) arrive excluded with theirs.

**Each taken or partial item is checked before the branch, by one read-only agent.**

`scope.mjs check-input` writes each item's input and prompt, its comments included. Dispatch each
one under its `name`, `scope-check <KEY>`, at its `agent`, in parallel, sending its prompt file as
it is; the prompt states what the agent does. `scope.mjs check` checks the reply; a refused reply
goes back once to the same agent with its errors, and a second refusal puts the item to the
developer. Then put every question of every item to the developer in one message, each with what
was checked and what it needs, and record the answers and the verdict with `scope.mjs answer`.
An obsolete item leaves the scope with its reason. A bug that does not reproduce is not closed:
`scope.mjs retest` sends it back to its tester through the tracker, and it leaves the scope.

**The developer confirms the branch name.**

`workspace.mjs suggest` proposes `<type>/<change>`, or `<type>/<KEY>/<change>` when the scope
takes a tracker issue: the key of the lowest rank, read from the scope by script. On a tie
(`keyChoices`), ask which key names the branch and suggest again with `--key`. When it has no
type, ask which type applies. Show the name and wait for an explicit answer; the developer may
edit it. Do NOT validate a confirmed name with a regular expression: a confirmed name is a
decision, and convention compliance is the developer's responsibility. No branch operation
happens without that answer. The worktree path stays per change name.

**Every tracker write holds for the developer's yes.**

`scope.mjs start` (after `propose.mjs create`, so the branch and the worktree exist) and
`scope.mjs retest` first return the plan as `pending`, with its preview in `report`. Show the
preview and run the same command with `--yes` only on the developer's explicit yes. A failed
apply resumes when the same command runs again with `--yes`. With no tracker plugin, or a tracker
skipped for the change, each says so and sends nothing.

**The scope record is committed with the artifacts.**

`propose.mjs create` copies the scope into the change as `scope.json` when it holds an item or a
skipped tracker. After the proposal is written, `scope.mjs render` writes its `## Scope sources`
section from that record, and the proposal's `scope-sources` gate refuses any other text there:
change the scope through `scope.mjs`, then render again. Neither `scope.json` nor the section is
edited by hand.

**Uncommitted tracked work stops the proposal.**

The preflight refuses it. Show `git status` in full and ask the developer to deal with it. Never
run `git stash`, never commit on their behalf, and never pass `--force` to anything: uncommitted
work is theirs to decide about.

**Every later step runs in the worktree.**

Pass the worktree root as `--root` to every core script. The propose session is recorded in the
change's ledger by script, once per session: by `propose.mjs create` for a new change, by
`changes.mjs next` for one continued; never record it by hand. Install nothing at propose. The change
holds only markdown until apply; whether and how the worktree is provisioned is decided there.

**Each artifact's gates bind it.**

`schema.json` declares the gates of an artifact; `changes.mjs done` runs them, `next` refuses a
later artifact while a written one fails them, and `propose.mjs commit` runs them all again. A
gate's findings are yours to fix in the artifact, never to argue past. The `specs` gates validate
this change's specs only, the proposal's capabilities against the spec folders, and each delta
against the main spec archive will apply it to. The last of them, `specs-base`, also writes
`specs-base.json` beside the deltas: the main-spec text of every requirement they modify, remove
or rename, which archive's three-way check reads as the base. `propose.mjs commit` commits it
with the artifacts; write and edit it never by hand. A requirement's `SHALL` or `MUST` MUST be
on the first line of its body: the validator does not scan past it.

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
request into the change's base; the title's type comes from the branch prefix, and the forge
marks the draft itself. A branch the developer named without a Conventional Commits type prefix
gives `--summary` no type: `forge.mjs` refuses it and asks for the title in full, `--title
"<type>(<scope>): <description>"`, which you agree with the developer. `forge.mjs` renders its
own `report`; never render the forge's JSON yourself. With no forge plugin enabled nothing is
pushed and the report says that no merge request exists. A degraded forge (its tool missing or
not logged in) does not stop the proposal: the report carries its `hint` and `fallback`
commands, and no merge request is claimed. A refusal is reported as it is; the committed
artifacts stay.
