<!-- sources:
- plugins/adf/scripts/lib/preflight.mjs
- plugins/adf/scripts/lib/commit.mjs
- plugins/adf/scripts/lib/superpowers.mjs
- plugins/adf/scripts/lib/installed.mjs
- plugins/adf/scripts/lib/registry.mjs
- plugins/adf/scripts/lib/branches.mjs
- plugins/adf/scripts/lib/workspace.mjs
- plugins/adf/scripts/lib/init.mjs
- plugins/adf/scripts/lib/propose.mjs
- plugins/adf/scripts/lib/changes.mjs
- plugins/adf/scripts/lib/update.mjs
-->

# Troubleshooting

A refusal is a stop that changes nothing, or nothing that you must undo. A script prints one JSON object and exits with code 1. The skill shows its `refusal` or `error` field to you. This page quotes each message as the code prints it. A word in angle brackets, such as `<change>`, stands for a value that the message names. The Codex form of each command is in [the Codex page](getting-started/codex.md).

## Before any phase

| Message | Cause | What to do |
|---|---|---|
| ``superpowers@claude-plugins-official is not installed for this project; install it with `claude plugin install superpowers@claude-plugins-official` and run again, and create or modify nothing until then.`` | The Superpowers plugin is missing. | Run the command in the message, then run the phase again. In Codex, the message names `codex plugin add superpowers@claude-plugins-official`. |
| `superpowers@claude-plugins-official is recorded but no install path exists on disk` | The install record points to a missing directory. The same ending as above follows. | Install the plugin again. |
| `superpowers@claude-plugins-official is installed but disabled` | The plugin is off in the settings. The same ending as above follows. | Enable the plugin in your Claude Code settings. |
| `change name "<name>" is not kebab-case; pass the resolved change name, never a placeholder.` | The change name has capitals, spaces or other characters. | Use lowercase words joined with hyphens. |

## `/adf:init`

| Message | Cause | What to do |
|---|---|---|
| `<paths> is not a path inside the project` | A path for `## Worktree copies` is absolute, climbs out with `..`, or holds a backtick. | Give a path relative to the project. |
| `.claude/adf-extensions.json sets no branches; run /adf:init` | The registry has no `branches` key. Other commands print this when they need the branch policy. | Run `/adf:init`, and answer the question about the integration branch. |

## `/adf:add` and `/adf:remove`

| Message | Cause | What to do |
|---|---|---|
| `this project has no ADF registry; run /adf:init first` | `.claude/adf-extensions.json` does not exist. | Run `/adf:init`. |
| ``<id> is not installed for this project; run: claude plugin install <id> --scope project; run it from <main>`` | The plugin has no install for this project. `<main>` is the main checkout of the project. | Run the command from `<main>`, then run `/adf:add` again. |
| `<id> is installed but disabled` | The plugin is off in the settings. | Enable the plugin, then run `/adf:add` again. |
| `<target> is already enabled` | The plugin is already in the registry. | Give a configuration to replace the current one. Otherwise nothing is needed. |
| `a plugin named <name> is already enabled (<entry>)` | Another entry has the same plugin name. | Remove the other entry first. |
| `the role <point> is already provided by <name>; remove it first` | A role has at most one provider. | Run `/adf:remove` for the other provider, then add this one. |
| `<name> needs contract <x>; this core runs <y>` | The plugin was written for a contract that the core does not run. The majors differ, or the plugin's minor is higher. | Update the core, or use another release of the plugin. See [the registry](concepts/registry.md). |
| `<entry>: no adf-extension.json` | The plugin directory has no declaration. | Check the path of the entry. |
| `<target> is not enabled` | `/adf:remove` found no such entry. | Check the plugin name or id. |

## `/adf:propose`

