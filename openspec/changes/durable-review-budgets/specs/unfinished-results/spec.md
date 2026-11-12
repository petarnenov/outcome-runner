## MODIFIED Requirements

### Requirement: Blocked and dependency reasons

A blocked task SHALL be explained with `kind` `blocked`, its `reason` and its `stage`. A blocked task whose review or
check budget ran out SHALL have the `reason` `review-budget-exhausted` or `check-budget-exhausted` and carry the
`budget` it exhausted; any other blocked task keeps the reason it had before. A task waiting for an unfinished
dependency SHALL be explained with `kind` `waiting-for-dependency` naming the unfinished `dependencies`.

#### Scenario: Blocked task

- **WHEN** a task's session fails and nothing else can be worked
- **THEN** the result is `incomplete` and its blocker has `kind` `blocked`, `reason` `operation-incomplete`, the
  `stage` where it stopped and the `state.json` diagnostics path

#### Scenario: Blocked by an exhausted budget

- **WHEN** a task's planning review rounds run out and nothing else can be worked
- **THEN** the result is `incomplete` and its blocker has `kind` `blocked`, `reason` `review-budget-exhausted`,
  `stage` `plan`, a `budget` with `exhausted` `reviews`, and the `state.json` diagnostics path

#### Scenario: Waiting for a dependency

- **WHEN** leaf `B` depends on leaf `A` and `A` is blocked
- **THEN** `B`'s blocker has `kind` `waiting-for-dependency` and `dependencies` `["A"]`
