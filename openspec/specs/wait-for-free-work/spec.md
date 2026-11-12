# wait-for-free-work Specification

## Purpose
TBD - created by archiving change wait-for-free-work. Update Purpose after archive.

## Requirements

### Requirement: Wait for work held elsewhere

When no remaining task can be picked and every blocker of every remaining task (and of every blocked task of the
invocation) has `kind` `waiting-for-claim` or `waiting-for-dependency`, the runner SHALL NOT end the run. It SHALL
wait one poll interval, then fetch the target, pull the claims ledger again, recompute the done tasks and pick the
next free task, repeating until a task can be picked or another ending applies.

#### Scenario: Claimed task becomes done

- **WHEN** invocation `one` has leaves `A` and `C`, `C`'s scopes overlap `A`'s, `A` is claimed by invocation `two`,
  and during `one`'s wait `two` merges `A`
- **THEN** after the poll `one` recomputes `A` as done, the claim of `A` no longer blocks `C`, `one` claims and
  accepts `C` in the same run, and the run ends `exhausted` with exit code 0

#### Scenario: Dependency merged by another runner

- **WHEN** invocation `one`'s leaf `B` depends on `A`, `A` is a task of `one` claimed by invocation `two`, and `two`
  merges `A` while `one` waits
- **THEN** `one` waits with `B` explained as `waiting-for-dependency`, and after `A`'s receipt appears on the target
  it claims and accepts `B` in the same run

#### Scenario: Claim released by dispose

- **WHEN** invocation `two` is blocked on task `B` holding its claim, invocation `one` with leaf `B` waits for it, and
  `two` is disposed during the wait
- **THEN** after the poll `one` claims `B` and accepts it in the same run

### Requirement: No wait for work nobody can finish

The run SHALL end with `incomplete` and the existing blockers, without waiting, when a remaining task or a task of
the invocation has a blocker of any other kind. This includes a task blocked in this invocation's own state, a task
depending on such a task, and a task waiting for a blocked scope. It SHALL end with `exhausted` or `limit-reached`
exactly as before when those apply.

#### Scenario: Self-blocked task

- **WHEN** leaf `B` depends on leaf `A`, `A`'s session fails and `A` is blocked in this invocation's state
- **THEN** the run ends `incomplete` with `A` `blocked` and `B` `waiting-for-dependency`, and the sleep is never
  called

#### Scenario: Mixed blockers

- **WHEN** one remaining task waits for a foreign claim and another task of the invocation is blocked in this
  invocation's own state
- **THEN** the run ends `incomplete` without waiting

#### Scenario: Limit reached

- **WHEN** `maxAccepted` is reached while other remaining tasks are claimed elsewhere
- **THEN** the run ends `limit-reached` without waiting

### Requirement: Poll interval

The poll interval SHALL default to 60 seconds and SHALL be set by the invocation field `pollSeconds`, an integer from
5 through 3600. An invalid value SHALL be refused at startup, before any preflight, lock, state, ownership file,
claim or worktree, with exit code 4, reason `invalid-poll-seconds`, and diagnostics naming `pollSeconds`.
`pollSeconds` SHALL NOT be part of the invocation identity.

#### Scenario: Default interval

- **WHEN** the invocation omits `pollSeconds` and the run waits
- **THEN** the sleep is called with 60000 milliseconds

#### Scenario: Configured interval

- **WHEN** the invocation sets `pollSeconds` to 5 and the run waits
- **THEN** the sleep is called with 5000 milliseconds

#### Scenario: Invalid pollSeconds refused

- **WHEN** the invocation sets `pollSeconds` to `4`, `3601`, `7.5` or `"60"`
- **THEN** the run exits 4, the printed reason is `invalid-poll-seconds`, the diagnostics file names `pollSeconds`,
  and no `state.json`, claim or worktree is created

#### Scenario: Interval outside the identity

- **WHEN** an invocation is resumed with a different valid `pollSeconds`
- **THEN** its identity is unchanged and the run resumes

### Requirement: Wait step line

While waiting, the runner SHALL write one step line per poll, immediately before each sleep, naming the tasks it
waits for and the hosts recorded in their foreign claims.

#### Scenario: Step line per poll

- **WHEN** task `B` is claimed by another invocation and the run polls twice (it sleeps twice: the first sleep
  returns, and the run's signal is aborted during the second sleep)
- **THEN** exactly two step lines with step `wait` are written, one before each sleep, each naming `B` and the host
  recorded in `B`'s claim

### Requirement: Cancel during the wait

A cancel signal during the wait SHALL end the run with `cancelled` without a further fetch, ledger pull, claim,
worktree or session. The result SHALL keep the blockers of the remaining tasks, `state.json` `status` SHALL be
`incomplete` and the ownership SHALL stay unreleased.

#### Scenario: Cancel during the wait

- **WHEN** during the wait the remote target and the remote claims-ledger branch each receive a new commit, and then
  the run's abort signal fires
- **THEN** the result is `cancelled`, the local `origin/<target>` ref and the local claims-ledger ref still hold
  their values from before the wait (no fetch or ledger pull followed the abort), no claim commit, worktree or
  session follows the abort, `state.json` `status` is `incomplete` and the ownership file has `released: false`
