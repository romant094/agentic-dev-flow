# Query

Answer a question about the codebase from the knowledge base and from the code together.

1. Read `.claude/memory/index.md`.
2. Read the pages it names for the question.
3. Read the code those pages describe. The pages can be stale; the code is the authority.
   When a page and the code disagree, say so and name the page.
4. Answer from both, and name each source you used.
5. When the answer taught something the pages do not hold, ingest it (`ingest.md`). When
   the answer is a valuable analysis or decision, it may become a page of its own.
6. Log it:
   `node <plugin>/scripts/memory.mjs log --type query --title "<the question>" --bullet "<the answer, and what was ingested>"`.

To search older log entries, grep `log-archive/`. Do not read an archive whole.
