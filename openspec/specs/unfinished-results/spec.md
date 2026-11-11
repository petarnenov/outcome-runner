# unfinished-results Specification

## Purpose
TBD - created by archiving change explain-unfinished-results. Update Purpose after archive.

## Requirements

### Requirement: Dependencies inside the invocation

Before creating run state, claiming or working any task, the runner SHALL check that every dependency of every task
it will work (the leaves, or all authority tasks when no leaves are given) is in that set or already accepted (a
valid receipt on `origin/<target>`).

#### Scenario: Dependency already accepted

- **WHEN** the leaf `B` depends on `A`, `A` is not a leaf and `A`'s receipt is already on the target
- **THEN** the dependency check passes and `B` is worked and accepted

#### Scenario: Dependency inside the set

- **WHEN** no leaves are given and every dependency of every authority task is an authority task
- **THEN** the dependency check passes

### Requirement: Refusal of dependencies outside the invocation

When the dependency check fails, the runner SHALL refuse the run with exit code 4 and diagnostics reason
`dependencies-outside-invocation`, listing each such task with its missing dependencies. The runner SHALL NOT exit 3
because a dependency outside the invocation can never be worked.

#### Scenario: Leaves missing a dependency

- **WHEN** the leaves are `B` and `C`, `B` depends on `A`, `C` depends on `A` and `X`, and neither `A` nor `X` is a
  leaf or accepted
- **THEN** the run exits 4, the printed reason is `dependencies-outside-invocation`, the diagnostics file lists `B`
  with `[A]` and `C` with `[A, X]`, and no `state.json`, claim or worktree is created

### Requirement: Every unfinished task explained

An `incomplete` result (exit code 3) SHALL contain in `blockers` one entry with a `kind` for every task in
`remaining`, so `blockers` is never empty while `remaining` is not. The classification SHALL use a snapshot of the
claims ledger taken on the return path itself, so the reasons are the same on every return path.

#### Scenario: Blockers cover remaining tasks

- **WHEN** a run returns `incomplete` with remaining tasks
- **THEN** every remaining task id has exactly one entry in `blockers`

### Requirement: Work continues after a failed acceptance recording

When recording the acceptance of a merged task fails, the runner SHALL record that task as blocked. Unless the run's
`maxAccepted` limit is reached by that task, the runner SHALL continue selecting and working the other tasks of the
invocation in the same run, and the run SHALL still end with an `incomplete` result (exit code 3) that holds the
`blocked` entry of the failed task and does not release the invocation's ownership.

#### Scenario: Independent task after a failed acceptance recording

- **WHEN** `maxAccepted` is unset, leaves `A` and `B` are independent with non-overlapping scopes, no foreign claim
  exists, and `A` merges but its acceptance recording fails
- **THEN** `B` is selected and worked in the same run, the run exits 3 (not 4), `A`'s blocker has `kind` `blocked`,
  and every task still in `remaining` has an explained `blockers` entry

### Requirement: Blocked and dependency reasons

A blocked task SHALL be explained with `kind` `blocked`, its `reason` and its `stage`. A task waiting for an
unfinished dependency SHALL be explained with `kind` `waiting-for-dependency` naming the unfinished `dependencies`.

#### Scenario: Blocked task

- **WHEN** a task's session fails and nothing else can be worked
- **THEN** the result is `incomplete` and its blocker has `kind` `blocked`, `reason` `operation-incomplete`, the
  `stage` where it stopped and the `state.json` diagnostics path

#### Scenario: Waiting for a dependency

- **WHEN** leaf `B` depends on leaf `A` and `A` is blocked
- **THEN** `B`'s blocker has `kind` `waiting-for-dependency` and `dependencies` `["A"]`

### Requirement: Claim and scope reasons

A task waiting for a foreign claim with the same id or overlapping scopes SHALL be explained with `kind`
`waiting-for-claim` naming the `claim`. A task whose scopes overlap a blocked task of this invocation SHALL be
explained with `kind` `waiting-for-blocked-scope` naming that `task`.

#### Scenario: Waiting for a foreign claim

