# Scripts-first audit of the ADF flow

Repository: `agentic-dev-flow`, branch `feat/plugin-core`. Read-only audit.

Scope read: `plugins/adf/commands/*.md`, `plugins/adf/schema/instructions/*.md`,
`plugins/adf/schema/templates/*.md`, `plugins/adf/agents/*.md`, `plugins/adf/host/planning.md`,
`plugins/adf/schema/schema.json`, the headers and exports of `plugins/adf/scripts/*.mjs` and
`plugins/adf/scripts/lib/*.mjs`, `plugins/gitlab/README.md`, `plugins/english-check/README.md`,
`docs/roadmap.md`, `docs/iterations/*.md`, and the Rule and Why columns of `docs/lessons/*.md`.

Principle tested: whatever a script can do deterministically is done by a script (pure library,
thin CLI, tested, one JSON object out, cross-platform); the LLM only does judgement.

Already scripted, so not proposed again: the Superpowers gate (`superpowers.mjs`), the registry
(`extensions.mjs`), change creation, status, instructions and find (`changes.mjs`), spec
validation (`specs.mjs`), the plan symbol check (`plan-symbols.mjs`), the ledger (`ledger.mjs`),
worktrees for the change, the groups and the base check (`workspace.mjs`), the dispatch guard
(`guard.mjs`), the tick (`tasks.mjs tick`), the reply check (`reply.mjs`), the SDD collision check
(`sdd.mjs`), the mechanical verify checks and the verdict (`verify.mjs run`, `verdict`), the forge
role (`forge.mjs`), and the English check hook.

Paths below are relative to `plugins/adf/` unless stated. "cmd" is `commands/`, "instr" is
`schema/instructions/`.

## 1. Candidates

Value: high, med or low, weighing token cost, error risk seen in the lessons, and frequency per
change. Effort: S (one function plus CLI and tests), M (a new module or several touch points),
L (a new subsystem).

### init / add / remove

| # | Where (file:line) | What the LLM does now | Script proposal (command, input, output) | What stays with the LLM | Value | Effort |
|---|---|---|---|---|---|---|
| I1 | cmd/init.md:40-55 | Runs `superpowers.mjs` and `extensions.mjs check` as two more calls after `init`, then branches on each `ok`. | `extensions.mjs init` returns `superpowers` and `check` objects in its one JSON result. | Nothing. | low | S |
| I2 | cmd/init.md:57-65; cmd/add.md:31-32; cmd/remove.md:21-22 | Composes the report from several JSON fields (created, contract, settings notes, policy, guide, plugins). | A `report` string field (rendered text) in each subcommand's result; the command prints it. | Nothing. | low | S |
| I3 | cmd/add.md:23-29 | Runs `check` after `add` and reads `ok`. | `add` runs the check before it returns and refuses or reports in the same object. | Nothing. | low | S |

### propose

