# Tasks

## 1. Dependency check

- [ ] 1.1 Add an exported pure helper `missingDependencies(ids, tasks, isAccepted)` (src/runner.ts) returning
  `{ [taskId]: dependencyIds[] }` for dependencies outside `ids` that are not accepted (unknown ids are missing).
- [ ] 1.2 In `runSteps`, after the authority checks on the initial refresh and before `new RunStore`, the ownership
  write, the claims ledger and any worktree, call it with the receipt check at the initial target and throw an
  error with `reason: 'dependencies-outside-invocation'`, a message naming each task and its missing dependencies
  and `details: { missing }` (printed reason and diagnostics file through the existing `reportFailure`, exit 4).

## 2. Unfinished reasons

- [ ] 2.1 Define the `Blocker` type (`kind` of `blocked`, `waiting-for-dependency`, `waiting-for-claim`,
  `waiting-for-blocked-scope`, `max-accepted`; `stage`, `reason`, `diagnostics`, `dependencies`, `claim`, `task`,
  `limit` as applicable) and use it for `RunResult.blockers`.
- [ ] 2.2 Add the exported pure helper `acceptedThisRun({ ids, completed, blocked, done, baselineDone })` (design
  decision 2) in src/runner.ts: ids of `ids` in `completed` and `done` and not in `baselineDone`, plus ids of `ids`
  that are keys of `blocked`, in `done` and not in `baselineDone`; never ids outside `ids`, even when newly done.
  In `runSteps`, call it with `ids`, `state.completed`, `state.blocked`, `done` and `baselineDone` for the existing
  `maxAccepted` limit check (replacing `newlyAccepted.length`).
- [ ] 2.3 Add an exported pure helper `explainUnfinished({ remaining, ids, tasks, completed, blocked, done,
  baselineDone, maxAccepted, foreignClaims, statePath })` applying the rules of design decision 4 in order. Its
  `max-accepted` rule calls `acceptedThisRun({ ids, completed, blocked, done, baselineDone })` itself (no
  precomputed count is passed in). It throws `Unexplained unfinished task` when no rule matches. Add a helper
  `foreignClaimsOf(snapshot, done)` for its foreign claims.
- [ ] 2.4 Acceptance-recording failure (design decision 3): record the task in `state.blocked` as today; return
  `incomplete` with `explainUnfinished` blockers only when `maxAccepted` is set and `acceptedThisRun(...).length`
  reaches it; otherwise skip the cleanup and `accepted` report of that task and continue with the normal remaining
  computation, limit check and selection of the same iteration.
- [ ] 2.5 Use `explainUnfinished` on the no-selectable-task `incomplete` return (with the ledger snapshot it already
  pulled), on the acceptance-failure return of 2.4 and on the `limit-reached` return (each pulling the ledger with
  `ledger.pull()` before the call); keep blocked entries outside `remaining` and keep `claimedElsewhere`.
- [ ] 2.6 On the `!remaining.length` path, when `state.blocked` holds a task of the invocation, do not release the
  ownership and return `incomplete` with the blocked entries; otherwise keep today's behaviour.

## 3. Invocation status

- [ ] 3.1 Write `status: 'running'` after the leftover sweep and before the first loop iteration.
- [ ] 3.2 Add a `finish(result)` wrapper that writes, before every return of the loop (in-progress work means a
  current task or recovered work that is claimed but neither accepted nor blocked; unstarted `max-accepted` tasks are
  not in-progress work): `released` (ownership released - all leaves accepted without a blocked task, or limit
  reached with no blocked task and no in-progress work, even when unstarted `max-accepted` tasks remain); `blocked`
  (a `limit-reached`, `incomplete` or `cancelled` result holding a blocked task of the invocation); `completed`
  (limit reached keeping in-progress work with no blocked task); `incomplete` (any other incomplete or cancelled
  result).

## 4. README

- [ ] 4.1 Document the dependency check (exit 4, reason `dependencies-outside-invocation`, diagnostics listing each
  task and its missing dependencies; accepted dependencies allowed) in the exit code table and start steps.
- [ ] 4.2 Document the `blockers` entry kinds of `incomplete` and `limit-reached` results, that every remaining
  task is named, that `maxAccepted` counts only tasks of the invocation (including a merged task whose acceptance
  recording failed), and that a failed acceptance recording keeps the run working other tasks unless the limit is
  reached, and still ends the run with exit 3 and a `blocked` entry.
- [ ] 4.3 Document `state.json` `status` values `running`, `incomplete`, `blocked`, `completed` and `released`,
  defining in-progress work (current or recovered claimed work, not unstarted tasks): a `limit-reached` run with no
  blocked task and no in-progress work is `released` even when unstarted `max-accepted` tasks remain; one keeping
  in-progress work without a blocked task is `completed`; one keeping a blocked task is `blocked`.

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Runner tests use scripted adapters, the
scripted pull request host and Git fixtures (`test/support/runner-fixture.ts`, extended with per-task dependencies
and scopes); the foreign claim is written to the claims ledger with another claimant. An acceptance-recording
failure is scripted as a claim-time recovery failure of the merged task.

### Grade E

- [ ] 5.1 (E) (coverage-only) `missingDependencies` returns `{}` when every dependency is in the set or accepted,
  and lists unknown dependency ids as missing.
- [ ] 5.2 (E) (coverage-only) `explainUnfinished` applies the rule order (`blocked` before `max-accepted` before
  `waiting-for-dependency` before `waiting-for-claim` before `waiting-for-blocked-scope`).
