## ADDED Requirements

### Requirement: Durable review round counts

The runner SHALL count the planning, implementation and documentation review rounds of each task in the durable
`budget` of the task's work state in `state.json`, and SHALL allow 4 review rounds per stage. A review round SHALL be
counted before its review session starts.

#### Scenario: Review round counted at session start

- **WHEN** a task is accepted after one implementation review without any retry
- **THEN** its work state has `budget.work.reviews` 1 and `budget.work.checks` 0

### Requirement: Restart keeps the budget

A restart of the invocation without `--retry` SHALL continue from the recorded counts and SHALL NOT grant new review
rounds or check attempts.

#### Scenario: Count kept across a restart

- **WHEN** a run's planning review rejects the plan twice, the third planning review session fails so the task is
  blocked, the invocation is restarted without `--retry`, and the next planning review rejects the plan again
- **THEN** the restarted run starts exactly one more planning review session, so the task has 4 planning review
  sessions in total, `budget.plan.reviews` in `state.json` is 4 and the task is blocked with
  `review-budget-exhausted`

#### Scenario: Restart of an exhausted task

- **WHEN** a task is blocked because its implementation review rounds ran out and the invocation is restarted
  without `--retry`
- **THEN** the task is blocked again with the same budget reason and no worker or review session is started for it

### Requirement: Legacy work state

Work state recorded without a `budget` SHALL take its review counts from its recorded planning, implementation and
documentation reviews and SHALL start its check counts at zero.

#### Scenario: Legacy review counts

- **WHEN** recovered work has no `budget`, 2 planning reviews, 3 implementation reviews and 1 documentation review
- **THEN** the runner treats 2 planning, 3 implementation and 1 documentation review rounds and no check attempts as
  used

### Requirement: Check failures use the check budget

A failing planning check (the OpenSpec packet or `project.planningCheck`) or a failing implementation-stage run of
`project.checks` SHALL consume one check attempt of that stage, SHALL NOT consume a review round, and SHALL give the
worker another session of the same stage while check attempts remain.

#### Scenario: Check failures do not consume review rounds

- **WHEN** the product checks fail after the first two implementation sessions and pass afterwards, and the
  implementation review returns changes-required three times and accepts the fourth time
- **THEN** the task leaves the implementation stage after six implementation sessions, `budget.work.checks` is 2,
  `budget.work.reviews` is 4 and no review session was started for the two failing check runs

### Requirement: Check attempt limits

The planning and implementation stages SHALL each allow 4 failing check runs, counted in the durable `budget`. The
documentation stage SHALL have a check limit of 0.

#### Scenario: Planning check failures

- **WHEN** the planning artifacts fail the planning check twice and then pass, and the planning review accepts
- **THEN** `budget.plan.checks` is 2, `budget.plan.reviews` is 1 and the task proceeds to the implementation stage

### Requirement: Blocked reason names the exhausted budget

When a stage's review rounds or check attempts run out, the runner SHALL block the task with a private reason in
`state.json` that names the stage, whether reviews or checks ran out, and the used and allowed counts of both.

#### Scenario: Reviews ran out

- **WHEN** every implementation review returns changes-required
- **THEN** after the fourth implementation review the task is blocked with the private reason `Implementation review
  budget exhausted: 4 of 4 review rounds and 0 of 4 check attempts used`

#### Scenario: Checks ran out

- **WHEN** the product checks fail after every implementation session
- **THEN** after the fourth failing check run the task is blocked without any implementation review and with the
  private reason `Implementation check budget exhausted: 0 of 4 review rounds and 4 of 4 check attempts used`

### Requirement: Budget blocker details

The blocked entry of an exhausted task SHALL carry `budget` with `stage`, `exhausted` (`reviews` or `checks`),
`reviews` and `checks`, each with `used` and `limit`. The run result's blocker SHALL have `kind` `blocked`, `reason`
`review-budget-exhausted` or `check-budget-exhausted`, the `stage` and the same `budget`.

#### Scenario: Review budget blocker

- **WHEN** a task is blocked because its implementation review rounds ran out with no failing check run
- **THEN** the blocker has `reason` `review-budget-exhausted` and `budget` `{ stage: 'work', exhausted: 'reviews',
  reviews: { used: 4, limit: 4 }, checks: { used: 0, limit: 4 } }`, and the blocked entry has the same `budget`

#### Scenario: Check budget blocker

- **WHEN** a task is blocked because its implementation check attempts ran out
- **THEN** the blocker has `reason` `check-budget-exhausted` and `budget.exhausted` `checks`

#### Scenario: Blocked entry without a budget

- **WHEN** a blocked entry has no `budget`
- **THEN** its blocker keeps the reason `operation-incomplete`

### Requirement: Owner retry grants one fresh budget

A blocked task SHALL get a fresh budget only when the owner restarts the invocation with `--retry <task id>`, which
resets that task's used review rounds and check attempts to zero before the task resumes.

#### Scenario: Retry grants one new budget

- **WHEN** a task blocked with `review-budget-exhausted` in the implementation stage is restarted with
  `--retry <task id>` and its next implementation review accepts
- **THEN** a new implementation session and review start and the task is accepted

### Requirement: Retry is recorded

Each retry SHALL be recorded with the task id, time, stage, previous budget and exhausted budget, if any, in the
task's work state and in `retries` of `state.json`. The task's receipt SHALL list its retries in `retries`, and a
receipt of a task without a retry SHALL have no `retries` field.

#### Scenario: Retry recorded in state and receipt

- **WHEN** a task blocked in the implementation stage after 4 review rounds is retried and accepted
- **THEN** `state.json` `retries` holds one record for the task with stage `work` and a previous budget showing 4
  used implementation review rounds, the completed work carries the same record, and the receipt lists it in
  `retries`

#### Scenario: Receipt without a retry

- **WHEN** a task is accepted without any retry
- **THEN** its receipt has no `retries` field

### Requirement: Retry arguments

`--retry` SHALL take the task id as the next argument, MAY be given once per task id, and SHALL NOT be part of the
invocation identity. A `--retry` for a task that is not a blocked task of the invocation SHALL be refused with exit
code 4 and reason `retry-not-blocked` before any ownership, claim or session, without changing any budget.

#### Scenario: Retry passed as a run option

- **WHEN** the CLI is started with `--retry A`
- **THEN** the runner receives `retry: ['A']` and the configuration has no retry field

#### Scenario: Retry of a task that is not blocked

- **WHEN** the invocation is started with `--retry <task id>` for a task that has no blocked entry
- **THEN** the run exits 4 with reason `retry-not-blocked` and no claim, session or budget change happens

#### Scenario: Invalid retry arguments

- **WHEN** `--retry` is given without a task id, with the same id twice, or as `--retry=<id>`
- **THEN** the arguments are refused with exit code 4 like any other invalid flag
