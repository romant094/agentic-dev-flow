The procedure `/adf:verify` executes: was the change actually built as its artifacts say. The
command file carries the step order; the rules below are stated here in full and the command
points at them. `<root>` is the change worktree the change was resolved to, `<change>` its name,
and `<verify>` is `<root>/.superpowers/sdd/<change>/verify/`. Every deterministic step is one
script call; the orchestrator keeps the judgement on its result and the talk with the developer.

**Verify runs after apply, never while planning.**

`verify.md` is written once apply has concluded. Its place after `plan` in the artifact graph is
an ordering edge, not a request to write it at propose. Verify is the only sanctioned executor of
its checks, and every check runs on every verify. If `verify.mjs` cannot be run at all, stop and
report why: checks improvised by hand are not a verification. Verify may be re-run as often as
needed; each run produces every section again and overwrites `verify.md` with the current state.
Run it until no blocking issue remains.

**Verify acts on the change worktree, on a branch that can take the record.**

The change is selected by the resolve instruction. Then one call checks where verify runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase verify --change <change> --root <root>
```

It checks the Superpowers gate, that `<root>` is the top level of a worktree other than the
main checkout, that the current branch is named and not protected, and that the change's
dependencies are done; on a pass it records the session. On `ok: false`, stop, show `refusal`
and write nothing. A change with no worktree of its own, or a protected current branch, is
refused: the record's commit would bypass the merge request. Verify makes no worktree and no
branch.

**The script runs the mechanical checks; the orchestrator reads verdicts, not output.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" run --change <change> --root <root> --suite
```

A run in a session other than the one that wrote `<verify>run.json` clears `<verify>` first:
a section left by an earlier session describes a HEAD that may have moved. `--fresh` forces the
clearing. The approved skill edits are read from the ledger. It prints one result per check
(`id`, `title`, `verdict`, `summary`, `output`); read the summaries, and leave the files to the
dispatches. Exit 1 means a check failed or the run was refused; an `error` field is the refusal.
The verdicts: `pass`; `warn`, which never blocks; `fail`, which blocks; `not-run`, which is not a
pass. What resolves each check:

- `validation`: the change's own artifacts validate strictly. A failure is this change's: fix
  the artifact and re-run; a fixed delta block takes the `specs-base` step below. The rest of
  the corpus is reported as advisory text and never gates.
- `tasks`: every item of the tracked tasks file is ticked. Each open item blocks until it is
  ticked, or until the developer rules on it with the reason it stays open (manual, out of
  scope, blocked).
- `deltas`: each capability's delta against its main spec. `needs sync` is expected before
  archive, which merges the deltas: a warning naming the capabilities, not a failure. A
  `conflict` is a delta archive could not apply, and fails.