| # | Where (file:line) | What the LLM does now | Script proposal (command, input, output) | What stays with the LLM | Value | Effort |
|---|---|---|---|---|---|---|
| P1 | cmd/propose.md:24-31, 38-66 | Five calls in sequence (gate, `suggest`, `create`, `changes new`, `ledger session`); decides "in flight" by checking whether `path` exists itself (`suggest` has no field for it); decides stop on `dirty`. | `propose.mjs start --change <n>` (gate + `suggest` with `exists`, `inFlight`, `dirty`, `bases`, `branch`) and `propose.mjs create --change <n> --branch <b> --base <x>` (create + `changes new --base` + `ledger session`) returning `{root, branch, base, baseRef}`. | Deriving the name from a description; the developer's choice of base and branch name; continue or rename for an in-flight change. | med | S |
| P2 | cmd/propose.md:33-36 | Decides whether the argument "is a kebab-case name". | Part of P1: `start` returns `nameValid` and the reason. | Deriving a name from prose. | low | S |
| P3 | cmd/propose.md:68-96 | Loop: run `status`, pick the first `ready` artifact in order, run `instructions`, read dependencies, write, run `status` again; tracks with the todo tool. | `changes.mjs next --change <n>` returns the next ready artifact's instructions with the dependency file paths, or `{done:true}` when every `applyRequires` artifact is done. | Writing each artifact. | med | S |
| P4 | cmd/propose.md:88-93; instr/propose.md:51-56, 64-69 | Must remember to run `specs.mjs validate` after `specs` and `plan-symbols.mjs` after `plan`, and to not commit before exit 0. | Gates declared per artifact in `schema.json` (`"gate": ["specs-validate"]`, `["plan-symbols", "plan-lint"]`) and run by `changes.mjs done <id> --change <n>`; `next` refuses to hand out a later artifact while a gate fails; the propose commit (X2) refuses without a passing gate record. | Fixing what a gate reports. | high | S |
| P5 | instr/proposal.md:20-22; instr/specs.md:6-9; templates/proposal.md:31-45 | Keeps the contract by reading: every capability in the proposal has `specs/<cap>/spec.md`, modified ones use an existing `openspec/specs/` folder, new names are compound kebab-case and do not collide. | `specs.mjs capabilities --change <n>`: parses the proposal's Capabilities section and returns `missingSpec`, `unlistedSpec`, `modifiedNotFound`, `newCollides`, `badName`. Runs as a gate of `specs` (P4). | Which capabilities a change has, and their scope. | high | S |
| P6 | instr/specs.md:11-19; templates/spec.md:31-36, 50-85 | Ensures a MODIFIED or REMOVED header matches the main spec exactly, REMOVED carries Reason, Migration and Code Disposition, RENAMED carries FROM/TO and Code Disposition. A mismatch shows only at verify (`deltas` conflict) or archive. | `specs.mjs validate --change <n> --against-main`: reuse `deltaState` (lib/verify.mjs:120) at propose; report each unmatched header and each missing field. | Writing the content. | high | S |
| P7 | instr/tasks.md:3-7, 16-18; templates/tasks.md | Writes `- [ ] X.Y` under numbered `##` groups and keeps paths and test commands out of `tasks.md`. | `tasks.mjs lint --change <n>`: checkbox grammar, item numbers match their group number, no duplicates; a warning for a backticked path or a command-like line. Gate of `tasks`. | Granularity: what one checkbox covers. | med | S |
| P8 | instr/tasks.md:37-41 | Applies the split rule: a task whose Files span two packages and that changes a failure or rollback path is split. | `plan-lint` (P9) flags each task whose `**Files:**` span two packages, from the guide's `## Packages` section or two top-level source directories. | The second conjunct: does the task change a failure or rollback path. | med | S |
| P9 | instr/plan.md:34-50; templates/plan.md:34-56 | Ensures one `### Task N` per checkbox in order, the back-reference `> Implements tasks.md N.M` names a real item, no deliverable without a checkbox, every task has Files, Interfaces, Level from the enum, Behaviour and acceptance, and a commit step. | `plan-lint.mjs <change>` (or `plan-symbols.mjs --lint`, which already parses tasks): returns findings per task plus `testFirst: [n]` (tasks with RED and GREEN steps). Gate of `plan`. | Content of each task; whether a task should be test-first. | high | S |
| P10 | instr/plan.md:52-68; templates/plan.md:12-30 | Builds the Execution Graph by hand: the Files column as the union of the group's tasks' Files, the coupling floor from file-set overlap, waves, no dependency on wave 2, the cap. | `plan-graph.mjs compute <change> --groups A=1,2;B=3` writes the group table (Files union) and the coupling floor per pair (`none`, `weak-or-medium`, `strong` from overlap and writer sets); `plan-graph.mjs check` parses the section and refuses a missing section, a strong or high-criticality medium pair in one wave, a medium row without a criticality word, a dependency on a wave-2 group, a task in no group. | The partition into groups; raising a floor for a shared contract; high or low criticality; the reason text. | high | M |
| P11 | instr/plan.md:88-91 | For a task that deletes a file, searches the repository for the path and exported names and lists every referencing file in Files. | Extend `plan-symbols.mjs`: for each `Delete:` path, `git grep` its path and basename and the names it exports; each hit outside the task's Files block is a finding. | Exported names of a non-JS file, if the parser cannot read them. | high | S |
| P12 | instr/plan.md:104-111 | Checks every design risk has a line naming a Task or a reasoned deferral. | `plan-lint` reads `design.md`'s `[Risk] →` lines and reports each with no plan line that names it and a `Task N` or "deferred". | Whether a task's text contradicts a mitigation or a requirement. | med | S |
| P13 | instr/brainstorm.md:3-8; instr/plan.md:3-6 | Must remember the skills write to `docs/superpowers/specs|plans/` and redirect. | `changes.mjs done brainstorm|plan` checks `docs/superpowers/` for files newer than the change's creation, moves them into the change (brainstorm to `brainstorm.md`, a design to `design.md`), and reports it. | Nothing. | med | S |
| P14 | instr/propose.md:58-62 | Must not copy `context`, `rules` or `guides` into the artifact. | `changes.mjs done <id>` reports any `rules` line or guide paragraph that appears verbatim in the artifact. | Nothing. | low | S |
| P15 | cmd/propose.md:98-109; instr/propose.md:71-76 | `git add`, reads `git status --porcelain`, decides whether anything outside the change is staged, commits with a fixed message. | `commit.mjs --root <r> --only openspec/changes/<n> --message "docs(openspec): propose <n>"` (see X2). | Nothing. | med | S |
| P16 | cmd/propose.md:111-122 | Builds the forge JSON by hand (`change`, `branch`, `base`, `protected` copied from the earlier `suggest`), derives `<type>` from the branch. | `forge.mjs open --change <n> --root <r> --summary "<scope>: <description>"`: the core reads the branch from git, the base from `.adf.json`, the protected list from the registry, and the type from the branch prefix. | Scope and description words of the title. | med | S |
| P17 | cmd/propose.md:124-129 | Runs `status` again and composes the report. | `changes.mjs status --report` returns the rendered report lines (artifacts, branch, worktree, base) and the merge request state passed in. | Nothing. | low | S |

