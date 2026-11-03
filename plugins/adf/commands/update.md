---
description: Update this project's ADF to the latest release, or to a given tag, in one merge request that pins the new release, migrates the registry and merges the host files. Triggers on "update ADF", "update the flow", "upgrade adf". Triggers may be phrased in any language.
argument-hint: [--to <tag>]
---

Update the project's ADF package to the latest release, or to the tag given with `--to`. The
update is one branch, `chore/adf-update-<version>`, in its own worktree, and one merge request.
Never merge it: the developer merges it.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" where` and show its `warning` when it
   is not null.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" check
   ```

   On exit code 1, show `error` and stop. When `pull` is true, the installed release is older
   than the one the project pins: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" pull`,
   show what it ran (or its `error`), tell the developer to restart the session so the pinned
   release loads, and stop. When `scope` is not `project`, or `pinned` is false, tell the
   developer this command updates a project that pins a release tag, and stop. When `behind` is
   false and no `--to` was given, say the project is on the latest release, and stop.

3. Run, with `--to <tag>` only when the developer gave one:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" plan --to <tag>
   ```

   On exit code 1, show `error` and stop; plan left no clones. When `upToDate` is true, say the
   project already is on `from`, and stop. Keep `clones`, `base` and `hostFiles`: later steps
   need them. From here on, every stop first removes the clones (step 9).

   `plan` reads the project at `base`, the tip of the integration branch the update branch forks
   from (`origin/<integration>` when the project has a remote), not the main directory.

4. Show the plan:
   - `from` → `to`, read at `base`;
   - each plugin of `plugins` with `changed`: its versions, and its subjects from `log` (the key
     is the plugin's name, `adf` for the core);
   - the dropped plugins, those with `to: null`: the new release no longer ships them, and their
     registry entries stay as they are;
   - the host files by `class`: `replace` and `new` take the new template, `edited` needs the
     developer's choice, `same`, `kept` and `absent` stay as they are;
   - when `contract.compatible` is false: the update is refused, since the contract moves from
     `contract.from` to `contract.to`, a major change. Say so, remove the clones (step 9) and stop;
   - each change of `inFlight`, with a warning: it continues on the new release, and a conflict
     is settled inside its own change.

   Ask the developer whether to go on. On a no, remove the clones (step 9) and stop.

5. For each host file with class `edited`, show its three versions: the old release's template
   (`<clones.old>/<template path>`), the project's file at `base` (`git show <base>:<path>`, not
   the main directory's copy), and the new release's template
   (`<clones.new>/<template path>`). The core's templates are `plugins/adf/host/planning.md` for
   `openspec/planning.md` and `plugins/adf/host/review-prompt.md` for the review prompt; a
   plugin's are the `hostFiles` of `plugins/<name>/adf-extension.json`. Ask "How to merge?":
   - **automatic**, then a second question: *Keep everything* (choice `keep`: the template's
     changes are carried into the project's file, the project's edits stay) or *Replace from the
     update* (choice `replace`: the file becomes the new template; the sections of
     `openspec/planning.md` the flow's scripts write are kept);
   - **manual** (choice `manual`): the file is left as it is, for the developer.

6. Run the new release's code, from the new clone, with plan's `hostFiles` as `--classes` and the
   choices as one JSON object of path to choice:

   ```bash
   node "<clones.new>/plugins/adf/scripts/update.mjs" apply --to <to> --clones '<clones as JSON>' --classes '<hostFiles as JSON>' --choices '<choices as JSON>'
   ```

   On exit code 1 nothing was written:
   - when `error` starts with `no choice for`, ask "How to merge?" (step 5) for each file it
     names, and run `apply` again with every choice;
   - on any other `error`, show it, remove the clones (step 9) and stop. The usual causes are
     uncommitted changes to tracked files in the main directory, an update branch that already
     exists, a major contract change, or a host file the integration branch changed since
     `plan` (run `/adf:update` again).

   Show `written`, `dropped` and `ran` (the config migrations each plugin ran). When
   `committed` is false (`commitError`, when present, is why apply's own commit failed: show it
   and fix its cause):
   - for each file of `conflicts`, resolve the conflict markers in `<worktree>/<path>` yourself:
     keep the project's edits and carry the template's changes. Show the developer the result;
   - for each file of `manual`, tell the developer to finish `<worktree>/<path>`, and wait until
     they say it is done;
   - then run:

     ```bash
     node "<clones.new>/plugins/adf/scripts/update.mjs" commit --worktree <worktree> --to <to>
     ```

     On exit code 1 with `error` starting `nothing to commit`, the update is committed already:
     go on. On another exit code 1, show `error`, fix what it names, and run it again.

7. Open the merge request. Read `branches` from `.claude/adf-extensions.json`: `integration`,
   and `protected` with the integration branch added to it. Write a description that lists
   `from` → `to`, each changed plugin's versions and its `log` subjects, and the dropped
   plugins. The update branch has no change metadata, so pass no `--change`. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --root <worktree> --input '{"change":"adf-update-<version>","branch":"<branch>","base":"<integration>","title":"chore(adf): update to v<version>","protected":[<protected>],"draft":false}'
   ```

   `<version>` is `to` without its `v`. When `state` is `none`, no forge plugin is enabled: tell
   the developer the branch `<branch>` in `<worktree>` is theirs to push and merge, and go to
   step 8. On `refused`, the commit stays; show `error` and go to step 8. Otherwise write the
   description into the merge request with the same input and `"body":"<description>"` in place
   of `"draft":false`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" finalize --root <worktree> --input '<input>'
   ```

   Show the `report` of each call as it is.

8. Tell the developer to restart the session after the merge request is merged, so the new
   release loads. The rest of the team gets the new release with the merge.

9. Remove the temporary clones:

   ```bash
   git -C <clones.repo> worktree remove <clones.old>
   git -C <clones.repo> worktree remove <clones.new>
   rm -rf "$(dirname <clones.repo>)"
   ```

   The three directories share one temporary parent, which `plan` made.
