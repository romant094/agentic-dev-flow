# Iteration 14a — Parity gate and window fixes

## Goal

`npm run parity -- <origin>` passes again on the release branch: the defects that iteration 14's
fixes caused in the parity harness are fixed, and the replay cannot hang. The window
retrospective the developer ran on the origin after iteration 14 found two defects in the port's
window, and they are fixed too.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | The replay host fakes the worktree preparation recipe (`setupHost` takes `prepareCommand`, and the sandbox has an `adf-replay-prepare` command), so a group worktree is prepared without building the origin's packages | `replay-host.spec.mjs`, `replay-drive.spec.mjs` |
| 2 | The reply reader takes the last `>` before the heredoc's `<<` as the reply's file, and skips a file descriptor redirect such as `2>&1` | `reply-v1.spec.mjs` |
| 3 | `origin-metrics-findings.mjs` counts a reply body that was refused and then fixed by a script as `unread-write` | `origin-metrics-findings.spec.mjs` |
| 4 | A window leaves out the transcript groups of a change whose branch another change shares, and names that change in `sharedBranch`; `origin-window.mjs` classifies the difference as `branch-shared` | `window.spec.mjs`, `npm run parity` |
| 5 | `cost.ttlNetSaving`: rewritten tokens × (1.25 − 0.1) − 5-minute cache writes × (2 − 1.25), in token-equivalents, higher is better | `window.spec.mjs`, `docs/lessons/metrics.md` |
| 6 | A role or hook provider gets its payload on stdin from a file, not from `spawnSync`'s `input`; a provider still running after 20 minutes (`ADF_PROVIDER_TIMEOUT_MS`) is stopped and refused | `roles.spec.mjs` |
| 7 | Version adf 0.17.2 | `npm test`, `npm run parity -- <origin>` |

## Decisions

Settled by the developer on 2026-10-29.

- Parity runs in every release step, not only at the end of an iteration: iteration 14's fixes
  broke it, and nothing showed that before the release.
- A change whose branch another change shares has transcript figures that cannot be split
  between the two. The window leaves them out and says so, and the parity class `branch-shared`
  explains the difference from the origin's figures.
- The TTL saving is counted in token-equivalents with a cache read at 0.1 of the input price,
  not in dollars, so it does not depend on the model's price.
- The hook hang (step 6) was found in the release's own parity run: the `adf-prisma` provision
  hook waited for end of input on stdin for almost two hours. The payload file gives the end of
  input; the timeout bounds any other hang.
- Deferred: the overhead split for small changes, to iteration 17 (`/adf:quick`); a baseline
  for the port's first window.

## Result

- Commits: 4028816 (steps 1–3), df47fa3 (steps 4–5), e4852c5 (step 6).
- `npm test`: 1503 tests, 1498 pass, 0 failures.
- `npm run parity -- <origin>` with four fresh candidates and one mid-flight: 23 tools pass, 0 fail; the origin checkout has no changes after the run.
