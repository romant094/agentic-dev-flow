# Lint

Keep the knowledge base true and connected. Run it periodically, or when asked.

1. Run `node <plugin>/scripts/memory.mjs check`. It reports the mechanical findings:
   - `unindexed`: a page `index.md` does not link;
   - `broken-link`: a link to a file that does not exist;
   - `malformed-header`: a log heading that is not `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>`;
   - `out-of-order`: a log entry newer than the entry above it, usually after a merge;
   - `missing`: no `index.md` or no `log.md`.
2. Fix each finding: index the page, repoint or remove the link, move the log entry to its
   place.
3. Read the pages for what no script sees: contradictions between pages, claims the code no
   longer supports, a subject with no page, a missing cross-reference. Fix what you can
   verify against the code. List the rest in the log entry.
4. Run `check` again. It must report nothing you could fix.
5. Log it:
   `node <plugin>/scripts/memory.mjs log --type lint --title "<scope of the pass>" --bullet "<what was fixed>" --bullet "<what is flagged, not fixed>"`.
