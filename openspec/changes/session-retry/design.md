# Design: session retry

## Context

`session(work, purpose, prompt, implementationReview?, attempt?, writablePaths?)` in `src/runner.ts` creates one
adapter, probes it, increments `sessionStarts`, calls `adapter.startAction` (raced with cancellation by
`cancellable`) and throws `Worker <purpose> incomplete` when no report was recorded or the report is `blocked`.
The stage callers (investigation, planning, planning review, implementation, implementation review, documentation,
documentation review) let that error reach the task `catch` block, which stores `reason: error.message` in the
blocked entry. The integration callers are different: the conflict resolution, integration review and integration
documentation review sessions run inside `try { ... } catch (error) { rejected(error); }`, and `rejected` turns every
non-cancel error into `IntegrationFailure('target-conflict-unresolved' | 'target-integration-rejected')`. The
send-back session's catch sets `failed = true` and calls `sendBackOrReject`.

The send-back step saves `sendBack.session = 'started'` right before its session. When a resumed run finds the
integration at step `send-back` with `sendBack.session === 'started'` (the runner stopped during that session), it
skips the `if (sendBack.session === 'pending') { ... }` block, writes the step line
`commit: committing the send-back result`, calls `commitSendBack` and only then saves the integration with
`step: 'checks'` and `sendBack.session: 'finished'`. Today no state update happens between entering that branch and
the commit.

The documentation loop runs `while (['document', 'document-review'].includes(activeWork().stage))`; its
`document-review` branch calls `countReview('document')` every time it is entered, because a restart in
`document-review` skips the `document` branch (the comment in the code says so). `round` is computed at the top of
the loop as `budget().document.reviews + 1`, before that count.

The adapters signal a lost harness as follows:

- Claude (`src/claude-adapter.ts`): `Claude transport exited (<code>) without a complete private result: ...` when
  the process exits without a complete result.
- Codex (`src/codex-adapter.ts`): `Codex transport exited` with `code: 'ECONNRESET'` when the app-server exits,
  `Codex RPC observation timed out` with `code: 'ETIMEDOUT'`, and raw child process errors such as `EPIPE`.
- A failed connection: the messages recognised by `isConnectionFailure` (`src/network-retry.ts`, OR-29).

Review rounds are counted by `countReview` before the review session and check attempts by `countCheck` after a
failing check run; both sit outside `session()`.

Step lines are formatted by `formatStep` (`src/step-log.ts`): `[outcome-runner] HH:MM:SS <subject> <step>: <message>`,
limited to `STEP_LINE_LIMIT` = 120 characters; a longer line is cut and ends with `...`. `createStepLog` appends
` (attempt N)` to the message for N >= 2 before formatting, so a too-long message loses the suffix.

## Goals / Non-Goals

Goals: retry transport failures of any worker or review session, at most 3 attempts in total, with durable attempt
counting that never leaks into another session, step lines that always keep their attempt number, a blocked reason
that names the attempts for every session (including integration sessions), and without touching the review and
check budgets, also across a restart.

Non-goals: retrying sessions that reported, sessions that failed for another reason, harness probes, checks, Git or
pull request operations (OR-29 covers network commands), a configurable attempt count, or changing which session a
restarted stage starts with.

## Decisions

### 1. Module `src/session-retry.ts`

Pure and exported:

- `SESSION_ATTEMPTS = 3`.
- `SESSION_RETRY_DELAYS_MS: readonly number[] = [10000, 30000]`; the wait before attempt `n` (n >= 2) is
  `SESSION_RETRY_DELAYS_MS[n - 2]`.
- `SESSION_LABELS: Readonly<Record<Purpose, string>>`: `investigation`, `planning`, `review`, `implementation`,
  `documentation` and `documentation review` for the purposes `investigate`, `plan`, `review`, `work`, `document`
  and `document-review`. The longest label is `documentation review` (20 characters).
- `sessionRetryMessage(purpose: Purpose, milliseconds: number): string`:
  `<label>: no report; retry in <seconds> s`, for example `documentation review: no report; retry in 30 s`
  (46 characters, the longest message).