- `specs-base`: `specs.mjs base --check`. Archive's three-way check reads each modified,
  removed or renamed requirement's base text from the change's `specs-base.json`, taken at
  propose, because a rebase moves `git merge-base` past the edit another change made. A
  requirement with no entry, or whose entry was taken for another delta text, fails: after
  editing a delta block, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/specs.mjs" base --change
  <change> --root <root>`, commit the file with the edit, and re-run.
- `tree`: an uncommitted path, untracked files included, is outside every range a later phase
  reads: commit it, or remove it, and re-run.
- `test-record`: whether apply's test record still describes HEAD. Its rules are below.
- `worktrees`: a task-group or base-check worktree of this change that remains is an apply that
  stopped, most likely at a blocked group; it fails whatever the other checks say. Resolve it
  through apply, never by deleting it from verify.
- `out-of-plan`: a file that no task's `**Files:**` block names, outside the change's own
  directory, the registry's `outsidePlan` globs and the approved skill edits, fails with its
  commit. The resolution is a plan amendment the developer approves, an "Added during apply"
  line as the apply instruction states it, or a ruling; never a rewritten verdict. An unparsed
  `**Files:**` bullet is a warning: its path is not in backticks, so the check could not read it.

**The test record is cited while it is current, and re-run once it is not.**

`verify.mjs run` reads the `**Commit:**` line of `.apply-test-record.md` and lists the commits
after it across the whole repository, ignoring only those confined to the change's own
directory, which no test reads.

- No commit outside the change directory since the record: the record stands. Its section cites
  the record, and the suite is not run again.
- A commit outside the change directory since the record, no record, or a record whose commit is
  not in the branch: the record is stale, and citing it would accept a cached result. The
  `test-record` check fails, and the whole suite runs as if no record existed.

`--suite` makes that re-run part of the same `verify.mjs run` call: on a failing `test-record`
check it runs the whole-suite command of the planning guide with `<root>` as its working
directory, exactly as the apply instruction's whole-suite rule describes, uncached, with the base
check, and writes `<verify>test-record.json` with its output file; the result carries the run as
`suite`, and its `ok` reads that section in place of the check. On a current record it removes a
`test-record` section an earlier re-run left, so the record is cited. A failure is checked on the base: a failure
that also fails on the base is pre-existing, named as separate work, and does not fail the
check; one that does not reproduce there fails it. On `comparison: "whole-run"`, compare the two
output files before relying on the result. A suite that cannot run at all in this workspace (a
missing dependency or service), or that runs past its timeout, is a failure, not a pass: the
developer decides whether to provision it or to accept the risk with a ruling. When the guide
holds no whole-suite command, the section is `not-run` with that reason. No agent runs the
suite: there is no `verify c6` dispatch.

The section quotes the runner's real output, its own pass and fail counts and its file or suite
counts, never a summary of them. A green run is evidence only of the configuration it ran
under.

**Test counts are reconciled by count, not by verdict.**

`verify.mjs run` reads the computed result of every accepted `impl` and `fix` reply in the
change's attempts log, and the test-run record of each one's last covering run, which
`suite.mjs covering` wrote. A done reply that names no covering run, a run that printed no count
line, or one that counts more tests than the apply record shows, is a warning. A free-text
summary that cannot show a suite that never loaded once read as green over one; the counts come
from the records, never from a reply's prose. The re-run's section carries these warning lines
over.

**The judgement checks are dispatches; each writes a section file.**

A verify dispatch is read-only: it edits no file of the change or of the project, commits
nothing, and dispatches no agent. Its reply is one JSON object under
`${CLAUDE_PLUGIN_ROOT}/schema/verify-<id>.schema.json`, written to the reply file its prompt
names, and it returns that path, not a report. The reply states no verdict and writes no section:
the script checks the reply, computes the verdict and writes the section from it. A section may
replace a script check only for `test-record`.

Name each dispatch in the fixed form the metrics read, and choose its level by the work:

| Dispatch | Section id | Level | Runs |
|---|---|---|---|
| `verify c4` | `c4` | `adf:architecture` | always |
| `verify c8` | `c8` | `adf:integration` | always, after the candidates `verify.mjs prompts` lists |
| none: `verify.mjs run --suite` | `test-record` | script | when `test-record` fails |

The number in a name is a fixed identifier, not a position or a count. One call lists the stale
skill candidates and writes both prompts, each with every fixed field filled (the change, `<root>`
as an absolute path, the base and range from `run.json`, the files in scope, the reply file to
write, and for `verify c4` the prose edits and the removed or renamed requirements the script
listed), and names each agent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" prompts --change <change> --root <root>
```

Each entry of its `dispatches` carries `name`, `agent`, `replyFile` and `prompt`; dispatch the
prompt as it is. A single section is written again from its own prompt, the `dispatch.mjs prompt`
command the verdict's `redispatchCommands` names.

git runs as `git -C <root>`. No dispatch text asks for a repository-wide git mutation.
`verify c4` and `verify c8` run in parallel, in one response.

