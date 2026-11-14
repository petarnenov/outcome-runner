## ADDED Requirements

### Requirement: Retry a session that ended without a report because of a transport failure

When a worker or review session ends without an outcome report because the harness process exited, its transport
closed or timed out, or its connection failed, the runner SHALL start the same session again instead of blocking the
task at once. A session SHALL have at most 3 attempts in total. The runner SHALL wait 10 seconds before the second
attempt and 30 seconds before the third attempt.

#### Scenario: A session fails once and then succeeds

- **WHEN** the planning session of a task ends without a report because the harness transport exited, and the second
  attempt reports `ready`
- **THEN** the runner waits 10 seconds, starts the planning session a second time and continues the task
- **AND** the task is accepted

#### Scenario: Waits before the second and third attempt

- **WHEN** the first and the second attempt of a session end with a transport failure
- **THEN** the runner waits 10000 milliseconds before the second attempt and 30000 milliseconds before the third

#### Scenario: Transport failures are recognised

- **WHEN** an attempt fails with `Claude transport exited (1) without a complete private result`, with an error whose
  code is `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ECONNREFUSED`, `ECONNABORTED` or `ENOTCONN`, with a message containing
  `timed out`, or with a connection failure recognised by the network retry
- **THEN** the failure is a transport failure and the session is retried

#### Scenario: Other failures are not transport failures

- **WHEN** an attempt fails with any other error, for example `Malformed Codex transport`, `Codex turn did not
  complete`, an unavailable harness interface or a value that is not an error
- **THEN** the failure is not a transport failure

### Requirement: What is not retried

A session that reported an outcome, a session that failed for a reason other than a transport failure, a cancelled
run, an interrupted run and an exhausted review or check budget SHALL NOT be retried and SHALL behave as before.

#### Scenario: A reported refusal is not retried

- **WHEN** a session reports the outcome `blocked`
- **THEN** exactly one attempt of that session is started, no retry wait happens and the task is blocked as before

#### Scenario: A cancelled run is not retried

- **WHEN** the run is cancelled during the wait before a second attempt
- **THEN** no further attempt starts, the run ends `cancelled` and the work keeps no session attempt record

### Requirement: Attempts use one review round and no check attempt

The attempts of one session SHALL use one review round of the stage budget and SHALL NOT use a check attempt. This
SHALL also hold when a restart continues the attempts of a review session: the restarted run SHALL NOT count another
review round for the session whose attempt record it continues.

#### Scenario: A retried review session uses one review round

- **WHEN** the implementation review session ends with a transport failure once and its second attempt accepts
- **THEN** two implementation review sessions were started, the work budget shows 1 used review round and 0 used
  check attempts, and the task is accepted

#### Scenario: A documentation review continued after a restart uses one review round

- **WHEN** the first attempt of the documentation review session ends with a transport failure, the run ends before
  the second attempt with the work in the `document-review` stage and its attempt record naming the
  `document-review` session, and the invocation is started again
- **THEN** the restarted run starts the documentation review as attempt 2 without starting the documentation session
  again, the documentation budget shows 1 used review round both before and after the restart, and the task is
  accepted with 1 used documentation review round

### Requirement: Durable attempt record

Each attempt SHALL be recorded in the durable work state before the session starts, with its attempt number and the
session it belongs to. A restart that starts the same session again SHALL continue with the recorded attempt count.

#### Scenario: A restart continues the attempt count

- **WHEN** the first attempt of the planning session fails with a transport failure, the run ends before the second
  attempt and the invocation is started again
- **THEN** the durable work records attempt 1 with the last failure before the restart, and the restarted run starts
  the planning session as attempt 2 with its `session retry` step line ending with `(attempt 2)`

#### Scenario: The record names its session

- **WHEN** an attempt record is saved
- **THEN** it names the session purpose, the stage and, during an integration, the integrated target commit and the
  integration step

### Requirement: Attempt record bound to its session

A recorded attempt SHALL be continued only by the session it names. A resumed send-back that is not started again
SHALL clear the recorded attempt in a state update made before the send-back result is committed.

#### Scenario: A stale record of another session is ignored

- **WHEN** the work holds an attempt record of another session and a session starts
- **THEN** the session starts as attempt 1 without a `session retry` step line or wait and replaces the record

#### Scenario: An abandoned send-back attempt is not inherited

- **WHEN** the runner stops during an attempt of a send-back session, a restarted run resumes the integration and
  commits the worktree without starting the send-back again, and a later integration of another target commit
  starts a `work` session in the `integrate` stage
- **THEN** the work has no session attempt record when the `committing the send-back result` step line is written,
  before the commit, and the later session starts as attempt 1 without a `session retry` step line or wait and is
  not blocked by the earlier attempts

### Requirement: Attempt step lines

Each attempt SHALL be logged as a step line with its attempt number: the first by the session's start line and each
later attempt by a `session retry` step line. That line SHALL keep its ` (attempt N)` suffix within the 120-character
step line limit for every session label and any task id of at most 20 characters.

#### Scenario: Attempt step lines

- **WHEN** a session is started for the second time after a transport failure
- **THEN** a `session retry` step line `<label>: no report; retry in 10 s (attempt 2)` is written before the wait

#### Scenario: The longest label keeps its attempt number

- **WHEN** the `session retry` line of the third documentation review attempt is written for a task id of 20
  characters
- **THEN** the line is at most 120 characters long, is not cut and ends with the text
  `documentation review: no report; retry in 30 s (attempt 3)`

### Requirement: Block after the last attempt

After the last failed attempt the task SHALL be blocked as before, and its private reason SHALL name the number of
attempts and the last failure. Integration sessions SHALL pass the exhausted attempts through their rejection
handling unchanged instead of turning them into an integration code.

#### Scenario: Three failures block the task

- **WHEN** all 3 attempts of the investigation session end with a transport failure
- **THEN** the task is blocked, its private reason in `state.json` is
  `Session investigate ended without a report after 3 attempts; last failure: <message of the third failure>` and
  exactly 3 investigation sessions were started

#### Scenario: An exhausted integration session names the attempts

- **WHEN** all 3 attempts of the implementation review session of a merged result during an integration end with a
  transport failure
- **THEN** the task is blocked, its private reason in `state.json` is
  `Session review ended without a report after 3 attempts; last failure: <message of the third failure>`, not
  `target-integration-rejected`, and the blocked work keeps its integration record at the `review` step

#### Scenario: An exhausted send-back session names the attempts

- **WHEN** all 3 attempts of the send-back session of an integration end with a transport failure
- **THEN** the task is blocked with the private reason
  `Session work ended without a report after 3 attempts; last failure: <message of the third failure>` and the
  send-back is not recorded as rejected

### Requirement: README documents the session retry

README SHALL describe the session retry, its waits, what is not retried and the blocked reason after the last attempt.

#### Scenario: README section

- **WHEN** a reader opens README
- **THEN** it describes the 3 attempts, the waits of 10 and 30 seconds, the failures that are not retried, the
  durable attempt count across restarts and the private blocked reason, including that integration sessions block
  with the same reason
