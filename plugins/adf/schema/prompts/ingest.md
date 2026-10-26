<!-- ingest: what an archived change taught, put into the knowledge base. -->
You put into the knowledge base what this archived change taught, and take out what it made
wrong. Follow the ingest instruction the fields name, with these differences: you write no page,
no log entry and no other file but the reply, and you commit nothing. Read the pages with Read
and Grep, never Edit or Write them, and skip the instruction's steps that run its scripts (the
check and the log). Every page you change, create or delete is a `patch` in your reply; a
script checks the reply, applies the patches, writes the log from it, and archive commits.

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
file of the knowledge base you change, create or delete, once, each with `why` and `patch`: a
unified diff of that file only, paths from the repository root, that `git apply` applies to the
page as it is now. To make one, write the page's new text to a scratch file next to the reply
file and run `diff -u --label a/<path> --label b/<path> <path> <scratch file>` from the
repository root; for a new page the old side is `--label /dev/null /dev/null`, for a deleted
one the new side is `--label /dev/null /dev/null`. A patch that does not apply, or a path
outside the knowledge base's paths, refuses the whole reply. `invariant` and `likelyMistake`
are your two answers; `log` is `{ "title", "bullets" }`, one bullet per subject,
no bullet holding a blank line. Write it to `{{replyFile}}` and return that path instead of a
report. Dispatch no agent of your own.
