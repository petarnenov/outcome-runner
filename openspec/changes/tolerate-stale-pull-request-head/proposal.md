# Tolerate a stale pull request head after a push

## Why

OR-13 addresses the OR-2 failure on PR #14 (2026-11-10): while the task waited in the merge stage, the target advanced. The runner integrated the target, checked and pushed a new head, but GitHub briefly returned the previous PR head. The immediate identity check blocked with `Checked head or target changed`; restarting the same invocation then merged successfully.

## What Changes

- In the runner merge stage, poll a mismatched PR head only while `git ls-remote origin refs/heads/<branch>` confirms the recorded tested head.
- Apply the same rule to the settled merge view used by `GitHubHost.merge`.
- Reuse the existing mergeability polling defaults: 3 seconds between views and at most 100 views, including the first.
- Block foreign branch movement and exhausted stale-head waits with `Checked head or target changed`, without merging.
- Preserve the local HEAD guard, target integration behavior, PR protections and `--match-head-commit <recorded head>`.
- Add deterministic scripted-host and Git-fixture regressions, including the complete target-advance race.

## Scope and Acceptance

Future product changes are confined to `src` and `test`; there are no task dependencies. The wait itself performs reads and delays only: it reruns no checks and creates no commit, push or PR. Existing target integration and its checks/push remain outside that wait.

This session writes only this change's proposal, design, tasks and capability delta. Implementation and execution of `npm run typecheck`, `npm test` and frozen project checks belong to the later session after specification binding.
