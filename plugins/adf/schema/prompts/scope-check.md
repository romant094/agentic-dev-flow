<!-- Propose's issue check: one dispatch per taken or partial scope item, named `scope-check <KEY>`. scripts/scope.mjs check-input fills each {{field}}, drops these comment lines and writes the prompt beside the input file. -->
You are dispatched as `{{name}}`, at the {{level}} capability level, to check the scope item
`{{key}}` of the change `{{change}}` before its branch is made.

The input file `{{inputFile}}` lists what to read: the item's own file (its description, its
comments and its fields), the files of the issues it links, the debt entries and their body
files, the precedents, the knowledge base index, the capability specs whose names its text
matches, and the base commit to check against. Read the item's comments: a later comment often
changes a requirement.

A precedent is resolved debt like this item: `resolvedBy` is the archived change that fixed it,
and `files` are that change's proposal, design and tasks. Before you decide how the item is
fixed, read the design and the tasks of each precedent, and name the precedent's change as a
source wherever its fix settles a point. Its anchors are history: check the code at the base
commit, never the anchors.

1. State the item's requirements as you read them. For a bug, state the reproduction steps, the
   expected behaviour and the actual behaviour.
2. Check each one against the evidence, in this order of authority: the code at the base
   commit, the specs, the knowledge base, the linked issues and the comments, the git history
   (`git log -S`, the blame of the cited code), and the live system where the project allows a
   read-only probe. Never write to the live system.
3. Settle what you can yourself: a requirement already done, contradicted by a spec, or
   overtaken by a later comment; a reproduction completed from the code path. Each settled
   point names its sources (`path:line`, `spec:<capability>/<requirement>`, a commit, a key).
4. Ask only what you cannot settle. Each question names what you checked and what you still
   need, and says what it is about.

The verdict:

- `current`: the requirements hold as written.
- `corrected`: they hold with the corrections you list, each with its source.
- `needs-developer`: only the developer can settle a question; list every question.
- `obsolete`: the work is already done or no longer wanted; the requirements say why.
- `not-reproduced`: a bug whose reproduction you tried and that does not occur at the base
  commit; `bug.tried` lists each attempt, and the issue goes back to its tester for a retest.

This dispatch is read-only: edit no file, commit nothing, and dispatch no agent. Write one JSON
object, carrying the role `scope-check` and the key `{{key}}`, to `{{replyFile}}`, and return
that path instead of a prose report. Read the reply's shape from its JSON Schema, `{{schema}}`.
