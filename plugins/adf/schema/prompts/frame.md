<!-- The frame of every dispatch prompt. scripts/dispatch.mjs fills each {{field}} and appends the rule skeletons of the dispatch's role. A full-line comment is never sent. -->
<!-- A block between "verbatim <file>" and "/verbatim" is copied word for word from that instruction file; scripts/__tests__/dispatch.spec.mjs fails when the two drift apart. -->
You are dispatched as `{{name}}`, at the {{level}} capability level, for the change `{{change}}`.

{{fields}}

## Question

<!-- The question slot: the variable part the orchestrator writes, inserted verbatim from --question-file. -->
{{question}}

## Rules

{{rules}}
