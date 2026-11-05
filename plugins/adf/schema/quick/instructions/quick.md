Write `quick.md`, the one file of a quick change. A quick change is a small fix that changes no
behaviour. Keep every section short.

Follow the template. Write these sections, in this order:

- **Goal**: one or two sentences. State what is wrong or missing and what the change achieves.
- **Scope**: what the change covers and what it leaves out. Name each tracker key or debt id the
  change takes, as a whole word.
- **Plan**: one to three numbered steps (`1.`, `2.`, `3.`). Each step holds a `**Files:**` line
  that names at least one file, then the action and the check. The `quick-plan` gate refuses
  more than three steps and a step with no file.
- **Summary**: leave it empty now. The end of the change fills it: what was wrong, what changed,
  the tests run and the review's result.

If the work needs more than three steps, or changes what the system does, stop. Propose the
change in full with `/adf:propose` instead.
