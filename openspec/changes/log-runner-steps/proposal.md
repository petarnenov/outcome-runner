# Proposal: Log every logical step before it starts

## Why

A person watching the console while `outcome-runner` works sees nothing between the start of the run and the
JSON result lines on stdout (plus the optional mascot). Long sessions, checks, Git lock waits and mergeability
polling look like a hang. One short stderr line before each logical step makes the runner's progress visible
without changing its machine-readable output.

## What Changes

- A new step logger (`src/step-log.ts`) formats lines
  `[outcome-runner] HH:MM:SS <task id or run> <step>: <message>`: a single line of at most 120 characters,
  in English, built only from fixed text and safe identifiers. Run-start values are shortened one by one so the
  invocation, harness, model and effort always appear.
- `runQueue` writes a step line before every logical step: run start (invocation, harness, model, effort),
  each preflight (OpenSpec, harness version, test framework), claim, worktree, each setup command, the
  investigation, planning, planning check and planning review sessions, implementation session, commit, each
  product check, implementation review, documentation and documentation review, final checks, archive, receipt,
  integration of an advanced target, push, pull request creation or reuse, the mergeability/checks wait,
  merge, acceptance, worktree and branch cleanup, a blocked task, and run end with its outcome.
- Waits (mergeability and checks, stale pull request head, Git lock) log once when the wait starts. Retried
  steps (planning and implementation attempts, documentation rounds, publish repeated after a target advance)
  log with their attempt number. Work found in durable state when the run starts logs its first continued step
  with `resuming` and never logs completed steps again.
- `RunOptions.steps` injects the line output; the default writes to `process.stderr`. `withGitLock` gains an
  optional `onWait` callback so the runner can log a contended Git lock once.
- README documents the step lines and their format.

stdout, exit codes, the diagnostics file, receipts, state and statistics stay unchanged.

## Capabilities

### New Capabilities

- `runner-step-log`: one short stderr line before each logical runner step.

## Impact

- Code: `src/step-log.ts` (new), `src/runner.ts`, `src/git-lock.ts`.
- Tests: new `test/step-log.test.ts` and `test/runner-steps.test.ts` using scripted adapters, scripted hosts
  and Git fixtures from `test/support`; existing tests that assert stderr inject a capturing or no-op output.
- Docs: `README.md`.
