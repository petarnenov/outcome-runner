# Tasks

## 1. Model and module

- [ ] 1.1 Add `SessionAttemptOwner` (purpose, stage, optional integration target and step), `SessionAttempt` and
  `Work.sessionAttempt?` to `src/model.ts` (design decision 2).
- [ ] 1.2 Create `src/session-retry.ts` with `SESSION_ATTEMPTS`, `SESSION_RETRY_DELAYS_MS`, `SESSION_LABELS`,
  `sessionRetryMessage`, `isSessionTransportFailure`, `sessionFailureDetail`, `sessionAttemptsMessage`,
  `SessionAttemptsExhausted`, `sessionAttemptOwner` and `sameSessionAttemptOwner` (decisions 1 and 2). The retry
  message is `<label>: no report; retry in <seconds> s`.

## 2. Runner

- [ ] 2.1 Add `RunOptions.sessionRetrySleep?: Sleep`, defaulting to `defaultSleep` (decision 5).
- [ ] 2.2 Rename the session helper to `sessionOnce` and make it throw the internal `SessionTransportFailure` only
  for an unreported, uncancelled, uninterrupted transport failure (decision 3).
- [ ] 2.3 Add the new `session(...)` retry loop with the same signature: a recorded attempt is continued only when
  its owner matches `sessionAttemptOwner(work, purpose)` (a stale record is ignored and replaced), the durable record
  with its owner before each attempt, the `session retry` step line (`sessionRetryMessage`, within the length bound
  of decision 3) and the wait before attempts 2 and 3, the record cleared on success, on any non-transport error and
  on cancellation, `SessionAttemptsExhausted` after the last attempt and on a restart with a matching recorded
  attempt of 3 (decision 3). Leave `countReview` and `countCheck` outside `session()` (decision 4). In the
  `document-review` branch of the documentation loop, compute
  `resumed = sameSessionAttemptOwner(activeWork().sessionAttempt, sessionAttemptOwner(activeWork(), 'document-review'))`
  before counting; call `countReview('document')` only when `resumed` is false, and pass `resumed ? round - 1 : round`
  as the attempt number of the `documentation review` start line, so a restart that continues the documentation
  review attempts counts no second review round (decision 4).
- [ ] 2.4 Integration sessions (decision 6): `rejected(error)` rethrows a `SessionAttemptsExhausted` unchanged, and
  the send-back catch rethrows it unchanged instead of setting `failed` and calling `sendBackOrReject`, so the task
  is blocked with the attempts message as its private reason.
- [ ] 2.5 Send-back resume path (decision 3a): in the send-back (`else`) branch of the integration loop, add
  `if (activeWork().sessionAttempt) save({ sessionAttempt: undefined });` directly after the
  `if (sendBack.session === 'pending') { ... }` block and directly before
  `taskStep(work.id, 'commit', 'committing the send-back result', currentAttempt())`, so the clearing save precedes
  the step line and `commitSendBack`. This is a new state update; the existing post-commit `save` (`step: 'checks'`,
  `session: 'finished'`) stays unchanged.

## 3. README

- [ ] 3.1 Add a "Session retry" section: 3 attempts in total, waits of 10 and 30 seconds, which failures count as
  transport failures, what is not retried (a reported outcome including a refusal, other failures, cancellation,
  interruption, an exhausted budget), one review round and no check attempt for all attempts (also when a restart
  continues a documentation review), the durable `sessionAttempt` record bound to its session and the
  `session retry` step line (for example `planning: no report; retry in 10 s (attempt 2)`), the count kept across
  restarts that start the same session again, and the private blocked reason
  `Session <purpose> ended without a report after 3 attempts; last failure: ...`, which integration sessions
  (conflict resolution, send-back and the reviews of the merged result) also use instead of an integration code.

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Runner tests live in `test/session-retry.test.ts`
and use `runnerFixture` (`test/support/runner-fixture.ts`, Git fixtures) with scripted adapters that wrap
`scriptedWorker`: a chosen session (matched by its prompt, for example `Create proposal.md`, `Inspect current
files`, `Review actual implementation`, `Review the documentation changes independently` or `Address the rejection
of the merged result`) rejects with
`new Error('Claude transport exited (1) without a complete private result: ')` for chosen attempts before reporting
anything. A fake clock is passed as `sessionRetrySleep`: it records each wait in milliseconds and resolves at once.
Step lines are captured with `steps`. Session counts are taken from the prompts the adapter receives. Integration
tests reuse the setup of the existing target integration tests (an advance of the target into the paths the task
changed, so the task enters the `integrate` stage).

