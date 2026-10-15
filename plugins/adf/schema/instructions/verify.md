The procedure `/adf:verify` executes: was the change actually built as its artifacts say. The
command file carries the step order; the rules below are stated here in full and the command
points at them. `<root>` is the change worktree the change was resolved to, `<change>` its name,
and `<verify>` is `<root>/.superpowers/sdd/<change>/verify/`.

**Verify runs after apply, never while planning.**

`verify.md` is written once apply has concluded. Its place after `plan` in the artifact graph is
an ordering edge, not a request to write it at propose. Verify is the only sanctioned executor of
its checks, and every check runs on every verify. If `verify.mjs` cannot be run at all, stop and
report why: checks improvised by hand are not a verification. Verify may be re-run as often as
needed; each run produces every section again and overwrites `verify.md` with the current state.
Run it until no blocking issue remains.

**Verify acts on the change worktree, on a branch that can take the record.**

The change is selected by the resolve instruction. Then confirm the worktree and the branch the
way apply does: `git -C <root> rev-parse --show-toplevel` prints `<root>`, `<root>` is not the
main checkout, and the `current` branch from `workspace.mjs suggest` is neither null nor listed
in `protected`. A change with no worktree of its own, or a protected current branch, is refused:
the record's commit would bypass the merge request. Verify makes no worktree and no branch.

**The script runs the mechanical checks; the orchestrator reads verdicts, not output.**

The first run of a verify session passes `--fresh`, which deletes `<verify>` first: every section
is produced again, and a section left by an earlier session describes a HEAD that may have
moved. Later runs of the same session leave it out:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" run --change <change> --root <root> [--fresh] [--skill-edit <sha> ...]
```

It prints one result per check (`id`, `title`, `verdict`, `summary`, `output`) and keeps the
list in `<verify>/run.json`. The raw output of each check is in the file its `output` names;
read the summaries, and leave the files to the dispatches. Exit 1 means a check failed or the
run was refused; an `error` field is the refusal. The verdicts: `pass`; `warn`, which never
blocks; `fail`, which blocks; `not-run`, which is not a pass.

- `validation`: the change's own artifacts validate strictly. A failure is this change's: fix
  the artifact and re-run. The rest of the corpus is reported as advisory text and never gates.
- `tasks`: every item of the tracked tasks file is ticked. Each open item blocks until it is
  ticked, or until the developer rules on it with the reason it stays open (manual, out of
  scope, blocked).
- `deltas`: each capability's delta against its main spec. `needs sync` is expected before
  archive, which merges the deltas: a warning naming the capabilities, not a failure. A
  `conflict` is a delta archive could not apply, and fails.
- `tree`: nothing uncommitted, untracked files included, and a non-empty range from the change's
  base to HEAD. An uncommitted path is outside every range a later phase reads: commit it, or
  remove it, and re-run.
- `test-record`: whether apply's test record still describes HEAD. Its rules are below.
- `worktrees`: no task-group worktree of this change and no base-check worktree remains. One
  that remains is an apply that stopped, most likely at a blocked group; it fails whatever the
  other checks say. Resolve it through apply, never by deleting it from verify.
- `out-of-plan`: every file a commit in the range touched is named by a task's `**Files:**`
  block, lies in the change's own directory, matches a glob of the registry's `outsidePlan`
  list, or belongs to an approved skill edit. Each other file is reported with its commit and
  fails. The resolution is a plan amendment the developer approves, an "Added during apply"
  line as the apply instruction states it, or a ruling; never a rewritten verdict. An unparsed
  `**Files:**` bullet is a warning: its path is not in backticks, so the check could not read
  it.

**The test record is cited while it is current, and re-run once it is not.**

The script reads the `**Commit:**` line of `.apply-test-record.md` and lists the commits after
it across the whole repository, ignoring only those confined to the change's own directory,
which no test reads.

- No commit outside the change directory since the record: the record stands. Its section cites
  the record, and the suite is not run again.
- A commit outside the change directory since the record, no record, or a record whose commit is
  not in the branch: the record is stale, and citing it would accept a cached result. Run the
  whole suite as if no record existed, through the `verify c6` dispatch.

`verify c6` runs the whole-suite command of the planning guide (delivered in `guides`, under
`## Whole-suite command`) with `<root>` as its working directory, exactly as the apply
instruction's whole-suite rule describes, uncached. A failure is checked on the base the same
way apply checks it, through `workspace.mjs base-check-add` and `base-check-remove`: a failure
that also fails on the base is pre-existing, named as separate work, and does not fail the
check; one that does not reproduce there fails it. A suite that cannot run at all in this
workspace (a missing dependency or service) is a failure, not a pass: the developer decides
whether to provision it or to accept the risk with a ruling. When the guide holds no
whole-suite command, the section is `not-run` with that reason.

The section quotes the runner's real output, its own pass and fail counts and its file or suite
counts, never a summary of them. A green run is evidence only of the configuration it ran
under.

