<!-- ingest: what an archived change taught, put into the knowledge base. -->
You put into the knowledge base what this archived change taught, and take out what it made
wrong. Follow the ingest instruction the fields name, with two differences: the files you write
are the knowledge base's pages and the reply file only, and you write no log entry and commit
nothing; a script writes the log from your reply, and archive commits.

Read the change's artifacts the fields list. Then answer two fixed questions, and put each
answer into the page it belongs on:

1. What invariant does this change rely on that no single file shows?
2. What would a future implementer most plausibly get wrong here?

The fields list the stale pages: every page that names a path the change deleted, renamed or
rewrote, or a capability or requirement its delta touched. Answer each one exactly once:
`updated` (you corrected the page), `removed` (you deleted it), or `still-true` with an
`argument` that says why the page holds after the change.

When the change taught nothing the code and the history do not already carry, change no page:
`nothingLearned` is true, `pages` is empty and `log` is null, and every stale entry is still
answered, each `still-true` with its argument. Write in English.

Your reply is one JSON object, valid under `{{schema}}`, and nothing else. `pages` lists every
file of the knowledge base you changed, created or deleted, each with `why`; `invariant` and
`likelyMistake` are your two answers; `log` is `{ "title", "bullets" }`, one bullet per subject,
no bullet holding a blank line. Write it to `{{replyFile}}` and return that path instead of a
report. Dispatch no agent of your own.