### Grade E

- [ ] 4.1 (E) (required) Transport failure classification: `isSessionTransportFailure` is true for the Claude
  `transport exited` message, for errors with codes `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ECONNREFUSED`,
  `ECONNABORTED` and `ENOTCONN`, for `Codex RPC observation timed out` and for `Could not resolve host: github.com`;
  it is false for `Scripted worker failure`, `Malformed Codex transport`, `Codex turn did not complete`,
  `Selected harness interface unavailable`, `Worker plan incomplete` and a string.
- [ ] 4.2 (E) (required) Constants and messages: `SESSION_ATTEMPTS` is 3, `SESSION_RETRY_DELAYS_MS` is
  `[10000, 30000]`, `sessionRetryMessage('plan', 10000)` is `planning: no report; retry in 10 s`,
  `sessionAttemptsMessage('plan', 3, 'x')` is `Session plan ended without a report after 3 attempts; last failure: x`,
  `SessionAttemptsExhausted` has that message, and `sessionFailureDetail` replaces control characters and keeps the
  last 2000 characters.
- [ ] 4.3 (E) (required) The longest label keeps its attempt number: with `createStepLog` and a fixed clock, the
  line for subject `ABCDEFGHIJKLMNOPQRST` (20 characters), step `session retry`, message
  `sessionRetryMessage('document-review', 30000)` and attempt 3 is at most 120 characters (without the newline),
  does not end with `...` and ends with `documentation review: no report; retry in 30 s (attempt 3)`; the same holds
  for every label of `SESSION_LABELS` with both waits.
- [ ] 4.4 (E) (required, scenario "The record names its session") Session owner binding: `sessionAttemptOwner`
  returns `{ purpose, stage }` outside the `integrate` stage and adds `integration: { target, step }` inside it;
  `sameSessionAttemptOwner` is true for equal owners and false for another purpose, another stage, another
  integration target, another integration step, when only one owner has an integration and when the record is
  undefined.

### Grade D

- [ ] 4.5 (D) (coverage-only) Another failure is not retried: a session failing through the `fail` hook
  (`Scripted worker failure`) blocks the task after one attempt, the fake clock records no wait and the blocked
  work has no `sessionAttempt`.
- [ ] 4.6 (D) (required) A cancelled run is not retried: the planning session fails once with a transport failure
  and the fake clock aborts the run's signal during the wait; the run ends `cancelled`, the adapter received exactly
  one planning prompt and the work in `state.json` has no `sessionAttempt`.

### Grade C

- [ ] 4.7 (C) (required) Fails once, then succeeds: the planning session fails once with a transport failure; the
  fake clock records `[10000]`, the adapter received two planning prompts, a `session retry` step line ending with
  `planning: no report; retry in 10 s (attempt 2)` was written, the task is accepted and the completed work has no
  `sessionAttempt`.
- [ ] 4.8 (C) (required) A reported refusal is not retried: the planning session reports `blocked`; the adapter
  received one planning prompt, the fake clock records no wait and the task is blocked with the reason
  `Worker plan incomplete`.
- [ ] 4.9 (C) (required) Three failures block: every investigation attempt fails with a transport failure whose
  message names the attempt; the fake clock records `[10000, 30000]`, the adapter received three investigation
  prompts, the run is `incomplete`, the private reason in `state.json` is `Session investigate ended without a report
  after 3 attempts; last failure: ` followed by the third failure, and the blocked work has no `sessionAttempt`.

### Grade B

- [ ] 4.10 (B) (required) A retried review uses one review round: the first implementation review attempt fails
  with a transport failure and the second accepts; the adapter received two implementation review prompts, the task
  is accepted and the completed work has `budget.work.reviews` 1 and `budget.work.checks` 0.
- [ ] 4.11 (B) (required) A restart continues the count: in the first run the planning session fails once with a
  transport failure and the fake clock throws `runner stopped` on its first call; the task is blocked and its work in
  `state.json` has `sessionAttempt` `{ purpose: 'plan', stage: 'plan', attempt: 1, failure }` with the failure
  detail (no `integration`). The second run (a new fake clock that resolves) writes a `session retry` step line
  ending with `(attempt 2)`, records the wait `[10000]`, starts the planning session once more and the task is
  accepted; two planning prompts were received in total.
