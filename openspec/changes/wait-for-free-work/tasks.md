# Tasks

## 1. Poll interval

- [ ] 1.1 Add `pollSeconds?: number` to `RunConfig` and `resolvePollSeconds(value = 60)` to src/model.ts (design
  decision 4): it returns the value, or throws an error with `reason: 'invalid-poll-seconds'`, the message
  `Invalid pollSeconds: expected an integer from 5 through 3600` and `details: { setting: 'pollSeconds', value }`
  unless the value is a safe integer from 5 through 3600. Call it from `validateConfig`.
- [ ] 1.2 In `runSteps` (src/runner.ts), resolve `pollSeconds` right after the required-settings check, before any
  preflight. Do not add it to `invocationIdentity`.

## 2. Waiting in the selection loop

- [ ] 2.1 Add `RunOptions.sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>`. The default is
  `setTimeout` from `node:timers/promises` with `{ signal }`, and an `AbortError` is ignored (decision 5).
- [ ] 2.2 Create a run-local `AbortController` that `stop` aborts. The wait signal combines it with
  `options.signal` through `AbortSignal.any`.
- [ ] 2.3 Where no task is picked, compute the blockers once. When they are nonempty and every `kind` is
  `waiting-for-claim` or `waiting-for-dependency` (decision 1), write the `wait` step line, sleep
  `pollSeconds * 1000`, then either return `finish({ status: 'cancelled', ..., blockers })` when stopped or aborted
  (with no fetch or ledger pull), or `continue` the loop (decision 2). Otherwise return the unchanged `incomplete`
  result.
- [ ] 2.4 Export `waitMessage(blockers, foreignClaims, pollSeconds)`, which returns
  `waiting <n>s for <id> on <host>, ...` with distinct sorted ids, the host recorded in the claim, `unknown host`
  for a claim without a host and `unclaimed` for a dependency without a foreign claim (decision 3).
- [ ] 2.5 Step-log rule (runner-step-log delta "Waits log once", design decision 3): a poll is one sleep of the poll
  interval, and the run-level `run wait` line is written once per poll, immediately before each sleep; the
  task-level waits (mergeability and checks, stale pull request head, Git lock) keep logging once per wait and are
  not changed. Keep the existing step-log tests for those waits passing unchanged; the per-poll rule is covered by
  graded test 5.10.

## 3. Test fixture and existing tests

- [ ] 3.1 In test/support/runner-fixture.ts (decision 6), `options(extra)` always creates a fixture-owned
  `AbortController` (`fixtureAbort`). It passes `signal: fixtureAbort.signal` when `extra.signal` is absent, and
  `signal: AbortSignal.any([extra.signal, fixtureAbort.signal])` when `extra.signal` is given, so the run always
  observes `fixtureAbort`. When `extra.sleep` is absent, the default fake `sleep` records its milliseconds, counts its
  calls, aborts `fixtureAbort` and returns; if it is called again after aborting, it throws
  `fake sleep: poll limit reached` so a regression fails instead of hanging. Expose the recorded calls to tests.
- [ ] 3.2 Update existing tests that expected `incomplete` from runs whose remaining work only waited for foreign
  claims or dependencies (for example the unclaimed incomplete dispose test, the many-runners and unfinished-results
  foreign-claim tests). They now expect `cancelled` with the same blockers and `state.json` `status` `incomplete`.
  Tests whose run ends for another reason stay unchanged. The modified unfinished-results scenarios are covered by
  the graded tests 5.7 and 5.11.

## 4. README

- [ ] 4.1 Document waiting for free work: when the runner waits (only claim and dependency waits), that it polls the
  target and claims ledger every `pollSeconds` (default 60, integer 5–3600, refused with exit 4 and
  `invalid-poll-seconds` otherwise), the `wait` step line written once per poll (unlike task-level waits, which log
  once), that a cancel during the wait ends `cancelled`, and when a run still ends `incomplete` (a task blocked in
  this invocation, a task depending on it, a blocked scope). Point to `dispose` for a stale claim of a runner that
  never returns. Replace any text saying claimed work ends the run `incomplete`.

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Run tests use `runnerFixture`
(test/support/runner-fixture.ts) with scripted adapters, the scripted pull request host, Git fixtures, a fake clock
(`now`) and a fake `sleep` that records its milliseconds and runs a scripted action per call. A task is held by
another invocation `two` that blocks on it through the `fail` hook, or by running `two` from inside `one`'s fake
sleep. New tests go into test/wait-for-free-work.test.ts.

### Grade E

- [ ] 5.1 (E) (required) `resolvePollSeconds`: `undefined` gives 60; 5 and 3600 are accepted; 4, 3601, 7.5, `"60"`
  and `NaN` throw with `reason` `invalid-poll-seconds` and `details.setting` `pollSeconds`.
- [ ] 5.2 (E) (coverage-only) `waitMessage` lists distinct sorted ids with their hosts, uses `unknown host` for a
  claim without a host and `unclaimed` for a dependency without a foreign claim.

### Grade D

- [ ] 5.3 (D) (required) Invalid `pollSeconds` refused through the CLI (spec scenario "Invalid pollSeconds refused"),
  parameterized over all four values `4`, `3601`, `7.5` and `"60"` (one case each): `main(file, run, output,
  { cwd, env })` returns 4, prints `reason` `invalid-poll-seconds`, the diagnostics file names `pollSeconds`, and no
  `state.json`, claim or worktree exists.
- [ ] 5.4 (D) (required) Self-blocked task ends without waiting: leaf `B` depends on leaf `A` and `A`'s session fails;
  the result is `incomplete` with `A` `blocked` and `B` `waiting-for-dependency`, and the fake sleep was never
  called.
