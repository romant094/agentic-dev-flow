# english-check

A Claude Code plugin that stops an agent's `git commit` when a file in scope that the commit
takes holds non-English text.

## What it checks

A line is non-English when it holds a character from one of four ranges: Cyrillic
(U+0400-U+04FF), CJK punctuation (U+3000-U+303F), CJK ideographs (U+4E00-U+9FFF) and fullwidth
forms (U+FF00-U+FFEF). Em dashes, arrows, typographic quotes, Latin diacritics, Greek, kana and
Hangul pass. Every offending line is reported, with its 1-based line number and its whole text.

## When it runs

The plugin ships one `PreToolUse` hook with the matcher `Bash`. It runs before every Bash call
of every agent in the session, subagents included, and does nothing unless the command runs
`git commit`. It recognises `git commit`, `git -C <dir> commit`, environment prefixes such as
`LEFTHOOK=0 git commit`, `cd <dir> && git commit`, and commits chained with `&&`, `||` or `;`.

The files it checks are those the commit takes:

- the staged added, copied, modified or renamed files;
- also the modified tracked files and the untracked files git does not ignore, when the same
  command line runs `git add` or the commit uses `-a` or `--all`. The hook runs before the
  command, so a `git add` on the same line has not staged anything yet.

A deleted file, or a file that cannot be read, is never a finding. The working-tree text of each
file is read.

On a finding the hook exits 2: Claude Code blocks the Bash call and gives the agent one
`path:line: text` line per finding and the instruction to rewrite those lines in English and run
the command again. With no finding it exits 0 and prints nothing. If the check itself fails (for
example, a malformed registry), it exits 1: Claude Code shows a hook error, the commit runs, and
the message says the commit was not checked.

## Configuration

The scope comes from the host's ADF registry, `.claude/adf-extensions.json` at the repository
root: the entry `{"plugin": "english-check@agentic-dev-flow", "config": {...}}`, or a `path`
entry whose directory holds this plugin's `adf-extension.json`. `/adf:add` can write it.

| Key | Meaning | Default |
|---|---|---|
| `include` | globs of repository-relative paths in scope | `openspec/changes/**`, `openspec/specs/**` |
| `exclude` | globs taken out of scope; an exclusion wins over an inclusion | `openspec/changes/**/plan.md` |
| `extensions` | file extensions read, without the dot | `md`, `mjs`, `yaml`, `yml`, `json` |

A key the configuration sets replaces that default; a key it does not set keeps it. In a glob,
`**` spans directories (`a/**/b` also matches `a/b`), and `*` and `?` stay inside one path
segment. The default exclusion exempts a change's `plan.md`, also after it is archived under
`openspec/changes/archive/<date>-<name>/`: a plan quotes code and fixtures verbatim.

## Limits

- The check exists only where this plugin is enabled in Claude Code. A commit made by hand,
  outside Claude Code, is not checked, and the plugin installs no git hook.
- The hook reads the command line, not what the shell will do: a commit hidden in a script or an
  alias is not seen.
- A file staged partly is checked as it is in the working tree.

## Tests

```
node --test plugins/english-check/scripts/__tests__/*.spec.mjs
```
