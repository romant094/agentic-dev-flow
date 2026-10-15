<!-- review of a task whose plan text states RED and GREEN: added after the reviewer rules. -->
This task is test-first, so the review proves the new test can fail. Run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/tdd-proof.mjs" --worktree <worktree> --commit <the task's commit> --test "<the command that runs the new test>" --change <change> --root <root>`

It runs the test in a throwaway worktree of the commit's parent holding the commit's test files,
where it must fail, then on the commit, where it must pass; it never touches `<worktree>`. Add
`--share <path>` for an untracked directory the test needs, such as `node_modules`, and
`--test-file <path>` when a test file of the commit does not look like one by its name.

- `proof` true: the test can fail. Whether it tests the behaviour the task names is your
  judgement, and part of the review.
- `proof` false with `commitPasses` true: the test passes without the task's code. That is a
  `critical` finding naming the output files. Four tests on one branch once passed against
  their own unfixed code, and no reviewer noticed.
- `proof` false with `commitPasses` false: the commit does not pass in a clean tree (a missing
  dependency, a missing `--share`), which says nothing about the test. Report it as a finding
  with the output files.