- **WHEN** another claimant holds a claim with scopes overlapping a remaining task
- **THEN** that task's blocker has `kind` `waiting-for-claim` and names the claimed task id and host

#### Scenario: Waiting for a blocked scope

- **WHEN** a remaining task's scopes overlap a blocked task of this invocation
- **THEN** its blocker has `kind` `waiting-for-blocked-scope` and names the blocked task

### Requirement: maxAccepted reason

A remaining task that is not blocked and is left because the run's `maxAccepted` limit is reached SHALL be
explained with `kind` `max-accepted`. The limit SHALL count only tasks of this invocation accepted during the run
(including a merged task of the invocation whose acceptance recording failed), never tasks outside the invocation
accepted by other runners. A `limit-reached` result SHALL carry the same `blockers` entries for its remaining tasks.

#### Scenario: Stopped by maxAccepted

- **WHEN** `maxAccepted` is 2, one task was accepted, a second task merged but its acceptance recording failed, and a
  third task remains
- **THEN** the result is `incomplete`, the third task's blocker has `kind` `max-accepted`, and the second task's
  blocker has `kind` `blocked`

#### Scenario: Limit reached

- **WHEN** `maxAccepted` is reached while tasks remain
- **THEN** the `limit-reached` result gives each remaining task that is not blocked `kind` `max-accepted`, and each
  blocked remaining task `kind` `blocked`

#### Scenario: Foreign acceptance does not count

- **WHEN** `maxAccepted` is 1, no task of the invocation was accepted, another runner accepts a task outside the
  invocation, and the only remaining task waits for a foreign claim
- **THEN** its blocker has `kind` `waiting-for-claim`, not `max-accepted`

### Requirement: Invocation status in state

`state.json` SHALL carry in `status` the invocation status the runner last reached - `running`, `incomplete`,
`blocked`, `completed` or `released` - instead of staying at `starting`. `running` SHALL be written when work
starts, and the final status SHALL be written before `runQueue` returns.

#### Scenario: Running during work

- **WHEN** a session of the first task starts
- **THEN** `state.json` `status` is `running`

### Requirement: Released final status

The final status SHALL be `released` when the run releases its ownership: all leaves accepted without a blocked
task, or a `limit-reached` result with no blocked task of the invocation and no in-progress work. In-progress work is
a current task or recovered earlier work that is claimed but neither accepted nor blocked; unstarted tasks explained
with `kind` `max-accepted` are not in-progress work.

#### Scenario: Completed run

- **WHEN** a run accepts every leaf
- **THEN** `state.json` `status` is `released`

#### Scenario: Limit reached without blocked or in-progress work

- **WHEN** `maxAccepted` is 1, a run accepts one of two independent leaves, the other leaf is unstarted and no task
  is blocked
- **THEN** the result is `limit-reached`, the unstarted leaf's blocker has `kind` `max-accepted`, the ownership is
  released and `state.json` `status` is `released`

### Requirement: Blocked final status

The final status SHALL be `blocked` for a `limit-reached`, `incomplete` or `cancelled` result that holds a blocked
task of the invocation.

#### Scenario: Limit reached with kept blocked work

- **WHEN** a run returns `limit-reached` while a blocked task of the invocation remains
- **THEN** `state.json` `status` is `blocked`

#### Scenario: Blocked run

- **WHEN** a run returns `incomplete` with a blocked task, including a merged task whose acceptance recording failed
- **THEN** `state.json` `status` is `blocked`

### Requirement: Completed and incomplete final status

The final status SHALL be `completed` for a `limit-reached` result that keeps in-progress work and has no blocked
task of the invocation, and `incomplete` for any other `incomplete` or `cancelled` result.

#### Scenario: Limit reached keeping in-progress work

- **WHEN** a run returns `limit-reached` while recovered claimed work is kept for a later run and no task is blocked
- **THEN** `state.json` `status` is `completed`

#### Scenario: Incomplete run

- **WHEN** a run returns `incomplete` because its only remaining task waits for a foreign claim
- **THEN** `state.json` `status` is `incomplete`
