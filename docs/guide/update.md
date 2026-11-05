<!-- sources:
- plugins/adf/skills/update/**
- plugins/adf/scripts/update.mjs
- plugins/adf/scripts/lib/update.mjs
- plugins/adf/scripts/lib/host-merge.mjs
- plugins/adf/hooks/hooks.json
-->

# /adf:update

`/adf:update` moves a project to a newer ADF release. It makes one branch and one merge request. It never merges the request. You merge it. The Codex form of each command is in [the Codex page](getting-started/codex.md).

## What it does

`/adf:update` takes the latest release tag, or the tag that you give with `--to <tag>`. It works only in a project that pins a release tag in `.claude/settings.json`, or on a user-scope install. See [Install in Claude Code](getting-started/claude-code.md#declare-the-marketplace).

First it runs `update.mjs check`. The result of `check` decides the path:

| Situation | What the command does |
|---|---|
| The project pins a release, and the installed release is older than the pin | It pulls the pinned release, tells you to restart the session, and stops. |
| The project pins a release, and a newer release exists (or you gave `--to`) | It plans and makes the update. |
| The project pins a release, and it is the latest | It says so and stops. |
| A user-scope install is on the latest release | It says so and stops. |
| The project pins no release tag | It tells you that it updates a project that pins a tag, or a user-scope install, and stops. |
| A user-scope install is behind the latest release | It pulls the latest release, tells you to restart the session, and stops. The global marketplace record does not move. |

## The steps of an update

1. `plan` clones the repository at the pinned tag and at the new tag. It reads the project at the tip of the integration branch, not at your working tree. It writes nothing in the project.
2. The command shows the plan. You answer whether to go on.
3. For each host file that you edited, the command asks how to merge it.
4. `apply` makes the branch `chore/adf-update-<version>` in its own worktree. It writes the files. It commits them with the message `chore(adf): update to v<version>` when no merge conflict and no manual file remains. Otherwise `update.mjs commit` makes the commit after you finish those files.
5. The command opens a draft merge request, writes its description, and finalizes it. Without a forge plugin, it tells you that the branch is yours to push and merge.
6. The command removes its temporary clones.

`apply` refuses when the integration branch moved since `plan`. Run `/adf:update` again in that case.

The plan shows the plugin versions, the commit subjects of each plugin, the dropped plugins and the host files. It also lists the changes that are in flight. They continue on the new release.

## What changes in the project

The update branch holds these changes:

| What | Change |
|---|---|
| `.claude/settings.json` | The `ref` of the marketplace is the new tag. |
| `.claude/adf-extensions.json` | `contract` is the contract version of the new release. The `version` of each changed entry is its new version. The config migrations of the plugins run, in version order. See [the registry](concepts/registry.md). |
| Host files | The templates of the new release are merged, by the table below. |

The plan lists a plugin that the new release no longer ships as dropped. Its registry entry stays as it is.

The command refuses an update that changes the major version of the extension contract. Every plugin must move to the new contract first.

### The host files

The host files are `openspec/planning.md`, the review prompt, and the `hostFiles` of each enabled plugin of the package. See [Host files](concepts/host-files.md). The plan sorts each file into a class:

| Class | What happens |
|---|---|
| `replace`, `new` | The file takes the new template. |
| `edited` | You choose how to merge it. |
| `same`, `kept`, `absent` | The file stays as it is. |

For an `edited` file, the command shows the old template, your file and the new template. You choose one of these:

- **Keep everything.** The changes of the template come into your file, and your edits stay.
- **Replace from the update.** The file becomes the new template.
- **Manual.** The command leaves the file for you.

These sections of `openspec/planning.md` hold values that the flow writes: the whole-suite command, the worktree copies, the worktree preparation, the format command and the affected tests command. Every choice keeps them.

The pages under `.claude/memory/` are the project's own content. *Replace from the update* empties them. The command warns you before it asks.

A merge conflict in *Keep everything* goes to the agent. It keeps your edits and carries the changes of the template. It shows you the result.

## The notice at the session start

A `SessionStart` hook runs `update.mjs notice`. It asks the remote once a day. It prints these messages, or nothing:

- `This project pins ADF v<ref>; v<installed> is installed. Run /adf:update to install it.`
- `ADF v<latest> is available; this project is on v<ref>. Run /adf:update.`
- `ADF v<latest> is available; v<installed> is installed. Run /adf:update.` (a user-scope install)

A project install can print the first two lines together. The pin line comes first.

Any error in the hook prints nothing.

## A CI job that adds the tracker link

Some projects have a CI job that adds a tracker link to the merge request description. The flow now writes the links of the scope itself, so this job is not needed.

1. Find the job in the CI configuration of the project.
2. Remove the job, its stage and its script in the update merge request.

The job that the origin of the flow used skips a key that is already in the description. Both can run during the transition. For a merge request opened after the update, the description shows the key once. A merge request opened before the update can show the key twice: once from the CI line outside the block of the change, and once in the links. Not checked: the behaviour of a job that your project wrote itself. Check that your job also skips a key that is already present.

## After the merge request

1. Pull the integration branch into the main checkout.
2. Remove the update worktree: `git worktree remove <worktree>`.
3. Delete the update branch: `git branch -d <branch>`.
4. Restart the Claude Code session.
5. When the session start says the pinned release is not installed, run `/adf:update`.

Each teammate runs `/adf:update` once after the merge. See [What a teammate does](projects/team.md).

## A half-finished update

`plan` and `apply` refuse when the update branch or its worktree exists. The command then offers two ways:

- Finish the update. Resolve the files, run `update.mjs commit`, and open the merge request.
- Start over, on your yes. The command removes the worktree and the branch, and you run `/adf:update` again.

The refusals are listed in [Troubleshooting](troubleshooting.md).
