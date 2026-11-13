# Tasks

## 1. Model and setting

- [ ] 1.1 Add `checkTimeoutMinutes?: number` to `RunConfig`, `DEFAULT_CHECK_TIMEOUT_MINUTES = 30` and
  `resolveCheckTimeoutMinutes` (reason `invalid-check-timeout`, details `{ setting: 'checkTimeoutMinutes', value }`)
  to `src/model.ts`. Call it in `validateConfig`, and add `timeLimitMs?: number` to `CheckRecord` (design 1 and 4).
- [ ] 1.2 Call `resolveCheckTimeoutMinutes` in `runSteps` right after `resolvePollSeconds`. Leave
  `invocationIdentity` unchanged (design 1).

## 2. Limited check process

- [ ] 2.1 Export `commandEnvironment()` from `src/git.ts` and use it in `command`.
- [ ] 2.2 Create `src/check-process.ts` with `runLimitedCheck` and `CHECK_KILL_GRACE_MS = 10000`: a detached
  process group, capped output, and on timeout SIGTERM to the group, a grace-period poll, SIGKILL if anything is
  left, then a poll until the group is gone (design 3).
- [ ] 2.3 Add `withNetworkRetryAsync` to `src/network-retry.ts`, with the same policy as `withNetworkRetry`.

## 3. Runner

- [ ] 3.1 Add the `RunOptions.checkLimits` test hook. Export `limitText`, `CheckTimedOut` and the limit line
  (design 2 and 4).
- [ ] 3.2 Make `checks` and `integrateTarget` async and await them everywhere. Run `project.checks` rows through
  `runLimitedCheck` and keep setup and planning checks synchronous.
- [ ] 3.3 On a timeout, write the `check timeout` step line, push the `timed-out` row, save it (`finalChecks` in the
  publish gate, otherwise `checks`) and throw `CheckTimedOut`. `failureDetail` returns its `detail` unchanged.

## 4. README

- [ ] 4.1 Document the check time limit, `checkTimeoutMinutes`, process-group stopping, the `timed-out` outcome, the
  step line and the `invalid-check-timeout` refusal (design 5).

## 5. Tests

Graded from E (easiest) to A (most complex), listed easiest first. Unit tests of the check process and runner tests
go in `test/check-time-limit.test.ts`. Small check scripts go in `test/support/check-scripts.ts`:

- a hang script that prints `check started`, appends its pid to a pid file whose absolute path (in the fixture base
  directory, outside the worktree) is its argument, and then sleeps for a long time while `src/a/hang.md` exists,
  resolved relative to the script's working directory (the check's cwd). Without that marker it exits 0 at once;
- a script that starts a child ignoring SIGTERM, ignores SIGTERM itself, writes both pids to a file and sleeps.

Runner tests use `runnerFixture` with scripted adapters wrapping `scriptedWorker`. They patch `project.checks` to put
`node -e <hang script> <pid file>` first, ahead of the fixture checks, and set `checkLimits: { timeoutMs: 300 }`
through the test hook. The marker is a Markdown file, so a scripted implementer or documentation session can write
or delete `src/a/hang.md` for chosen sessions.

### Grade E

- [ ] 5.1 (E) (required) `resolveCheckTimeoutMinutes()` returns 30; 1 and 240 are returned unchanged; `0`, `241`,
  `7.5`, `"30"` and `null` throw with `reason` `invalid-check-timeout` and `details.setting` `checkTimeoutMinutes`.
- [ ] 5.2 (E) (required) `limitText(1800000)` is `30 minutes`, `limitText(60000)` is `1 minute` and
  `limitText(300)` is `300 ms`; `CHECK_KILL_GRACE_MS` is 10000.
- [ ] 5.3 (E) (required) `invocationIdentity` of a configuration with `checkTimeoutMinutes: 5` equals the identity
  without it.

### Grade D

- [ ] 5.4 (D) (required) Within the limit: `runLimitedCheck` of `node -e "console.log('ok')"` with a 5000 ms limit
  passes with output `ok`; a check that exits 1 after printing to stdout and stderr rejects with `status` 1, and
  `failureDetail` of the error holds both outputs.
- [ ] 5.5 (D) (required) Hanging check stopped: the test creates a temporary directory containing `src/a/hang.md`
  and a pid file path in a separate temporary directory, then calls `runLimitedCheck` of the hang script with that
  directory as `cwd` and a 300 ms limit. The result is `timed-out` in less than 5 seconds, its output holds
  `check started`, and the recorded pid no longer belongs to a live process.
- [ ] 5.6 (D) (required) Output tail: a `CheckTimedOut` whose check printed 20000 characters has a `detail` that is
  exactly the last 16000 characters, a newline and `Check timed out after 300 ms`, and `failureDetail` returns it
  unchanged.

### Grade C

- [ ] 5.7 (C) (required) Child ignoring SIGTERM: the check script starts a child that ignores SIGTERM and ignores it
  itself. With a 300 ms limit and a 200 ms grace, the result is `timed-out` only after at least the grace has
  passed. Afterwards `process.kill(pid, 0)` throws `ESRCH` for both recorded pids.
- [ ] 5.8 (C) (required) Invalid `checkTimeoutMinutes` through `main`: for `0`, `241`, `7.5` and `"30"` the exit
  code is 4, the printed reason is `invalid-check-timeout`, the diagnostics file names `checkTimeoutMinutes`, and no
  `state.json`, claim or worktree exists.
- [ ] 5.9 (C) (required) Checks within the limit unchanged: a fixture run with the default limit accepts task `A`,
  writes no `check timeout` step line, and the receipt's checks are all `passed`.
- [ ] 5.10 (C) (required) Resume with another valid `checkTimeoutMinutes` (spec scenario "Limit outside the
  identity"): a run blocked by a failing session is resumed with `checkTimeoutMinutes: 10` and is not refused as
  incompatible.

### Grade B

- [ ] 5.11 (B) (required) Hanging check recorded and logged: the first implementation writes `src/a/hang.md` and
  every later one keeps it. The first `check timeout` step line names `node`, `1/3` and `300 ms`, and comes before
  the second `implementation` step line. After the run, `state.json` holds a blocked `A` with
  `check-budget-exhausted`, `budget.work.checks` 4 and no implementation review session. Its work `checks` holds a
  `timed-out` record with `timeLimitMs` 300 and output holding `check started` and ending with
  `Check timed out after 300 ms`. The second implementation prompt holds that limit line in its findings, and no
  pid in the pid file belongs to a live process.
- [ ] 5.12 (B) (required) Worker `run_checks` times out: an implementation session with `src/a/hang.md` present
  calls `run_checks`. The tool call rejects with a message ending in `Check timed out after 300 ms`, and
  `budget.work.checks` read right after the call is unchanged.

### Grade A

- [ ] 5.13 (A) (required) Worker fixes the hang: the first implementation writes `src/a/hang.md`, and the second
  deletes it after its prompt holds the limit line. The task is accepted, `budget.work.checks` of the completed work
  is 1, the receipt's checks are all `passed`, and no pid in the pid file belongs to a live process.
- [ ] 5.14 (A) (coverage-only) Final checks time out: the documentation session writes `src/a/hang.md`. The
  `final-checks` stage times out, the task is blocked, and the work `checks` holds the `timed-out` record.

## 6. Verification after binding

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run `npm test` with the coverage gate at 85%.