- [ ] 4.12 (B) (required, scenario "A stale record of another session is ignored") A stale record of another
  session is ignored: before a run, the blocked work's record is set through `RunStore` to
  `{ purpose: 'investigate', stage: 'investigate', attempt: 3, failure: 'f' }` while the work is in the `plan`
  stage; the planning session starts as attempt 1 (no `session retry` line, no wait), the task is accepted and the
  completed work has no `sessionAttempt`.
- [ ] 4.13 (B) (required, scenario "A documentation review continued after a restart uses one review round") A
  restarted documentation review uses one review round: in the first run the first documentation review attempt
  (prompt `Review the documentation changes independently`) fails with a transport failure and the fake clock throws
  `runner stopped` on its first call; the task is blocked and its work in `state.json` is in stage
  `document-review` with `sessionAttempt` `{ purpose: 'document-review', stage: 'document-review', attempt: 1,
  failure }` and `budget.document.reviews` 1. The second run (a new fake clock that resolves) receives no
  documentation session prompt (`Update the documentation inside the task scopes`), writes the
  `documentation review` start line without an attempt suffix (round 1) followed by a `session retry` step line
  ending with `documentation review: no report; retry in 10 s (attempt 2)`, records the wait `[10000]`, receives one
  documentation review prompt, and the task is accepted with `budget.document.reviews` 1 (not 2), one entry in
  `documentationReviews` and no `sessionAttempt`.

### Grade A

- [ ] 4.14 (A) (coverage-only) A restart after the last attempt started (a runner crash during attempt 3): a first
  run fails investigation attempts 1 and 2 and its fake clock throws `runner stopped` on its second call, leaving the
  blocked work with `sessionAttempt.attempt` 2; the test then sets that record to
  `{ purpose: 'investigate', stage: 'investigate', attempt: 3, failure: 'f' }` through `RunStore` on the same state
  directory and identity, as other state preparation in the tests does. The restarted run blocks the task with
  `Session investigate ended without a report after 3 attempts; last failure: f` without starting an investigation
  session, and a further run starts the investigation again as attempt 1 (no `session retry` line before it).
- [ ] 4.15 (A) (required) An exhausted integration review names the attempts: the task enters the `integrate` stage
  and every attempt of the implementation review of the merged result fails with a transport failure; the adapter
  received three such review prompts, the fake clock records `[10000, 30000]`, the private reason in `state.json` is
  `Session review ended without a report after 3 attempts; last failure: ` followed by the third failure (not
  `target-integration-rejected`), the run's blocker reason is `operation-incomplete` and the blocked work keeps
  `integration.step` `review`.
- [ ] 4.16 (A) (required) An exhausted send-back session names the attempts: the integration review rejects the
  merged result once, so a send-back starts, and every send-back attempt fails with a transport failure; the adapter
  received three send-back prompts, the private reason is `Session work ended without a report after 3 attempts;
  last failure: ` followed by the third failure, and the send-back record has no `outcome` `rejected`.
- [ ] 4.17 (A) (coverage-only) A retried send-back session of an integration: the send-back session fails once with
  a transport failure and succeeds on the second attempt; the integration continues with `sendBack.session`
  `finished` and only one send-back record.
- [ ] 4.18 (A) (required, scenario "An abandoned send-back attempt is not inherited") A send-back that crashes
  during an attempt and is resumed: the integration review rejects the merged result so a send-back starts; its
  first attempt fails with a transport failure and the fake clock throws `runner stopped`, leaving the blocked work
  at integration step `send-back` with `sendBack.session` `started` and `sessionAttempt`
  `{ purpose: 'work', stage: 'integrate', integration: { target, step: 'send-back' }, attempt: 1, failure }`. In the
  restarted run, the `steps` callback reads `state.json` synchronously when it receives the step line
  `commit: committing the send-back result` (written after the new clearing `save` and before `commitSendBack`,
  decision 3a): at that point the current work has no `sessionAttempt`, its integration is still at step
  `send-back` with `sendBack.session` `started` (so the post-commit `save` has not run yet), and no send-back prompt
  was received in that run. The target then advances again into the guarded paths with a conflict, so a later
  integration of the new target commit starts a conflict resolution session (purpose `work`, stage `integrate`): it
  is started as attempt 1 with no `session retry` step line and no fake clock wait, and the task is not blocked with
  a `Session work ended without a report` reason. A variant sets a stale record with `attempt: 3` and the old target
  through `RunStore` before the later integration and shows that it is ignored too.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with the coverage gate at 85%.
