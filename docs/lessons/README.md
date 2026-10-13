# Lessons

One file per ported capability, written before the port starts. It lists every rule the origin
project's flow holds for that capability and what the port does with it. Most rules exist
because something failed; dropping one without reading why repeats the failure.

## Sources in the origin project

- The flow's rule history with the reason for each guard (`opsx-workflow` memory page).
- The deferred flow findings ledger.
- The capability specs of the flow.
- The command files and the schema blocks of the capability.

## File template

```markdown
# <Capability>

Sources read: <files, with the commit of the origin project they were read at>

| Rule | Why it exists (the incident or the measurement) | Decision | Where it lives now | Evidence |
|---|---|---|---|---|
| <the rule in one line> | <what went wrong without it> | ported / changed / rejected | <file in this repository, or the reason it is rejected> | <see below> |

## Open findings carried over

<deferred findings of the origin project that touch this capability, and whether this port
fixes them>
```

A capability is ported only when every row has a decision.

## Evidence

The Evidence cell is what `scripts/check-lessons.mjs` checks on every `npm test`. It holds one
or more items separated by `; `:

- `` `<path>`: `<phrase>` `` — the file exists and contains the phrase (whitespace collapsed).
  Pick a phrase that only the rule's implementation would contain: a function name, a message,
  a test title.
- `pending: iteration NN` — the rule lands in iteration NN. The check fails once that
  iteration's record has a `## Result`, so no iteration closes without the rules it promised.
- `—` — only for a rejected rule.

The check proves a rule was not lost in the port. It does not prove the rule's meaning; that is
what the parity tools and the behaviour check are for (`docs/roadmap.md`).