- `isSessionTransportFailure(error: unknown): boolean`: true when `error` is an `Error` and
  - its `code` is one of `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `EPIPE`, `ENOTCONN`; or
  - its message matches `/transport exited/iu` (both adapters) or `/timed out/iu`; or
  - `isConnectionFailure(error)` is true.
  Anything else is false, including `Scripted worker failure`, `Malformed Codex transport`, `Codex turn did not
  complete`, `Codex RPC refused`, `Worker <purpose> incomplete`, `Selected harness interface unavailable`,
  capability or model mismatch errors, and non-`Error` values.
- `sessionFailureDetail(error: unknown): string`: the error message with control characters replaced by spaces,
  cut to its last 2000 characters.
- `sessionAttemptsMessage(purpose: Purpose, attempts: number, lastFailure: string): string`:
  `Session <purpose> ended without a report after <attempts> attempts; last failure: <lastFailure>`.
- `class SessionAttemptsExhausted extends Error` with `purpose`, `attempts` and `lastFailure`; its message is
  `sessionAttemptsMessage(...)`.
- `sessionAttemptOwner(work: Pick<Work, 'stage' | 'integration'>, purpose: Purpose): SessionAttemptOwner` and
  `sameSessionAttemptOwner(a, b): boolean` (decision 2).

### 2. Durable attempt record, bound to its session

`src/model.ts` gains

```ts
/** The session an attempt record belongs to. */
export interface SessionAttemptOwner {
  purpose: Purpose;
  stage: Stage;
  /** Set only in the `integrate` stage: the integrated target commit and the integration step of the session. */
  integration?: { target: string; step: IntegrationStep };
}
/** The attempts of the session in progress; cleared when it reports, fails for another reason or is cancelled. */
export interface SessionAttempt extends SessionAttemptOwner { attempt: number; failure?: string }
```

and `Work.sessionAttempt?: SessionAttempt`. `attempt` is the number of attempts started; `failure` is the detail of
the last failed attempt, if any.

`sessionAttemptOwner(work, purpose)` returns `{ purpose, stage: work.stage }` and, when `work.stage` is `integrate`
and `work.integration` is set, also `integration: { target: work.integration.target, step: work.integration.step }`.
`sameSessionAttemptOwner` is true only when `purpose` and `stage` are equal and either both records lack
`integration` or both have it with the same `target` and `step`; it is false when either argument is undefined.

A record belongs only to the session whose owner it names. A record with another owner is stale: it is ignored, and
the new session starts as attempt 1 and replaces it with its own record (decision 3 step 4). This binding matters in
the `integrate` stage, where the conflict resolution and the send-back sessions both have purpose `work`: a record
left by one integration step or by an earlier integration (another target commit) can never be inherited by a later
session. Within one integration each step has at most one session of a given purpose (the send-back runs once per
target commit, and the checks and reviews after it carry other steps or purposes), so a matching owner always means
the same session resumed after a restart.

Blocked entries keep the work, so a blocked task recovered by a restart keeps its record.

### 3. The retry loop

The current helper is renamed `sessionOnce` and changed in one place: when `startAction` rejects, no report was
recorded (`result === undefined`), the run is not stopped or aborted, the error is not `interrupted` and
`isSessionTransportFailure(error)` is true, it throws an internal `SessionTransportFailure` carrying the original
error as `cause`. Every other path is unchanged.

The new `session(...)` keeps the old signature and does:

1. `owner = sessionAttemptOwner(activeWork(), purpose)`; `previous = activeWork().sessionAttempt` when
   `sameSessionAttemptOwner(previous, owner)`, otherwise none (a stale record of another session is ignored).
   `attempt = (previous?.attempt ?? 0) + 1`; `failure = previous?.failure`.
2. When `attempt > SESSION_ATTEMPTS` (a restart after the last attempt started): save `sessionAttempt: undefined`
   and throw `SessionAttemptsExhausted(purpose, SESSION_ATTEMPTS, failure ?? 'the run stopped during the last
   attempt')`. No session starts.
3. When `attempt >= 2`: write the step line
   `taskStep(work.id, 'session retry', sessionRetryMessage(purpose, delay), attempt)`, rendered for example as
   `[outcome-runner] 12:00:00 OR-34 session retry: planning: no report; retry in 10 s (attempt 2)`, then
   `await sessionRetrySleep(delay, waitSignal)`. When the run is stopped or the signal aborted after the wait, save
   `sessionAttempt: undefined` and throw the abort reason (or `signal.throwIfAborted()`), so the run ends
   `cancelled` as before and no further attempt starts.
4. Save `sessionAttempt: { ...owner, attempt, ...(failure ? { failure } : {}) }` before the session starts; this
   replaces any stale record. The first attempt is logged by the caller's existing start line (attempt 1 has no
   suffix by the step-log convention); attempts 2 and 3 by the `session retry` line of step 3.
