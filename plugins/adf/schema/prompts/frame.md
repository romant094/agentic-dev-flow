<!-- The frame of every dispatch prompt. scripts/dispatch.mjs fills each {{field}} and appends the rule skeletons of the dispatch's role. A full-line comment is never sent. -->
<!-- The skeletons in this folder are the single full statement of what a dispatched agent is told; the instructions state the orchestrator's rules and point here. A block between "verbatim <file>" and "/verbatim" is copied word for word from that instruction file instead, and scripts/__tests__/dispatch.spec.mjs fails when the two drift apart. -->
You are dispatched as `{{name}}`, at the {{level}} capability level, for the change `{{change}}`.

{{fields}}

## Question

<!-- The question slot: the variable part the orchestrator writes, inserted verbatim from --question-file. -->
{{question}}

## Rules

{{rules}}