### apply

| # | Where (file:line) | What the LLM does now | Script proposal (command, input, output) | What stays with the LLM | Value | Effort |
|---|---|---|---|---|---|---|
| A1 | cmd/apply.md:22-81; instr/apply.md:5-16, 27-40 | Seven calls and the logic between them: gate; `rev-parse --show-toplevel` equals root; `--git-common-dir` parent is main and differs from root; `suggest` `current` not null and not protected; `sdd.mjs`; `ledger session`; `instructions apply` state; `plan-symbols --phase apply`. | `preflight.mjs --phase apply --change <n> --root <r>`: one JSON `{ok, refusal, main, root, branch, protected, base, state, progress, tasks, sdd, planFindings}`; it records the session itself. A guard that reads a fallible call checks the call. | Confirming the change with the developer (resolve). | high | M |
| A2 | cmd/apply.md:83-84; instr/apply.md:240-243 | Reads the plan to say which tasks are test-driven and lists the remaining tasks. | `testFirst` from P9 and `tasks` from A1. | Whether a task without RED and GREEN should have them. | low | S |
| A3 | instr/apply.md:55-64 | Writes `.superpowers/sdd/<change>/progress.md` with one exact identity line by hand. | `sdd.mjs init --change <n> --root <r>`: runs the check, then writes the line; part of A1. | Nothing. | med | S |
| A4 | instr/apply.md:66-78 | Calls the skill's `task-brief` and `review-package` with an explicit output path, resolves BASE and HEAD to commit ids, names the file `review-<base7>..<head7>.diff`, then checks `.superpowers/sdd/plan/` and moves stray output. | `sdd.mjs brief --change <n> --task <N>` and `sdd.mjs package --change <n> --base <ref> --head <ref>`: locate the skill directory, resolve shas, compute the path, call the skill script, assert `plan/` is absent (move and report if not). Output `{file}`. | Nothing. | high | S |
| A5 | instr/apply.md:80-108 | Reads the graph, numbers groups by row, decides the single-group case, applies the 2-3 cap, decides which groups start and their `<target>`. | `plan-graph.mjs schedule --change <n> --root <r>`: `{single, groups:[{n, letter, tasks, wave, dependsOn}], startNow:[n], waiting:[n]}` from the parsed graph (P10). | A deliberate serial run (then a `deviation`). | high | S |
| A6 | instr/apply.md:132-160, 193-204 | Chooses the agent per dispatch (task Level, review at integration or above, merge-review, final-review and adjudication at architecture, round 2 one level up), composes the dispatch name `T<n> <role> r<k>`, and computes the reply file with the `-2`, `-3` suffix. | `dispatch.mjs plan --change <n> --role <role> [--task <N>] [--group <G>] [--round <k>]` returns `{name, agent, replyFile, worktree}`. | Nothing. | med | S |
| A7 | instr/apply.md:162-191 | Writes every prompt: task id, absolute worktree, files in scope, question, reply role and file, and the fixed implementer clauses (read the brief, state Files first, one commit, never tick, no subagents, the `ledger.mjs debt` command). | `dispatch.mjs prompt` (same inputs as A6) emits the prompt skeleton with every fixed field filled from the plan, the brief path and A6; a `--question-file` slot for the variable part. | The question for fix, review and merge-review rounds (the findings, the conflict context). | high | M |
| A8 | instr/apply.md:206-214 | Counts refusals per dispatch: one retry, then `BLOCKED`. | `reply.mjs` records attempts per dispatch name in the change workspace and returns `next: "retry" | "blocked" | "act"`. | Nothing. | low | S |
| A9 | instr/apply.md:245-251 | The reviewer overwrites each changed file with the parent's version (`git show <parent>:<path> > <path>`), moves created files aside, runs the test, restores, checks porcelain is empty. | `tdd-proof.mjs --worktree <w> --commit <sha> --test "<cmd>"`: does the swap in a throwaway worktree of the parent plus the test files (never in the working tree), returns `{failsOnParent, passesOnCommit, outputs}`. | The reviewer judges whether the test tests the behaviour. | high | M |
| A10 | instr/apply.md:258-271 | Maps the plan task to its `tasks.md` item through the back-reference, ticks, then commits `tasks.md` with a fixed message. | `tasks.mjs tick --plan-task <N> --change <n> --root <r> --commit`: resolves the item from the back-reference, ticks, commits `tasks.md` (and `plan.md` when amended) with the fixed message, returns `{item, sha}`. | Deciding that the task is complete (its review passed or the breaker parked it). | high | S |
| A11 | instr/apply.md:273-281 | Detects a file outside its task's Files block after a fix, sweep or merge, chooses the owning task (the one whose files it changed most), and writes the dated, backticked "Added during apply" bullet. | `plan.mjs unplanned --change <n> --root <r>` (reuse `checkOutOfPlan`, lib/verify.mjs) lists such files with a proposed owner; `plan.mjs added --path <p> --why <w> [--task <N>]` inserts the bullet with the date and the verb. | The `why`; overriding the owner. | high | S |
| A12 | instr/apply.md:283-303 | After `group-merge`, finds the merge's first parent and the merge commit and cuts the merge-review package. | `group-merge` returns `{mergeCommit, firstParent, package}` by calling A4's `package`. | The merge review, the conflict resolution. | med | S |
| A13 | instr/apply.md:305-318 | Runs `group-remove`, then builds the forge `push` JSON (branch, protected list) by hand. | `workspace.mjs group-finish --change <n> --group <N> --root <r>`: removes the worktree and branch, pushes through the forge role with values it reads itself, returns `{removed, push:{state, hint}}`. | Nothing. | med | S |
| A14 | instr/apply.md:320-331, 458-465 | Tracks which wave-2 groups may start, which group is `BLOCKED`, and on resume rebuilds the state from the ledger, `tasks.md`, `git log` and `workspace.mjs groups`. | `plan-graph.mjs schedule` (A5) reads merged groups (merge commits), kept worktrees and the last `handoff` record; `apply-status.mjs --change <n>` returns `{merged, blocked, startable, ticked, remaining, openDebt, lastHandoff}`. | When to hand off (observable proxies), what to do with a blocked group. | med | M |
| A15 | instr/apply.md:340-361 | Computes the sweep's range (`origin/<base>` or `<base>`, merge-base), decides whether the deltas carry `REMOVED` or `RENAMED`, and must not report pairs already carrying a `DUP` marker. | `sweep.mjs inputs --change <n>` returns `{range, base, removedOrRenamed:[{requirement, codeDisposition}], dupMarkers:[{file, line, existing}]}`; `sweep.mjs filter <reply>` drops findings a marker covers. | The sweep's question itself. | med | S |
| A16 | instr/apply.md:375-396 | Places the `DUP` marker in the file's comment syntax and records `ledger.mjs debt --accepted`. | `dup.mjs mark --file <f> --line <l> --existing <e> --reason <r> --change <n>`: a comment-syntax table by extension, refusal for a format without one, and the debt record in one call. | Getting the developer's dismissal and reason. | med | S |
| A17 | instr/apply.md:398-436 | Reads the whole-suite command from the planning guide, runs it in the root, reads the raw output, on failure makes a base-check worktree, runs again, removes it, compares, writes `.apply-test-record.md` (`**Commit:**`, command, real output, counts) and commits it last. | `suite.mjs run --change <n> --root <r> [--base-check] [--record --commit]`: output to a file, never to the context; `{exit, counts, failing, base:{exit, failing}, preExisting, newFailures, recordSha}`. | No command in the guide (find one, propose it to the developer); a failure set that only partly overlaps the base's when the runner's names cannot be parsed; the pause. | high | M |
| A18 | instr/apply.md:400-406 | On the developer's confirmation, writes the command under `## Whole-suite command` and commits with a fixed message. | `planning.mjs set-suite "<cmd>" --root <r> --commit`. | Finding the candidate command and asking. | low | S |
| A19 | cmd/apply.md:106-143 | Fills the Complete or Paused template (progress, open debt count from `ledger.mjs list`, push state). | `apply-status.mjs --report` (A14) renders the Complete block; the Paused block's issue and options stay prose. | The issue text and the options when paused. | low | S |

