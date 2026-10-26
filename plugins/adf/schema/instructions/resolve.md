How apply, verify, review, archive and land decide which change they act on. Each command file
carries the step order and points here; the rules below are stated in full only here.

**The active change answers; the developer is asked only when nothing does.**

Each checkout keeps a local pointer to its active change, `.adf/active.json`, one entry per
branch: in a change worktree, the worktree's own; in stay-on-branch mode, the main checkout's
entry for that branch. It is never global and never committed. Propose writes it when it makes
the change. Run, from wherever the session is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" active [--change <name>]
```

- The developer named a change, in the command's input or in the conversation: pass it as
  `--change`. The script uses that change and points its checkout at it. A pointer that named
  another change is switched, and the switch is recorded in the ledger of the change switched
  to; the old change stays as it is. A name no checkout holds is refused with the list: show
  it and stop.
- No name: the script reads the pointers, else takes the one change in flight. Use the change
  it returns, and do not ask the developer to confirm it.
- `ask` true: no pointer answers and more than one change is in flight, or one name is in two
  checkouts. Show each `choices` entry's `label` as it is and ask which one; then run the
  script again with `--change`. A choice with no name is a worktree whose change directory the
  script could not read: let the developer name the change it holds, and never guess the name
  from the branch.
- `change` null with no `ask`: no change is in flight. Say so and stop.

Land runs after archive removed the worktree, so it passes `--archived`: archive hands the
worktree's pointer to the main checkout, and the script returns the archived change it names
that land has not finished.

**Only a change directory names a change.**

The script reads every checkout of the repository, because a change directory is committed only
on its own branch, in its own worktree. Take the name from the script, never from a branch
name: the developer may edit the branch name at propose, and a name read off a branch may match
no change.

**Announce the change and its root before the first call that takes it.**

Say `Using change: <name> in <root>`. From then on, pass `--change <name> --root <root>` to every
core script and run git with `git -C <root>`. Never act on the change from the main checkout.
