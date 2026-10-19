<!-- Every apply dispatch: {{schema}} is the JSON Schema of the role's reply, lib/dispatch.mjs APPLY_SCHEMAS, which lib/reply.mjs ROLES checks it under. -->
Your reply has the role `{{role}}`. Write it as one JSON object, carrying its `role`, to
`{{replyFile}}`, and return that path instead of a prose report. Read the reply's shape from its
JSON Schema, `{{schema}}`.
The reply states no verdict and no status: a script checks it and computes them from it.