| Message | Cause | What to do |
|---|---|---|
| `<root> is not the main checkout; run propose from <main>, where change worktrees are made.` | You ran the command inside a worktree. | Run `/adf:propose` in the main checkout. |
| `<n> tracked file(s) have uncommitted changes; show git status to the developer and let them deal with it, never stash or commit for them.` | The main checkout has uncommitted changes to tracked files. | Commit or discard the changes yourself. Untracked files do not block. |
| `<branch> is protected; a change never works on it` | The branch name is in the protected list. | Choose another branch name. |
| `uncommitted changes to tracked files:` | The same as the line above, found when the worktree is made. A list of files follows. | Commit or discard the changes. |
| `<path> already exists` | The worktree path of the change is in use. | Choose another change name, or remove the old worktree. |
| `branch <branch> already exists` | The change branch exists. | Choose another branch name. |
| `.claude/worktrees/ is not ignored by git; run /adf:init` | The `.gitignore` line is missing. | Run `/adf:init`, and commit the line. |
| `HEAD is detached; there is no current branch to fork from` | You chose your current branch as the base, and no branch is checked out. | Check out a branch, or choose the integration branch. |
| `<branch> is protected; fork from the integration branch` | You chose a protected branch as the base. | Choose the integration branch. |
| `<id> has no output at openspec/changes/<change>/<file>; write it first` | An artifact is marked done and its file is missing. | Write the file. |
| `<id> fails its gate(s) <gates>; fix it, then run <command>` | An artifact fails a check. | Fix the artifact, then run the command in the message. |
| `<ids> is not done; run changes.mjs next` | The commit of the propose stage found an artifact that is not done. | Run `/adf:propose <change>` to continue. |
| `gate(s) fail: <artifact>/<gate>; nothing was committed` | A check of an artifact fails at the commit. | Fix the artifact, then run `/adf:propose <change>` again. |

## `/adf:apply`

| Message | Cause | What to do |
|---|---|---|
| `<root> holds no change "<change>"; select the change and its root from changes.mjs find.` | The change does not exist in that checkout. | Check the change name. |
| `<root> is the main checkout; a change works only in its own worktree, so pick that worktree from changes.mjs find or make one with /adf:propose.` | The command ran in the main checkout. | Run it for the change worktree. |
| `HEAD is detached; check out the change branch in the worktree.` | The worktree has no branch checked out. | Check out the change branch. |
| `<branch> is protected and nothing is committed to it directly; work on the change branch /adf:propose made.` | The worktree is on a protected branch. | Check out the change branch. |
| `the registry sets no branch policy, so the protected branches are unknown; run /adf:init.` | The registry has no `branches` key. | Run `/adf:init`. |
| `Cannot apply this change yet. Missing artifacts: <ids>. Create them first. Run /adf:propose <change> to continue its artifacts up to the plan.` | An artifact that apply needs is not done. | Run `/adf:propose <change>`. |
| `The plan names <n> thing(s) the tree does not hold; correct plan.md from planFindings, then run apply again.` | `plan.md` names a file or symbol that the tree does not hold. | Correct `plan.md`, then run `/adf:apply` again. |
| `Every task is complete; run /adf:verify next.` | No task is left. | Run `/adf:verify`. |
| ``Every task is complete and openspec/changes/<change>/verify.md says Verdict: FAIL; open an apply round for the fix with plan.mjs reopen --change <change> --title "<the fix>" --task-file <file>, then run apply again.`` | Verify failed, and the plan has no open task. | Run `plan.mjs reopen` as the message says. |

## `/adf:verify`, `/adf:review` and `/adf:archive`

The same preflight checks run for these stages. It also prints these messages:

| Message | Cause | What to do |
|---|---|---|
| `<stage> needs <ids> done first; run <command> to write it.` | A record that the stage reads is missing. | Run the command in the message. |
| `openspec/changes/<change>/verify.md says Verdict: FAIL; fix what it names and run /adf:verify <change> before the review.` | The verify record has a failing verdict. | Fix what `verify.md` names, then run `/adf:verify`. |
| `openspec/changes/<change>/verify.md has no Verdict: line; run /adf:verify <change> again.` | The record is incomplete. | Run `/adf:verify` again. |
| `openspec/changes/<change>/verify.md is not committed; run /adf:verify <change> to assemble and commit it.` | The record is not in a commit. | Run `/adf:verify`. |
| `commit(s) <shas> after the verify record touch files outside openspec/changes/<change>/: the code changed since it was verified; run /adf:verify <change> again.` | The code changed after verify. | Run `/adf:verify` again. |
| `archive needs review done first; run /adf:review <change> to write it.` | `review.md` is not done. | Run `/adf:review`. |
| `archive needs review done first; run /adf:quick <change> to write it.` | A quick change has no `review.md`. | Run `/adf:quick` with the change name. |
| `uncommitted files outside openspec/changes/<change>/: <files>; archive commits only what it writes, so the developer commits, moves or discards them first.` | The worktree holds other uncommitted files. | Commit, move or discard them. |

