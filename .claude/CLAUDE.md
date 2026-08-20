# CLAUDE.md — Agentic Dev Flow

This file is the flow's own instruction set, extracted from the origin project so it can
be adopted elsewhere. It carries only the two sections that define the flow: the wiki
memory the archive stage writes into, and the OpenSpec change workflow itself. A host
project's own principles, stack rules and domain conventions are not here — add them
around this file, or fold these two sections into an existing CLAUDE.md.

The section numbering below is local to this file. Where a command, skill or spec refers
to "CLAUDE.md §5", it means Section 2 here — see "Adopting this in a host project" at the
bottom.

## 1. Wiki Memory & Agent Rules

### Wiki Memory (Karpathy Method)

**At session start:** read [`.claude/memory/index.md`](.claude/memory/index.md) to load the
knowledge catalog before any work.

Knowledge base lives in `.claude/memory/`:
- **index.md**: catalog of `entities/`+`concepts/` pages, one-line summary each, by
  category. Read first for any query.
- **log.md**: reverse-chronological, current month only. Entry format:
  `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>` (types: `ingest`/`query`/`lint`/`task`;
  author = `git config user.name`), prepended below the `# Log` heading and its rotation
  note, no blank lines between an entry's list items. **Don't duplicate what git already
  carries**: a mechanical `task` entry already covered by a commit gets a one-line pointer
  (`see commit <sha> — <one-line reason>`); expand to full bullets only for what git *can't*
  reconstruct (`query` entries with no commit, cross-page connections, non-obvious "why",
  things deliberately left undone).
- **log-archive/**: prior months of `log.md`, one file per month
  (`.claude/memory/log-archive/YYYY-MM.md`), read-only (grep it, don't Read it whole).
- **system.md**: high-level system overview and architecture.
- **entities/**: pages for specific modules, components, classes, services.
- **concepts/**: pages for patterns, protocols, workflows, decisions.

**Timestamp rule:** before writing ANY entry to `log.md`, run `date '+%Y-%m-%d %H:%M'` via
Bash — never a hardcoded or guessed timestamp.

**Log Rotation Check** (before prepending any `log.md` entry, all types; self-triggering):
invoke the `log-rotation` skill (`.claude/skills/log-rotation/`). No-op when the oldest
entry is already in the current month. Then prepend the new entry.

**Ingest Workflow** (when new knowledge is gained):
1. Extract key information.
2. Write or update the relevant page(s) in `entities/` or `concepts/`.
3. Update cross-references on related pages (a single ingest may touch 5–15 pages).
4. If a new page was created, add it to `index.md` with a one-line summary.
5. Log Rotation Check, then prepend an `ingest` entry.

**Query Workflow** (when answering a question about the codebase):
1. Read `index.md` to identify relevant pages; read them and synthesize the answer.
2. If the answer reveals new knowledge, run the Ingest Workflow.
3. Valuable analysis or decisions MAY be filed as new pages.

**Task Completion Workflow** (after completing any task):
1. Run `git diff HEAD -- .claude/memory/log.md`. If an uncommitted entry at the top covers
   the same task → update it in place, do NOT prepend. Otherwise → Log Rotation Check, then
   prepend a `task` entry.
2. If new knowledge was gained, run the Ingest Workflow.

**Lint Workflow** (periodically or on request):
- Check for contradictions, stale claims, orphan pages, concepts lacking their own page,
  missing cross-references. Fix what can be fixed; flag the rest.
- Log Rotation Check, then prepend a `lint` entry.

## 2. OpenSpec Change Workflow

Cycle: `/opsx:propose <change-name>` → `/opsx:apply` → `/opsx:verify` → `/opsx:review` → `/opsx:archive`.

Eight artifacts, in this order, under `openspec/changes/<change-name>/`:

| Artifact | Produced by | Answers |
|---|---|---|
| `brainstorm.md` | `superpowers:brainstorming` | which approach, and what was rejected |
| `proposal.md` | OpenSpec | why, and which capabilities |
| `design.md` (optional) | OpenSpec | how, at the architecture level |
| `specs/**/*.md` | OpenSpec | what the system must do (delta format) |
| `tasks.md` | OpenSpec | what is delivered, in what order |
| `plan.md` | `superpowers:writing-plans` | how each task is executed |
| `verify.md` | `/opsx:verify` | did it actually get built |
| `review.md` | `/opsx:review` | did the tuned code review find anything, and what happened to it |

Apply is blocked until `plan.md` exists. Implementation runs through
`superpowers:subagent-driven-development`, which brings a per-task code review
unconditionally; TDD is enforced when the task's own text in `plan.md` calls for it, not
as a guarantee of the skill itself.

- **`/opsx:propose` is the single entry point.** There is no `/opsx:explore` — the
  brainstorm artifact covers that stage.
- Exempt (fix directly): typos, formatting, dependency bumps, bug fixes that restore
  already-specified behavior. If a "bug fix" turns out to change what the system should do,
  stop and propose.
- **Superpowers is required.** Each `/opsx:*` command checks for it first and stops if
  missing (except the read-only `/opsx:sync`, which writes nothing). Install with
  `claude plugin install superpowers@claude-plugins-official`. Never do a missing skill's
  work manually.
- **One branch and one worktree per change**, created at propose time:
  `<type>/<TASK-ID>/<short-description>`, branched from `origin/develop` into
  `.claude/worktrees/<TASK-ID>/`. `develop` is never checked out and never committed to
  directly. A developer already mid-feature may instead ask to stay on the current branch;
  then no branch/worktree is created and every later command works in place — but only
  while that branch is not `develop`, which each command refuses outright.
- **`npm install`/`npm ci` are never run inside a worktree**, except when the change
  itself touches the dependency manifests or the ORM schema. A dependency update is a
  separate task and a separate merge request.
- `openspec/specs/` is written **only** by `/opsx:archive`. Never hand-author or backfill it.
  One exception: a capability's introductory prose, above its `## Requirements` heading, is
  not a requirement and no delta merge can reach it. When a change makes that prose
  contradict the requirements it introduces, the change edits it by hand, on its own branch,
  and `verify.md` records which capabilities and why. Nothing below `## Requirements` is ever
  edited outside archive.
