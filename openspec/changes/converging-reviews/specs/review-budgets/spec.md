## MODIFIED Requirements

### Requirement: Durable review round counts

The runner SHALL count the planning, implementation and documentation review rounds of each task in the durable
`budget` of the task's work state in `state.json`. Without a `budgets` setting it SHALL allow 6 planning review
rounds, 4 implementation review rounds and 4 documentation review rounds. A review round SHALL be counted before its
review session starts.

#### Scenario: Review round counted at session start

- **WHEN** a task is accepted after one implementation review without any retry
- **THEN** its work state has `budget.work.reviews` 1 and `budget.work.checks` 0

#### Scenario: Plan accepted in its fifth review round

- **WHEN** the first four planning reviews return changes-required and the fifth accepts, with no `budgets` setting
- **THEN** the task proceeds to the implementation stage and is accepted, and `budget.plan.reviews` is 5

### Requirement: Restart keeps the budget

A restart of the invocation without `--retry` SHALL continue from the recorded counts and SHALL NOT reset them. It
SHALL allow further review rounds and check attempts only up to the limits configured for that restart.

#### Scenario: Count kept across a restart

- **WHEN** a run's planning review rejects the plan twice, the third planning review session fails so the task is
  blocked, the invocation is restarted without `--retry` and without a `budgets` setting, and every following
  planning review rejects the plan
- **THEN** the restarted run starts exactly three more planning review sessions, so the task has 6 planning review
  sessions in total, `budget.plan.reviews` in `state.json` is 6 and the task is blocked with
  `review-budget-exhausted` and `reviews` `{ used: 6, limit: 6 }`

#### Scenario: Restart of an exhausted task

- **WHEN** a task is blocked because its implementation review rounds ran out and the invocation is restarted
  without `--retry` and with an implementation review limit that is not above the used count
- **THEN** the task is blocked again with the same budget reason and no worker or review session is started for it

### Requirement: Check attempt limits

Without a `budgets` setting the planning and implementation stages SHALL each allow 4 failing check runs, counted in
the durable `budget`. The documentation stage SHALL have a check limit of 0.

#### Scenario: Planning check failures

- **WHEN** the planning artifacts fail the planning check twice and then pass, and the planning review accepts
- **THEN** `budget.plan.checks` is 2, `budget.plan.reviews` is 1 and the task proceeds to the implementation stage

## ADDED Requirements

### Requirement: Configurable budgets

The invocation MAY set `budgets.<stage>.reviews` and `budgets.<stage>.checks` for the stages `plan`, `work` and
`document`, except `budgets.document.checks`. Each value SHALL be an integer from 1 through 12. A given value SHALL
replace the default limit of that stage and part; an omitted value SHALL keep the default. The blocked entry, the
private blocked reason and the public blocker of an exhausted task SHALL report the limits in force for the run that
blocked it.

#### Scenario: Configured planning review limit

- **WHEN** the invocation sets `budgets.plan.reviews` 2 and every planning review rejects
- **THEN** after 2 planning reviews the task is blocked with `review-budget-exhausted`, stage `plan` and `reviews`
  `{ used: 2, limit: 2 }` in both the blocker and the blocked entry

#### Scenario: Configured planning check limit

- **WHEN** the invocation sets `budgets.plan.checks` 1 and the planning check fails
- **THEN** after 1 failing planning check the task is blocked with `check-budget-exhausted` and `checks`
  `{ used: 1, limit: 1 }` and no planning review starts

#### Scenario: Configured implementation limits

- **WHEN** the invocation sets `budgets.work.reviews` 2 and every implementation review rejects, or sets
  `budgets.work.checks` 2 and every implementation fails the product checks
- **THEN** the task is blocked after 2 implementation reviews with `review-budget-exhausted` and the private reason
  `Implementation review budget exhausted: 2 of 2 review rounds and 0 of 4 check attempts used`, or after 2 failing
  check runs with `check-budget-exhausted` and `checks` `{ used: 2, limit: 2 }`

#### Scenario: Configured documentation review limit

- **WHEN** the invocation sets `budgets.document.reviews` 1 and the documentation review rejects
- **THEN** after 1 documentation review the task is blocked with `review-budget-exhausted`, stage `document` and
  `reviews` `{ used: 1, limit: 1 }`, `checks` `{ used: 0, limit: 0 }`

### Requirement: Invalid budgets are refused

An invocation with an invalid `budgets` setting SHALL be refused with exit code 4, reason `invalid-budget` and
private diagnostics whose `details.setting` names the offending field.

#### Scenario: Value out of range

- **WHEN** the invocation sets `budgets.plan.reviews` to 0, 13, 2.5 or `"4"`
- **THEN** the run exits 4 with reason `invalid-budget` and the diagnostics name `budgets.plan.reviews`

#### Scenario: Documentation checks or unknown fields

- **WHEN** the invocation sets `budgets.document.checks`, `budgets.review` or `budgets.work.rounds`, or `budgets` is
  an array
- **THEN** the run is refused with reason `invalid-budget` and the diagnostics name that field (`budgets` for the
  array)

### Requirement: Budget shape

A valid `budgets` setting SHALL be an object whose keys are only `plan`, `work` or `document`. Each stage value SHALL
be an object whose keys are only `reviews` or `checks`, and `document` SHALL NOT have `checks`.

#### Scenario: Stage value not an object

- **WHEN** the invocation sets `budgets.plan` to 5
- **THEN** the run is refused with reason `invalid-budget` and the diagnostics name `budgets.plan`

### Requirement: Budgets are validated before any side effect

The budget validation SHALL happen at startup before the OpenSpec preflight and before any lock, state, ownership
file, claim, worktree or session is created.

#### Scenario: Refused run leaves nothing behind

- **WHEN** the invocation is refused with reason `invalid-budget`
- **THEN** no lock, state, ownership file, claim, worktree or session exists

### Requirement: Budgets are operational

`budgets` SHALL NOT be part of the invocation identity, so a restart with different budgets resumes the same
invocation.

#### Scenario: Identity without budgets

- **WHEN** the identity is computed for a configuration with and without `budgets`
- **THEN** both identities are equal

### Requirement: Resume after a raised limit

A task blocked by an exhausted budget SHALL resume on a restart without `--retry` when the limit configured for the
restart is above its used count. It SHALL keep its used counts and SHALL get no retry record. `--retry` SHALL keep
granting a fresh budget as before.

#### Scenario: Raised implementation review limit

- **WHEN** a task is blocked after 4 rejected implementation reviews, and the invocation is restarted without
  `--retry` with `budgets.work.reviews` 6, and the next implementation review accepts
- **THEN** one new implementation session and one review start, the task is accepted, its completed work has
  `budget.work.reviews` 5, and `state.json` and the receipt have no `retries`

#### Scenario: Limit not raised enough

- **WHEN** a task is blocked after 4 rejected implementation reviews and the invocation is restarted without
  `--retry` with `budgets.work.reviews` 3
- **THEN** no session starts and the blocker and blocked entry carry `reviews` `{ used: 4, limit: 3 }`

#### Scenario: Retry with configured limits

- **WHEN** a task blocked with `budgets.work.reviews` 2 after 2 rejected implementation reviews is restarted with
  `--retry <task id>` and its next implementation review accepts
- **THEN** the task is accepted with `budget.work.reviews` 1 and its retry record has `exhausted.reviews`
  `{ used: 2, limit: 2 }`
