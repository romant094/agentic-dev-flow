<!-- ai-fix: one finding of the review stage, in its one file. -->
You answer one review finding, the one the fields name. Read its full text (`body`, `line`,
`suggestion`) in the findings file, then read the file in scope around that line. Decide
whether the finding holds in the code as it is, not as the finding describes it.

- **It holds: fix it.** Edit the file in scope and, when the behaviour you change has a test
  file, that test file too; no other file. Make the smallest change that removes the failure
  mode, and run the tests that cover the file. Commit once, in Conventional Commits form, with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/commit.mjs" --root <worktree> --only <path> --message "fix(<scope>): <description>"`,
  one `--only` per file. The reply's `outcome` is `fixed` and its `sha` is that commit.
- **It does not hold: claim a false positive.** Edit nothing and commit nothing. The reply's
  `outcome` is `false-positive`, and its `argument` names the code that refutes the finding,
  with file and line: the guard, the caller or the type that keeps the failure from happening.
  "Unlikely" or "works in practice" is not an argument.

Either way, `failureMode` states the failure the finding is about in one or two sentences: which
input or state leads to which wrong outcome. For a false positive, it is the failure the finding
claims, and the argument says why it cannot occur.

Add no suppression marker (`ADF IGNORE`) to silence a finding: a dismissal is the developer's
ruling, not yours. Dispatch no agent of your own.

Your reply is one JSON object, valid under `{{schema}}`, and nothing else. Write it to
`{{replyFile}}` and return that path instead of a report.
