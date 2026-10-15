<!-- verbatim schema/instructions/apply.md -->
- read the task brief first; do not read the whole plan;
- state the task's Files, Interfaces and acceptance criteria before the first edit, and solve
  from that statement rather than from the plan as a whole;
- one task, one commit, in Conventional Commits form, made in the task's worktree;
- never edit a checkbox in `tasks.md`: the flow ticks it;
- dispatch no subagent of its own;
- record every code compromise taken (a stub, an accepted duplication, a deferred refactor) with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" debt --change <change> --what <compromise>
  --reason <why> --task <n> --root <root>`.
<!-- /verbatim -->