**Each reply is recorded by one call, which writes the section.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" reply --change <change> --name "verify <id>" --file <replyFile> [--resume no] --root <root>
```

It checks the reply against its schema and against what the script itself listed, records the
reply's event in the change's attempts log, and on a valid reply computes the verdict and writes
the section `<verify><id>.json` from it, returned as `section`; for `verify c8` it also joins the
CONFIRMED patches into `<verify>c8.diff`. `verify.mjs verdict` accepts a `c4` or `c8` section only
as the section of the last accepted reply of this verify session, with its computed verdict: a
section written by hand is refused. On a refusal, `next` is `retry` the first time: resume the same
agent with the `errors` (`mode: resume`), or, where the harness cannot resume it, pass `--resume
no` and dispatch the prompt afresh with the errors as its question (`mode: fresh`). The second
refusal of a name is `stop`: verify stops there and reports the errors to the developer. The count
starts again with each verify session, at `started` in `run.json`.

**`verify c4`: design and specs against each other and against the code.**

- Every design decision traces to a requirement or a scenario, and every requirement agrees
  with the decisions. Read every decision and requirement, not a sample, and open what a
  decision names: the command, script or skill it changes, including one a command hands
  control to. A row that cites only the file that agrees is no evidence.
- Drift between two documents is a warning, with file and line on both sides. A contradiction
  between two executable surfaces (code, scripts, commands that run) fails.
- No delta specs: the check covers the design against the tasks. No design: it covers the specs
  against the implementation. The section says which case applied.
- A commit in the range that edits a capability's prose above `## Requirements` in
  `openspec/specs/` is listed with the capabilities and the reason the change gives for it; an
  edit with no stated reason is a warning. An edit at or below `## Requirements` fails: only
  archive writes there.
- When a delta carries `REMOVED` or `RENAMED`: each such requirement's `**Code Disposition:**`
  is checked against the code, and the old path against reachability. A disposition the code
  contradicts, a missing one, or an old path still reachable fails. This is the verifier of the
  disposition apply's sweep recorded.
- New mechanisms: for each one the change adds, which of its paths a test or a recorded run
  exercised and which nothing exercised. A green gate never stands in for a path that ran.

The script lists the commits of the range that edit a capability's `spec.md`, each with the
edit's position against `## Requirements`, and the `REMOVED` and `RENAMED` requirements of the
deltas; the reply's `proseEdits` and `removalAccounting` answer each listed entry exactly once,
and its `case` is the one the change's files give. The verdict is computed from the reply: it
fails on an `exec-contradiction`, a `prose-edit-below-requirements`, a `disposition-contradicted`,
a `disposition-missing` or an `old-path-reachable` finding, on an edit at or below `##
Requirements`, and on a removal with no disposition, one the code does not hold, or one whose old
path is still reachable; it warns on a `doc-drift`, a `prose-edit-unstated`, a
`decision-untraced` or a `requirement-contradicts-decision` finding, on an edit with no stated
reason, and on a path of a new mechanism nothing exercised (`exercisedBy: null`); it passes
otherwise. The record renders the section from the reply: the case, the findings, the
hand-edited capability prose with each edit's position and reason, and the removal accounting,
or `N/A: no REMOVED or RENAMED requirement`.

**`verify c8`: stale skills.**

`verify.mjs prompts` lists the candidates before it writes the prompt. It reads every `<root>/.claude/skills/*/SKILL.md` and the `README.md` beside it, and writes to
`<verify>c8-candidates.txt` each line that names a path, symbol, command or route the range's
diff changed. Only the host's own skills are read, never an installed plugin's. The dispatch
judges each candidate line, reading the skill around it and the diff: does the skill state, as
current fact, a behaviour the diff changed?

- **CONFIRMED**: a skill's stated fact is contradicted by the diff. The item carries its
  proposed edit as `patch`, a unified diff that `git apply` accepts in `<root>`:
  `diff --git a/<path> b/<path>` headers with paths relative to `<root>`, context lines copied
  exactly, nothing after the last hunk. It edits nothing.
- **PLAUSIBLE**: the skill may be affected but is not clearly contradicted. A warning.
- **None**: no candidate line, or none that the diff contradicts. A pass.

