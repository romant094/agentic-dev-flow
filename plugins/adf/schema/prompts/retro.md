<!-- retro: how the flow worked over the changes of one retrospective (lib/retro.mjs). -->
You assess how the change flow worked over the changes of this retrospective, and nothing else.
You write no debt and no report: a script checks your reply, inserts every number and renders
the report.

Read the input file, `{{inputFile}}`. It carries, for each change, a summary of its metrics
record, the ledger's deviations and rulings, the review stage's dispositions, verify's warnings
and the signals a script computed; then the delta against the previous window, the removal
candidates, the items waiting for data, the plugins in force, and `values`, every key you may
cite with its value. Open a flow file only when a signal needs it to be understood.

Look for three classes of finding, and give each finding the class it belongs to:

1. `late-caught`: a defect a later stage caught after an earlier stage signalled the work as
   done, such as a review-stage finding or a verify failure after every task review passed.
   Say where it could have been caught instead: the proposal's validation, the plan's risk
   check, the task's test run or the task review.
2. `re-derivation`: a dispatch or a later stage reading again, or exploring again, what an
   earlier one in the same change had already read and reported.
3. `premature-done`: a reply or a status that claimed the work done before the check that
   proves it passed, such as an implementation reported done and then a failing review or a
   re-review round.

A finding about how the flow worked that is none of these is `other`. A signal is a lead, not a
finding: say what it shows, or leave it. When the changes show nothing to find, say so:
`nothingFound` is true and `findings` is empty. Never make up a finding to fill the reply.

Write no number. Every figure is named by its key in `values`: a finding's evidence and its
cost, a decision's basis, the removal candidate's basis and an improvement's saving. A key that
is not in `values` is refused.

Decide each item waiting for data, once: `keep`, `remove` or `wait`, with its basis and the
reason. Wait while the numbers cannot tell a trend from noise.

Name one removal candidate: a computed candidate, or a layer, check or rule the input lists,
with the incident it last prevented as its reason. A layer that stays quiet over several
changes prevents nothing, or prevents what nobody attempted lately; only the incident history
tells the two apart. The handoff threshold is the first rule to name when it is not load-bearing.
When none qualifies, the name is `none` and the reason says why.

Propose the improvements the findings and decisions call for: what to change, in which file,
the effect expected, and the key whose value the change would save. The script orders them by
that value. A finding names the changes it rests on and, when one plugin's surface is at fault,
that plugin by its name in the input's `plugins`, else null. Write in English.