- [ ] 5.5 (D) (required) Limit reached without waiting (spec scenario "Limit reached"): `maxAccepted` 1, `one`
  accepts `A` while `B` is claimed by `two`; the result is `limit-reached` and the sleep was never called.
- [ ] 5.6 (D) (coverage-only) Fixture with a caller signal: a test passes its own `extra.signal` (never aborted) and
  no `extra.sleep`; `one`'s only leaf `B` is held by `two`. The run returns `cancelled` after exactly one default
  sleep call instead of hanging, which proves the combined signal of task 3.1.

### Grade C

- [ ] 5.7 (C) (required) Incomplete run (unfinished-results scenario "Incomplete run"): `one`'s only remaining task
  `B` waits for `two`'s claim and the fake sleep aborts the run; the result is `cancelled` and `state.json` `status`
  is `incomplete`.
- [ ] 5.8 (C) (required) Mixed blockers: one remaining task waits for a foreign claim while another task of the
  invocation is blocked in its own state; the run ends `incomplete` without calling the sleep.
- [ ] 5.9 (C) (required) Interval outside the identity (spec scenario "Interval outside the identity"):
  `invocationIdentity` of a config with `pollSeconds` 5 equals that of the same config with `pollSeconds` 120. Then
  invocation `one` with leaves `A` and `B`, `maxAccepted` 1 and `pollSeconds` 5 ends `limit-reached` after accepting
  `A`. The same invocation is run again with `pollSeconds` 120 and with `maxAccepted` omitted (`maxAccepted` is
  operational and not part of `invocationIdentity`, and `baselineDone` is kept from the first run, so keeping
  `maxAccepted` 1 would end the second run `limit-reached` at once). The second run is not refused as a different
  or incompatible invocation, reuses the same state directory and the same `identityHash` in the ownership file,
  claims and accepts `B`, and ends `exhausted`.
- [ ] 5.10 (C) (required) Step line per poll and interval (wait-for-free-work scenarios "Step line per poll",
  "Default interval", "Configured interval" and runner-step-log scenario "Wait for free work logs every poll"):
  `two` blocks holding `B`; `one` with leaf `B` and `pollSeconds` 5 waits. The fake sleep polls exactly twice: its
  first call returns, its second call aborts the run's signal (a third call would throw `fake sleep: poll limit
  reached`). The run ends `cancelled`; the sleep was called exactly twice, with 5000 each time; exactly two
  `run wait` step lines were written, one before each sleep, each naming `B` and the host recorded in `B`'s claim
  (read from `two`'s claim in the claims ledger, which the fixture writes as `os.hostname()`). With `pollSeconds`
  omitted and the default fixture sleep, the sleep received 60000.
- [ ] 5.11 (C) (required) Foreign acceptance does not count (unfinished-results scenario): invocation `one` has
  `maxAccepted` 1 and only leaf `B`; invocation `three` first accepts a task `X` outside `one`'s invocation, and `two`
  blocks holding `B`. `one` waits (the fake sleep was called once) instead of ending `limit-reached`; its sleep aborts
  the run, and the `cancelled` result's blocker for `B` has `kind` `waiting-for-claim`, not `max-accepted`.

### Grade B

- [ ] 5.12 (B) (required) Cancel during the wait (spec scenario "Cancel during the wait", design decision 7): `two`
  blocks holding `B`; `one` with leaf `B` waits. Before the wait the test records the local
  `refs/remotes/origin/<target>` and the local claims-ledger ref of `one`'s repository. Inside `one`'s fake sleep,
  before aborting, the test advances origin: it pushes a new commit to `<target>` from a separate integrator clone and
  a new commit to the remote claims-ledger branch, and checks that both remote refs moved. Then it aborts the run's
  signal. The result is `cancelled` with `B`'s `waiting-for-claim` blocker; the local `origin/<target>` ref and the
  local claims-ledger ref still hold their recorded pre-wait values (so no fetch or ledger pull followed the abort);
  no claim of `B` by `one` exists, no worktree was created for `one` and the scripted session was never started for
  `one`. `state.json` `status` is `incomplete` and the ownership file has `released: false`.
- [ ] 5.13 (B) (required) Claim released by dispose: `two` blocks holding `B`; `one` with leaf `B` waits, and its fake
  sleep calls `disposeInvocation` for `two`. After the poll `one` claims and accepts `B`, and the run ends
  `exhausted`.
- [ ] 5.14 (B) (required) Claimed task becomes done: `one` has leaves `A` and `C`, `C`'s scopes overlap `A`'s, and
  `two` holds `A` (claimed, then blocked through `fail`). In `one`'s fake sleep, `two` is retried with `--retry A`
  and a passing worker, and merges `A`. After the poll `one` claims and accepts `C`, and the run ends `exhausted` with
  `C` in `accepted`.

### Grade A

- [ ] 5.15 (A) (required) Dependency merged by another runner: `one` has leaves `A` and `B`, `B` depends on `A`,
  and `two` holds `A`. `one` waits with `A` `waiting-for-claim` and `B` `waiting-for-dependency`. In the fake sleep,
  `two` finishes and merges `A`. After the poll `one` recomputes `A` as done, claims and accepts `B`, ends
  `exhausted`, and `A`'s receipt names `two`'s merge.
- [ ] 5.16 (A) (coverage-only) Process signal during the wait: a `SIGINT` listener added by the run (`stop`) aborts a
  real default sleep with a 5-second interval, and the run returns `cancelled` well before 5 seconds.

## 6. Verification after binding

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run `npm test` with the coverage gate at 85%.
