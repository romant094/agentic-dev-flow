Invoke **superpowers:brainstorming** with the Skill tool.

Output redirection:
- Do NOT write to `docs/superpowers/specs/`. Write the brainstorming output directly to this
  change's `brainstorm.md`; the skill's default location is outside the change, where the
  artifact would be missing and the graph blocked.
- If brainstorming produces a design document, also write it to this change's `design.md`. It
  pre-fills the optional design artifact instead of being lost.

After brainstorming completes, summarize the agreed design in `brainstorm.md` using the template
structure.

The brainstorming skill will:
1. Explore project context
2. Ask clarifying questions
3. Propose 2-3 approaches with trade-offs
4. Present design sections for approval
5. Output the validated design

**Read first, and name what you read.** Before proposing anything, read the project's knowledge
base, if the host has one, and the pages it points at for this area; then read the code that area
actually contains. Name what you read. An approach accepted only because it was stated, or an
alternative invented without looking, is what this step prevents.

**Check the developer's approach against the evidence.** Then either agree, citing the evidence
that supports it, or propose a better alternative, citing what in the knowledge base or the code
makes it better. Agreeing is a valid outcome — do not manufacture an alternative to look
thorough. Never disagree on a general principle alone: a disagreement cites something you read.
Where the knowledge base and the code disagree, the code is the fact and the page is stale; name
the stale page so it can be fixed.

**Read before you ask, and ask once.** Answer from the code and the knowledge base whatever they
answer. Then put every question whose answer would change the design to the developer together,
in one message, rather than one at a time; decide routine points yourself and state what you
decided. The approval of the design before any code stays — that gate is the developer's
decision, not a question. In the measured change, 45 of the 49 minutes before the first dispatch
were spent waiting on questions.

What `brainstorm.md` records:
- 2-3 alternatives with their trade-offs, and why each was not chosen.
- Where the change lands in the code, or an explicit statement that it touches no runtime code.
- The decision and the discarded options — not the design document. `brainstorm.md` records
  which approach and what was rejected; `design.md` explains how.
