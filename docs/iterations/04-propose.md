# Iteration 04 — Propose

## Goal

`/adf:propose` takes a change from an idea to a plan ready for apply, in its own branch and
worktree, without the openspec CLI or any origin script. The rules and their reasons are in
`docs/lessons/propose.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | The branch policy in the registry (`branches.integration`, `branches.protected`), set by `/adf:init` from the remote's default branch and the developer's answer | `workspace.spec.mjs`, `extensions.spec.mjs` |
| 2 | `/adf:init` ignores `.claude/worktrees/` and creates the planning guide `openspec/planning.md` from a template | `workspace.spec.mjs`, `extensions.spec.mjs` |
| 3 | `workspace.mjs suggest` and `create`: one branch and one worktree per change, from the integration branch or the current one | `workspace.spec.mjs`, against real git repositories |
| 4 | The change's base branch in `.adf.json`; the project guides an artifact names in the schema delivered by `instructions` | `changes.spec.mjs`, `schema.spec.mjs` |
| 5 | The artifact instructions, the `propose` block and the plan template, made project-independent | no origin path, command, tool, model or vendor name left |
| 6 | `plan-symbols.mjs`: the plan symbol check | `plan-symbols.spec.mjs`; `scripts/parity/origin-plan-symbols.mjs` |
| 7 | `ledger.mjs`: the execution ledger | `ledger.spec.mjs`; `scripts/parity/origin-ledger.mjs` |
| 8 | `/adf:propose` | the lessons file's evidence |
| 9 | `check-lessons.mjs` splits table cells as GitHub does | a `\|` inside a code span or escaped no longer splits a cell |

## Decisions

- The worktree is part of the core, not a plugin. Every change gets its own branch and
  worktree, for parallel work and isolation. The developer chooses the base: the integration
  branch (new work) or the current branch (mid-feature, not offered on a protected branch).
  The origin's "stay on the current branch without a worktree" path is replaced by the second
  base. The base is the merge target: through the forge plugin when one is enabled, otherwise a
  merge into the base at archive (iteration 10).
- The branch policy lives in the registry: one integration branch, and a list of other
  protected branches such as a release branch. The plan symbol check's apply phase reads the
  change's base from `.adf.json`, not a literal `origin/develop`.
- How a project gathers information for a plan, and where checks that need the developer go, is
  project knowledge: `openspec/planning.md`, created by `/adf:init` from a template. An artifact
  names the guides it needs in the schema (`guides`), and `instructions` delivers their text.
  The core names no hardware.
- The English-only check is its own plugin, iteration 05.
- The whole ledger script is ported now; apply only adds instructions.
- The propose commit message stays `docs(openspec): propose <name>`.
- The symbol check prints one JSON object, with the origin's exit codes.
- Spec validation at propose covers the change's own specs only.
- The tasks instruction's reference to the `openspec-conventions` skill, which never existed, is
  removed; the design instruction states that `design.md` is optional.

## Result

- `npm test`: 136 tests, 0 failures; `check-lessons.mjs`: 168 rules, every one with a decision
  and evidence or a pending iteration.
- `npm run parity -- <origin>`: all five tools PASS.
  - `origin-plan-symbols.mjs`: 145 cases (65 origin plans, 7 generated plans, each under
    propose and apply, plus one argument case); 998 origin findings matched; one explained
    difference, the trailing `--phase` usage error.
  - `origin-ledger.mjs`: 173 steps (54 accepted, 119 refused); every difference is the output
    form only (`json-output`).
  - `openspec-status.mjs`, `openspec-validate.mjs`, `origin-superpowers.mjs`: as in
    iterations 02 and 03, no unexplained difference.
- A smoke run of the scripts on a temporary host: `init`, `branches`, `workspace suggest` and
  `create`, `changes new --base`, `ledger session`, `instructions plan` delivering the planning
  guide; the main checkout stayed on its branch.
- Not run: `/adf:propose` itself by an agent end to end. That is the behaviour check,
  iteration 15.
- Also found: the origin ignores `.superpowers/` and `docs/superpowers/`; `/adf:init` now adds
  both with `.claude/worktrees/`.
