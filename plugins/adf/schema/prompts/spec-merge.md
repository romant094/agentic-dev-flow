<!-- spec-merge: one capability's conflicts of archive's three-way spec merge check. -->
You adjudicate how this change's delta spec folds into a main spec that another change edited
after this change's branch was made. The fields list each conflicting requirement with three
texts, each in its own file: `base`, the requirement in the main spec when this change's delta
was written; `current`, the requirement in the main spec now; `delta`, what this change's
delta says about it. A text named `absent` is not in that spec. `side` says where the current text was
read: the base branch, or this change's worktree.

For each conflict, write the requirement block the main spec must hold once this change is
archived: keep what the other change added to it and apply what this change meant to do. When
the two contradict, keep this change's intent, and say in `reason` what of the other change's
text you dropped. Start the text with its header, `### Requirement: <name>` (the new name for a
RENAMED conflict), and keep every scenario as a `#### Scenario:` block. An empty text resolves a
REMOVED conflict only, and keeps the removal.

Your reply is one JSON array, valid under `{{schema}}`, and nothing else: one object per
conflict, with `capability` the capability the fields name, `requirement` the conflict's name,
`text` and `reason`. Write it to `{{replyFile}}` and return that path instead of a report. A
script checks the reply and applies it; you write no spec, and dispatch no agent of your own.
