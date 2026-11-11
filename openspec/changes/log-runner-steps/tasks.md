# Tasks

## 1. Step logger

- [ ] 1.1 Add `src/step-log.ts` with `formatStep`, `runStartMessage` and `createStepLog({ write, now })`: format
  `[outcome-runner] HH:MM:SS <subject> <step>: <message>`, control characters replaced, 120-character limit with
  `...`, `attempt` suffix, `resuming` prefix and swallowed write failures (design D1, D2).
- [ ] 1.2 Cap run-start values separately: invocation and model at 16 characters, harness and effort at 8, each
  ending with `...` when cut, so all four values always fit (design D4a).
- [ ] 1.3 Add `RunOptions.steps` (default `process.stderr`) and build the logger in `runQueue` with `RunOptions.now`.

## 2. Runner steps

- [ ] 2.1 Write run start, the three preflight lines, leftover cleanup lines and the run end line (status, or
  `unavailable` on a throw) (design D4).
- [ ] 2.2 Write claim, worktree, setup, investigation, planning, planning check, planning review, implementation,
  commit, check, review, documentation, documentation review, final checks, archive, receipt, integrate, push,
  pull request, merge, acceptance, cleanup and blocked lines immediately before each step's first effect.
- [ ] 2.3 Log the merge-stage wait once on entry and the stale-head wait once per merge stage (design D5).
- [ ] 2.4 Add `onWait` to `withGitLock` (try without waiting, call `onWait` once, then wait the remaining timeout)
  and use it through a runner `lockGit(subject, fn)` wrapper for every runner Git group and the claim ledger
  (design D5).
- [ ] 2.5 Pass attempt numbers for retried planning and implementation attempts (from `sessionStarts` on resume),
  documentation rounds (from `documentationReviews.length + 1`) and publish passes after a target advance (an
  in-memory counter per task) (design D6).
- [ ] 2.6 Record the task ids of work found in durable state when `runQueue` starts (current and recovered blocked
  work) and mark only the first line of each with `resuming`; later passes of the same call never do (design D7).
- [ ] 2.7 Keep stdout, exit codes, diagnostics, receipts, state and statistics unchanged; let existing tests that
  assert stderr inject `steps`.

## 3. Documentation

- [ ] 3.1 Describe the step lines on stderr, their format, the 120-character limit and the wait/retry/resume rules
  in README.md.

## 4. Tests (graded E to A, easiest first)

- [ ] 4.1 (E) (required) `formatStep` produces `[outcome-runner] 09:05:03 OR-17 claim: <message>` from a fixed clock,
  with zero-padded local time.
- [ ] 4.2 (E) (required) A message that would exceed 120 characters is cut to exactly 120 characters ending with
  `...`; newlines, carriage returns and ESC in any part become spaces.
- [ ] 4.3 (E) (required) `runStartMessage` with a 60-character invocation id and a 60-character model id yields a
  run start line of at most 120 characters that still contains the shortened invocation, the harness, the
  shortened model and the effort.
- [ ] 4.4 (E) (coverage-only) `attempt` 2 appends `(attempt 2)`, attempt 1 or missing appends nothing, and
  `resuming` prefixes the message.
- [ ] 4.5 (E) (coverage-only) A throwing `write` is swallowed and `createStepLog` defaults to `process.stderr`.
- [ ] 4.6 (D) (coverage-only) `withGitLock` with a lock held by `test/support/git-lock-child.ts` calls `onWait`
  exactly once before waiting; a free lock never calls it; nested calls and timeout behaviour are unchanged.
- [ ] 4.7 (D) (required) A throwing OpenSpec preflight writes run start (naming invocation, harness, model and
  effort), the OpenSpec preflight line and a last `run end` line with `unavailable`.
- [ ] 4.8 (C) (required) Scripted runner whose product checks keep failing: the last line for the task is
  `<id> blocked: stopped at <step>` and no line contains the block reason, check output or session text.
- [ ] 4.9 (C) (required) Implementation attempt 1 fails product checks: attempt 2 implementation and its check lines
  carry `(attempt 2)`.
- [ ] 4.10 (C) (required) Documentation review requests changes once: the second documentation, commit and
  documentation review lines carry `(attempt 2)` and the first round's lines carry no suffix.
- [ ] 4.11 (C) (required) Merge stage with several stale pull request views (no-op delay) writes one mergeability wait
  line and one head wait line regardless of the number of views.
- [ ] 4.12 (C) (required) Target advanced outside scope before publish writes an `integrate` line before the merge
  commit; an unadvanced target writes none.
- [ ] 4.13 (C) (coverage-only) Leftover accepted worktree sweep writes one `run cleanup` line per swept task.
- [ ] 4.14 (B) (required) Runner Git lock contention: while `test/support/git-lock-child.ts` holds the Git lock of
  the fixture clone, a scripted run writes exactly one `<subject> git lock: waiting for the Git lock` line before
  its Git group runs and completes after the child releases; the same run with a free lock writes no such line.
- [ ] 4.15 (B) (required) Target advances during the merge stage: the task returns to publish and the repeated
  integrate, check, push, pull request and wait lines carry `(attempt 2)`; no line carries `resuming`.
- [ ] 4.16 (B) (required) A run stopped after planning was bound is resumed: no claim, worktree, investigation or
  planning lines for the task, the first task line is the implementation line with `resuming`, and no later line
  (including the acceptance pass) carries `resuming`.
- [ ] 4.17 (B) (required) The same scripted run with a capturing and a no-op step output yields identical stdout
  lines (through `main`), exit code and receipt, and no step line on stdout.
- [ ] 4.18 (A) (required) A task accepted end to end with a scripted adapter, scripted host and Git fixtures writes
  the ordered step lines of design D4 (run start, the three preflights, task steps, run end), each recorded in a
  shared event log before its step's first effect (session start, command, ledger push, host call), every line
  matching the format and at most 120 characters, no line containing `resuming`, ending with `run end` naming
  the status.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with the coverage gate at 85%.
- [ ] 5.3 Run frozen project checks through the bound implementation workflow and inspect their recorded output.

All implementation and executable validation tasks remain pending for the later bound session. This planning
session creates only the four requested OpenSpec artifacts.
