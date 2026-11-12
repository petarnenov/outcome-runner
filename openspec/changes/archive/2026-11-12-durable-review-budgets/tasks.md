# Tasks

## 1. Model and state

- [x] 1.1 Add `BudgetStage`, `StageBudget`, `TaskBudget`, `BudgetUse`, `BudgetExhaustion` and `RetryRecord` to
  `src/model.ts`, and `budget?: TaskBudget` and `retries?: RetryRecord[]` to `Work` (design decision 1).
- [x] 1.2 Add `budget?: BudgetExhaustion` to `BlockedEntry` and `retries?: RetryRecord[]` to `RunState` in
  `src/run-store.ts`; add `retries?: RetryRecord[]` to `Receipt` in `src/git.ts` (decisions 4, 6 and 7).

## 2. Runner budgets

- [x] 2.1 Export `REVIEW_ROUNDS = 4` (replacing `DOCUMENTATION_ROUNDS`) and `CHECK_ATTEMPTS = { plan: 4, work: 4,
  document: 0 }`, the pure `budgetOf(work)` with the legacy derivation (decision 2), the pure
  `budgetMessage(exhaustion)` (decision 4) and the `BudgetExhausted` error class from `src/runner.ts`.
- [x] 2.2 Rewrite the `plan` and `work` stage loops as `for (;;)` bounded only by the budgets: check exhaustion at the
  top of every round before any session; immediately before each review session throw `BudgetExhausted`
  (exhausted `reviews`) when `reviews.used >= REVIEW_ROUNDS`, otherwise save the incremented review count and start
  the review; on a failing `packet()` / `planningCheck` or `project.checks` save the incremented check count with the
  findings and throw `BudgetExhausted` when it reaches the limit, otherwise start the next fix session; after a
  rejecting review throw `BudgetExhausted` when the review count reached `REVIEW_ROUNDS` (decision 3 and 4).
- [x] 2.3 Count documentation review rounds in `budget.document.reviews` (saved before the documentation review
  session) instead of `documentationReviews.length`. Check exhaustion before each documentation (`document`) session
  and also in the `document-review` branch right before the documentation review session: when
  `budget.document.reviews >= REVIEW_ROUNDS` throw `BudgetExhausted` (stage `document`, exhausted `reviews`)
  without starting a session and without incrementing the count. This covers a run that resumes with stage
  `document-review` and skips the `document` branch (decision 4).
- [x] 2.4 In the task catch block store `budget` of a `BudgetExhausted` beside the reason in the blocked entry, and in
  `explainUnfinished` map such an entry to `review-budget-exhausted` / `check-budget-exhausted` with a copy of
  `budget`; add `budget?: BudgetExhaustion` to `Blocker` (decision 5).

## 3. Retry

- [x] 3.1 `parseFlags` in `src/cli.ts`: accept `--retry <task id>` (separate argument, repeatable for distinct ids),
  refuse a missing id, an id beginning with `-`, a repeated id and `--retry=<id>`; update the flag error message.
  `main` passes `retry` in `RunOptions` without changing the config (decision 6).
- [x] 3.2 `RunOptions.retry?: string[]`; after the disposed check validate every id against the invocation's tasks
  and `store.state.blocked`, refusing with `reason: 'retry-not-blocked'` and `details: { tasks }` before settings,
  ownership file, claims or sessions; then, in one `store.update` before recovery, zero the budget, append the
  `RetryRecord` to the work's `retries` and to `RunState.retries` (decision 6).
- [x] 3.3 Write `retries` into the receipt when the task has at least one retry (decision 7).

## 4. README

