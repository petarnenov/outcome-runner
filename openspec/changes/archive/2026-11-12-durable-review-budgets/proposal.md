# Durable review round budgets

## Why

The planning and implementation stages loop `for (attempt = 0; attempt < 4; ...)` in memory, so every restart of an
invocation silently grants four new rounds. A failing planning check or product check uses up one of those rounds
as if a review had rejected the work, and the blocked reason (`Planning review remains unresolved`,
`Implementation checks or review remain unresolved`) does not say whether reviews or checks ran out or how much was
used. The owner has no explicit way to grant a blocked task another budget.

## What Changes

- Every task records a durable `budget` in its work state: review rounds used for the planning, implementation and
  documentation stages, and failing check runs used for the planning check and the product checks. A restart
  continues from the recorded counts. State written before this change derives the review counts from the recorded
  reviews, so an upgrade never grants new rounds.
- Review rounds and check attempts are separate budgets: a failing planning check or product check gives the worker
  another fix session and consumes only a check attempt, never a review round. A review round is consumed when its
  review session starts.
- When a budget runs out the task is blocked with a private reason that names the stage, the exhausted budget
  (`reviews` or `checks`) and the used and allowed counts of both. The public blocker uses the reason
  `review-budget-exhausted` or `check-budget-exhausted` with a `budget` object; other blocked entries keep
  `operation-incomplete`.
- A blocked task gets a fresh budget only when the owner restarts with `--retry <task id>`. The retry is recorded in
  `state.json` (on the task's work and in `retries` of the state) and listed in the task's receipt as `retries`. A
  `--retry` for a task that is not blocked is refused with exit code 4 and reason `retry-not-blocked`.
- README documents the budgets, the blocked reasons and `--retry`.

## Capabilities

### New Capabilities

- `review-budgets`: durable per-task review and check budgets, the budget-exhausted blocked reasons and blockers,
  and the owner's `--retry`.

### Modified Capabilities

- None. The new budget blocker reasons are specified in `review-budgets`; the existing `unfinished-results`
  requirements stay valid for every other blocked task.

## Impact

- `src/model.ts` (budget and retry types on `Work`), `src/run-store.ts` (`BlockedEntry.budget`, `RunState.retries`),
  `src/runner.ts` (stage loops, blocking, retry, receipt, `explainUnfinished`), `src/cli.ts` (`--retry` parsing),
  `src/git.ts` (`Receipt.retries`).
- New tests under `test/` with scripted adapters; README section on budgets and `--retry`.
- The invocation identity is unchanged: `--retry` is an operational option, never frozen.
