# Design: tolerate a stale pull request head

## Current Behavior

In `src/runner.ts`, the merge stage reads the PR, validates the work and tested target, then rejects either a changed local HEAD or a mismatched PR head. An unrelated target advance sends work back through publish, which integrates, checks and pushes a new recorded head. The next PR read may still expose the previous head.

In `src/git.ts`, `GitHubHost.settledMergeView` polls only `mergeStateStatus === 'UNKNOWN'`. Its limit is 100 total views; `mergeStatePollMs` defaults to 3000. `GitHubHost.merge` then validates state, head, base, mergeability and draft status before issuing the guarded merge.

## Polling Contract

Treat a mismatched PR head as potentially stale, not as proof of foreign movement. Resolve the task branch directly on origin using the argument-array command `git ls-remote origin refs/heads/<branch>`. Parse the exact requested ref and compare its object ID to the recorded tested head. A remote-tracking ref or local HEAD is not authoritative evidence for origin's current branch.

For each mismatched view, including a final mismatched view, verify origin's branch. Only equality permits another view when budget remains. A different or missing ref must fail closed with `Checked head or target changed`; a failed remote read must also prevent merge and retain private failure diagnostics. Never replace the expected head with an observed foreign value.

Use the existing mergeability cadence and limit for both callers: 3000 ms between views and 100 views by default, counting the initial view. There is no delay after the final view. A matching head on the last permitted view is eligible for the existing merge checks. Exhaustion with a mismatched head produces `Checked head or target changed`.

Share a small internal policy/helper where useful so the runner and GitHub host cannot drift on defaults, budget accounting or exact origin-ref verification. Preserve scripted `PullRequestHost` support; the runner must not rely on a GitHub-only method to reread via `host.find(work.branch)`.

## Runner Merge Stage

Preserve the existing handling of a missing PR, already merged PR, exact specification, changed target and local HEAD. Keep the local HEAD mismatch an immediate failure; stale metadata must not hide local mutation. With an otherwise eligible PR whose head differs from `now.head`, enter the bounded wait and reread the PR via the scripted or real host.

Reevaluate the fresh PR rather than merging the original stale object. Missing or closed PRs must not become merge candidates. Keep the tested-target and local HEAD guards effective at the merge boundary after a potentially long wait: a new target advance follows the existing return-to-publish path, and changed local HEAD still blocks. Once the head matches, call `host.merge` with the recorded tested head. Receipt validation and restart reconciliation retain their existing roles.

## GitHub Host

Supply the expected head and branch identity to the settled-view path. Prefer the branch already present on the PR returned by `find`; ensure `find` requests the GitHub head branch field if necessary. If branch identity is absent on a direct merge call, obtain it from the PR view before doing origin-ref verification. Never guess a branch from the expected hash.

Extend the settled-view loop to continue for either unknown mergeability or an eligible stale head. These reasons share one total view budget per settled-view call; head convergence must not reset it or start a second 100-view phase. An origin mismatch during a stale-head view must terminate immediately, even when mergeability is UNKNOWN. A matching head with UNKNOWN mergeability continues the existing wait.

After settling, stale-head exhaustion or remote mismatch yields the exact identity error. Existing OPEN, base, CLEAN and non-draft protections still apply; a settled BLOCKED status with an already matching head fails without waiting. Keep `gh pr merge --merge --match-head-commit <recorded head>` unchanged and never bypass protection.

## Effects and Tests

The polling operation performs only PR views, origin-ref reads and delays. It must not call checks, commit, push or PR creation. The full target-advance regression may observe the normal integration/check/push before the wait; snapshot effect counters at wait entry to distinguish those authorized effects from polling.

Extend `test/runner.test.ts` or focused files under `test` using the current scripted adapter, fixture origin and target-advance helpers. Script independent PR view snapshots so a stale response cannot accidentally mutate the recorded expected head. Cover convergence after several views, convergence at the final view, foreign origin movement on the initial or a later stale view, and stale-head exhaustion. Assert accepted versus blocked state, exact blocked reason and merge call counts.

Reproduce the full race by advancing an unrelated target after PR creation, allowing the publish cycle to integrate/check/push, then returning the old head for several views before the new recorded head. Assert one existing PR and a merge of the newly tested head without restarting.

Exercise the corresponding convergence, foreign-origin and exhaustion cases directly through `GitHubHost.merge`, including combined UNKNOWN/stale views sharing a budget and preserved guarded-merge arguments. Use actual local bare Git origins to exercise `ls-remote`, with scripted gh responses. Existing direct host tests with matching heads need no remote lookup.

Inject a fake/no-op delay for all polling tests, or use the test runner's timer mocking; assert the configured delay values without elapsed wall time. A minimal internal injection seam is allowed within `src`; do not add public CLI/configuration options for this fix.

## Validation and Boundaries

After specification binding, run `npm run typecheck` and `npm test` and the frozen project checks. Keep package scripts, unrelated capabilities and external services outside scope. The remote read is a point-in-time observation; retain GitHub's existing match-head merge guard for changes after observation. This plan does not claim an atomic transaction between Git and GitHub.