**Test counts are reconciled by count, not by verdict.**

The script reads every `impl` and `fix` reply in the change's SDD workspace. A reply whose test
summary carries no count, or counts more than the apply record shows, is a warning. A summary
line that cannot show a suite that never loaded once read as green over one. A re-run's section
carries these warning lines over from the script's `test-record` output.

**The judgement checks are dispatches; each writes a section file.**

A verify dispatch is read-only: it edits no file of the change or of the project, commits
nothing, and dispatches no agent. It writes exactly two files into `<verify>`: its raw output,
`<id>-agent.txt`, and its section, `<id>.json`, one JSON object `{ "id", "title", "verdict",
"summary", "output" }` with `verdict` one of `pass`, `warn`, `fail`, `not-run` and `output` the
output file's path relative to `<root>`. It returns the section's path, not a report. The
section is what `verify.mjs verdict` validates, so a verify dispatch has no reply role and
writes no reply file. A section may replace a script check only for `test-record`.

Name each dispatch in the fixed form the metrics read, and choose its level by the work:

| Dispatch | Section id | Level | Runs |
|---|---|---|---|
| `verify c4` | `c4` | `adf:architecture` | always |
| `verify c8` | `c8` | `adf:integration` | always |
| `verify c6` | `test-record` | `adf:integration` | when `test-record` fails as stale or missing |
| `verify assemble` | — | `adf:mechanical` | once the verdict is computed |

The number in a name is a fixed identifier, not a position or a count. Every prompt carries the
change, `<root>` as an absolute path, the base and range from `run.json`, the files in scope,
the question, and the two file paths to write; git runs as `git -C <root>`. No dispatch text asks
for a repository-wide git mutation. `verify c4` and `verify c8` run in parallel, in one response.

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

**`verify c8`: stale skills.**

Compare the range's diff with every `<root>/.claude/skills/*/SKILL.md`, and the `README.md` and
manifest beside it where present: does a skill state, as current fact, a behaviour the diff
changed? Only the host's own skills are read, never an installed plugin's.

- **CONFIRMED**: a skill's stated fact is contradicted by the diff. The check fails. The
  dispatch writes the proposed edit, as a diff, into its output file and edits nothing.
- **PLAUSIBLE**: the skill may be affected but is not clearly contradicted. A warning.
- **None**: the diff touches nothing any skill documents as current fact. A pass.

Show each CONFIRMED finding's proposed edit to the developer and ask whether to apply it. No
skill file is edited without an explicit approval; silence is not approval, and an automatic
dismissal looks exactly like a missed defect.

- **Approved**: apply the edit and commit it on its own, touching only files under
  `<root>/.claude/skills/`, in Conventional Commits form. No plan task is back-filled for it.
  Pass its sha as `--skill-edit <sha>` to `verify.mjs run`, now and on every later run for this
  change, including a later verify session, which reads the shas from the committed
  `verify.md`. Re-run `verify.mjs run`, then `verify c8` with the approved shas in its prompt, so
  the section records them and shows the finding resolved.
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
dispatches. Write what was run and what it showed to `<verify>/developer.txt`; it is recorded
in its own section and does not replace a check.

**The verdict is computed by script.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs" verdict --change <change> --root <root> --out <root>/.superpowers/sdd/<change>/verdict.json
```

It reads `run.json`, every section file and the rulings, and computes `PASS`, `PASS WITH
WARNINGS` or `FAIL`: any failing check without a ruling makes it FAIL. An `error` with
`refusals` means the record cannot be given a verdict yet: a section is malformed or has no
output file, or a check is not run and has no ruling. Correct the section by re-dispatching it,
or obtain a ruling, and compute again. The verdict file stays outside `<verify>`, where it
would be read as a section.

**`verify assemble` fills the template; it decides nothing.**

It writes `<root>/openspec/changes/<change>/verify.md` from the template, the sections in the
template's order, each with its verdict as the verdict file displays it, its summary and the
verbatim content of its output file. A section with nothing to paste is a step that was
skipped: report it rather than describe what it would have said. The record's last line is the
verdict file's `line`, unchanged. Before committing, confirm that the record's last line equals
that `line`.

**The record is committed alone, and verify pushes nothing.**

```bash
git -C <root> add -- openspec/changes/<change>/verify.md
git -C <root> commit -m "docs(openspec): verify <change>" -- openspec/changes/<change>/verify.md
```

The commit holds `verify.md` and nothing else; an approved skill edit is its own commit. Verify
calls no forge operation: the record reaches the remote with a later push. Verify offers no
worktree removal either: the review runs next in this worktree, and archive removes it.

**The next step follows the verdict.** `PASS` or `PASS WITH WARNINGS`: the review, which reads
the record's `Verdict:` line. `FAIL`: fix what the failing checks name (the artifact, the code
through a new apply round, or the plan with the developer's approval) and run verify again.
