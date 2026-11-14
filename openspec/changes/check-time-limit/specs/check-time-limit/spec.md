## ADDED Requirements

### Requirement: Product check time limit

Every product check command SHALL have a time limit. This covers checks a worker session runs through the broker
(`run_checks`) and checks the runner runs itself: work-stage checks, final checks, integration checks and the checks
before publishing and merging. The limit SHALL default to 30 minutes.

#### Scenario: Default limit

- **WHEN** the invocation omits `checkTimeoutMinutes`
- **THEN** each product check runs with a limit of 30 minutes, and the limit line of a timed-out check reads
  `Check timed out after 30 minutes`

#### Scenario: Checks within the limit unchanged

- **WHEN** every product check ends within its limit
- **THEN** passing checks are recorded as `passed` with their output, and failing checks fail with their stdout and
  stderr as before; no `check timeout` step line is written, and the task is accepted as before

### Requirement: checkTimeoutMinutes setting

The invocation field `checkTimeoutMinutes` SHALL set the product check time limit in minutes. Its value MUST be an
integer from 1 through 240.

#### Scenario: Configured limit

- **WHEN** the invocation sets `checkTimeoutMinutes` to 1, or to 240
- **THEN** the value is accepted and the limit is 1 minute, or 240 minutes

### Requirement: Invalid checkTimeoutMinutes refused

An invalid `checkTimeoutMinutes` SHALL be refused at startup, before any preflight, lock, state, ownership file,
claim or worktree, with exit code 4, reason `invalid-check-timeout` and diagnostics naming `checkTimeoutMinutes`.

#### Scenario: Invalid checkTimeoutMinutes refused

- **WHEN** the invocation sets `checkTimeoutMinutes` to `0`, `241`, `7.5` or `"30"`
- **THEN** the run exits 4, the printed reason is `invalid-check-timeout`, the diagnostics file names
  `checkTimeoutMinutes`, and no `state.json`, claim or worktree is created

### Requirement: Check time limit outside the invocation identity

`checkTimeoutMinutes` SHALL NOT be part of the invocation identity.

#### Scenario: Limit outside the identity

- **WHEN** the identity of an invocation is computed with and without `checkTimeoutMinutes`, or the invocation is
  resumed with a different valid value
- **THEN** the identity is the same, and the run is not refused as incompatible

### Requirement: Stopping a check past its limit

Each product check SHALL run in its own process group. When a check runs past its limit, the runner SHALL send
`SIGTERM` to the process group. If any process of the group is left 10 seconds later, it SHALL send `SIGKILL` to the
group. The check SHALL be recorded only after no process of the group remains.

#### Scenario: Hanging check stopped

- **WHEN** a check prints a line and then sleeps far longer than a limit of a few hundred milliseconds set through
  the test hook
- **THEN** the check ends shortly after the limit with the result `timed-out`, and its output holds the printed line

#### Scenario: Child ignoring SIGTERM

- **WHEN** a check starts a child process that ignores `SIGTERM` and both keep running past the limit
- **THEN** after the kill grace period the group receives `SIGKILL`, and when the check is recorded neither the
  check process nor the child process exists

### Requirement: Timed-out check record

A timed-out check SHALL be recorded as a failed check. Its outcome SHALL be `timed-out`, and the record SHALL hold
the limit and the last 16000 characters of its output followed by a line naming the limit. It SHALL use one check
attempt of the stage budget, and the worker SHALL receive it like any other failed check.

#### Scenario: Hanging check recorded

- **WHEN** the work-stage product check hangs past the limit
- **THEN** the work state holds a check record with outcome `timed-out`, the limit, and output that holds the check's
  printed line and ends with `Check timed out after <limit>`; `budget.work.checks` grows by one; the next
  implementation session's findings hold that output

#### Scenario: Output tail

- **WHEN** a timed-out check printed more than 16000 characters
- **THEN** its failure detail is exactly the last 16000 characters of its output, a newline and the limit line

#### Scenario: Worker run_checks times out

- **WHEN** a worker session calls `run_checks` and a product check hangs past the limit
- **THEN** the worker receives a failed tool result whose message ends with the limit line, and the stage budget
  is not changed by that call

#### Scenario: Worker fixes the hang

- **WHEN** the first implementation makes a check hang and the next implementation, after receiving the timed-out
  result, removes the hang
- **THEN** the task is accepted, `budget.work.checks` is 1, and every check in the receipt is `passed`

#### Scenario: Budget exhausted by timeouts

- **WHEN** every implementation makes a check hang
- **THEN** after four timed-out check runs the task is blocked with `check-budget-exhausted`, and no implementation
  review session starts

### Requirement: Timed-out step line

A timed-out check SHALL be logged as a step line naming the check and the limit, before the next effect.

#### Scenario: Step line before the next effect

- **WHEN** a work-stage check times out
- **THEN** a step line with step `check timeout` names the check program, its index and the limit, and it is
  written before the next implementation step line