- [x] 4.1 Document the review budget (4 review rounds each for planning, implementation and documentation, counted
  when the review starts and kept across restarts), the check budget (4 failing planning check runs and 4 failing
  product check runs, never consuming review rounds; worker `run_checks` calls do not count), the private blocked
  reason and the public `review-budget-exhausted` / `check-budget-exhausted` blockers with `budget` (add them to the
  Unfinished results table), that a restart without `--retry` keeps the counts, and `--retry <task id>` (syntax in
  Start and resume, fresh budget, `retries` in `state.json` and in the receipt, refusal `retry-not-blocked` in the exit
  code 4 reasons).

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Runner tests live in
`test/review-budgets.test.ts` and use `runnerFixture` (`test/support/runner-fixture.ts`) with scripted adapters
wrapping `scriptedWorker`: a scripted reviewer returns `changes-required` with a finding for chosen review numbers
(matched by `Review planning artifacts` / `Review actual implementation` / `Review the documentation`), a scripted
implementer writes a `result.mjs` whose `next(1) !== 2` for chosen sessions so `checks.mjs` fails, a scripted
planner omits `specs/counter/spec.md` for chosen sessions so the planning check (`packet`) fails, and the `fail`
hook fails a chosen session. Session counts are taken from the prompts the adapter receives. Each numbered test that
starts "after 5.7's run" builds its own fixture and repeats the 5.7 run in it first, so tests never share state.

### Grade E

- [x] 5.1 (E) (required) `budgetMessage` gives `Implementation review budget exhausted: 4 of 4 review rounds and 0 of
  4 check attempts used` for exhausted work reviews and `Planning check budget exhausted: 1 of 4 review rounds and 4
  of 4 check attempts used` for exhausted plan checks.
- [x] 5.2 (E) (required) Legacy work state: `budgetOf` of a work without `budget` and with 2 planning reviews, 3
  reviews and 1 documentation review returns those review counts and zero check counts; with `budget` it returns it
  unchanged.
- [x] 5.3 (E) (required) `explainUnfinished` maps a blocked entry with `budget.exhausted` `reviews` to `reason`
  `review-budget-exhausted` and `checks` to `check-budget-exhausted`, copying `budget` and `stage`; an entry without
  `budget` keeps `operation-incomplete`.
- [x] 5.4 (E) (required) Invalid retry arguments: `parseFlags(['--retry', 'A', '--retry', 'B'])` returns
  `retry: ['A', 'B']`; `['--retry']`, `['--retry', '--no-mascot']`, `['--retry', 'A', '--retry', 'A']` and
  `['--retry=A']` throw.

### Grade D

- [x] 5.5 (D) (required) `main(file, runner, output, { args: ['--retry', 'A'] })` with a spy runner passes
  `retry: ['A']` in the run options and leaves the config without a retry field; an invalid `--retry` returns 4.
- [x] 5.6 (D) (required) Receipt without a retry: a task accepted by the fixture without `--retry` has a receipt
  without `retries` and work state with `budget.work.reviews` 1 and `budget.work.checks` 0.

### Grade C

- [x] 5.7 (C) (required) Reviews ran out: every implementation review rejects; after 4 implementation reviews the run
  is `incomplete`, the private reason in `state.json` is the exact message of the scenario, the blocked entry and the
  blocker carry `budget` `{ stage: 'work', exhausted: 'reviews', reviews: { used: 4, limit: 4 }, checks: { used: 0,
  limit: 4 } }` and the blocker `reason` is `review-budget-exhausted`.
- [x] 5.8 (C) (required) Checks ran out: every implementation writes a failing result; after 4 failing check runs the
  task is blocked with `check-budget-exhausted`, the scenario's message, and no implementation review session was
  started. Assert that the blocker's `budget` and the blocked entry's `budget` in `state.json` both equal
  `{ stage: 'work', exhausted: 'checks', reviews: { used: 0, limit: 4 }, checks: { used: 4, limit: 4 } }`, and that
  the work's `budget.work.checks` in `state.json` is 4.
- [x] 5.9 (C) (required) Planning check failures: the planner omits the spec file twice; `budget.plan.checks` is 2,
  `budget.plan.reviews` is 1 and the task proceeds to the work stage.
