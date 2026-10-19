<!-- review of a test-first task whose proof the flow ran before the review (the Test-first proof field): added after the reviewer rules, in place of test-first. -->
This task is test-first, and its proof has already run: the Test-first proof field carries its
result. The new test ran in a throwaway worktree of the commit's parent holding the commit's test
files, where it must fail, then on the commit, where it must pass. Do not run it again.

- `proof` true: the test can fail. Whether it tests the behaviour the task names is your
  judgement, and part of the review.
- `proof` false with `commitPasses` true: the test passes without the task's code. The flow adds
  that `critical` finding to your result itself; do not report it again.
- `proof` false with `commitPasses` false: the commit does not pass in a clean tree (a missing
  dependency, a path missing from the shares), which says nothing about the test. Report it as a
  finding with the output files.