5. Call `sessionOnce`. On success, save `sessionAttempt: undefined` and return the review record.
6. On `SessionTransportFailure`: `failure = sessionFailureDetail(cause)`; save the record with that `failure`.
   When `attempt === SESSION_ATTEMPTS`, save `sessionAttempt: undefined` and throw `SessionAttemptsExhausted`;
   otherwise continue with step 3 and `attempt + 1`.
7. On any other error (a `blocked` report, `Worker <purpose> incomplete`, a cancellation, an interruption, any
   non-transport failure): save `sessionAttempt: undefined` and rethrow unchanged. A crash of the runner process (no
   catch runs) or an error thrown by the wait itself keeps the record, so a restart continues the count — but only
   for a restart that starts the same session again (same owner, step 1).

#### 3a. The send-back resume path clears the record before its commit

The one resume path that does not start its interrupted session again is the send-back step with
`sendBack.session === 'started'`: it commits the worktree instead. No existing state update precedes that commit, so
this change adds one. In the final `else` branch of the integration loop (the send-back step), directly after the
`if (sendBack.session === 'pending') { ... }` block and directly before
`taskStep(work.id, 'commit', 'committing the send-back result', currentAttempt())`, the runner executes

```ts
if (activeWork().sessionAttempt) save({ sessionAttempt: undefined });
```

On the resume path this removes the record of the abandoned send-back attempt; on the normal path the record was
already cleared by `session()` (success), so no save happens. The order is therefore: clearing `save`, then the
`commit: committing the send-back result` step line, then `commitSendBack`, then the existing post-commit `save`
with `step: 'checks'` and `session: 'finished'`. Because the step line is written after the clearing save and before
the commit, a test that reads `state.json` when that step line arrives observes the work without `sessionAttempt`
before the commit runs (task 4.18). Together with the owner binding this guarantees that a later `work` session in
the `integrate` stage (the conflict resolution or send-back of a later integration) starts as attempt 1, without a
`session retry` line or wait, and is never blocked by a record it did not create.

Every caller writes its own start line (`taskStep`) before calling `session()`, so on a restart the `resuming`
prefix of the first continued step is always taken by that start line and never by the `session retry` line.

#### Step line length bound

The `session retry` line is
`[outcome-runner] HH:MM:SS ` (26) + `<id> ` (id + 1) + `session retry: ` (15) + message + ` (attempt N)` (12).
The longest message is `documentation review: no report; retry in 30 s` (46 characters), so the line is at most
`100 + <id length>` characters. With a task id of at most 20 characters (queue ids such as `OR-34` have 5) the line
stays within the 120-character limit and always ends with ` (attempt N)`; for example a 20-character id gives
exactly 120 characters. A required test (task 4.3) checks the longest label with attempt 3 and a 20-character id.

### 4. Budgets, also across a restart

Within one run, `countReview` runs once before the review session and `countCheck` only after a failing runner
check run; both stay outside `session()`, so all attempts of one review session use one review round and no check
attempt. `sessionStarts` is still incremented per attempt, because it counts started harness sessions; the attempt
number of a later round's start line (`sessionsStarted + 1`) therefore counts the retried attempts too.

Across a restart, each review session falls in one of these cases:

- **Documentation review (`document-review` stage).** A restart enters the `document-review` branch again and
  continues the same session. The branch therefore decides first whether it resumes:

  ```ts
  const resumed = sameSessionAttemptOwner(activeWork().sessionAttempt,
    sessionAttemptOwner(activeWork(), 'document-review'));
  if (!resumed) countReview('document');
  taskStep(work.id, 'documentation review', 'starting the documentation review session', resumed ? round - 1 : round);
  ```

  A matching record `{ purpose: 'document-review', stage: 'document-review', ... }` exists only when an attempt of
  this round was saved by `session()` after this round's `countReview`, and was not cleared (the runner stopped or
  the wait threw). So `resumed` means the round is already counted: no second round is counted, and the start line
  shows the same round number as before the restart (`round - 1` equals the counted `budget().document.reviews`).
  The budget limit was already checked by that earlier `countReview`. A record of any other session (for example
  the `document` session, which clears its record on success before the stage becomes `document-review`) does not
  match, so a new round is counted as before. A matching record with `attempt` 3 makes `session()` throw
  `SessionAttemptsExhausted` without counting a round (decision 3 step 2).
