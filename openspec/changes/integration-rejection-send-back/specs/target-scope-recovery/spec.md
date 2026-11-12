## MODIFIED Requirements

### Requirement: Rejected clean merge blocks

When the checks, the implementation review or the documentation review after a clean in-scope merge do not accept
the result, the runner SHALL first give the worker one send-back session and then run the checks and both reviews
again. The runner SHALL block the task with reason `target-integration-rejected` only when the result is still not
accepted after that one send-back session.

#### Scenario: Rejected clean merge

- **WHEN** the checks or a review after a clean merge do not accept the result, and the checks or a review still do
  not accept it after the one send-back session
- **THEN** exactly one send-back session started
- **AND** the task is blocked with reason `target-integration-rejected`

#### Scenario: Rejected clean merge repaired by the send-back session

- **WHEN** the checks or a review after a clean merge do not accept the result, and the send-back session repairs it
- **THEN** the task is not blocked, and it is merged and accepted after the checks and both reviews accept