## `/adf:update`

The skill shows the `error` field of the script. In these messages, `<base>` is the integration branch, written `origin/<branch>` when the project has a remote. See [/adf:update](update.md).

| Message | Cause | What to do |
|---|---|---|
| `.claude/settings.json has uncommitted changes; commit or revert them first` | The pull step restores this file afterwards, so it must be clean. | Commit or revert the changes, then run `/adf:update` again. |
| `claude <arguments> failed: <error of the command>` | A `claude plugin` call of the pull step failed. | Fix the cause that the error names, then run `/adf:update` again. |
| `after the pull ADF v<installed> installed for this project, older than the pinned <ref>; run claude plugin update adf@agentic-dev-flow --scope project and check its output` | The install is still older than the pin. When no install exists, the text reads `ADF is not installed for this project`. | Run the command in the message. |
| `<base>:.claude/settings.json declares no agentic-dev-flow marketplace` | The integration branch does not declare the marketplace. | Declare it. See [Install in Claude Code](getting-started/claude-code.md). |
| `<base> has no .claude/adf-extensions.json; run /adf:init` | The integration branch has no registry. | Merge the setup into the integration branch first. |
| `<base>:.claude/settings.json pins no release of agentic-dev-flow (ref: <ref>); pin a tag v<x.y.z> first` | The `ref` is a branch, or is missing. | Pin a release tag. |
| `<base>:.claude/settings.json declares no url for the agentic-dev-flow marketplace` | The marketplace source has no URL. | Add the `url` to the source. |
| `<url> has no release tag v<x.y.z>` | The repository has no release tag. | Give a tag with `--to`. |
| `the update to <tag> cannot start: <reasons>` | The reasons are `the main directory has uncommitted changes to tracked files:` with a file list, `branch chore/adf-update-<version> already exists`, or `<path> already exists`. | Commit or discard the changes. For the other two reasons, see "A half-finished update" in [/adf:update](update.md). |
| `cannot clone <url> at <ref> and <tag>: <git error>` | Git cannot reach the repository or one of the tags. | Check the network and the tag. |
| `the update to v<version> is refused: <reason>` | The reason is a major change of the contract, or an invalid `contract` in the registry. See the next two rows. | Read the reason. |
| `the update moves the extension contract from <a> to <b>, a major change; every plugin must move to contract <b> first` | The reason of the row above. | Move every plugin to contract `<b>`, then run `/adf:update` again. |
| `.claude/adf-extensions.json has no valid "contract" field (<value>); set it to the contract version the project runs` | The reason of the row above, for a registry with a bad `contract`. | Set `contract` to the `version` in `plugins/adf/contract/contract.json`, a `major.minor` value. See [the registry](concepts/registry.md). |
| `the integration branch moved since plan (<base> is <commit>, plan read <commit>); run plan again` | A commit reached the integration branch after the plan. | Run `/adf:update` again. |
| `<dir> is not at <tag>; run plan again` | The clone is not at the target tag. | Run `/adf:update` again. |
| `no choice for <files>: each edited host file needs keep, replace or manual` | The command did not get a choice for an edited file. | Answer the merge question for each file. |
| `cannot make the update branch: <reason>` | Git refused to make the branch or the worktree. | Fix the reason. |
| `<worktree> holds no .adf/update-<version>.json; run apply first` | `update.mjs commit` ran in a worktree that `apply` did not make. | Run `/adf:update`. |
| `<files> still hold conflict markers; resolve them, then commit again` | A merge conflict is open in these files. | Resolve the conflict, then commit again. |
| `nothing to commit in <worktree>: the update's files are already committed or unchanged` | The update is already committed. This is not a failure. | Go on to the merge request. |
| `<directory> is not a temporary directory plan made; remove it yourself` | The cleanup step refuses a directory that `plan` did not make. | Remove the directory yourself, if you know it is safe. |
