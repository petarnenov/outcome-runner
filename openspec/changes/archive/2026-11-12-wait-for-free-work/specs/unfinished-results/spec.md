## MODIFIED Requirements

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
  invocation, the only remaining task waits for a foreign claim, and the run is cancelled during its wait
- **THEN** the run waited instead of ending `limit-reached`, and the `cancelled` result's blocker for that task has
  `kind` `waiting-for-claim`, not `max-accepted`

### Requirement: Completed and incomplete final status

The final status SHALL be `completed` for a `limit-reached` result that keeps in-progress work and has no blocked
task of the invocation, and `incomplete` for any other `incomplete` or `cancelled` result.

#### Scenario: Limit reached keeping in-progress work

- **WHEN** a run returns `limit-reached` while recovered claimed work is kept for a later run and no task is blocked
- **THEN** `state.json` `status` is `completed`

#### Scenario: Incomplete run

- **WHEN** a run whose only remaining task waits for a foreign claim is cancelled during its wait
- **THEN** the result is `cancelled` and `state.json` `status` is `incomplete`
