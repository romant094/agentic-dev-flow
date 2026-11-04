---
name: update
description: Update this project's ADF to the latest release, or to a given tag, in one merge request that pins the new release, migrates the registry and merges the host files. Triggers on "update ADF", "update the flow", "upgrade adf". Triggers may be phrased in any language.
argument-hint: [--to <tag>]
---
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.


Update the project's ADF package to the latest release, or to the tag given with `--to`. The
update is one branch, `chore/adf-update-<version>`, in its own worktree, and one merge request.
Never merge it: the developer merges it.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" where` and show its `warning` when it
   is not null.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" check
   ```

   On exit code 1, show `error` and stop. Then, by `scope`:
   - `project` with `pull` true: the installed release is older than the one the project pins.
     Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" pull`. Show what it ran and `installed`
     against `ref`, or its `error` (it names both versions when the install is still older).
     Tell the developer to restart the session so the pinned release loads, and stop. In Codex
     `pull` runs `codex plugin marketplace upgrade` and `codex plugin add <id>` (first moving the
     user's marketplace record to the pinned ref), and the user's record is the only one Codex
     has: say that it now follows this project's ref;
   - `user` with `behind` true: this is a user-scope install outside a project that pins a
     release. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" pull --scope user`, and show
     `installed` against `latest` (or its `error`). Say that the global marketplace record is
     not moved: a user marketplace pinned to a ref stays on that ref. Tell the developer to
     restart the session, and stop;
   - `user` with `behind` false: say the install is on the latest release, and stop;
   - `none`, or `project` with `pinned` false: tell the developer this command updates a project
     that pins a release tag, or a user-scope install, and stop;
   - `project` with `behind` false and no `--to` given: say the project is on the latest
     release, and stop.

3. Run, with `--to <tag>` only when the developer gave one:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" plan --to <tag>
   ```

   On exit code 1, show `error` and stop; plan left no clones. It refuses before cloning when
   the main directory has uncommitted changes to tracked files, or the branch
   `chore/adf-update-<version>` or its worktree exists (a half-finished run: see "Resume" below).
   When `upToDate` is true, say the project already is on `from`, and stop. Keep `clones`,
   `baseCommit` and `hostFiles`: later steps need them. From here on, every stop first removes
   the clones (step 10).

   `plan` reads the project at `baseCommit`, the tip of `base`, the integration branch the
   update branch forks from (`origin/<integration>` when the project has a remote), not the
   main directory. `apply` refuses when that branch moved since, so what step 5 shows is what
   `apply` merges.

4. Show the plan:
   - `from` → `to`, read at `base`;
   - each plugin of `plugins` with `changed`: its versions, and its subjects from `log` (the key
     is the plugin's name, `adf` for the core);
   - the dropped plugins, those with `to: null`: the new release no longer ships them, and their
     registry entries stay as they are;
   - the host files by `class`: `replace` and `new` take the new template, `edited` needs the
     developer's choice, `same`, `kept` and `absent` stay as they are. In
     `openspec/planning.md` the sections the flow's scripts write (whole-suite command, worktree
     copies, worktree preparation, format command) are values: they never count as edits, and
     every choice keeps them;
   - when `contract.compatible` is false: the update is refused for `contract.reason`. Say so,
     remove the clones (step 10) and stop;
   - each change of `inFlight`, with a warning: it continues on the new release, and a conflict
     is settled inside its own change.

   Ask the developer whether to go on. On a no, remove the clones (step 10) and stop.

5. For each host file with class `edited`, show its three versions: the old release's template
   (`<clones.old>/<template path>`), the project's file at `baseCommit` (`git show
   <baseCommit>:<path>`, not the main directory's copy), and the new release's template
   (`<clones.new>/<template path>`). The core's templates are `plugins/adf/host/planning.md` for
   `openspec/planning.md` and `plugins/adf/host/review-prompt.md` for the review prompt; a
   plugin's are the `hostFiles` of `plugins/<name>/adf-extension.json`. Ask "How to merge?":
   - **automatic**, then a second question: *Keep everything* (choice `keep`: the template's
     changes are carried into the project's file, the project's edits stay) or *Replace from the
     update* (choice `replace`: the file becomes the new template; the sections of
     `openspec/planning.md` the flow's scripts write are kept);
   - **manual** (choice `manual`): the file is left as it is, for the developer.

   For a file under `.claude/memory/` (the knowledge plugin's seed pages, which the project
   fills in), warn before the question: *Replace from the update* empties the project's
   content. Recommend *Keep everything* or manual.

6. Run the new release's code, from the new clone, with plan's `baseCommit` and the choices as
   one JSON object of path to choice:

   ```bash
   node "<clones.new>/plugins/adf/scripts/update.mjs" apply --to <to> --clones '<clones as JSON>' --base <baseCommit> --choices '<choices as JSON>'
   ```

   `apply` classifies the host files with the new release's code. On exit code 1:
   - when `error` starts with `no choice for`, nothing was written: ask "How to merge?" (step 5)
     for each file it names, and run `apply` again with every choice;
   - on any other `error`, show it, remove the clones (step 10) and stop. Most refusals come
     before any write: the integration branch moved since plan (run `/adf:update` again), a
     contract refusal, uncommitted changes to tracked files in the main directory, an update
     branch or worktree that already exists. When the error comes after the branch was made, the
     branch and its worktree stay: see "Resume" below.

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
   and `protected` with the integration branch added to it. The update branch has no change
   metadata, so pass no `--change`. `<version>` is `to` without its `v`. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --root <worktree> --input '{"change":"adf-update-<version>","branch":"<branch>","base":"<integration>","title":"chore(adf): update to v<version>","protected":[<protected>],"draft":true}'
   ```

   Show its `report` as it is. When `state` is `none`, no forge plugin is enabled: tell the
   developer the branch `<branch>` in `<worktree>` is theirs to push and merge, and go to step 8.
   On `refused`, the commit stays; show `error` and go to step 8.

   Otherwise write the description into the merge request. The forge refuses a description
   that lacks a section of the project's merge request template, or leaves one empty. Read the
   template the forge plugin copied into the project (the `to` of its `hostFiles` in its
   `adf-extension.json`, for adf-gitlab `.gitlab/merge_request_templates/adf.md`) and fill every
   `## ` section it has, without its `<!-- ... -->` comment lines:
   - `## What`: `from` → `to`, each changed plugin's versions with its `log` subjects, and the
     dropped plugins;
   - `## Why`: the project moves to ADF release `to`, so the team runs the fixes and
     improvements listed above;
   - `## QA`: numbered steps: merge, restart the Claude Code session, run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" check` and see `ref` is `to`, `pull` is
     false and `installed` equals `to` without its `v` (on a session-start notice to install the
     pinned release, run `/adf:update` first);
   - any other section of the template: fill it from the same facts.

   Run `finalize` with the same input, `"body":"<description>"` in place of `"draft":true`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" finalize --root <worktree> --input '<input>'
   ```

   Show its `report` as it is. On `refused`, show `error`, and tell the developer the merge
   request stays a Draft with the branch pushed: they write the description and mark it ready,
   or fix what `error` names and run `finalize` again.

8. Tell the developer what to do after the merge request is merged:
   1. Pull the integration branch into the main directory: `git -C <main directory> pull`.
   2. Remove the update worktree: `git -C <main directory> worktree remove <worktree>`.
   3. Delete the update branch: `git -C <main directory> branch -d <branch>`.
   4. Restart the Claude Code session, so the new release loads. When the session start says the
      pinned release is not installed, run `/adf:update`: it pulls the pinned release.

   The rest of the team gets the new release with the merge, by the same session-start notice.

9. **Resume** a half-finished run (plan or apply names an existing branch or worktree), with
   the developer:
   - when `<worktree>/.adf/update-<version>.json` exists and the branch has no
     `chore(adf): update to v<version>` commit yet, finish it: resolve the files (step 6), run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" commit --worktree <worktree> --to <to>`,
     then open the merge request (step 7). When the commit exists, go to step 7;
   - to start over instead, on the developer's yes: `git -C <main directory> worktree remove
     --force <worktree>` (it drops the worktree's uncommitted files) and `git -C <main directory>
     branch -D <branch>`, then run `/adf:update` again.

10. Remove the temporary clones:

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs" cleanup --clones '<clones as JSON>'
    ```

    It removes the one temporary directory `plan` made for the three clones, and refuses any
    other directory. Never remove the clones with `rm`.