- **Planning review and implementation review (`plan` and `work` stages).** A restart in these stages does not
  start the interrupted review session again: the stage loop restarts at its first session (the planning or
  implementation session), as it does today. That session has another owner, so the review record is stale and is
  replaced (decision 2); the review of the new round is a new session with its own count of one round. The
  interrupted round stays counted as today (`countReview` counts the round durably before its session, so a failing
  session still uses it). This is not "one session using two rounds": the attempts of the interrupted session used
  one round, and the restarted stage runs a new round with new sessions. Changing which session a restarted stage
  starts with is out of scope.
- **Integration reviews (`integrate` stage).** `countReview` is not called there, so no round is counted, before or
  after a restart.

### 5. Injectable wait

`RunOptions.sessionRetrySleep?: Sleep` (the `Sleep` type of the free-work wait) defaults to the existing
`defaultSleep`, which ends early when the signal aborts. Tests pass a fake clock that records the milliseconds and
resolves at once. It is operational only and never enters the invocation identity.

### 6. Integration sessions: `SessionAttemptsExhausted` passes through unchanged (option 1)

The integration conflict resolution, send-back, review and documentation review sessions use the same `session()`;
a transport failure is retried inside `session()` before their rejection handling sees any error. The send-back
record is saved `started` once before the first attempt, so a retry never starts a second send-back.

After the last attempt, `SessionAttemptsExhausted` must keep its message as the private reason, so the integration
handlers let it through unchanged:

- `rejected(error)` rethrows `error` unchanged when it is a `SessionAttemptsExhausted`, exactly as it already does
  for a cancellation, an interruption and an `IntegrationFailure`. It no longer becomes
  `target-conflict-unresolved` or `target-integration-rejected`.
- The send-back catch rethrows a `SessionAttemptsExhausted` unchanged (like a cancellation) instead of setting
  `failed = true` and calling `sendBackOrReject`.

The error then reaches the task `catch`, which blocks the task with `reason` =
`Session <purpose> ended without a report after 3 attempts; last failure: <detail>`, the same as for a stage
session. Its blocker is `operation-incomplete` (the reason is not an integration code). The integration record stays
in the blocked work with its current `step`, so a later run resumes the integration at that step. For a send-back
the record keeps `session: 'started'`; as today after a crash during that session, a resumed run commits the
worktree instead of starting the send-back again, and (decision 3a) the new clearing `save` before
`commitSendBack` removes any `sessionAttempt` left there.

Option 2 (keeping the integration code and storing the attempts message beside it) was rejected: it needs a new
field in the blocked entry and in `explainUnfinished`, while option 1 keeps one reason for every exhausted session.

## Risks / Trade-offs

- A harness that exits for a lasting reason costs 40 seconds before the block. Accepted: the limit is small.
- Classification by message is heuristic; unknown errors are not retried, which keeps the earlier behaviour.
- The record of attempt `n` is saved after its wait, so a runner killed during the wait repeats that wait on restart
  and never loses an attempt.
- A task id longer than 20 characters would cut the ` (attempt N)` suffix of the `session retry` line; queue ids
  are far shorter, and the bound is stated here and tested.
- An integration session that exhausts its attempts is reported as `operation-incomplete` rather than with an
  integration code; the private reason names the attempts and the last failure.
- A stale record (left by a session that is never started again) stays in the work until the next session saves
  its own record; it is harmless because the owner binding ignores it, and the send-back resume path clears it.
- A restart in the `plan` or `work` stage during a review restarts the stage round as today (decision 4); the
  interrupted review's attempt count is not continued there because that review session is not started again.

## Migration

Work recorded before this change has no `sessionAttempt` and starts at attempt 1. No state migration is needed.
