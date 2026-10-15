The section's id is `test-record`; take its title from `run.json`.
<!-- verbatim schema/instructions/verify.md -->
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
<!-- /verbatim -->
