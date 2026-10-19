# English check

Sources read: at origin commit `045c5f4a` — `.claude/scripts/check-english.mjs` (whole, 60
lines) and `.claude/scripts/__tests__/check-english.spec.mjs` (whole, 12 tests);
`.lefthook.json` (the origin has no `lefthook.yml`) and `package.json` (`postinstall: lefthook
install`); `.gitlab-ci.yml` (no job runs the check or the `.claude/scripts` tests);
`.claude/commands/opsx/propose.md:207-232`, `.claude/commands/opsx/review.md:100-120`,
`.claude/commands/opsx/archive.md:484-492`; `openspec/schemas/sdd-plus-superpowers/schema.yaml`
(worktree provisioning 694-712, archive memory ingest 1256-1263);
`openspec/specs/change-workflow-schema/spec.md:72-82`,
`openspec/specs/merge-request-lifecycle/spec.md:73-80`; `openspec/config.yaml:51`;
`.claude/CLAUDE.md` §2 rule 1; `.claude/memory/adf/flow.md:51,112,259`;
`.claude/memory/concepts/tech-stack.md:66-75`; `.claude/memory/adf/adf-deferred-findings.md`
(no English entry); `.claude/scripts/check-opsx-commands.mjs:30-36`; the archived change
`2026-08-04-integrate-superpowers-workflow` (`design.md:112-116,402-405`, `tasks.md` 9.10,
11.4, 11.6); `git log -S'check-english'` (introduced in `5ab014f3`; `.lefthook.json` touched in
`65e763f5` and `73961eb5`, the `english` job unchanged; scope edited in `4b4ec224`; review call
added in `73961eb5`). Skills and commands holding Cyrillic, all out of scope:
`.claude/skills/adf-digest/{SKILL,README}.md`, `.claude/skills/release-changelog/{SKILL,README}.md`,
`.claude/skills/generate-user-guide/references/add-domain-note.md`. Behaviour probed by running
the origin script read-only: a missing path, an absolute path, no arguments, and kana, Hangul
and Latin diacritics. The Claude Code hooks reference (`code.claude.com/docs/en/hooks`, read
2026-10-14): plugin `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`, the `PreToolUse` input
(`cwd`, `tool_name`, `tool_input.command`), exit 2 blocks the call and gives stderr to the
agent, any other non-zero exit is a non-blocking error, and plugin hooks also run in subagents.