- [ ] 5.3 (E) (coverage-only) `explainUnfinished` throws `Unexplained unfinished task` when no rule matches.
- [ ] 5.4 (E) (required) Foreign acceptance does not count: call the real `explainUnfinished` (which computes the
  count itself through `acceptedThisRun`; no count is passed in) with `ids` `["R"]`, `remaining` `["R"]`,
  `maxAccepted` 1, empty `completed` and `blocked`, `R` without dependencies, a task `F` outside `ids` that is in
  `done` but not in `baselineDone` (newly accepted by another runner), and `foreignClaims` holding a claim of another
  claimant on a task `G` (not done) whose scopes overlap `R`'s. Assert that `R`'s blocker has `kind`
  `waiting-for-claim` naming `G`, not `max-accepted`. Also call `acceptedThisRun({ ids, completed, blocked, done,
  baselineDone })` directly with the same inputs and assert it returns `[]` (length 0).

### Grade D

- [ ] 5.5 (D) (required) Leaves `B` and `C` missing dependencies `A` and `X`: `main` exits 4, the printed reason is
  `dependencies-outside-invocation`, the diagnostics file lists `B` with `[A]` and `C` with `[A, X]`, and no
  `state.json`, claim or worktree exists.
- [ ] 5.6 (D) (required) Without leaves, authority tasks whose dependencies are all authority tasks pass the
  dependency check and are worked in dependency order.

### Grade C

- [ ] 5.7 (C) (required) Dependency already accepted allowed: after a run with leaves `[A]` accepts `A`, a run with
  leaves `[B]` (`B` depends on `A`) passes the check and accepts `B`.
- [ ] 5.8 (C) (required) Blocked kind: a failing session yields an `incomplete` result whose blocker has `kind`
  `blocked`, `reason` `operation-incomplete`, its `stage` and the `state.json` path; `state.json` `status` is
  `blocked` after the run.
- [ ] 5.9 (C) (required) Waiting for a dependency: leaf `B` depends on blocked leaf `A`; `B`'s blocker has `kind`
  `waiting-for-dependency` and `dependencies` `["A"]`; `blockers` covers every remaining task.
- [ ] 5.10 (C) (required) Waiting for a foreign claim: a foreign claimant holds a claim overlapping the only
  remaining task; its blocker has `kind` `waiting-for-claim` naming the claimed task and host; `state.json`
  `status` is `incomplete` after the run.
- [ ] 5.11 (C) (required) Waiting for a blocked scope: a remaining task overlapping the scopes of a blocked task of
  the invocation has `kind` `waiting-for-blocked-scope` naming the blocked task.
- [ ] 5.12 (C) (required) `state.json` `status` is `running` when observed from inside the first scripted session.

### Grade B

- [ ] 5.13 (B) (required) Completed run: a run accepting every leaf exits 0 and leaves `state.json` `status`
  `released`.
- [ ] 5.14 (B) (required) Limit reached without blocked or in-progress work: `maxAccepted` 1 with two independent,
  non-overlapping leaves; the first is accepted and the second is unstarted. The result is `limit-reached` (exit 0),
  the second leaf stays in `remaining` with `kind` `max-accepted`, the ownership is released and `state.json`
  `status` is `released` (not `completed`).
- [ ] 5.15 (B) (required) Limit reached with kept blocked work: `maxAccepted` 1 with three independent,
  non-overlapping leaves - one whose session fails (blocked), one accepted, and a third that is still selectable
  when the limit is reached. The result is `limit-reached`; the third leaf stays in `remaining` with `kind`
  `max-accepted`, the blocked leaf has `kind` `blocked`, and `state.json` `status` is `blocked`.

### Grade A

- [ ] 5.16 (A) (required) Stopped by maxAccepted in an incomplete result: `maxAccepted` 2, task `A` accepted, task
  `B` merged but its acceptance recording fails, task `C` remains; the result is `incomplete` with exit 3, `C` has
  `kind` `max-accepted`, `B` has `kind` `blocked`, and `state.json` `status` is `blocked`.
- [ ] 5.17 (A) (required) Acceptance-recording failure without a limit: `maxAccepted` unset, independent leaves `A`
  and `B` with non-overlapping scopes, no foreign claim, `A` merges but its acceptance recording fails. (a) `B` is
  then selected and accepted in the same run; `main` exits 3 (not 4), the result is `incomplete` with `A` `kind`
  `blocked`, the ownership is not released and `state.json` `status` is `blocked`. (b) With `B`'s session also
  failing, `remaining` is `["B"]`, every remaining task has an explained `blockers` entry (`B` `blocked`, and `A`
  `blocked` as well), `main` exits 3, and no `Unexplained unfinished task` error is raised.
- [ ] 5.18 (A) (required) Limit reached keeping in-progress work: an earlier run leaves a claimed, unaccepted and
  unblocked task of the invocation (recovered work); a new run with `maxAccepted` 1 accepts another task while the
  recovered work is kept for a later run and no task is blocked. The result is `limit-reached`, the ownership is not
  released and `state.json` `status` is `completed`.

## 6. Verification after binding

- [ ] 6.1 Update existing tests that assert exact `blockers` objects for the added `kind` field.
- [ ] 6.2 Run `npm run typecheck`.
- [ ] 6.3 Run `npm test` with the coverage gate at 85%.
