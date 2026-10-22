# Iteration 14 — Behaviour check

## Goal

The port runs the whole cycle on the origin's own archived changes, in a sandbox copy of the
origin at each change's base commit, and the result is compared with what the origin produced:
the branch, the artifacts' structure, the plan's groups and waves, the commit sequence, the
ledger, the review verdict, the archive result and the merge request. Every existing parity
tool checks one script on origin data; this iteration checks one phase consuming another
phase's output. The replay is script-level and repeatable, and it runs in `npm run parity`. One
pass with real agents through the real commands checks what the scripts cannot: the commands'
text and the agents' replies. Strong differences are fixed before the switch (iteration 15).

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Sandbox builder `scripts/parity/lib/sandbox.mjs`: a `--no-hardlinks` clone of the origin as a per-run cache under `os.tmpdir()/adf-replay-<id>/` (no `xnms` in the path), one `--shared` clone per candidate from that cache, a bare `remote.git` that both `origin` URLs point at, `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR` inside the sandbox, a `PATH` starting with the sandbox `bin/` holding logging fakes of `glab`, `docker`, `psql` and `npx`, and the fake-Jira preload; an isolation assertion at start | `sandbox.spec.mjs`: refuses a remote URL outside the sandbox, a fake binary that does not resolve into `bin/`, the real `HOME`; a poisoned `PATH` run refuses; the origin's refs, `git status` and stash are unchanged after a run |
| 2 | Candidate discovery by rule, not by a committed list: regular changes of the final origin flow (archive with a ledger, `plan.md`, `verify.md` and `review.md`), plus named exceptions given as arguments; the base: the exact base when the local branch survives, else the merge's first parent (D3); the merge request number from the merge commit | `replay-candidates.spec.mjs` on a fixture repository: squashed and branch-kept changes, an anomaly left out, `no-branch` reported (D10) |
| 3 | Host setup driver: `/adf:init`, the branch policy, the debt root and the registry entries from the inputs of iterations 12 and 13, committed on the sandbox `develop` and pushed to `remote.git`; it reports every host edit the switch needs (registry, `.gitignore`, `openspec/planning.md` sections, the debt tables' `Jira` → `Tracker` rename) | the host check passes after setup; the edit list is written into this record's inputs for 15 |
| 4 | Reply synthesizer: every place an agent writes is filled from the origin's records (artifacts from the archive directory or the propose commit, task results from the commits, review findings from `review.md`, the ingest reply from the memory diff), each reply validated by the port's own schema (D5) | every synthesized reply passes its schema; a synthesized difference is classified `injected` |
| 5 | Phase drivers, fresh mode: propose (create, gates, commit, Draft), apply (groups, waves, group worktrees, task commits, merges, suite record), verify, review (assemble, gate), archive (all steps and resume), land; each phase reads only the previous phase's output and the injected replies | each candidate reaches the end of archive; a resumed archive gives the same result |
| 6 | Mid-flight mode (the change with the kept branch): start from the origin's own propose commit, pinned to the origin schema, and continue with the port's apply to archive; `adf-gitlab` `finalize` replaces a Draft block with the origin's `opsx:` marker of the same change once (D6) | `forge.spec.mjs`: an `opsx:` block is replaced, no second block; the mid-flight replay reaches the end of archive |
| 7 | Comparison and report in `scripts/parity/origin-replay.mjs`: branch, worktree, artifacts and their headings, gate verdicts, groups and waves, the commit sequence by phase, the ledger, the review verdict and counts, the main specs after merge, the final `openspec/` and memory tree, the merge request call log against `glab mr view`; each difference `explained` (it cites a lessons row), `older-origin`, `injected` or `defect`; only `defect` fails, and a strong difference (D7) is always `defect` until explained | the tool runs in `npm run parity` on every candidate |
| 8 | The plan graph gap (D8): run the graph check offline on every regular origin plan; tasks the origin ran on the change branch after the groups are either allowed by the port or a plan defect, decided on that evidence; `tasks-lint` stops warning on origin wording that is not a path (`N/A`, a directory name) | `plan.spec.mjs` / `tasks-lint` tests with the origin wordings |
| 9 | Fix every `defect` the replay finds; a difference the developer accepts becomes a `changed` lessons row | `origin-replay.mjs` has no `defect` |
| 10 | One pass with real agents: the small candidate through `/adf:propose` … `/adf:archive` in a sandbox (D1), the developer answering the brainstorm and the holds; nothing leaves the sandbox | the transcript and the result are recorded in `## Result`; every difference from the script-level replay is classified |
| 11 | Inputs for iteration 15 (host edits from step 3, the in-flight Drafts, the mid-flight rule); lessons; version; roadmap row 14; `## Result` | `check-lessons.mjs`, `npm test`, `npm run parity -- <origin>`, `claude plugin validate .` |

## Decisions

Settled by the developer on 2026-10-22, all as recommended. Analysis: the iteration 14
analysis of 2026-10-22.

- D1 Script-level replay first, in `npm run parity`; then one pass with real agents on the
  small candidate. A full pass with real agents on every candidate is not done (about $200 per
  pass); row 18 repeats the agent pass on real systems after the switch.
- D2 Candidates: a small change, a database change, a flow-only change and a large change, by
  rule; a second database change as a fallback.
- D3 A squash-merged change replays from the merge's first parent; a gate difference that comes
  only from that base is `injected`.
- D4 No real database: `docker`, `psql` and `npx` are logging fakes; the real create, drop and
  generate stay "not run" until the switch, as iteration 12 recorded.
- D5 Agent replies are synthesized from the origin's records everywhere; transcripts are a
  cross-check only where they exist.
- D6 `finalize` replaces the origin's `opsx:` block of the same change once, so the in-flight
  Drafts migrate at the switch without a duplicate block.
- D7 Strong: a stopped phase, another branch or base, a lost or invented ledger record, another
  spec merge result, another merge request state sequence. Wording, warnings and noise are
  recorded only.
- D8 Tasks outside every group are decided on the evidence of every regular origin plan.
- D9 One clone of the origin per run, as a cache inside the sandbox.
- D10 A change without its local branch is replayed and compared on its final tree only. The
  developer keeps the two branches the mid-flight mode needs until iteration 15.
- No origin content is committed to this repository: candidates are found at run time, and no
  change name, commit, bundle or merge request body is stored here.
