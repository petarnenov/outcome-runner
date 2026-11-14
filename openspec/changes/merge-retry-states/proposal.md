# Proposal: merge retries that tolerate pending checks, a behind pull request and release commits

## Why

The merge stage asks the pull request host to merge the checked head and treats every refusal the same way.
`GitHubHost.merge` throws `PR protection or identity blocks merge (<status>)` for any settled `mergeStateStatus`
other than `CLEAN`, and the runner records that as `operation-incomplete`. Three common, temporary situations
therefore stop a task that would merge minutes later:

- **BEHIND**: the repository requires branches to be up to date, so GitHub reports the open pull request with the
  checked head as `BEHIND` the target. This is an advanced target and the existing catch-up and publish path can
  resolve it, but it is never reached.
- **Pending required checks**: right after a push the required checks of the new head are still running and GitHub
  reports `BLOCKED`, `UNSTABLE` or `UNKNOWN`. The runner blocks instead of waiting for the checks.
- **Release commits**: the release workflow pushes `chore(release): vX.Y.Z` commits that only bump the `version`
  fields of `package.json` and `package-lock.json` and add a `CHANGELOG.md` section. Every merged pull request
  triggers one, so a busy target burns the 10-attempt limit of `target-keeps-advancing` on commits that never
  touch product code.

## What changes

- The pull request host can report merge eligibility: the settled `mergeStateStatus` plus the required checks of the
  pull request with their buckets (`pass`, `fail`, `pending`, `skipping`, `cancel`). `GitHubHost` reads them with
  `gh pr view` and `gh pr checks --required`. A merge refused only because of the status throws a typed
  `MergeIneligible` error carrying the same data.
- The merge stage classifies the eligibility of the open pull request with the checked head:
  - `BEHIND` is handled like an advanced target: a `retry` with reason `behind`, back to the catch-up and publish
    steps.
  - `BLOCKED`, `UNSTABLE` or `UNKNOWN` with pending required checks keeps polling for up to 30 minutes, then blocks
    with the new reason `merge-not-eligible` and the last status.
  - A failed or cancelled required check blocks at once with `merge-not-eligible` and the check names.
- A target advance whose commits are only release commits changing only the `version` fields of `package.json`,
  `package-lock.json` and `CHANGELOG.md` is integrated as usual but does not count toward the attempt limit.
- Each merge-stage retry and its reason is saved in the durable work (`mergeRetries`, `targetAttempts`, `mergeWait`)
  before the next effect and logged as a step line, so a restart resumes at the recorded attempt and wait.
- `explainUnfinished` keeps `merge-not-eligible` with its status and check names in the run result blocker.
- README describes merge eligibility retries, `merge-not-eligible` and the release-commit exception.

## Capabilities

- New: `merge-retry-states`.
- Modified: `merge-when-target-unchanged` (requirement "Bounded repeats": release-only advances do not count).

## Impact

- Code: `src/merge-eligibility.ts` (new: pure classification and release-only detection), `src/git.ts`
  (`GitHubHost.eligibility`, `requiredChecks`, `MergeIneligible`), `src/runner.ts` (merge stage, blocker),
  `src/model.ts` (`Work.mergeRetries`, `Work.mergeWait`), `src/run-store.ts` (blocked entry eligibility).
- Tests: new `test/merge-retry-states.test.ts` with scripted hosts, a fake clock and Git fixtures.
- Docs: `README.md`.
- Hosts without `eligibility` behave as before (assumed eligible), so existing scripted hosts and tests keep
  working. The refusal message of `GitHubHost.merge` stays `PR protection or identity blocks merge (<status>)`.
