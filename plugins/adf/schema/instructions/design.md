Create the design document explaining HOW to implement the change.

Write `design.md` only when the change needs to explain non-trivial technical decisions; the
artifact is optional and nothing requires it.

If brainstorming already wrote `design.md`, review and refine it rather than starting from
scratch. If it is empty or does not exist, write it from `brainstorm.md`.

Sections:
- **Context**: background, current state, constraints, stakeholders.
- **Goals / Non-Goals**: what this design achieves and what it explicitly excludes.
- **Decisions**: key technical choices with rationale (why X over Y?), including the
  alternatives considered.
- **Risks / Trade-offs**: known limitations and what could go wrong, each as
  `[Risk] → Mitigation`. Plan authoring reconciles every risk in this format.
- **Migration Plan**: steps to deploy and the rollback strategy, if applicable.
- **Open Questions**: outstanding decisions or unknowns to resolve.

Prefer extending an existing module over introducing a new abstraction; justify any new
abstraction explicitly.

Focus on architecture and approach, not line-by-line implementation. A good design explains the
"why" behind its technical decisions.
