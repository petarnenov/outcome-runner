# Design

## Context

`runSteps` in `src/runner.ts` loops: refresh the target, compute `done`, record acceptances, check the limit and
exhaustion, then pull the claims ledger and pick the first free task. When no task is free it returns
`finish({ status: 'incomplete', ..., blockers: explain(remaining, foreignClaims), claimedElsewhere })`.
`explainUnfinished` already classifies each remaining task (and each blocked task of the invocation) with one of
`blocked`, `max-accepted`, `waiting-for-dependency`, `waiting-for-claim`, `waiting-for-blocked-scope`.

## Decisions

### 1. When to wait

At the point where no task is picked, compute `blockers = explain(remaining, foreignClaims)` as today. The run waits
exactly when `blockers` is nonempty and every entry has `kind` `waiting-for-claim` or `waiting-for-dependency`.
Otherwise it returns the same `incomplete` result as before.

This gives the required self-block rule without a separate graph walk. A task blocked in this invocation's own state
has its own `blocked` entry, because `explainUnfinished` lists every blocked id of the invocation, including merged
tasks whose acceptance recording failed. So any blocked task, and therefore any task depending on one, prevents the
wait. A task overlapping a blocked scope has `waiting-for-blocked-scope` and also prevents it. `max-accepted` cannot
occur here because the limit check returns earlier. The `exhausted` and `limit-reached` paths come before selection
and are untouched.

### 2. The wait

```
step('run', 'wait', waitMessage(blockers, foreignClaims, pollSeconds));
await sleep(pollSeconds * 1000, waitSignal);
if (stopped || signal?.aborted) return finish({ status: 'cancelled', ...resultData(newlyAccepted), remaining,
  blockers });
continue;   // top of the loop: refresh() fetches the target, done is recomputed, ledger.pull() at selection
```

- `continue` re-enters the loop. The loop fetches `origin/<target>`, recomputes `done` from receipts, pulls the
  claims ledger and picks the next free task. No new code path claims anything.
- After the sleep, a cancellation returns at once. It does no fetch, ledger pull, claim, worktree or session. The
  `cancelled` result carries the blockers computed before the wait, so the remaining tasks stay explained.
  `finish` writes `state.json` `status` `incomplete`, as for any other cancelled result without a blocked task. The
  ownership is not released.
- `state.json` `status` stays `running` while waiting, and ownership and the invocation lock stay held.

### 3. Step line

A poll is one sleep of the poll interval. Exactly one `run wait` line is written immediately before each sleep, so
a run that sleeps twice (the first sleep returns, the second is aborted) writes exactly two lines.

`waitMessage` returns `waiting <n>s for <id> on <host>, ...`. It lists the distinct ids being waited for, sorted,
each with the host recorded in the claim holding it:

- for a `waiting-for-claim` blocker, the claim's task id and recorded host (`unknown host` when the claim has none);
- for a `waiting-for-dependency` blocker, each dependency not already listed: its foreign claim's recorded host when
  one exists, otherwise `unclaimed`.

Illustrative example: `waiting 60s for A on host-1, B on host-2`. In the Git fixtures every claim records
`os.hostname()`, so tests assert the host read from the claim rather than a literal. `waitMessage` is exported so it
can be unit-tested.

This conflicts with the current `runner-step-log` requirement "Waits log once", which forbids a line per poll for
waits and polling loops. The change carries a MODIFIED delta for that requirement: it keeps "log once" for the
task-level waits it lists (mergeability and checks, stale pull request head, Git lock) and states that the run-level
wait for free work writes one line per poll. A run-level wait lasts minutes to hours with a 60-second default, so one
line per poll is a useful heartbeat and bounded output; the task-level waits poll every few seconds and stay quiet.

### 4. Poll interval

- `RunConfig.pollSeconds?: number`. `resolvePollSeconds(value = 60)` in `src/model.ts` returns the value, or
  throws an error with `reason: 'invalid-poll-seconds'`, the message
  `Invalid pollSeconds: expected an integer from 5 through 3600` and `details: { setting: 'pollSeconds', value }`
  unless the value is a safe integer in 5..3600.
- `runSteps` calls it right after the required-settings check, before any preflight, lock, state, ownership file,
  claim or worktree. Through the CLI, `reportFailure` prints `{ status: 'unavailable', reason: 'invalid-poll-seconds',
  diagnostics }` with exit code 4. The diagnostics file holds the message and details naming `pollSeconds`.
  `validateConfig` also calls it, so programmatic configurations are checked.
- `pollSeconds` is operational. It is not part of `invocationIdentity`, so changing it never makes a stored
  invocation incompatible.

### 5. Injectable sleep and cancellation

- `RunOptions.sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>`. The default is
  `timers/promises` `setTimeout(ms, undefined, { signal })`, and the wait ignores its `AbortError`.
- `waitSignal` is `AbortSignal.any([options.signal, local])` (only `local` when no signal is given). `local` is a
  run-local `AbortController` that the existing `stop` aborts. A `SIGINT` or `SIGTERM` received through
  `process.on(..., stop)` therefore also ends the wait.
- Tests pass a fake `sleep` that advances a fake clock (`options.now`) and runs a scripted action: another
  invocation merges, `disposeInvocation` releases a claim, or the test's `AbortController` aborts.

### 6. Test fixture and existing tests

With waiting, a run whose only remaining work waits for a foreign claim no longer returns by itself.

`runnerFixture.options(extra)` always creates its own `AbortController` (`fixtureAbort`). The `signal` it passes to
the run is:

- `fixtureAbort.signal` when `extra.signal` is absent;
- `AbortSignal.any([extra.signal, fixtureAbort.signal])` when `extra.signal` is given.

So the run always observes `fixtureAbort`, whether or not the test supplies its own signal. The default fake
`sleep` (used when `extra.sleep` is absent) records its milliseconds, increments a call counter, aborts
`fixtureAbort` and returns. Because the run sees that abort, the first default poll always ends the run with
`cancelled`; a test with its own signal can never loop unbounded on the default sleep. As a second guard, the
default sleep throws `fake sleep: poll limit reached` if it is called again after it has aborted (the run should
never do so), so a regression fails the test instead of hanging it.

Tests that need several polls pass their own `sleep`; they are responsible for ending the run, by aborting their
signal or by making a task free.

Existing tests that expected `incomplete` from pure claim or dependency waits then get `cancelled`, with
`state.json` `status` `incomplete` and the same blockers; their assertions are updated to that. Examples are the
dispose test of an unclaimed incomplete invocation and the unfinished-results foreign-claim tests.

### 7. Proving no effect after a cancel

Refs that stay unchanged do not prove that no fetch happened, because a fetch while origin has not moved leaves them
unchanged too. The cancel test therefore moves origin inside the fake sleep before it aborts: it pushes a commit to
`<target>` from a separate integrator clone and a commit to the remote claims-ledger branch. After the run returns,
the local `refs/remotes/origin/<target>` and the local claims-ledger ref must still hold their pre-wait values. Any
fetch or ledger pull after the abort would have moved them.

## Risks

- A claim held by a runner that crashed and never comes back makes a run wait until it is cancelled. The README says
  so and points to `dispose` of the stale invocation.
- Each poll costs one fetch and one ledger pull; the 5-second minimum bounds that load.