- [x] 5.10 (C) (required) Retry of a task that is not blocked: (a) `runQueue` with `retry: ['B']` where `B` has no
  blocked entry throws `reason` `retry-not-blocked` with `details.tasks` `['B']`; no claim is added to the ledger, no
  session starts and `state.json` has no `retries`; through `main` the exit code is 4 with that reason. (b) Mixed
  list, in its own fixture: after the 5.7 run leaves `A` blocked with an exhausted work budget, snapshot `A`'s
  blocked entry, its work `budget` and its (absent) `retries` from `state.json`, then run with `retry: ['A', 'B']`
  (`B` is not blocked). Assert the run is refused with `retry-not-blocked` and `details.tasks` `['B']`; `A`'s blocked
  entry, its work `budget` and its absent `retries` in `state.json` equal the snapshot, `state.json` has no
  `retries`, no claim is added to the ledger and no session starts.
- [ ] 5.11 (C) (coverage-only) Blocked by an exhausted planning budget: every planning review rejects; the blocker has
  `stage` `plan`, `reason` `review-budget-exhausted` and `budget.exhausted` `reviews`. not needed: coverage reached

### Grade B

- [x] 5.12 (B) (required) Check failures do not consume review rounds: checks fail after the first two implementation
  sessions, reviews reject three times and accept the fourth; the task is accepted after six implementation sessions,
  with `budget.work.checks` 2 and `budget.work.reviews` 4 in the completed work, and four implementation review
  sessions.
- [x] 5.13 (B) (required) Count kept across a restart: planning reviews 1 and 2 reject and planning review session 3
  fails (blocked); the second run without `--retry` starts exactly one planning review, which rejects; the task is
  blocked with `review-budget-exhausted`, `budget.plan.reviews` is 4 and four planning review sessions ran in total.
- [x] 5.14 (B) (required) Restart of an exhausted task: in its own fixture, after the 5.7 run, a second run without
  `--retry` blocks the task again with `review-budget-exhausted` and the adapter receives no prompt for that task.
- [ ] 5.15 (B) (coverage-only) Documentation budget: every documentation review rejects; after 4 documentation reviews
  the blocker has `stage` `document`, `review-budget-exhausted` and `checks` `{ used: 0, limit: 0 }`. not needed:
  coverage reached

### Grade A

- [x] 5.16 (A) (required) Retry grants one new budget, as two separate sub-cases, each in its own fixture that first
  repeats the 5.7 run so `A` is blocked with an exhausted work review budget and `state.json` has no `retries`:
  (a) `runQueue` with `retry: ['A']`; (b) `main` with `--retry A`. In each sub-case exactly one retry run is made; it
  starts a new implementation session and review that accepts; the task is accepted; `state.json` `retries` holds
  exactly one record (length 1) for `A` with `stage` `work`, `previous.work.reviews` 4 and `exhausted` equal to the
  blocked budget; the completed work's `retries` has length 1 with the same record; and the receipt on the target
  lists that single record in `retries`. Sub-case (a) then makes one more run with `retry: ['A']` and asserts it is
  refused with `retry-not-blocked` and `details.tasks` `['A']`, and that `state.json` `retries` still has length 1.
- [ ] 5.17 (A) (coverage-only) A review session that fails after it started still uses its round: the fourth
  implementation review session fails; the restarted run blocks with `review-budget-exhausted` without starting a
  review. not needed: coverage reached
- [ ] 5.18 (A) (coverage-only) Documentation review crash on the last round: documentation reviews 1 to 3 reject and
  the 4th documentation review session fails, leaving `budget.document.reviews` 4 and stage `document-review`; the
  restarted run without `--retry` blocks the task with `review-budget-exhausted` at stage `document`, the adapter
  receives no documentation or documentation review prompt in the second run, and `budget.document.reviews` in
  `state.json` is still 4. not needed: coverage reached

## 6. Verification after binding

- [x] 6.1 Run `npm run typecheck`.
- [x] 6.2 Run `npm test` with the coverage gate at 85%.
