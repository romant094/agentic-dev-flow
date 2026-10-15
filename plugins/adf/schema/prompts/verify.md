<!-- verbatim schema/instructions/verify.md -->
A verify dispatch is read-only: it edits no file of the change or of the project, commits
nothing, and dispatches no agent. It writes exactly two files into `<verify>`: its raw output,
`<id>-agent.txt`, and its section, `<id>.json`, one JSON object `{ "id", "title", "verdict",
"summary", "output" }` with `verdict` one of `pass`, `warn`, `fail`, `not-run` and `output` the
output file's path relative to `<root>`. It returns the section's path, not a report.
<!-- /verbatim -->
<!-- verbatim schema/instructions/verify.md -->
git runs as `git -C <root>`. No dispatch text asks
for a repository-wide git mutation.
<!-- /verbatim -->
