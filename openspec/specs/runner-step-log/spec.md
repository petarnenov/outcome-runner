# runner-step-log Specification

## Purpose
TBD - created by archiving change log-runner-steps. Update Purpose after archive.

## Requirements

### Requirement: Log run-level steps

The runner SHALL write one step line before the run starts, before each preflight, and a last line when the run
ends, each before the step has any effect.

#### Scenario: Run start, preflights and run end

- **WHEN** a run starts, runs its preflights and ends
- **THEN** a run start line names the invocation, harness, model and effort
- **AND** one line is written before each preflight (OpenSpec, harness version, test framework)
- **AND** the last line is the run end line naming the outcome

#### Scenario: Long invocation or model id

- **WHEN** the invocation id or the model id is longer than its display cap
- **THEN** that value is shortened and the run start line still names all four values within 120 characters

### Requirement: Log ordered task steps before their effects

The runner SHALL write one step line before each logical step of a task, before the step has any effect.

#### Scenario: Accepted task logs ordered steps

- **WHEN** a task is accepted end to end with a scripted adapter, scripted host and Git fixtures
- **THEN** the lines appear in order: run start, preflights, claim, worktree, setup, investigation, planning,
  planning check, planning review, implementation, commit, checks, review, documentation, documentation review,
  final checks, archive, receipt, push, pull request, wait, merge, acceptance, cleanup and run end
- **AND** each line is recorded in a shared event log before its step's first effect

### Requirement: Log integration of an advanced target

The runner SHALL write an `integrate` line before merging an advanced target into the task branch, and only then.

#### Scenario: Advanced target is integrated

- **WHEN** the target advanced outside the task scope before publishing
- **THEN** an `integrate` line is written before the target is merged into the task branch
- **AND** no `integrate` line is written when the target did not advance

### Requirement: Log a run that fails before any task

When a run fails before any task, the runner SHALL still end with a run end line.

#### Scenario: Preflight throws

- **WHEN** a preflight throws
- **THEN** the run start line and that preflight line were written
- **AND** the last line is the run end line with outcome `unavailable`

### Requirement: Step line format and content

Each step line SHALL have the form `[outcome-runner] HH:MM:SS <task id or run> <step>: <message>`, SHALL be one
English line of at most 120 characters, and SHALL never contain secrets, worker output, file contents, error
messages, block reasons or other private diagnostics.

#### Scenario: Line format

- **WHEN** a line is formatted for subject `OR-17`, step `claim` and a clock at 09:05:03 local time
- **THEN** the line is `[outcome-runner] 09:05:03 OR-17 claim: <message>` with no control character

#### Scenario: Long message is cut to the limit

- **WHEN** a message would make the line longer than 120 characters
- **THEN** the line is exactly 120 characters and ends with `...`

#### Scenario: Blocked task names its step without the reason

- **WHEN** a task is blocked, for example because its product checks keep failing
- **THEN** the last line for that task is `<id> blocked: stopped at <step>`
- **AND** no line contains the block reason, check output or session text

### Requirement: Waits log once

Waits and polling loops (mergeability and checks, stale pull request head, Git lock) SHALL log once when the wait
starts and SHALL NOT log on every poll.

#### Scenario: Mergeability and stale head polling

- **WHEN** the merge stage reads several stale pull request views before the head matches
- **THEN** one mergeability wait line and one head wait line are written, whatever the number of views

#### Scenario: Contended Git lock

- **WHEN** another process holds the Git lock while the runner needs it
- **THEN** exactly one `<subject> git lock: waiting for the Git lock` line is written before the runner waits
- **AND** no such line is written when the lock is free

### Requirement: Retried steps log their attempt

A step that is retried SHALL log again with ` (attempt N)` for N of 2 or more.

#### Scenario: Retried implementation

- **WHEN** the first implementation attempt fails its product checks and a second attempt runs
- **THEN** the second implementation line and the lines of that attempt carry `(attempt 2)`

#### Scenario: Retried documentation round

- **WHEN** the documentation review requests changes and a second documentation round runs
- **THEN** its documentation and documentation review lines carry `(attempt 2)`

#### Scenario: Publish repeated after a target advance

- **WHEN** the target advances during the merge stage and the task returns to publish
- **THEN** the repeated integrate, check, push, pull request and wait lines carry `(attempt 2)`

### Requirement: Resume does not repeat completed steps

On resume, steps completed in durable state SHALL NOT be logged again. Only the first step line of work found in
durable state when the run starts SHALL carry `resuming`.

#### Scenario: Resumed run

- **WHEN** a run stopped after planning was bound and a new run continues the task from durable state
- **THEN** no claim, worktree, investigation or planning lines are written for that task
- **AND** the first task line is the implementation line containing `resuming`, and no later line does

#### Scenario: Fresh run never resumes

- **WHEN** a task is claimed and accepted within one run
- **THEN** no line of that run contains `resuming`

### Requirement: Machine output unchanged and output injectable

Step lines SHALL go through an injected output (`RunOptions.steps`), defaulting to stderr. stdout, exit codes,
the diagnostics file, receipts and durable state SHALL be unchanged; a failing step output SHALL NOT change the run.

#### Scenario: stdout identical with and without step logging

- **WHEN** the same scripted run executes with a capturing and with a no-op step output
- **THEN** stdout lines, exit code and receipt are identical and no step line appears on stdout

### Requirement: Documented and verified

README SHALL describe the step lines on stderr and their format. `npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Verification

- **WHEN** the bound implementation is verified
- **THEN** README describes the step lines and their format
- **AND** `npm run typecheck` and `npm test` pass
