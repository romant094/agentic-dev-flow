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

| Rule | Why it exists (the incident or the measurement) | Decision | Where it lives now |
|---|---|---|---|
| <the rule in one line> | <what went wrong without it> | ported / changed / rejected | <file in this repository, or the reason it is rejected> |

## Open findings carried over

<deferred findings of the origin project that touch this capability, and whether this port
fixes them>
```

A capability is ported only when every row has a decision.