- **The branch is integrated by the developer, through a merge request.** Propose pushes
  the branch and opens a Draft merge request; apply pushes after each task group. Archive
  ends the cycle: it refuses a change with no passing `review.md` whose commit is still
  HEAD, merges the delta specs, commits the archive move and the memory ingest, takes the
  merge request out of draft, pushes, and removes the worktree. It does not merge:
  `develop` is only reached through a merge request the developer merges. The local branch
  survives archiving; the forge deletes the remote branch on merge.
- Keep `openspec/config.yaml` current when architectural invariants change.
- **Match the agent to the work.** Every dispatch names the capability level it runs at,
  chosen to fit the task: mechanical work with a complete spec → cheapest capable level;
  integration and debugging → middle; architecture, adjudication and the whole-branch
  review → highest available. Never hardcode a model or vendor name — this flow is
  executed by more than one agent runtime.
- **Group tasks before dispatching, don't default to one subagent per checkbox.** When
  writing `tasks.md`, merge checkboxes into one when either holds: (1) *cascading* — items
  touch the same file/test suite and fixing one likely reveals the next (a stale-mock
  cascade across one test file once cost four implement+review round trips because the
  file was never read in full first); investigate the whole file/domain first — read-only,
  via `superpowers:dispatching-parallel-agents` if several such domains exist — and write
  one checkbox covering everything found. (2) *mechanical* — several items are each small
  and independent, and reviewing them together loses no clarity. Keep checkboxes separate
  when a task is risky, large, or needs isolated review attention — grouping trades review
  granularity for round trips, so only spend that trade where granularity wasn't buying
  anything.
- **Independent task-groups can run in parallel, in their own worktrees.** When `plan.md`
  groups its tasks and the groups are independent or weakly coupled, `writing-plans` may
  lay out a two-tier execution graph and `subagent-driven-development` fans wave-1 groups
  into sibling worktrees, capped at 2-3 at once — full mechanics in the
  `parallel-group-execution` capability (`openspec/specs/parallel-group-execution/spec.md`)
  and `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `apply` instruction. Additive:
  a plan with no independent groups behaves exactly as before.
- Section 1 workflows still apply: the archive stage ingests what was learned into
  `.claude/memory/` — that replaces a per-change retrospective.
- **Never run `openspec update`.** It rewrites `.claude/commands/opsx/` and
  `.claude/skills/openspec-*/` from the CLI's own templates, which deletes the
  availability gate, the branch model, the worktree lifecycle and the provisioning
  decision — 140 lines, measured — and restores the removed `/opsx:explore`. If it has
  already been run, `node .claude/scripts/check-opsx-commands.mjs` names what was lost;
  restore those files from git before doing anything else.

## 3. Flow Documentation

`openspec/specs/` is the authoritative statement of what the flow does — nine capabilities,
listed in `README.md`. When behaviour and documentation disagree, the spec is right.

`.claude/memory/concepts/opsx-workflow.md` explains *why* the flow is shaped the way it
is — the incidents each guard was built against, and the approaches that were tried and
dropped. It is cross-check material, never the spec: where the two disagree, the spec is
right and the page is stale.

## 4. Adopting This In A Host Project

The commands, skills and specs copied here refer to `CLAUDE.md` **§5** for the change
workflow and **§4** for the wiki memory, matching the origin project's numbering. Two ways
to resolve that:

- Fold Section 1 and Section 2 above into the host `CLAUDE.md` as its §4 and §5, and the
  references resolve untouched. This is the lower-risk path.
- Or keep this file as-is and renumber the references. Missed renumbering is a known
  failure mode — a reference that points at a section which has since moved reads as
  authoritative and is not. Expect to grep for `CLAUDE.md §5` and `CLAUDE.md §4` across
  `.claude/` and `openspec/`.

Then configure it. Nothing below requires editing logic — the forge host comes from the
environment, and the rest is filling in what only this project can know.

1. `openspec/config.yaml` — replace the placeholder `context:` and the `rules:` bodies with
   this project's own. The file ships as a template, not a working config; the propose and
   design stages read it, so whatever is missing here is what the agent will not know.
2. The forge host — set `GITLAB_HOST`, or rely on `CI_SERVER_HOST`, which GitLab CI defines
   already. `infra/claude/review.sh` exits 2 with a named error when neither is set, and
   `.claude/scripts/mr.mjs` prints `<your-gitlab-host>` in its auth hint.
3. `.claude/commands/opsx/verify.md`, the test-selection step — it asks for this
   repository's path-to-package mapping. A single-package repository needs no mapping; a
   monorepo should state it, and adapt the test command if it does not use turbo.
4. `.gitlab-ci.flow.yml` — merge into `.gitlab-ci.yml` per the instructions in that file's
   header, set the runner tag, and define `AI_CLAUDE_INSPECT_ENABLED`, `ANTHROPIC_API_KEY`
   and `GITLAB_API_TOKEN`.
5. The integration branch is `develop` throughout the commands and specs. A project that
   integrates into `main` must change it in both places.
