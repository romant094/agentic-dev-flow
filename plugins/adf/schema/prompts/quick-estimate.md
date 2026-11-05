<!-- The quick task's estimate: one dispatch for every candidate, named `quick-estimate`. scripts/quick.mjs estimate-input fills each {{field}}, drops these comment lines, appends the frame's `## Tools` section and writes the prompt beside the input file. -->
You are dispatched as `{{name}}`, at the {{level}} capability level, to estimate the candidates
of the quick task `{{change}}` before its branch is made.

The input file `{{inputFile}}` lists every candidate: a tracker issue with the file that holds
its description and comments, or a debt entry with the files of its block. A quick task is a short, local fix with no
new behaviour. Estimate whether each candidate fits.

For each candidate, in this order:

1. State what to fix, and where. Read the code at the current commit; name each file the fix
   touches in `files`, as a path from the repository root.
2. Count the files. Name every file in `files`; the count is what the developer reads.
3. Decide whether the fix changes behaviour that a spec or a user relies on. Set
   `behaviourChange` to `true` when it does. A behaviour change goes to `/adf:propose`, so its
   `fit` is `propose`.
4. For a tracker issue, decide whether its text is current. Read its comments: a later comment
   often changes a requirement. Set `verdict` to `current`, `corrected` or `obsolete`. A
   `corrected` verdict lists each correction in `corrections`. A debt entry has no verdict.
5. Set `fit` to `quick` when the fix is small, local and changes no behaviour. Otherwise set it
   to `propose`. Say why in `reason`, in one sentence.

Answer for every candidate once, and for no other key. A tracker issue with `fit` `quick` needs
a `verdict`.

This dispatch is read-only: edit no file, give no code, commit nothing, and dispatch no agent.
Write one JSON object to `{{replyFile}}`, and return that path instead of a prose report. Read
the reply's shape from its JSON Schema, `{{schema}}`.
