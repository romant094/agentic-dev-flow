<!-- sources:
- plugins/adf-english-check/scripts/*.mjs
- plugins/adf-english-check/scripts/lib/*.mjs
- plugins/adf-english-check/adf-extension.json
- plugins/adf-english-check/hooks/**
-->

# `adf-english-check`

`adf-english-check` stops an agent's `git commit` when a file in scope that the commit takes holds non-English text. It provides no contract point. It is an agent hook: see [the agents' own hooks](../extension-points/agent-hooks.md).

## What it does

A line is non-English when it holds a character from one of four ranges:

| Range | Code points |
|---|---|
| Cyrillic | U+0400-U+04FF |
| CJK punctuation | U+3000-U+303F |
| CJK ideographs | U+4E00-U+9FFF |
| Fullwidth forms | U+FF00-U+FFEF |

Em dashes, arrows, typographic quotes, Latin diacritics, Greek, kana and Hangul pass. The hook reports every offending line, with its 1-based line number and its whole text.

## Install and enable

1. Install the plugin by id. A registry `path` entry does not load the hook.
2. Enable it in the registry.

```
claude plugin install adf-english-check@agentic-dev-flow --scope project
/adf:add adf-english-check@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md). In Codex, trust the hook in `/hooks`.

The registry entry also enables the check. A repository with no registry, or with no entry for this plugin, is not checked. The hook exits 0 and prints nothing, although the plugin is installed. An entry with no `config` checks the defaults below.

## Configure

The `config` object of the entry in `.claude/adf-extensions.json`:

| Key | Meaning | Default |
|---|---|---|
| `include` | globs of repository-relative paths in scope | `openspec/changes/**`, `openspec/specs/**` |
| `exclude` | globs taken out of scope; an exclusion wins over an inclusion | `openspec/changes/**/plan.md` |
| `extensions` | file extensions read, without the dot | `md`, `mjs`, `yaml`, `yml`, `json` |

A key the configuration sets replaces that default; a key it does not set keeps it. In a glob, `**` spans directories, and `a/**/b` also matches `a/b`. The characters `*` and `?` stay inside one path segment.

The default exclusion exempts a change's `plan.md`, also after archive moves it under `openspec/changes/archive/<date>-<name>/`. A plan quotes code and fixtures verbatim.

## When the hook runs

The plugin ships one `PreToolUse` hook with the matcher `Bash`. It runs before every Bash call of every agent in the session, subagents included. It does nothing unless the command runs `git commit` in a repository whose registry enables this plugin.

The hook recognises these forms:

- `git commit`
- `git -C <dir> commit`
- an environment prefix, such as `LEFTHOOK=0 git commit`
- `cd <dir> && git commit`
- commits chained with `&&`, `||` or `;`

### Which files it checks

The hook checks the files that the commit takes:

- the staged added, copied, modified or renamed files;
- the modified tracked files and the untracked files that git does not ignore, when the same command line runs `git add` or the commit uses `-a` or `--all`.

The hook runs before the command. A `git add` on the same line has staged nothing yet. A deleted file, or a file that cannot be read, is never a finding. The hook reads the working-tree text of each file.

### The commit scripts of the core

Some core scripts run `git commit` themselves, out of the command line's sight. The hook recognises them when you run them with `node <path>/<script>` or directly.

| Script | Commits | Files checked |
|---|---|---|
| `commit.mjs --root <r> --only <path> ... --message <m>` | always | the staged, modified and untracked files under each `--only` path |
| `tasks.mjs tick ... --change <name> --commit` | with `--commit` | `openspec/changes/<name>/tasks.md` and its `plan.md` |
| `propose.mjs commit [--change <name>]` | always | `openspec/changes/<name>/`; without `--change`, every change directory |
| `verify.mjs assemble --change <name> --commit` | with `--commit` | `openspec/changes/<name>/verify.md` |
| `verify.mjs skill-edit ...` | always | `.claude/skills/`, in scope only when the registry includes it; with `--diff-file`, also the lines the diff adds, which are not in the files yet |
| `suite.mjs run --change <name> --record --commit` | with `--commit` | `openspec/changes/<name>/.apply-test-record.md` |
| `suite.mjs set --command <c> --commit` | with `--commit` | `openspec/planning.md` |
| `dup.mjs mark --file <path> ... --commit` | with `--commit` | the `--file` path |
| `review.mjs assemble --change <name> --commit` | with `--commit` | `openspec/changes/<name>/review.md` |
| `review.mjs mark --file <path> ... --commit` | with `--commit` | the `--file` path |
| `plan.mjs added [--change <name>] ... --commit` | with `--commit` | `openspec/changes/<name>/plan.md`; without `--change`, every change directory |
| `archive.mjs commit-specs --change <name>` | always | `openspec/changes/<name>/`, `openspec/changes/archive/` and `openspec/specs/` |
| `archive.mjs commit-memory --change <name>` | always | every uncommitted file; the hook cannot read where the knowledge base and the debt tree are, and archive refuses any uncommitted file there that it did not write |
| `update.mjs commit --worktree <w> --to <tag>` | always | the `written` and `manual` files of the record `<w>/.adf/update-<version>.json`, under `<w>` |
| `update.mjs apply ...` | with no conflict and no manual file | none: it commits the release's templates and text merged from files already checked, and writes them only after the hook runs |

Paths resolve against `--root`, or against the directory of the command when `--root` is absent. For `update.mjs commit`, they resolve against `--worktree`.

The list is `CORE_COMMIT_SCRIPTS` in `scripts/lib/english.mjs`. A future core script that commits must be added there, or its commits go unchecked. `tasks.mjs` reads its tasks file name from the schema of the core. The hook assumes the default, `tasks.md`.

## What you see

| Exit code | Meaning |
|---|---|
| 0 | No finding, or the command is not a commit. The hook prints nothing. |
| 2 | Claude Code blocks the Bash call. The agent gets one `path:line: text` line for each finding, and the instruction to rewrite those lines in English and run the command again. |
| 1 | The check failed, for example on a malformed registry. Claude Code shows a hook error and the commit runs. The message says the commit was not checked. |

## Limits

- The check exists only where this plugin is enabled in Claude Code and in the repository's registry. A commit made by hand, outside Claude Code, is not checked. The plugin installs no git hook.
- The hook reads the command line, not what the shell will do. A commit hidden in a script or an alias is not seen. The commit scripts of the core above are the exception.
- A file that is staged in part is checked as it is in the working tree.

## Points it provides

None. The plugin provides no contract point. Its hook is described in [the agents' own hooks](../extension-points/agent-hooks.md).
