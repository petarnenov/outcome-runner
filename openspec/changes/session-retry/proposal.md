# Proposal: Retry a session that failed without a report before blocking

## Why

A worker or review session sometimes ends without an outcome report for reasons outside the worker: the harness
process exits, its transport closes or times out, or its connection fails. Today `session()` in `src/runner.ts`
throws at once and the task is blocked, so one short outage costs the owner a manual restart. These failures are
usually transient, and starting the same session again is safe because a session has no accepted effect until it
reports.

## What Changes

- A session that ends without an outcome report because of a transport failure (harness process exited, transport
  closed or timed out, connection failed) is started again: up to 3 attempts in total, waiting 10 seconds before
  the second and 30 seconds before the third attempt.
- Not retried, behaving as before: a session that reported an outcome (including a `blocked` refusal), any other
  failure (for example an invalid report, a refused capability or an unavailable harness), a cancelled run, an
  interrupted run and an exhausted review or check budget.
- The attempts of one session belong to one review round and use no check attempt of the stage budget. A restart
  that continues the attempts of a documentation review (the only review a restarted stage starts again) does not
  count a second review round.
- Each attempt is recorded in the durable work state (`sessionAttempt`) before the session starts and logged as a
  `session retry` step line with its attempt number (`<label>: no report; retry in <s> s (attempt N)`, short enough
  that the attempt number is never cut). A restart that starts the same session again continues with the recorded
  attempt count.
- The record is bound to its session (purpose, stage and, during an integration, the target commit and integration
  step), so a record left by another session is never continued; a resumed send-back that commits instead of
  starting its session again clears the record in a new state update before its commit.
- After the last failed attempt the task is blocked as before; the private reason names the number of attempts and
  the last failure. Integration sessions (conflict resolution, send-back and the reviews of the merged result) pass
  this error through their rejection handling unchanged, so they block with the same reason instead of an
  integration code.
- The wait is injectable (`RunOptions.sessionRetrySleep`) so tests use a fake clock.
- README documents the session retry, its waits, what is not retried and the blocked reason.

## Capabilities

### New Capabilities

- `session-retry`: retrying a worker or review session that ended without an outcome report because of a
  transport failure.

### Modified Capabilities

None.

## Impact

- `src/session-retry.ts` (new): the attempt limit, the waits, the labels and retry message, the transport failure
  classification, the blocked reason and the session owner of an attempt record.
- `src/model.ts`: `SessionAttemptOwner`, `SessionAttempt` and `Work.sessionAttempt`.
- `src/runner.ts`: `RunOptions.sessionRetrySleep`; the retry loop around the existing session helper; the
  `document-review` branch counts a review round only when it does not continue a recorded attempt; `rejected` and
  the send-back catch let `SessionAttemptsExhausted` through unchanged; the send-back resume path clears the record
  with a new `save` before `commitSendBack`.
- `test/session-retry.test.ts` (new) with scripted adapters, a fake clock and Git fixtures.
- `README.md`.
- Depends on OR-29 (network retry): connection failure messages are recognised with `isConnectionFailure` from
  `src/network-retry.ts`.
