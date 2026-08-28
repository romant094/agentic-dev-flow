# Verification Report

> Produced by the `/opsx:verify` command after apply completes, to confirm
> the implementation matches specs / design / tasks. A failed check means returning
> to the corresponding artifact, fixing it, and re-running verify.

**Change**: `<change-name>`
**Verified at**: `YYYY-MM-DD HH:mm`
**Verifier**: `<who / which agent>`

---

## 1. Structural Validation (`openspec validate --all --json`)

- [ ] All items report "valid": true

**Result**:

```text
<paste the openspec validate --all output summary>
```

If any items failed, list id + issues:

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every "- [ ]" is now "- [x]"

**Incomplete tasks** (if any):

| Task | Reason incomplete | Blocks archive |
|---|---|---|
| — | — | — |

---

## 3. Delta Spec Sync State

For each capability directory under `openspec/changes/<name>/specs/`, compare
against `openspec/specs/<capability>/spec.md`:

| Capability | Sync state | Notes |
|---|---|---|
| — | synced / pending / N/A | — |

---

## 4. Design / Specs Coherence

Compare every decision in `design.md` against the Requirements and Scenarios of
`specs/*.md`, and against the executable surface each decision names — the command,
script, schema instruction or skill it describes. Cite the file that would contradict the
decision, not the one that already agrees with it.

| Decision | design says | specs and executable surface say | Gap |
|---|---|---|---|
| — | — | — | — |

**Drift between two documents** (warning, non-blocking):

- <list if any; otherwise "none">

**Contradiction between two executable surfaces** (blocking — the verdict is FAIL):

- <list if any; otherwise "none">

---

## 5. Implementation Signal

- [ ] No uncommitted changes in the worktree
- [ ] Every commit this change produced is present in the branch's history

**Commit range** (if known): `<from-sha>..<to-sha>`

---

## 6. Tests For What This Change Touched

- [ ] Packages affected by this change are green, or the change touched none
- [ ] The run was real, not served from a cache
- [ ] Cited from apply's own record, or re-run because a commit landed since

**Packages affected** (from the `**Files:**` blocks in `plan.md`):

**Result**:

```text
<paste the test output — pass and fail counts, and the line showing nothing
was served from the cache. If no package was affected, say which directories
the change touched instead.>
```

If the affected packages could not be tested at all (missing `node_modules`, a missing
service they need), say which and record it as a FAIL rather than a pass.

---

## 7. No Leftover Group Worktree (`git worktree list`)

- [ ] No `.claude/worktrees/<TASK-ID>--group-*` path remains

**Result**:

```text
<paste the git worktree list output>
```

If a group worktree remains, name it here and record this as a blocking FAIL — the
apply phase stopped mid-fan-out.

---

## 8. Stale-Skill Check

- [ ] No CONFIRMED-stale skill remains unresolved (either fixed with developer approval, or
      explicitly declined with a recorded reason)

**Skills reviewed**: `<list every .claude/skills/*/SKILL.md checked, or "none — diff touches no
skill-relevant code">`

**Findings**:

| Skill | Classification | Detail | Resolution |
|---|---|---|---|
| — | CONFIRMED / PLAUSIBLE / — | — | approved and applied / declined: `<reason>` / — |

If any row is CONFIRMED and unresolved (no approval, no recorded decline), this check is a blocking
FAIL.

---

## 9. Workflow Shape

- [ ] Documentation matches the workflow shape derived from its own sources

**Result**:

```text
<paste the output of `node .claude/scripts/check-workflow-shape.mjs`, including its
exit status. A clean run prints nothing and exits 0.>
```

| File | Line | Rule | Expected |
|---|---|---|---|
| — | — | — | — |

A finding means a declaration site — the CLAUDE.md cycle line, stated artifact count or
artifact table, the schema description's artifact sequence, or the verify command's
sections-and-checks sentence —
disagrees with the shape derived from the schema, the command directory and this template,
or that the site's anchor could not be found. Incidental prose is not scanned.

---

## 10. Out-Of-Plan Commits

Commits on the change branch whose files lie outside every `### Task N`'s `**Files:**` block
in `plan.md`. Allowlisted: `openspec/changes/**`, `.claude-reports/**`.

- Commits checked: <!-- range -->
- Out-of-plan commits: <!-- none, or one line per commit: sha, file, why it has no task -->
- Result: <!-- PASS / FAIL -->

---

## 11. Flow Regression Set

One deterministic script per confirmed flow defect, under `.claude/scripts/adf-regression/`.
This is **one** check reporting per item, not one check per script: the shape check derives
the check count from this template's sections, so a set growing by one check per incident
would move that count on every future change.

- Items run: <!-- count, or 0 -->
- Per item: <!-- name, PASS/FAIL, incident, last fired -->
- Result: <!-- PASS / FAIL — an empty set is a PASS -->

---

## Overall Decision

- [ ] ✅ PASS — proceed to archive (removing the worktree is archive's last step)
- [ ] ⚠️ PASS WITH WARNINGS — proceed, but note: `<explanation>`
- [ ] ❌ FAIL — fix the failing artifact and re-run verify

**Next step**:

<describe the next action>