### verify

| # | Where (file:line) | What the LLM does now | Script proposal (command, input, output) | What stays with the LLM | Value | Effort |
|---|---|---|---|---|---|---|
| V1 | cmd/verify.md:22-60; instr/verify.md:15-21 | Same isolation sequence as apply (gate, two `rev-parse`, `suggest`, `ledger session`, `instructions verify` and its dependencies). | `preflight.mjs --phase verify` (A1), which also refuses when a dependency of `verify` is not done. | Confirming the change. | high | S (after A1) |
| V2 | cmd/verify.md:62-64; instr/verify.md:25-31, 155-160 | Decides `--fresh` ("first run of the session") and keeps every approved skill-edit sha, re-reading them from the committed `verify.md` in a later session. | `verify.mjs run` compares the session id stored in `run.json` with `CLAUDE_CODE_SESSION_ID` to decide fresh, and reads approved shas from ledger records (`ledger.mjs skill-edit --sha <s>`). | Nothing. | high | S |
| V3 | instr/verify.md:105-117 | Writes the c4 and c8 prompts with the change, root, base and range from `run.json`, files in scope, the two output paths. | `verify.mjs prompt c4|c8 --change <n>` (uses A6/A7) emits the prompt with every fixed field, including the enumerated host skill files for c8. | The judgement inside the dispatch. | med | S |
| V4 | instr/verify.md:140-149 | The c8 agent reads every host skill against the whole diff. | `verify.mjs skill-candidates`: for each `.claude/skills/*/SKILL.md`, README and manifest, the lines that name a path, symbol, command or route the diff changed. The agent reads candidates only. | CONFIRMED, PLAUSIBLE or none; the proposed edit. | med | M |
| V5 | instr/verify.md:155-161 | Commits the approved skill edit touching only `.claude/skills/`, passes its sha to every later `run`, re-runs `run` and c8. | `verify.mjs skill-edit --change <n> --commit -m "<msg>"`: refuses any path outside `.claude/skills/`, commits, records the sha in the ledger, re-runs `run`. | The approval, the edit text, the message. | med | S |
| V6 | cmd/verify.md:74-75; instr/verify.md:62-86 | Dispatches `verify c6` at the integration level to run the whole-suite command, the base check and to write the section with real counts. | `suite.mjs run --section test-record --change <n>` (A17) writes `verify/test-record.json` and its output file. No agent. | A suite that cannot run (ruling with the developer); a partial overlap with the base. | high | S (after A17) |
| V7 | instr/verify.md:186-189 | Writes `developer.txt`; how its section JSON is produced is not stated. | `verify.mjs developer --text-file <f>` writes the output file and its section object. | Running the check with the developer; the text. | low | S |
| V8 | cmd/verify.md:84-86; instr/verify.md:204-218; templates/verify.md | Dispatches `verify assemble` (mechanical level) to fill the template "deciding nothing", then confirms the last line equals the verdict's `line`, then runs the two-step commit. | `verify.mjs assemble --change <n> --commit`: renders `verify.md` from the template, `run.json`, the sections (verbatim output files), `verdict.json`, rulings and skill-edit shas; c4's section carries structured fields (`proseEdits`, `removalAccounting`, `exercised`) so nothing is decided at assembly; asserts the last line; commits `verify.md` alone; returns `{sha, verdict}`. | Nothing (c4 writes its own fields). | high | M |
| V9 | cmd/verify.md:80-82; instr/verify.md:191-202 | Maps each refusal to a re-dispatch or a ruling request. | `verdict` adds `redispatch:[id]` and `needsRuling:[id]` to its refusal object. | Asking the developer; deciding a ruling exists in their words. | low | S |
| V10 | cmd/verify.md:88-99 | Fills the report from the verdict. | `verify.mjs verdict --report` renders the block (failing, warnings, accepted, next step). | Nothing. | low | S |

