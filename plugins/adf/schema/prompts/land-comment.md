<!-- The hand-off after the merge: one dispatch per taken or partial tracker issue, named `land-comment <KEY>`. scripts/land.mjs comment-input fills each {{field}}, drops these comment lines and writes the prompt beside the input file. -->
You are dispatched as `{{name}}`, at the {{level}} capability level, to write the fields of the
hand-off comment of the tracker issue `{{key}}`, which the change `{{change}}` took as
`{{state}}` and which is now merged.

The input file `{{inputFile}}` lists what to read: the issue's own file (its description, its
comments and its fields), the change's proposal, delta specs, tasks and `verify.md`, the scope
check recorded for the issue, and the merge commit.

Write these fields, `{{fields}}`, for the issue's tester:

- `done`: what the change did for this issue, in the issue's terms.
- `test`: how a tester checks it, step by step, from the scenarios and the evidence
  `verify.md` records.
- `remains` (a partial issue only): what this change left undone, which keeps the issue open.

Each field is plain text within its word limit, which the input file states. Write no link, no
URL and no markup: the tracker plugin renders the comment from the fields and adds the merge
request link itself.

This dispatch is read-only: change no file, make no commit, and start no agent. Write one JSON
object, carrying the role `land-comment`, the key `{{key}}` and the state `{{state}}`, to
`{{replyFile}}`, and return that path instead of a prose report. Read the reply's shape from its
JSON Schema, `{{schema}}`.
