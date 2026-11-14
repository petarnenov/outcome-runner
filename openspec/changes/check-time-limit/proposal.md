# Proposal: Time limit for product checks

## Why

The runner runs product checks synchronously (`execFileSync` through `command` in `src/git.ts`) with no time limit.
A check that hangs (for example a test that never ends, or a server a test forgot to stop) stops the whole run
forever: no step line, no record, no budget use, and the worker never learns why. Child processes the check started
can also be left running.

## What Changes

- Every product check command (`project.checks`) gets a time limit. This covers checks a worker session runs
  through the broker (`run_checks`) and checks the runner runs itself: work-stage checks, final checks, integration
  checks and the publish gate before the merge.
- The limit defaults to 30 minutes. The new invocation field `checkTimeoutMinutes` (an integer from 1 through 240)
  sets it. An invalid value is refused at startup with exit code 4, reason `invalid-check-timeout` and diagnostics
  naming `checkTimeoutMinutes`. The field is operational and never enters the invocation identity.
- A product check runs in its own process group. When it runs past its limit, the runner sends `SIGTERM` to the
  group. If any process is still left after 10 seconds, it sends `SIGKILL`. The check is recorded only once no
  process of the group remains.
- A timed-out check is a failed check with outcome `timed-out`. Its record holds the limit and the last 16000
  characters of its output, followed by a line naming the limit. It uses one check attempt of the stage budget, and
  the worker receives it like any other failed check.
- A step line names the timed-out check and the limit before the next effect.
- README documents the limit, `checkTimeoutMinutes` and the `timed-out` outcome.

Setup commands, the planning check and the archive command keep their current behaviour.

## Capabilities

### New Capabilities

- `check-time-limit`: the time limit of product checks, how they are stopped, and how a timed-out check is
  recorded, logged and counted.

## Impact

- `src/check-process.ts` (new): runs one check in its own process group with a limit and a kill grace period.
- `src/model.ts`: `checkTimeoutMinutes` in `RunConfig`, `resolveCheckTimeoutMinutes`, and the limit fields of
  `CheckRecord`.
- `src/runner.ts`: product checks become asynchronous. Adds the timeout step line, the timed-out record, the
  failure detail and the test hook `RunOptions.checkLimits`.
- `src/network-retry.ts`: an asynchronous variant of the connection retry that uses the same policy.
- `test/check-time-limit.test.ts` (new) and `test/support/check-scripts.ts` (new).
- `README.md`.
