# Wait for claimed and dependent tasks instead of ending the run

## Why

When several runners share one queue, a runner whose remaining tasks are all claimed by other runners, or wait for
dependencies those runners are still working, ends today with `incomplete` (exit 3). The owner must start it again
by hand, often many times, until the queue is empty. Those tasks will become free without any action of this
invocation: another runner merges its task, or a claim is released by `dispose`. The run should wait for them.

## What Changes

- When no remaining task can be picked and every blocker of every remaining task is `waiting-for-claim` or
  `waiting-for-dependency`, the runner waits one poll interval, then pulls the claims ledger and the target again,
  recomputes the done tasks and picks the next free task, instead of ending with `incomplete`.
- New optional invocation field `pollSeconds` (integer 5..3600, default 60). An invalid value is refused at startup
  with exit code 4, reason `invalid-poll-seconds` and diagnostics naming `pollSeconds`. It is operational and never
  enters the invocation identity.
- The run still ends with `incomplete` and the existing blockers when any remaining task (or a blocked task of the
  invocation) has a blocker of another kind, such as `blocked` or `waiting-for-blocked-scope`, so a run never waits
  for work nobody can finish. `exhausted` and `limit-reached` endings are unchanged.
- One step line per poll names the tasks waited for and the hosts holding them; a cancel signal during the wait ends
  the run with `cancelled` without a further effect.
- The step-log rule "Waits log once" is narrowed to the task-level waits it lists (mergeability and checks, stale
  pull request head, Git lock); the run-level wait for free work logs once per poll.
- `RunOptions.sleep` makes the wait injectable, so tests use a fake clock.
- README documents waiting for free work, `pollSeconds` and when a run still ends `incomplete`.

## Capabilities

### New Capabilities

- `wait-for-free-work`: waiting for work held by other runners, the poll interval and its refusal, the wait step
  line and cancellation during the wait.

### Modified Capabilities

- `unfinished-results`: a run whose only remaining work waits for foreign claims no longer returns `incomplete`; the
  scenarios that relied on that are restated for a run cancelled during the wait.
- `runner-step-log`: "Waits log once" applies only to the task-level waits it lists (mergeability and checks, stale
  pull request head, Git lock); the run-level wait for free work writes one `wait` line per poll.

## Impact

- `src/runner.ts` (selection loop, `RunOptions.sleep`, cancellation of the wait), `src/model.ts`
  (`RunConfig.pollSeconds`, `resolvePollSeconds`).
- Tests: new `test/wait-for-free-work.test.ts`; `test/support/runner-fixture.ts` gets a fake sleep and combines a
  caller's signal with its own; existing tests that expected `incomplete` from pure claim or dependency waits cancel
  during the wait instead.
- `README.md`.
