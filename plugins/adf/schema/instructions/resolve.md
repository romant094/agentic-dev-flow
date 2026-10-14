How apply, verify and archive decide which change they act on. Each command file carries the
step order and points here; the rules below are stated in full only here.

**Every checkout is read, because no single one is complete.**

A change directory is committed only on its own branch, in its own worktree. The main
checkout, where a session usually starts, rarely holds one. Run, from wherever the session is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find
```

It reads the main checkout and every change worktree of the repository, and lists each active
change with the checkout that holds it (`root`), its branch and its task progress. A task
group's worktree is part of its change and is not listed.

**Only a change directory names a change.**

Take the name from a `changes` entry, never from a branch name: the developer may edit the
branch name at propose, and a name read off a branch may match no change.

**The developer confirms the change, always.**

- The developer named a change: use the entry with that name. If none has it, say so, show the
  list, and stop.
- One entry and no name given: name it and ask the developer to confirm.
- Several entries: show them (name, branch, task progress) and ask which one.
- No entry: say that no change is in flight and stop.

The same name in two checkouts is two copies of one change: show both and ask which root to
use.

**Announce the change and its root before the first call that takes it.**

Say `Using change: <name> in <root>`. From then on, pass `--change <name> --root <root>` to every
core script and run git with `git -C <root>`. Never act on the change from the main checkout.
