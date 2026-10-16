The procedure `/adf:review` executes: the project's tuned code review over a verified change,
bounded fix rounds for what it blocks on, and the record archive reads. The command file
carries the step order; the rules below are stated here in full and the command points at
them. `<root>` is the change worktree the change was resolved to, `<change>` its name, and
`<review>` is `<root>/.superpowers/sdd/<change>/review/`, the run's state, which the
`review.mjs` header lists file by file.

**Why the stage exists, and what it does not replace.**

Apply's per-task reviews and its final review judge the work against the plan. This review
judges the branch's diff against the project's own criteria, the prompt file the registry's
`review.prompt` names, the same file a review in continuous integration reads. It replaces none
of apply's reviews. Its reviewer sees the diff and nothing else: the reuse sweep reads the whole
tree, and that is no precedent for widening the reviewer's input. For the same reason the
criteria carry no duplication or reuse category while the input is a diff; duplication is the
sweep's. A regression a fix causes outside its own diff is beyond this reviewer; the suite run
after the fixes and a review of the whole merge request diff catch what they can of it.

**The scripts decide; the orchestrator judges and talks.**

Every deterministic step is one script call: the range, the filter, the reviewer's input, the
reply check, the verdict, the fix plan, the fix check, the dispositions, the markers and the
record. `review.mjs` is the only sanctioned executor of the stage: if it cannot run, stop and
report why, and review nothing by hand. What stays with the orchestrator, and with nobody's
script:

- the review itself and each fix, which are dispatches;
- weighing a fixer's false-positive argument, and the talk with the developer about it;
- the one-sentence body of a recorded or an accepted finding: why it was left, for a reader who
  never saw the review;
- whether a non-blocking finding contradicts the change's own delta spec, which makes it a
  defect to fix whatever its severity;
- whether a tool the change adds was exercised on a real input before it is reviewed.

A finding's suggestion is a proposal: the failure it identifies is what gets fixed, and what it
prescribes is checked before anyone follows it. A finding against a file of another change, on a
branch that carries several, is recorded with a body that names the change it belongs to.

Only the developer's own words make a ruling, written with `ledger.mjs ruling`: an
orchestrator's or a dispatch's judgement is not one, and silence never is. The stage's rulings
are `review-range`, `review-slices`, `review-suite`, `review-round-<k>` on a check, and
`--finding F<n> --as dismissed|accepted` on a finding.

**The procedure, one script call per step.**

1. **Preflight.** The change is selected by the resolve instruction, then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase review --change <change> --root <root>
   ```

   It checks the Superpowers gate, the worktree, a branch that is named and not protected, the
   change's dependencies, and the verify record: its `Verdict:` line is not `FAIL`, and no commit
   after it touches a path outside the change directory, so the reviewed code is the verified
   code. On a pass it records the session. On `ok: false`, stop, show `refusal` and write
   nothing.

2. **A tool the change adds runs on a real input first.** When the change adds a tool (a script,
   a command, a generator), read the `## Exercised and not exercised` section of the change's
   `verify.md`. A tool no recorded run fed a non-empty, real input goes to the developer before
   the reviewer is dispatched: it is run with them as a verify check that needs the developer,
   and verify runs again. A green gate over an empty input is no such run.

3. **Start.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" start --change <change> --root <root>
   ```

   It measures the branch from the change's base, applies the exclusion list and records the
   run's start; read `counts`, `bytes`, `empty`, `over` and `warnings`, not the file lists.
   - `empty: true`: no reviewer is dispatched; go to step 11 with `--not-reviewed`.
   - `over: true`: the diff is larger than one reviewer takes. Show the developer `slices` and
     `proof`, the byte coverage, and ask. On their approval, record it:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" ruling --change <change> --check review-slices --reason "<their reason>" --root <root>
     ```

     Each round then runs steps 5 to 7 once per slice, with `--slice <n>`.
   - A warning that the range touches none of the plan's `**Files:**` paths means the change's
     code reached the base outside this branch. Only with the developer's `review-range` ruling,
     written before the call, is `start` run again with `--range <A..B>`, the implementation
     commits they name; the record names the range and the ruling.
   - A run of an earlier session with rounds is kept; `--fresh` discards it and starts again.

4. **Open the round.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" round --change <change> --root <root>
   ```

   It returns `round`, the `<k>` of every call below. Round 1 reads the start's range; a later
   round reads only the fix range of the round before. A refusal with `escalate: true` is the
   cap: go to the developer with the open findings. On their decision to allow one more round,
   run its `rulingCommand` with their reason and call `round` again; otherwise assemble the
   record, which is then BLOCKED. A refusal that nothing landed to re-review means the loop is
   over: go to step 10.

5. **Write the reviewer's input.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" input --change <change> --round <k> --root <root>
   ```

   It writes one file under `<review>`: the host prompt, the core's reply format and marker
   grammar, then the filtered diff; from round 2 also the findings the fixes targeted, with
   their state and failure modes. Keep its path and size; leave its content to the reviewer.
   A refusal with `needsRuling` names the slices ruling of step 3.

