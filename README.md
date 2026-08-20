# Agentic Dev Flow

A spec-driven change workflow for agent-executed development: every feature and every
behaviour change goes through `propose → apply → verify → review → archive`, leaving
behind a spec, a plan, a verification record, a review record, and a merge request a human
merges.

This repository is the flow itself, extracted from the project it grew in. It contains no
application code — only the commands, specs, schema, guard scripts, review harness and CI
fragment that make the flow run.

Start with the cycle table below for what the flow does. Read `.claude/CLAUDE.md` for the
agent-facing rules, `openspec/specs/` for what each stage is contractually required to do,
and `.claude/memory/concepts/opsx-workflow.md` for *why* each guard exists.

## The cycle

| Stage | Command | What it does |
|---|---|---|
| Propose | `/opsx:propose <name>` | Brainstorms the approach, creates the branch and worktree, writes the artifacts, pushes, opens a Draft merge request |
| Apply | `/opsx:apply` | Implements each task group through a fresh subagent with a per-task review, pushes after each group, runs the full test suite once at the end |
| Verify | `/opsx:verify` | Eight checks — specs, tasks, spec sync, design coherence, clean tree, affected-package tests, stray worktrees, stale skills — into `verify.md` |
| Review | `/opsx:review` | Runs the same review prompt CI runs, fixes CRITICAL and HIGH in place, writes `review.md` |
| Archive | `/opsx:archive` | Merges the delta specs, moves the change to the archive, ingests into memory, undrafts the merge request, pushes, removes the worktree |
| Sync | `/opsx:sync` | Read-only: reports delta-spec sync state |

Agents never merge and never push to the integration branch. The merge request is the only
path in, and a developer merges it.

## Layout

```
.claude/CLAUDE.md                       the agent-facing rules: memory + the change workflow

.claude/commands/opsx/                  the six slash commands
.claude/skills/
  ai-code-review/                       runs the CI review prompt locally, before the MR does
  openspec-sync-specs/                  archive's delta-spec merge subroutine
  flow-retro/                           token/time retrospective over a past session
  log-rotation/                         monthly rotation of the memory log
.claude/scripts/
  check-superpowers.mjs                 the availability gate every command runs first
  check-opsx-commands.mjs               detects what `openspec update` would have destroyed
  check-sdd-workspace.mjs               worktree/workspace state guard
  check-workflow-shape.mjs              design-vs-reality coherence check used by verify
  check-english.mjs                     pre-commit guard: repository artifacts stay English
  mr.mjs                                merge request create/update/undraft plumbing
  *.test.mjs                            node:test unit tests for all of the above

openspec/
  specs/                                the nine capabilities that define the flow
  schemas/sdd-plus-superpowers/         artifact order, per-stage instructions, templates
  config.yaml                           TEMPLATE — replace the context and rules
  changes/                              where a change lives while it is in flight

infra/claude/
  review-prompt.md                      the review prompt, shared by CI and /opsx:review
  review.sh                             fetches the MR diff, calls the API, posts the verdict
  review-verdict.sh                     parses the verdict into an exit code
  review-verdict.test.sh                its unit tests

.gitlab/merge_request_templates/opsx.md the What / Why / QA description template
.gitlab-ci.flow.yml                     CI fragment: the draft-quiet anchor and the review gate
.lefthook.json                          pre-commit: the English guard
```

The nine capabilities under `openspec/specs/`: `change-workflow-schema` (the cycle and its
artifacts), `change-branch-isolation` (branch and worktree lifecycle),
`merge-request-lifecycle` (who pushes and undrafts, and when), `ci-unit-testing` (which
stage runs which tests), `ai-review-flow-stage` (the local review stage),
`ai-review-ci-gate` (the merge request gate), `superpowers-availability-gate` (why every
command stops without the plugin), `parallel-group-execution` (independent task groups in
sibling worktrees), `flow-retrospective` (the retro).

## Prerequisites

```
claude plugin install superpowers@claude-plugins-official
```

Required. Every `/opsx:*` command except the read-only `/opsx:sync` checks for it first and
stops if it is missing — a degraded flow fails loudly rather than silently skipping steps.

```
brew install glab
glab auth login --hostname <your-gitlab-host>
```

Optional. Without it nothing breaks: the merge request steps degrade, print the command to
run later, and the cycle continues.

Node 22 or newer, for the guard scripts and their tests.

## Configuration

Every environment variable the flow reads is documented in `.env.example`, including which
ones GitLab CI supplies on its own and must not be set by hand. Copy it and fill in the
four required values:

```
cp .env.example .env
```

`ANTHROPIC_API_KEY` and `GITLAB_API_TOKEN` are secrets — in CI they belong in masked
project variables, not in a file. `AI_CLAUDE_INSPECT_ENABLED` defaults to `false`, so the
review gate stays off until you turn it on.

### GitLab CI/CD variables

Set these under **Settings → CI/CD → Variables** in the project that runs the pipeline.
Anything not listed here is either predefined by GitLab or has a working default in
`infra/claude/review.sh`.