### cross-cutting

| # | Where (file:line) | What the LLM does now | Script proposal (command, input, output) | What stays with the LLM | Value | Effort |
|---|---|---|---|---|---|---|
| X1 | cmd/propose.md:98-109; instr/apply.md:264-267, 405-406, 431-436; instr/verify.md:155-157, 213-218 | Six commit shapes written as raw git: stage exact paths, check nothing else is staged, commit with a pathspec and a fixed or Conventional message. | `commit.mjs --root <r> --only <path...> --message <m>`: stages only the paths, refuses other staged content, refuses a protected or detached branch and the main checkout, commits with `--`, returns `{sha, files}`. Used by P15, A10, A17, A18, V5, V8. | Free-form messages (skill edit). | med | S |
| X2 | instr/resolve.md:22-34 | Groups `find` entries, spots one name in two checkouts, shows unresolved worktrees. | `changes.mjs find` adds `duplicates` and a `choices` list (name, root, branch, progress) ready to show. | The developer's choice. | low | S |
| X3 | every command after selection (cmd/apply.md:32-33, cmd/verify.md:32-33, instr/resolve.md:38-39) | Threads `--change <n> --root <r>` into every call by hand; a call without `--root` runs on the cwd, often the main checkout. | Each core script infers `--change` from a root that holds exactly one active change, and refuses the main checkout for a change-scoped operation unless told otherwise. | Nothing. | low | S |
| X4 | cmd/propose.md:19-20; cmd/apply.md:15-17; cmd/verify.md:14-17 | Names read-only dispatches `investigate <topic>`, `verify c4` etc. by memory. | `dispatch.mjs plan --role investigate --topic <w>` (A6) for every phase. | The topic word. | low | S |