| Rule | Why it exists (the incident or the measurement) | Decision | Where it lives now | Evidence |
|---|---|---|---|---|
| The foreign class is exactly four ranges: U+0400-U+04FF (Cyrillic), U+3000-U+303F (CJK punctuation), U+4E00-U+9FFF (CJK ideographs), U+FF00-U+FFEF (fullwidth forms); kana, Hangul, Greek, the Cyrillic supplement and Latin diacritics pass (probed). | The upstream schema shipped in Traditional Chinese and the team writes Russian (`integrate-superpowers-workflow` design item 1); the ranges target those two sources only. | ported — the same four ranges, written as escapes; the parity tool finds no difference. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/lib/english.mjs`: `[\u0400-\u04ff\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]`; `plugins/english-check/scripts/__tests__/english.spec.mjs`: `kana, Hangul, Greek, the Cyrillic supplement and Latin diacritics pass, as in the origin`; `scripts/parity/origin-english.mjs`: `export const ORIGIN_CONFIG = resolveConfig` |
| The check is line-based: each line is tested on its own, line numbers are 1-based, and the whole offending line is echoed. | The author fixes the prose from the report without opening the file. | ported. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/__tests__/english.spec.mjs`: `the line text is echoed whole and line numbers are 1-based` |
| The output is one `<file>:<line>: <text>` line on stdout per finding; exit 0 clean, 1 with findings; no arguments exit 0. | A pre-commit hook reads only the exit code; the text is for the human. | changed — the hook prints one `<path>:<line>: <text>` line per finding on stderr and one line telling the agent to rewrite those lines in English and run the command again, and exits 2, which blocks the Bash call; clean, it exits 0 and prints nothing. | `plugins/english-check/scripts/hook.mjs`; `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/lib/english.mjs`: `Rewrite those lines in English, then run the command again.`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `a clean commit passes silently` |
| A path that cannot be read crashes the script with an uncaught `readFileSync` error and exit 1 (probed); propose passes `git diff --cached --name-only`, which lists staged deletions. | No incident; the propose commit stages only additions today. | changed — the hook takes only added, copied, modified or renamed paths, and a path that cannot be read is skipped, never a finding or a stack trace. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/lib/english.mjs`: `'--diff-filter=ACMR'`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `a staged deletion is never a finding` |
| Scope patterns are anchored, repository-relative regexes; an absolute path, or a path given from a subdirectory, matches none and passes silently (probed). | The script assumes it runs from the repository root, as lefthook does. | changed — the hook finds the repository with `git rev-parse --show-toplevel` in the commit's directory (`cd`, then `-C`, against the call's `cwd`) and matches normalised repository-relative paths. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/lib/english.mjs`: `export function normalizePath`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `git -C relative to cwd, from a subdirectory` |
| An out-of-scope path is skipped without output; the exclusion list is tested before the inclusion list, so an exclusion always wins. | `plan.md` matches the `openspec/changes/` inclusion and must still be exempt. | ported — `exclude` globs win over `include` globs. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/__tests__/english.spec.mjs`: `an exclusion wins over an inclusion`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `a file out of scope is ignored` |
| Scope patterns also restrict by extension: `.md`, `.mjs`, `.yaml` (`openspec/config.yaml`, schemas, changes); lefthook's glob adds `.yml`, which no scope pattern matches. | Only text the flow writes is read; a binary file would be read as UTF-8. | changed — one configurable extension list, default `md`, `mjs`, `yaml`, `yml`, `json`. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/lib/english.mjs`: `extensions: ['md', 'mjs', 'yaml', 'yml', 'json']`; `plugins/english-check/scripts/__tests__/english.spec.mjs`: `a path outside the extension list is out of scope` |
| Scope is a hand-kept path list; moving the script tests into `__tests__/` needed a new pattern and a renamed exclusion (`4b4ec224`), and a removed verification skill stayed named in the scope until review round five (`integrate-superpowers-workflow` design 402-405). | A path list goes stale silently when files move or are deleted. | changed — the default scope is two directory globs of the flow's own records, which no file move inside them makes stale; a host's wider scope is its registry configuration, and its stale globs are its own. | `plugins/english-check/scripts/lib/english.mjs`; host `.claude/adf-extensions.json` | `plugins/english-check/scripts/lib/english.mjs`: `include: ['openspec/changes/**', 'openspec/specs/**']`; `plugins/english-check/README.md`: `A key the configuration sets replaces that default` |
| Among skills only `.claude/skills/openspec-sync-specs/` is in scope; every other skill is out (test "a skill README other than the sync-specs skill is out of scope"). | Five skill files carry functional Russian trigger phrases (`adf-digest`, `release-changelog`, `generate-user-guide`). | changed — no skill is in the default scope; a host includes its own by configuration. The origin keeps `openspec-sync-specs` by configuration at the switch. | host `.claude/adf-extensions.json` | `plugins/english-check/scripts/__tests__/english.spec.mjs`: `one skill can be included while the other skills stay out`; pending: iteration 15 |
| The checker's own test fixture file (`__tests__/check-english.spec.mjs`) is exempt. | The fixtures are foreign text by design. | rejected — the plugin's own tests write foreign text as escapes, and a host never stages them; no exemption is needed. | — | — |
| Importing the module does not run the CLI (`invokedDirectly` guard); its tests prove they can fail (task 9.10). | An import that called `process.exit` killed the test runner. | ported — a library module and a thin hook entry, as in the core. | `plugins/english-check/scripts/lib/english.mjs`; `plugins/english-check/scripts/hook.mjs` | `plugins/english-check/scripts/hook.mjs`: `if (isMain(import.meta.url))`; `plugins/english-check/scripts/lib/main.mjs`: `realpathSync.native(process.argv[1])` |
| The test set: Cyrillic flagged; CJK flagged; em dash, arrow and quotes pass; every line reported; scope cases for a command, a memory page, a skill README, the fixtures, other script tests, `plan.md` before and after archive, an archived proposal. | Each scope decision has a test that fails when it regresses. | changed — the character and plan-exemption tests port as they are; the origin path cases become configuration tests; the hook is tested end to end against real temporary repositories. | `plugins/english-check/scripts/__tests__/` | `plugins/english-check/scripts/__tests__/english.spec.mjs`: `a change plan stays exempt after it is archived`; `plugins/english-check/scripts/__tests__/english.spec.mjs`: `a wiki memory page is out of scope unless included` |
| A lefthook `pre-commit` job runs the check on staged `*.{md,mjs,yaml,yml}` in parallel with format and lint. | It is the only gate for apply's code and artifact commits, where the provisioned worktree has `node_modules` (`schema.yaml:706-712`). | rejected for the plugin — a host's git hook is the host's; the origin keeps its `.lefthook.json`, and the plugin installs no git hook. | host `.lefthook.json` | — |
| (new for the port, proposed in the draft) A CLI that accepts a plain list of paths, so a host's pre-commit hook or CI job can call the check without the core. | Would keep one implementation for the core and the host's own gates. | rejected — the developer settled on one mechanism, the Claude Code hook; no CLI, no contract point and no README snippet for a host gate. | — | — |
| (new) The check runs on every Bash call of every agent, subagents included, and acts only when the command runs `git commit`: plain, with `-C <dir>`, behind `cd <dir> &&`, behind environment assignments such as `LEFTHOOK=0`, or chained with `&&`, `||` or `;`. | The origin's check had two call sites and a git hook that could silently not run; a commit by any agent through any path must meet the same check. | changed — a `PreToolUse` hook with the matcher `Bash` in the plugin; no core call. | `plugins/english-check/hooks/hooks.json`; `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/hooks/hooks.json`: `"matcher": "Bash"`; `plugins/english-check/scripts/__tests__/english.spec.mjs`: `commit detection: plain, env prefix, -C, cd, chains`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `the env prefix and a chain are seen` |
| (new) A `git add` on the same command line, or `-a`/`--all` on the commit, adds the modified tracked files and the untracked files git does not ignore. | The hook runs before the command, so a same-line `git add` has staged nothing yet. | changed. | `plugins/english-check/scripts/lib/english.mjs` | `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `an unstaged change counts only when the line also runs git add`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `-am and --all take the modified tracked files` |
| (new) A check that cannot run (a malformed registry, unreadable input) fails open: exit 1 and a one-line warning that the commit was not checked; it never blocks, and never passes in silence. | Exit 2 on an internal error would block every commit for a defect in the check; exit 0 would hide it. Claude Code treats exit 1 as a non-blocking error and shows it. | changed. | `plugins/english-check/scripts/hook.mjs` | `plugins/english-check/scripts/hook.mjs`: `this commit was not checked`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `a check that cannot run fails open` |
| `/opsx:review` runs the check on `review.md` alone before the record commit (`review.md:112`, `73961eb5`). | The record commit must contain nothing but the record and must be English. | changed — covered by the `PreToolUse` hook, which checks every commit an agent makes, the review record's included; the core makes no call. | `plugins/english-check/hooks/hooks.json` | `plugins/english-check/hooks/hooks.json`: `"PreToolUse"`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `a staged foreign line in a change artifact blocks the commit with path and line` |
| Apply, verify and archive commits run no explicit check; they rely on lefthook. | From apply on, the worktree is provisioned and lefthook resolves its binary. | changed — covered by the `PreToolUse` hook on every commit: apply's tick commits, `verify.md`, the archive move and merged specs; the core makes no call. | `plugins/english-check/hooks/hooks.json` | `plugins/english-check/hooks/hooks.json`: `"PreToolUse"`; `plugins/english-check/scripts/__tests__/hook.spec.mjs`: `every offending line of every file is reported` |
| The merge request description is written in English (`merge-request-lifecycle` requirement "One fixed description template, enforced mechanically"; `archive.md:489`); only its headings are checked mechanically. | The description is assembled from English artifacts, so no check was added. | changed — the description is not committed: it is an ignored file outside the change (`mr-input`'s `bodyFile`), so no commit hook sees it. As in the origin, it is assembled from English artifacts, and the archive instruction states English; no mechanical check is added. | core archive instruction | `plugins/adf/schema/instructions/archive.md`: `Write the body in English: it is an ignored file outside the change, so no commit hook checks it.`; `plugins/adf/scripts/lib/archive.mjs`: `export const bodyPath` |
| Memory pages and `.claude/memory/adf/` are written in English (`schema.yaml:1260`), but `.claude/memory/` is out of the check's scope by design. | Memory may quote non-English user input; the check would block an ingest. | ported — memory is outside the default scope; the archive instruction states English. | core archive instruction | `plugins/english-check/scripts/__tests__/english.spec.mjs`: `a wiki memory page is out of scope unless included`; `plugins/adf/schema/prompts/ingest.md`: `Write in English.` |
| `.claude/CLAUDE.md` §2 rule 1 and `openspec/config.yaml:51` require English in every artifact, code and comments included; the check covers far less. | The rule is the team's; the check enforces the flow's own files only. | changed — the default scope is the change artifacts and the specs; code, comments and commands are opt-in `include` globs in the host registry. The origin's wider scope moves into its registry at the switch. | `plugins/english-check/README.md`; host `.claude/adf-extensions.json` | `plugins/english-check/README.md`: `globs of repository-relative paths in scope`; pending: iteration 15 |
| (new) Without this plugin enabled in Claude Code nothing checks and nothing is said; a commit made by hand outside Claude Code is not checked. | The developer chose one mechanism; a host that wants a git or CI gate keeps its own. | changed — stated as a limit in the plugin's README. | `plugins/english-check/README.md` | `plugins/english-check/README.md`: `outside Claude Code, is not checked` |
| `check-english.mjs` is one of propose's adaptation markers in `check-opsx-commands.mjs:34`, so an `openspec update` that regenerates the command is detected. | `openspec update` overwrites the adapted commands. | rejected — the port owns its commands; no upstream regeneration exists. | — | — |

## Open findings carried over

- `adf-deferred-findings.md` holds no finding about the English check.
- No CI job runs the check, and neither `npm test` nor CI runs `.claude/scripts/__tests__/`
  (`.gitlab-ci.yml`, `package.json`); in the origin a commit with `--no-verify`, or on a machine
  where lefthook did not install, passes unchecked. The port's hook does not depend on git
  hooks, so `--no-verify` does not pass it; a commit made by hand is not checked (decision 2).
- A staged deletion crashes the propose invocation with a stack trace (probed). Fixed in the
  port (row "A path that cannot be read").
- An absolute path passes silently (probed). Fixed in the port: paths come from git, relative
  to the repository root.
- Kana and Hangul pass (probed). Not fixed; decision 1.
- The `.yml` part of the lefthook glob matches no scope pattern. Host-side; not carried.
- New, found by the parity tool: the origin's `invokedDirectly` guard compares `argv[1]` with
  the module's real URL, so the CLI called through a symbolic link (the macOS temporary
  directory is one) does nothing and exits 0. Harmless under lefthook, which uses a relative
  path. The port had the same guard in every script. Fixed in the port: `isMain` compares both
  paths after the system resolves them (`realpathSync.native`), so a symbolic link or another
  letter case (Windows, macOS) no longer skips a CLI. The parity tool runs the origin script
  through its real path.

## Decisions

Settled with the developer on 2026-10-14.

1. The character class stays the origin's four ranges. Widening it (kana, Hangul, the Cyrillic
   supplement) is a later recorded change.
2. One mechanism only: a Claude Code `PreToolUse` hook (matcher `Bash`) in the plugin. No
   contract point, no CLI for a host's pre-commit hook or CI, no README snippet for one, no git
   hook installed. The check exists only where the plugin is enabled.
3. The merge request description is a file committed in the change before `finalize`, so the
   hook checks it; it lands in iteration 10.
4. With the plugin not enabled, nothing checks and nothing is said.
5. The origin's wider scope (`.claude/CLAUDE.md`, `.claude/scripts/`, the flow commands,
   `openspec-sync-specs`) moves into its registry configuration at the switch, iteration 15.
6. A check that cannot run fails open with exit 1 and a warning on stderr: Claude Code shows a
   non-blocking hook error and the commit runs.

## Coverage already in propose.md

Rows of `docs/lessons/propose.md`, not repeated above; their evidence now points at this
plugin:

- "Run the English check on the staged files before the commit; on a finding fix the prose and re-run, never commit past it."
- "The check flags Cyrillic, CJK punctuation, ideographs and fullwidth forms, not em dashes, arrows or typographic quotes, and reports every offending line."
- "The check's pattern is written with escapes, not literal characters."
- "The check's scope is a list of origin paths (`.claude/CLAUDE.md`, `.claude/scripts/`, `.claude/commands/opsx/`, `openspec/`)." (the origin's scope: pending iteration 15)
- "A change's `plan.md` is exempt, before and after archiving."
- "The commit disables the host's hooks with `LEFTHOOK=0`." (pending iteration 12)

Also covered in `docs/lessons/schema-and-engine.md:89`: "English-only templates and
instructions" (requirement "English-only artifact templates").