| Variable | Required | Masked | Protected | Value |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | **yes** | see note | Anthropic API key the review calls with |
| `GITLAB_API_TOKEN` | yes | **yes** | see note | Project or personal access token, `api` scope — reads the MR diff and posts the verdict |
| `AI_CLAUDE_INSPECT_ENABLED` | yes | no | no | Exactly the string `true`. Any other value and the gate never runs |
| `GITLAB_HOST` | no | no | no | Only outside GitLab CI. In CI the predefined `CI_SERVER_HOST` is used |
| `CLAUDE_MODEL` | no | no | no | Defaults to `claude-opus-5` |
| `CLAUDE_MAX_TOKENS` | no | no | no | Defaults to `32000` |
| `CLAUDE_THINKING` | no | no | no | `adaptive` (default) or `disabled` |
| `CLAUDE_EFFORT` | no | no | no | `low`, `medium` (default), `high`, `xhigh`, `max` |
| `CLAUDE_PRICE_INPUT` / `_OUTPUT` / `_CACHE_WRITE` / `_CACHE_READ` | no | no | no | Per-million-token rates for the cost line only. Override to correct a stale rate |

**Do not mark the two secrets Protected unless every branch that must run the review is a
protected branch.** A protected variable is not exposed to pipelines on unprotected
branches, so the review job would start, find the key missing, and fail — on exactly the
feature branches the gate exists to check. Mask both; that is the setting that keeps them
out of job logs.

Two more knobs are pipeline-level rather than variables: the runner tag in
`.gitlab-ci.flow.yml` (`your-runner-tag` as shipped) must name a runner that can reach
`api.anthropic.com`, and the job's `needs:` must point at a job that exists in your
pipeline.

### Model, cost, and thinking

**The review is the expensive part of this flow, and the default model is the expensive
tier.** It runs once per non-draft merge request pipeline, and each run sends the whole MR
diff plus a large prompt. Budget for it deliberately:

- The default is `claude-opus-5` at **$5 per million input tokens and $25 per million
  output** — roughly 1.7× a Sonnet-tier model on both sides. The prompt is cached
  (`cache_control`), so repeat runs on the same prompt bill the prompt portion at
  cache-read rates; the diff is never cached because it differs every time.
- Every report carries its own token counts and a computed cost line, so real spend is
  visible per MR rather than estimated. Those figures come from a rate table in
  `infra/claude/review.sh` — the API does not report prices, so **a model change needs a
  matching table entry**, otherwise the cost line confidently describes the wrong model.
  Unknown models report `0` and log a warning rather than guessing.
- To spend less, lower `CLAUDE_EFFORT` before changing anything else. `low` and `medium`
  are strong on this model and the review stays accurate; effort is the real cost lever.
  Switching to a Sonnet-tier model is the larger saving, and the rate table already covers
  it.

**Thinking is on by default on this model, and that has two consequences worth knowing.**

First, `max_tokens` caps thinking *and* response text together. A budget sized for a
thinking-off model gets spent on reasoning and truncates the report — which then fails the
script's own structural check and **fails the pipeline for a reason that has nothing to do
with the code under review**. That is why `CLAUDE_MAX_TOKENS` defaults to `32000` here
rather than a tighter number. If you see `stop_reason` warnings or missing report sections,
raise it before suspecting the prompt.

Second, turning thinking off is not the cost lever it looks like. With
`CLAUDE_THINKING=disabled` this model can leak literal `<thinking>` tags into its visible
answer — which here means into `claude-review.md`, the artifact reviewers read. It is also
rejected outright above `high` effort: `disabled` together with `xhigh` or `max` is a 400,
so `review.sh` catches that combination up front and exits 2 (a yellow pipeline and a named
configuration error) instead of letting it surface as an opaque API failure. Prefer
`adaptive` thinking at lower effort.

The review reads only the response's text block, so thinking content never reaches the
report either way — `thinking.display` stays at its default and no reasoning is surfaced.

## Adopting it in a project

`.claude/CLAUDE.md` §4 is the checklist. In short: fold its sections 1 and 2 into your own
`CLAUDE.md` as its §4 and §5 (which keeps every internal `CLAUDE.md §5` reference
resolving), then configure five things — `openspec/config.yaml`, the forge host via
`GITLAB_HOST` or `CI_SERVER_HOST`, the path-to-package mapping in
`.claude/commands/opsx/verify.md`, the CI fragment, and the integration branch name if it
is not `develop`.

The flow is written against GitLab and the `glab` CLI. Nothing in the cycle depends on
GitLab except `.claude/scripts/mr.mjs` and `infra/claude/review.sh`; porting to another
forge means reimplementing those two.

## Tests

```
npm test
```

Runs the `node:test` suites for the guard scripts and the bash suite for the verdict
parser. No network, no application code, no dependencies beyond Node itself (`lefthook` is
only needed if you want the pre-commit hook).

## What was deliberately left out

This is an extract, not a fork. Absent by intent: the origin project's application code,
its build/deploy/installer/release CI jobs, its domain specs and archived feature changes,
its accumulated `.claude/memory/` pages other than the flow's own, and its unrelated
skills. `openspec/changes/` and the memory directories ship empty so the flow has somewhere
to write.
