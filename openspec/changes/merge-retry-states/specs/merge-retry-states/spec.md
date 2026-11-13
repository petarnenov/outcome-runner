## ADDED Requirements

### Requirement: Merge eligibility report

The pull request host SHALL be able to report the merge eligibility of an open pull request: its settled
`mergeStateStatus` and its required checks with their buckets (`pass`, `fail`, `pending`, `skipping`, `cancel`). A
`CLEAN` view SHALL be reported without reading checks. A host that does not report eligibility SHALL be treated as
eligible.

#### Scenario: CLEAN reads no checks

- **WHEN** `GitHubHost.eligibility` settles a `CLEAN` view of the checked head
- **THEN** it returns status `CLEAN` with no checks and issues no `gh pr checks` command

### Requirement: Required checks read from gh

`GitHubHost` SHALL read the required checks with `gh pr checks <number> --required --json name,bucket` and SHALL use
the printed JSON also when `gh` exits nonzero because checks are pending or failed.

#### Scenario: Pending checks are parsed from a nonzero exit

- **WHEN** the settled view is `BLOCKED` and `gh pr checks --required` exits nonzero while printing a pending and a
  passing check
- **THEN** `GitHubHost.eligibility` returns status `BLOCKED` with both checks and their buckets

### Requirement: Status-only merge refusal

`GitHubHost.merge` SHALL refuse a settled view whose only problem is a status other than `CLEAN` with a
`MergeIneligible` error carrying the status and the required checks, without calling the guard or `gh pr merge`.

#### Scenario: Merge refused by the status

- **WHEN** `GitHubHost.merge` settles an `OPEN`, non-draft view of the checked head and target with status `BEHIND`
- **THEN** it throws `MergeIneligible` with status `BEHIND`, its message is
  `PR protection or identity blocks merge (BEHIND)`, and neither the guard nor `gh pr merge` is called

### Requirement: BEHIND is an advanced target

When the settled pull request is `OPEN` with the checked head but its status is `BEHIND`, the runner SHALL treat it
as an advanced target: it SHALL record a retry with reason `behind`, log a `retry` step line and return to the catch-up
and publish steps, and SHALL NOT block with `operation-incomplete`. The retry SHALL count toward the attempt limit
unless the advance is release-only.

#### Scenario: BEHIND leads to catch-up and a merge

- **WHEN** the host reports `BEHIND` for the open pull request with the checked head on the first merge-stage view
  and `CLEAN` afterwards
- **THEN** the step log has `retry: #1 is behind origin/main; catching up (attempt 2)`, followed by the publish
  `compare` line with `(attempt 2)` and the checks and push of attempt 2
- **AND** the work records a `mergeRetries` entry with reason `behind` and attempt 2 and `targetAttempts` 1
- **AND** the task is merged and accepted, and no blocked entry has `operation-incomplete`

#### Scenario: Merge refusal BEHIND after an advance

- **WHEN** the host's `merge` advances the target outside the task scopes and throws `MergeIneligible` with status
  `BEHIND`
- **THEN** the runner integrates the advanced target, checks, pushes and merges the new checked head, and the task is
  accepted

### Requirement: Waiting for pending required checks

When the status is `BLOCKED`, `UNSTABLE` or `UNKNOWN` and required checks are still pending, or the status is
`UNKNOWN` without check results, the runner SHALL keep polling the pull request for up to 30 minutes from the first
pending view. It SHALL merge once the pull request is `CLEAN` and SHALL block with reason `merge-not-eligible` and
the last status when 30 minutes pass while it is still pending.

#### Scenario: Pending checks turn green and merge

- **WHEN** the host reports `BLOCKED` with a pending required check on two views and then `CLEAN`
- **THEN** the runner delays twice with the eligibility poll interval and merges the checked head
- **AND** the task is accepted

#### Scenario: Pending for more than 30 minutes

- **WHEN** the host keeps reporting `UNSTABLE` with a pending required check while the clock passes 30 minutes from
  the first pending view
- **THEN** the task is blocked with reason `merge-not-eligible`, the blocked entry and the run result blocker carry
  status `UNSTABLE` and the pending check names, and nothing is merged

### Requirement: Eligibility wait is quiet and read-only

The eligibility wait SHALL write one `wait` step line when it starts and one whenever the status changes, and SHALL
perform only pull request reads, target comparisons and delays.

#### Scenario: One wait line and no effects while pending

- **WHEN** the host reports `BLOCKED` with a pending required check on two views and then `CLEAN`
- **THEN** `wait: waiting for required checks of #1 (BLOCKED)` is written exactly once
- **AND** no check, commit, push or pull request creation happens during the wait

### Requirement: Failed required checks block at once

When a required check is in bucket `fail` or `cancel` while the status is `BLOCKED`, `UNSTABLE` or `UNKNOWN`, the
runner SHALL block the task at once with reason `merge-not-eligible`, the status and the sorted names of the failed
checks, without a delay or a further view.

