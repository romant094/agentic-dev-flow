# openspec-sync-specs

The spec-writing step of `/opsx:archive`. It merges the delta specs of the change being
archived into `openspec/specs/`, requirement by requirement, so that a partial delta
updates a main spec without replacing it wholesale.

## Not a standalone action

`/opsx:archive` step 7 dispatches this skill by name and is its only sanctioned caller.
The dispatch supplies the change name, the absolute workspace path and the delta spec
summary; step 1 of the skill refuses any invocation missing one of the three, including a
request to update the main specs without archiving the change.

`openspec/specs/` is written only by `/opsx:archive` — see `.claude/CLAUDE.md` section 5.
Merging mid-implementation would make the main specs describe behaviour that is not built
and whose change was never archived, and the next `/opsx:verify` would then report those
deltas as already synced.

## What it does

Reads each delta spec of the change and applies it to
`openspec/specs/<capability>/spec.md`: `ADDED` requirements are added, or updated in place
if they already exist; `MODIFIED` requirements are folded scenario by scenario, preserving
scenarios the delta does not mention; `REMOVED` requirements are deleted whole; `RENAMED`
pairs are matched `FROM`/`TO`; and a capability with no main spec yet gets one created.
It commits nothing — `/opsx:archive` commits its output with the archive move.
