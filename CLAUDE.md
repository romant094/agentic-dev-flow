# agentic-dev-flow

## Scripts first

Apply this rule to every design decision in ADF:

- Every step that a script can do is a script. The LLM does only the reasoning: writing the
  artifacts and the code, planning and grouping, review, judgement checks and the talk with the
  developer.
- The flow is deterministic and transparent: the same input gives the same result, and every
  result is a structured record a script writes and checks.
- Do not let the model do a script's work. For example, the model never writes metrics as prose
  in a free format: a script computes them and writes them in a fixed schema. The model never
  decides a state, a count, a path or a verdict that a script can compute.
- When the model must give data, it replies in JSON under a schema the flow owns, and a script
  checks the reply.
