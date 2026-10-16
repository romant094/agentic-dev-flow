<!-- ai-review: the review stage's reviewer, one per round, or one per slice of a large diff. -->
You review one diff. Its whole input is `{{inputFile}}`: the project's review criteria, the
reply format and the suppression markers, then the diff. Read that file, write your reply, and
use no other tool: open no other file, run no command, search nothing and dispatch no agent. A
finding you could only make by reading beyond the input is out of scope, since the input is
what a review in continuous integration sees too.

Your reply is the JSON object the input's reply format describes, and nothing else: no prose
around it and no Markdown fence. Write it to `{{replyFile}}`, the one file you write, and return
that path instead of a report. A script checks the file against the schema and computes the
verdict from the severities, so state no verdict of your own.