6. **Dispatch `ai-review r<k>`.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <change> --role ai-review --round <k> --root <root>
   ```

   Dispatch its `prompt` as it is, to its `agent`, named `name`; the reviewer writes its JSON
   reply to `replyFile`. The slices of one round are dispatched in parallel, in one response.

7. **Store the reply.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" response --change <change> --round <k> --file <replyFile> --root <root>
   ```

   It checks the reply against the core's schema, stores it and, once every slice is in,
   numbers the round's findings on from the earlier rounds and computes the verdict over them.
   - `retry: true`: write its `errors` to a file, run step 6 again with `--question-file
     <file>`, and store the new reply. One retry is all there is.
   - `stopped: true`: the stage stops. Nothing is recorded, fixed or reviewed again; report the
     reason to the developer. Only `start --fresh` begins a new run.
   - `complete: false`: the slices it lists in `missing` are still to come.

   On a complete round, read `verdict`, `blocking` and `counts`. Nothing blocking and no fix to
   make: go to step 9.

8. **Fix, wave by wave.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" fixplan --change <change> --round <k> --root <root>
   ```

   It lists the round's open blocking findings in `waves`, each entry with its dispatch `name`
   and level, and the false-positive claims that wait for the developer apart. A non-blocking
   finding that contradicts the change's delta spec joins the plan with `--also F<n>`. For each
   entry of a wave, in one response:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <change> --role ai-fix --finding F<n> --round <k> --findings <findingsFile> --root <root>
   ```

   with `findingsFile` from the fix plan, and dispatch each `prompt` as it is. Then store every
   fixer's reply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" fix --change <change> --round <k> --file <replyFile> --root <root>
   ```

   `fixed` is checked against the round's fix range and the finding's file, and closes the
   finding. An invalid reply follows step 7's retry rule. The next wave starts once every reply
   of the one before is stored.

9. **Settle what is not fixed.**
   - A false-positive claim (`awaiting: "developer"`, or the fix plan's `awaitingDeveloper`):
     weigh the argument against the code it cites, then put the claim and your assessment to
     the developer. If they agree, record the dismissal with `ledger.mjs ruling --finding
     F<n> --as dismissed --decision "<their reason>"`, then:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" disposition --change <change> --finding F<n> --as dismissed --root <root>
     ```

     A refusal with `markCommand` names the line to mark: run it, `review.mjs mark ... --commit`
     with the developer's reason and the finding's key, then the disposition again. A
     finding whose line is gone from HEAD is dismissed with no marker, and the record says so.
     If they reject the claim, the finding is fixed and carries no marker: dispatch its fixer
     again with their reason in `--question-file`.
   - A blocking finding the developer decides to leave as it is: their ruling `--as accepted`,
     then `disposition --as accepted`, with `--body-file` when the reason needs more than the
     ruling says.
   - Every non-blocking finding not fixed: write its body to a file and record it with
     `disposition --as recorded --body-file <file>`.

   Then go back to step 4: a fix landed in this round opens the next one, which re-reviews it.

10. **Run the suite after the fixes,** when any fix landed, after the last commit of the stage,
    markers included:

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/suite.mjs" run --change <change> --section review --root <root>
    ```

    It runs the planning guide's whole-suite command with the base check and writes the result
    the record reads. A new failure blocks the verdict. The resolution is another fix, which
    the next round re-reviews, or the developer's `review-suite` ruling with their reason. A
    commit after the run makes it stale: run it again.

11. **Assemble and commit the record.**

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" assemble --change <change> --commit --root <root>
    ```

    For an empty filtered diff, add `--not-reviewed "<reason>"`: the record is PASS with no
    round. The script reads HEAD itself, renders `openspec/changes/<change>/review.md` from the
    run's state and the rulings, computes `PASS` or `BLOCKED`, and commits the record alone. It
    refuses a tree with changes outside the record; any other refusal carries `refusals`, each
    naming the call that resolves it: run them and assemble again. Show the result's `report`;
    on BLOCKED its `outstanding` entries name what is left.

**The verdict is computed, never typed.** BLOCKED while a finding whose severity is in the
registry's `review.blockOn` is open, a fix is not yet re-reviewed, or the suite after the fixes
fails with no ruling; PASS otherwise. A blocking finding is closed by its fix, by a dismissal
the developer ruled and the marker carries, or by the developer's acceptance. Review calls no
forge operation and pushes nothing: the record reaches the remote with a later push.

**The next step follows the verdict.** `PASS`: archive, which reads the record's verdict and
reviewed commit. `BLOCKED`: the outstanding findings go to the developer, whose rulings or a
further round resolve them; then assemble again.
