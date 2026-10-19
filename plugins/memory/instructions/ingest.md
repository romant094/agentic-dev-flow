# Ingest

Put what a piece of work taught into the knowledge base at `.claude/memory/`, and take out what
it made wrong. Archive runs this for every change; run it by hand after any work that taught
something the code alone does not say.

1. Read `index.md`. Read the pages it names for the subjects the work touched.
2. For every claim the work made stale, correct it or remove it. A stale page is read as fact
   by every later agent, so this step is not optional. A page that only names a path the work
   deleted, renamed or rewrote is still a stale page. When you keep a claim, say why it is
   still true.
3. Add what the work taught that git cannot reconstruct: an invariant and the test that holds
   it, a decision and the reason for it, a mistake an agent is likely to make. Add it to the
   page of the module or concept it is about. Make a new page only for a subject no page
   covers: `entities/` for a module, component or service, `concepts/` for a pattern,
   protocol, workflow or decision.
4. Update the cross-references on every page whose claims your edit changes, and on no other
   page.
5. Index every new page in `index.md`, in one line, under its subject. Remove the line of a
   page you deleted.
6. Run `memory.mjs check`. Fix every finding your edit caused.
7. Log it:
   `node <plugin>/scripts/memory.mjs log --type ingest --title "<what was ingested>" --bullet "<what changed, and where>"`.
   One bullet per subject. No bullet holds a blank line.

Do not write `log.md` or `log-archive/` by hand. `log-archive/` is read-only: grep it, never
read it whole.
