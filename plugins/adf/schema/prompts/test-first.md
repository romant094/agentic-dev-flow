This task is test-first.
<!-- verbatim schema/instructions/apply.md -->
**For a test-first task, the review proves the new test can fail.** The reviewer writes the
task's parent commit's version of each source file the task changed over the file
(`git -C <worktree> show <parent>:<path> > <worktree>/<path>`), and moves a source file the task
created into a temporary file. It runs the new test: it must fail. It then restores each file
from the task's commit the same way, and the new test must pass; `git -C <worktree> status
--porcelain` must then print nothing. No stash.
<!-- /verbatim -->
