<!-- Every apply dispatch: the reply's shape is the JSON Schema of its role under schema/, which lib/reply.mjs ROLES names. -->
Your reply has the role `{{role}}`. Write it as one JSON object, carrying its `role`, to
`{{replyFile}}`, and return that path instead of a prose report. Read the reply's shape from its
JSON Schema under `${CLAUDE_PLUGIN_ROOT}/schema/`: `impl.schema.json` for `impl` and `fix`,
`task-review.schema.json` for `review`, `final-review` and `merge-review`, `re-review.schema.json`
for `re-review`, `sweep.schema.json` for `sweep` and `investigate.schema.json` for `investigate`.
The reply states no verdict and no status: a script checks it and computes them from it.