A CONFIRMED item fails the check. The reply answers each candidate line exactly once; a CONFIRMED
item's patch touches its own skill file, stays under `.claude/skills/` and passes `git apply
--check` in `<root>`, alone and joined with the others, and no other item carries a patch. A
patch that does not apply is a refused reply, retried before the developer sees it.

Show each CONFIRMED finding's proposed edit to the developer and ask whether to apply it. No
skill file is edited without an explicit approval; silence is not approval, and an automatic
dismissal looks exactly like a missed defect.

- **Approved**: apply the diff and commit it on its own, in one call. Without `--diff-file` it
  takes `<verify>c8.diff`, the CONFIRMED patches of the accepted reply; when the developer
  approved only part of it, or changed it, write that diff to a file and pass it as `--diff-file`:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" skill-edit --change <change> --message "<type(scope): description>" [--diff-file <file>] --root <root>
  ```

  It applies the diff with `git apply` from its first `diff --git` line, and refuses, changing
  nothing, a diff with a path outside `<root>/.claude/skills/`, a tree that already holds a
  change, and a diff that does not apply cleanly. Then it commits, records the sha in the
  ledger, where every later run reads it, and runs the checks again. No plan task is
  back-filled for it. Then run `verify.mjs prompts` and dispatch `verify c8` again, so the
  section shows the finding resolved.
- **Declined with a reason**: record the decline as a ruling on `c8`. It resolves the finding.

**A developer ruling turns a failing check into a warning; nothing else does.**

When the developer explicitly accepts a failing or not-run check and gives the reason, record
it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" ruling --change <change> --check <id> --reason <reason> --root <root>
```

The verdict then shows that check as accepted, with the reason. Only the developer's own words
make a ruling: an orchestrator's or a dispatch's judgement is not one, and silence never is.
`tree` and `worktrees` cannot be accepted. A check that could not be run is recorded as not run,
with the reason; it is never written up as passed.

**Every claim is verify's own.**

Each check runs from verify's scripts and dispatches, against the tree as it is now. A claim an
implementer's reply made about the live environment is re-run, never copied. Every issue names a
file and a line; "consider reviewing" is not an issue.

**What verify does not check.** The corpus lint, the reuse sweep and the shape of apply's waves
belong to other phases; none of them gates verify.

**Checks that need the developer.** A check the plan assigns to verify that needs the developer
(a live environment, real hardware, consent at the time) is run with the developer after the
dispatches. Write what was run and what it showed to a text file outside `<verify>`, agree the
verdict with the developer, and record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" developer --change <change> --text-file <file> --verdict <pass|warn|fail|not-run> --summary <text> --root <root>
```

It copies the text verbatim to `<verify>developer.txt` and writes its section, which does not
replace a check.

**The verdict is computed by script.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" verdict --change <change> --root <root> --report
```

It reads `run.json`, every section file and the rulings, and computes `PASS`, `PASS WITH
WARNINGS` or `FAIL`: any failing check without a ruling makes it FAIL. An `error` with
`refusals` means the record cannot be given a verdict yet, and the result names what resolves
it, each with its exact command: `redispatchCommands`, one per section to write again (the
`dispatch.mjs prompt` call of a dispatch, whose prompt you dispatch; the suite run; the
developer call; `null` for a stray section file, which you remove); `rulingCommands`, one per
check that waits for the developer's ruling, with the reason left for their words; and
`rerunCommand`. Run them, then compute again.

**The record is rendered and committed by script, alone, and verify pushes nothing.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" assemble --change <change> --root <root> --commit
```

It renders `openspec/changes/<change>/verify.md` from the template, `run.json`, the sections in
the template's order (a script check with the verbatim content of its output file, `c4` and `c8`
from their recorded replies), the verdict, the rulings and the approved skill edits, deciding
nothing; the record's last line is the verdict's `line`. It
refuses while the verdict refuses, and when HEAD moved since the run: run the checks again. The
commit holds `verify.md` and nothing else; an approved skill edit is its own commit. Show the
result's `report`. Verify calls no forge operation: the record reaches the remote with a later
push. Verify offers no worktree removal either: the review runs next in this worktree, and
archive removes it.

**The next step follows the verdict.** `PASS` or `PASS WITH WARNINGS`: `/adf:review`, which reads
the record's `Verdict:` line. `FAIL`: fix what the failing checks name (the artifact, the code
through a new apply round, or the plan with the developer's approval) and run verify again.
