# Design: durable review round budgets

## Context

`runSteps` in `src/runner.ts` runs the `plan` and `work` stages in `for (let attempt = 0; attempt < 4; ...)` loops.
The counter lives only in memory, so every process start grants four new iterations. A failing `packet()` or
`project.planningCheck`, and a failing `project.checks` run in the `work` stage, `continue` the same loop and so
consume an iteration that is otherwise a review round. The documentation stage already counts durably
(`documentationReviews.length >= DOCUMENTATION_ROUNDS`). On start, `store.update({ blocked: {} })` moves every
blocked task back into recovery, so a blocked task is resumed by any restart.

## Goals / Non-goals

- Goals: durable per-task counts for planning, implementation and documentation review rounds; a separate check
  budget for the planning check and the product checks of the `work` stage; a blocked reason naming the exhausted
  budget and the counts; an explicit owner `--retry <task id>` as the only way to get a fresh budget, recorded in
  state and receipt.
- Non-goals: budgets for the `integrate` stage (its review and checks keep blocking on the first failure), for the
  final checks, for the investigation session, and for `run_checks` calls a worker makes inside its own session
  (those are the worker's tool use, not a runner check attempt). The invocation identity does not change.

## Decisions

### 1. Budget record

`src/model.ts` adds:

```ts
export type BudgetStage = 'plan' | 'work' | 'document';
export interface StageBudget { reviews: number; checks: number }
export type TaskBudget = Record<BudgetStage, StageBudget>;
export interface BudgetUse { used: number; limit: number }
export interface BudgetExhaustion { stage: BudgetStage; exhausted: 'reviews' | 'checks';
  reviews: BudgetUse; checks: BudgetUse }
export interface RetryRecord { task: string; at: string; stage: Stage; previous: TaskBudget;
  exhausted?: BudgetExhaustion }
```

`Work` gains `budget?: TaskBudget` (the used counts) and `retries?: RetryRecord[]`. The limits are exported
constants of `src/runner.ts`: `REVIEW_ROUNDS = 4` for every budget stage (it replaces `DOCUMENTATION_ROUNDS`) and
`CHECK_ATTEMPTS = { plan: 4, work: 4, document: 0 }`. The documentation stage runs no checks, so its check limit is
0 and it can never exhaust checks.

### 2. Legacy initialisation

The exported pure function `budgetOf(work)` returns `work.budget` when present. Otherwise it derives the used counts
from durable history: `plan.reviews = planningReviews.length`, `work.reviews = reviews.length`,
`document.reviews = documentationReviews.length`, and every `checks` count 0 (failed check runs were not recorded
before). The budget stages all precede the `integrate` stage, and integration never returns to them, so integration
reviews never affect a budget that is still in use. The runner saves the budget the first time it enters a budget
stage, so an upgraded runner never grants new review rounds.

### 3. Counting

- A review round is consumed when its review session is about to start: the incremented `budget.<stage>.reviews` is
  saved before `session(...)` is called, so a crash or a failing review session still uses the round.
- A check attempt is consumed when a runner check run of the stage fails: `packet()` or `project.planningCheck` in
  `plan`, `project.checks` in `work`. The incremented `budget.<stage>.checks` is saved together with the failure
  `findings`. A failing check never touches the review count.
- The worker session that follows a failure is the fix attempt; the stage loops become `for (;;)` and are bounded
  only by the two budgets.

### 4. Exhaustion

`BudgetExhausted extends Error` (exported) carries a `BudgetExhaustion`. The runner throws it

- at the top of every round of `plan`, `work` and `document`, before any session starts, when
  `reviews.used >= REVIEW_ROUNDS` (exhausted `reviews`) or else `checks.used >= limit` for a stage with a nonzero
  check limit (exhausted `checks`); so a restart of an exhausted task blocks again without starting a session;
- immediately before every review session of every budget stage, before the round is counted, when
  `reviews.used >= REVIEW_ROUNDS` (exhausted `reviews`). This guard matters in particular for the documentation
  loop: a run that resumes with stage `document-review` skips the `document` branch and goes straight to the review
  branch, so the top-of-round check alone would not run there. The guard in the `document-review` branch (and the
  same guard before the planning and implementation review sessions) makes a restart after a crashed fourth review
  session block without starting a fifth review and without raising the count above `REVIEW_ROUNDS`;
- right after a failing check run raises `checks.used` to its limit (exhausted `checks`);
- right after a review that is not accepted with zero findings when `reviews.used` has reached `REVIEW_ROUNDS`
  (exhausted `reviews`).

The exported pure function `budgetMessage(exhaustion)` gives
`<Stage> <review|check> budget exhausted: <r> of <R> review rounds and <c> of <C> check attempts used`, for example
`Implementation review budget exhausted: 4 of 4 review rounds and 1 of 4 check attempts used` (stage names
`Planning`, `Implementation`, `Documentation`). The catch block of the task stores the message as the private
`reason` and the exhaustion as `budget` of the `BlockedEntry` (`src/run-store.ts` adds `budget?: BudgetExhaustion`),
like `paths` of an integration failure.

### 5. Public blocker

`explainUnfinished` maps a blocked entry with `budget` to `kind` `blocked`, `reason` `review-budget-exhausted` or
`check-budget-exhausted` (from `budget.exhausted`), its `stage`, `diagnostics` and a copy of `budget`. `Blocker`
gains `budget?: BudgetExhaustion`. Integration reasons and `operation-incomplete` are unchanged for other blocks.

### 6. `--retry <task id>`

- CLI: `parseFlags` accepts `--retry` followed by a separate task id argument, repeatable for different ids, and
  returns them as `retry: string[]`. A missing id, an id beginning with `-`, a repeated id or `--retry=<id>` is
  refused like any invalid flag (exit 4). `main` passes `retry` in `RunOptions`; it is not written into the config,
  so it never enters the identity.
- Runner: `RunOptions.retry?: string[]`. After the store is opened and the disposed check, and before the settings,
  ownership file, claims or any session, every retry id must be a task of the invocation with an entry in
  `store.state.blocked`. Otherwise the run is refused with `reason: 'retry-not-blocked'` and
  `details: { tasks: [...] }` (exit 4), and no budget, blocked entry or retry record is changed.
- For each valid id, in one `store.update` before recovery is built: the blocked entry's work gets a zeroed
  `budget` and an appended `RetryRecord { task, at: now(), stage: work.stage, previous: budgetOf(work),
  exhausted: entry.budget }`, and the same record is appended to `RunState.retries`. Recovery then resumes the task
  as before. A retried task that is accepted is no longer blocked, so a later `--retry` of it is refused with
  `retry-not-blocked` and adds no record.
- Without `--retry`, recovery still resumes blocked tasks (a failed session or acceptance recording is retried as
  today) but keeps their budgets, so an exhausted task blocks again at once (decision 4).

### 7. Receipt

The receipt gains `retries: structuredClone(work.retries)` when the task has at least one retry; receipts of tasks
without a retry have no such field (like `invocationChanges`). `Receipt` in `src/git.ts` gains
`retries?: RetryRecord[]`. `receiptAt` ignores unknown fields, so such receipts stay valid.

## Risks / Trade-offs

- Counting a review round at session start means a harness crash during review uses a round; this is the
  conservative reading of "never grant new rounds silently".
- Legacy state has no failed-check history, so its check counts start at 0; an upgrade grants at most one check
  budget and never review rounds.