Row count: 53 (high 18, med 19, low 16).

## 2. Patterns

1. **`preflight` per phase.** A1 and V1, and ahead review, archive and quick task, repeat one
   shape: gate, isolation (`show-toplevel` = root, root ≠ main), branch neither null nor
   protected, session record, instruction state, phase-specific checks (SDD workspace and plan
   symbols for apply, dependencies for verify, passing `review.md` at HEAD for archive). One
   `preflight.mjs --phase <p>` with a per-phase check table. Selection stays a developer question.
2. **Gates bound to artifacts, not to recall.** P4, P5, P6, P7, P9, P10, P12, P13, P14: `changes.mjs
   done <id>` runs the artifact's declared gates from `schema.json`; `next` and the commit refuse
   while one fails. The LLM fixes findings; it never decides whether to run a gate.
3. **One plan model.** `plan-symbols`, verify's `plannedPaths`/out-of-plan, the tick
   back-reference, the graph, the schedule, test-first, the split rule and "Added during apply"
   all parse `plan.md`. One `lib/plan.mjs` parser with subcommands (`lint`, `graph`, `schedule`,
   `unplanned`, `added`, `owner-of`) removes the duplicate readers.
4. **Dispatch builder.** A6, A7, V3, X4: name, agent level, reply file and the prompt skeleton
   come from fixed fields. The LLM writes only the question. Reply retries are counted by
   `reply.mjs` (A8).
5. **Scripts read state; the LLM does not carry values between scripts.** P16, A13: today the
   orchestrator copies `protected`, `branch` and `base` from one JSON into another script's JSON.
   Every value already lives in git, `.adf.json` or the registry.