#### Scenario: Failed required check

- **WHEN** the host reports `BLOCKED` with the required check `build` in bucket `fail` and `lint` in bucket `pass`
- **THEN** the task is blocked with reason `merge-not-eligible`, status `BLOCKED` and checks `['build']`
- **AND** the run result blocker has `kind` `blocked`, reason `merge-not-eligible`, `status` `BLOCKED` and `checks`
  `['build']`
- **AND** no delay was requested after that view, `merge` was never called, and the worktree and branches still exist

### Requirement: Statuses that waiting cannot fix

A `BLOCKED` or `UNSTABLE` status without pending or failed required checks, and any other non-`CLEAN`, non-`BEHIND`
status, SHALL block at once with `merge-not-eligible` and the status. This SHALL hold both when the status comes
from the eligibility read and when the host's `merge` refuses with `MergeIneligible` because the status changed
after that read; such a refusal SHALL NOT end as `operation-incomplete`.

#### Scenario: Classification of refused statuses

- **WHEN** the eligibility is `BLOCKED` with only passing checks, or `DIRTY`
- **THEN** it is classified as refused and the runner blocks with `merge-not-eligible` and that status

#### Scenario: Merge refused after an eligible read

- **WHEN** the eligibility read reports `CLEAN` and the host's `merge` then throws `MergeIneligible` with status
  `DIRTY` and no checks
- **THEN** the task is blocked with reason `merge-not-eligible`, status `DIRTY` and empty checks, the run result
  blocker carries the same reason and status, and no blocked entry has `operation-incomplete`

### Requirement: Release commits do not consume attempts

A target advance whose commits are all release commits (`chore(release): vX.Y.Z`) and whose changed paths are only
`package.json` and `package-lock.json` with changes limited to their version fields and `CHANGELOG.md` SHALL be
integrated, checked and published like any advance but SHALL NOT count toward the target attempt limit. Any other
advance SHALL count.

#### Scenario: Release-only advance does not consume an attempt

- **WHEN** a release commit that changes only the `version` fields of `package.json` and `package-lock.json` and adds
  a `CHANGELOG.md` section reaches the target right before the merge
- **THEN** the runner logs `retry: origin/main advanced with a release commit; integrating it without using an
  attempt (attempt 1)`, integrates the commit and merges the task
- **AND** the accepted work has `targetAttempts` 0 or absent and a `mergeRetries` entry with reason `release-commit`

#### Scenario: A dependency change is not release-only

- **WHEN** a commit with subject `chore(release): v1.2.3` also changes a dependency in `package.json`
- **THEN** the advance counts toward the attempt limit

#### Scenario: Attempt limit reached with target-keeps-advancing

- **WHEN** the target advances with non-release commits before 10 consecutive merges and release-only advances occur
  in between
- **THEN** the task is blocked with `target-keeps-advancing` after the tenth counted attempt, the `retry` lines that
  count carry attempts 2 to 10, and the release-only retries did not raise the attempt number

### Requirement: Durable merge retries

Each merge-stage retry and its reason SHALL be recorded in the durable work (`mergeRetries`, `targetAttempts`,
`mergeWait`) before the next effect and logged as a step line. A restart SHALL resume at the recorded attempt count
and, during an eligibility wait, at the recorded start of the wait.

#### Scenario: Restart resumes at the recorded attempt

- **WHEN** a run is cancelled right after a `behind` retry was recorded and the same invocation runs again
- **THEN** `state.json` shows `targetAttempts` 1 and one `mergeRetries` entry with reason `behind`
- **AND** the rerun's publish `compare` line carries `(attempt 2)`, no second `behind` entry is recorded, and the task
  is merged and accepted

#### Scenario: Restart during an eligibility wait keeps its start

- **WHEN** a run is cancelled during a pending-checks wait and rerun while the checks stay pending
- **THEN** the rerun keeps `mergeWait.since` of the first run and blocks with `merge-not-eligible` once 30 minutes have
  passed since that time

### Requirement: README describes merge eligibility retries

The README SHALL describe merge eligibility retries (BEHIND catch-up and the 30-minute wait for pending required
checks), the blocked reason `merge-not-eligible` with its status and check names, and the release-commit exception to
the attempt limit.

#### Scenario: README section

- **WHEN** a reader looks up target advances in the README
- **THEN** the section names `BEHIND`, pending required checks, `30 minutes`, `merge-not-eligible`, release commits
  and that they do not count toward the attempt limit

### Requirement: Verification

Automated tests SHALL use scripted hosts, a fake clock and Git fixtures without real-time waits, and
`npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Suite passes

- **WHEN** the bound implementation is verified
- **THEN** `npm run typecheck` and `npm test` pass with the coverage gate
