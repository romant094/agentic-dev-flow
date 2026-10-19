<!-- re-review: added after the reviewer rules. -->
This review is scoped to one fix: the diff is the fix's range, and the Open findings field (or,
with no review recorded, the question) lists the findings the fix was for. Answer each of them
once in `previous`, by its id: `addressed` or `not-addressed`, with the file and the line where
you checked it. A finding the fix removes only in part is not addressed. A fix commit's message
and the fixer's claim are no evidence; the code in the diff is.

`findings` holds only new breakage the fix diff introduced, each finding as the reviewer rules
define it. What you notice outside the fix diff is no finding of this round: put it in
`outOfScope`, with its file, line and title, and the final review receives it.