6. **Record assembly.** V8 now, and ahead `review.md`, the merge request description, the test
   record (A17), and every command's final report: a template renderer fed by structured
   sections. A judgement dispatch writes structured fields; a script writes the document.
7. **Command runner with output to file.** A17 and V6 (and iteration 12's scoped test run): a
   runner that writes raw output to a file and returns counts, exit codes and the base
   comparison, so raw output never enters a context.
8. **Commit with fixed paths** (X1) everywhere a phase commits.
9. **Composite subcommands** for fixed multi-call sequences: `init`+`check`, `add`+`check`,
   `group-merge`+package, `group-remove`+push, tick+commit.

## 3. Ahead (roadmap iterations 09-18)

| # | Iteration | Scriptable from the start | Stays with the LLM |
|---|---|---|---|
| 09 | Review | `preflight --phase review` (refuses without `verify.md` whose `Verdict:` is PASS or PASS WITH WARNINGS); the diff against the whole branch from the integration branch, never narrowed (forge-gitlab lessons row 60) and the same diff filter CI uses; the verdict checker of the tuned review output; round naming `review r<k>`, `fix r<k>`; `review.md` assembled from the reviewer's structured verdict and the dispositions, with `## Recorded findings` rendered; the commit of `review.md` alone; recording the reviewed HEAD sha that archive checks. | The review, fix decisions, adjudicating a disputed finding. |
| 10 | Archive and wiki memory | Refusal unless `review.md` passes at HEAD and `ledger list --unresolved-debt` is empty; the **spec merge**: `specs.mjs` already ports the delta parser, and the apply order RENAMED → REMOVED → MODIFIED → ADDED (templates/spec.md:77) is mechanical, yet `agents/architecture.md:3` and the `spec-merge` reply role plan an agent for it, so make it a script and dispatch only a conflict; moving the change to `archive/<date>-<name>/`; copying `ledger.jsonl` once after the last write; writing each debt resolution to its ledger file; log entry header and rotation; the merge request body: What from `tasks.md`, Why from `proposal.md`, QA candidates from `#### Scenario` blocks and verify's developer checks, written to a temp file outside the repository; `forge finalize`; worktree removal by the listed path, never forced; the no-forge merge after the developer's yes. | Placing each debt (tech-debt, flow-debt, follow-up, accepted); the memory ingest; the wording of What, Why and QA. |
| 11 | Metrics and retrospective | All metrics: dispatch names, levels, rounds, tokens and timings parsed from transcripts and the ledger; window selection of changes merged since the last retrospective. | The retrospective's conclusions and the removal candidate. |
| 12 | Project stack plugin | Provisioning decided from the plan's Files blocks (lessons apply row 57), per-worktree database create and drop, the test runner scoped from a package map (verify lessons rows 89-92), migration order, an uncached-proof assertion (`Cached: 0`); all behind `preflight` and the suite runner (pattern 7). | None in the core path. |
| 13 | Tracker plugin: Jira | Context fetch at propose, transitions on start and after merge, `forge.state` reads, the land step; all role operations returning one JSON object. | Summarising the fetched context into the brainstorm. |
| 14 | Behaviour check | The replay harness (sandbox copy at each change's base commit), and a structural comparator: artifact headings and sections, branch name, ledger kinds and counts, merge request fields, dispatch names. | Classifying a difference as strong or acceptable. |
| 15 | Switch the origin project | Migrating in-flight changes: writing `.adf.json` (base, schema version) from the origin's metadata, registry init and `add` in one script with a dry run. | Deciding which in-flight changes move. |
| 16 | Update | Entirely scriptable: version comparison, plugin update, registry and host-file migration, a diff report of what changed. | None. |
| 17 | Quick task | Reuse `preflight`, `propose.mjs start`/`create`, `commit.mjs`, the forge calls, the suite runner and a quick-task lint of its two artifacts. | The short plan and summary; the optional discuss and research steps. |
| 18 | Live check | A scripted matrix: the English-check hook in a scratch repository (blocked and clean commits), the GitLab plugin's degraded paths (`glab` absent, logged out) against a test project, run per OS in CI. | The subagent leg (a commit made by a dispatched agent) needs an agent run. |

Also open from iteration 08 (`docs/iterations/08-verify.md:55-57`): the artifact list and the
cycle's commands compared with the schema description, and optional artifacts derived from
`requires`. Both are structural comparisons and belong in `flow-regression.spec.mjs`, not in an
agent check.

## 4. Evidence: incidents where an LLM did a mechanical step

Lessons rows cite the line of the table row in the lessons file.

| Lessons row | Incident | Candidate that removes it |
|---|---|---|
| apply.md:88 | A failed `rev-parse` resolved the branch to `''` and the protected-branch guard passed on it. | A1, V1 |
| apply.md:54 | The SDD check run with a literal `<name>` placeholder gave a false STOP. | A1 |
| apply.md:38, apply.md:44; verify.md:59 | Steps run from the main checkout: `node_modules` symlinked onto itself, a worktree attempted for a checked-out branch, the plan check reported false findings. | A1, V1, X3 |
| apply.md:52, apply.md:53 | The SDD basename collision recurred three times; a controller skipped completed work. | A3 |
| apply.md:55 | J1: `task-brief` and `review-package` wrote into `plan/` on two changes after the rule existed. | A4 |
| apply.md:90, apply.md:91 | 17 of 39 dispatches missed the naming form, nearly all in verify and review. | A6, X4 |
| apply.md:94 | Reply overwrites lost layer counts; three writers corrupted one `progress.md`. | A6 |
| apply.md:86 | A working-directory sentence did not bind later calls and a group bypassed the review gate; `git add -A` destroyed two uncommitted files. | A7, X1 |
| apply.md:102 | Four tests passed against their own unfixed code; no reviewer ran the prove-it-can-fail step. | A9 |
| apply.md:113; `scripts/lib/tasks.mjs:1-2` | A tick missed or put on the wrong line fails verify check 2. | A10 |
| apply.md:116; verify.md:115 | Out-of-plan check failed after a correct apply three times; the plan was amended by hand after the fact (ten files on one change, fourteen on another). | A11 |
| verify.md:104 | An approved skill edit failed out-of-plan until a task was back-filled by hand. | V2, V5 |
| apply.md:80, verify.md:140 | Fabricated `psql` transcript; "142/142 green" true only under a reverted override, both claims from the cheapest level. | A17, V6 (the script runs the suite; no agent claims it) |
| apply.md:131, apply.md:133 | A cached green hid 11 failing tests of 478; the whole-suite gate was overridden by hand twice in one session. | A17 |
| apply.md:135 | A test record written before the last commit leaves a range verify reports. | A17 (`--record --commit` as the last step) |
| verify.md:129, verify.md:84 | A free-form record outside the template; a template box ticked on no evidence. | V8 |
| propose.md:92 | The first-line SHALL rule was hit only at verify. | P4 (gate already scripted, now bound) |
| propose.md:113 | Greps written from reasoning stopped three of seven tasks on a wrong baseline; the scripted scan found five defects in four minutes. | Proof the principle pays: P9, P10, P11 extend it. |
| propose.md:61; apply.md:109 | Of 13 hand-written ledgers, two had a parseable session line. | Already scripted (`ledger.mjs`); same lesson for A11, A16. |
| propose.md:138 | The title read `Draft: Draft:` from a prefix the agent added. | P16 |
| propose.md:140 | A caller that left the change worktree handed the main checkout's branch to the push guard. | P16, A13 (the script reads the branch) |
| apply.md:104 | Eight per-task reviews missed a reference to a deleted file. | P11 |
| apply.md:64; propose.md:109 | A 22-task plan ran serially because the graph section was omitted. | P10, A5 |
| forge-gitlab.md:61 | The merge request step was inserted after the `cd` to the main checkout and would have pushed `develop`. | Pattern 1 (`preflight --phase archive`), iteration 10 |
| verify.md:111, verify.md:105 | Count literals and check lists drifted across three surfaces five times. | Iteration 08 open rule (structural test) |

## 5. Side findings

- `scripts/forge.mjs:4` and its usage error (line 32) name `check|open|finalize`, but apply calls
  `forge.mjs push` (instr/apply.md:309) and contract 1.2 defines it. The help text is stale.
- `workspace.mjs suggest` returns `path` but no `exists` field, so cmd/propose.md:45-46 leaves the
  existence test to the agent (P1).
- How `developer.txt` becomes a section that `verify.mjs verdict` reads is not stated
  (instr/verify.md:186-189 versus `computeVerdict`, which reads only `*.json` sections) (V7).
