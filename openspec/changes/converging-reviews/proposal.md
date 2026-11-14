# Reviews that converge within their budget

## Why

Reviewers often report only the first problems they find, so a stage needs many rounds to converge, and a reviewer
of a later round does not know what the earlier rounds asked for. The planning stage in particular runs out of its 4
review rounds before a plan converges. The limits are fixed in code, so an owner cannot give a stage more rounds, and
a task blocked by an exhausted budget can only continue through `--retry`, which resets every count.

## What Changes

- Every planning, implementation and documentation review prompt (including the integration reviews, which share the
  implementation and documentation review text) tells the reviewer to report every finding it can find in this round,
  not only the first ones, and to report accepted only with zero findings.
- From the second review round of the planning, implementation and documentation stages, the review prompt lists the
  findings of the earlier recorded review rounds of that stage for the task and tells the reviewer to check first that
  each of them was resolved; new findings stay allowed.
- New optional invocation setting `budgets`: `budgets.<stage>.reviews` and `budgets.<stage>.checks` for `plan`, `work`
  and `document` (no `budgets.document.checks`), each an integer from 1 through 12. An invalid value is refused at
  startup with exit code 4, reason `invalid-budget` and diagnostics naming the field. `budgets` is not part of the
  invocation identity.
- **BREAKING (default)**: without a setting the planning stage allows 6 review rounds instead of 4; every other limit
  stays (4 implementation and documentation review rounds, 4 planning and implementation check attempts, 0
  documentation check attempts).
- A task blocked by an exhausted budget resumes on a restart without `--retry` when the limit configured for that
  restart is above its used count. `--retry` still grants a fresh budget. Blocked entries, private reasons and public
  blockers report the limit in force when the task was blocked.
- README documents all of the above.

## Capabilities

### New Capabilities

- `converging-review-prompts`: the exhaustive review instruction and the earlier findings in later review rounds.

### Modified Capabilities

- `review-budgets`: configurable per-stage limits, the new planning default, resumption after a raised limit and the
  `invalid-budget` refusal.

## Impact

- `src/model.ts`: `BudgetLimits`, `DEFAULT_BUDGETS`, `RunConfig.budgets`, `resolveBudgets`, validation in
  `validateConfig`.
- `src/runner.ts`: review prompt builders, earlier findings, limits read from the resolved budgets, early refusal.
- `test/review-budgets.test.ts`, new `test/converging-reviews.test.ts`.
- `README.md`.
- No change to the invocation identity schema, the state layout or the receipt layout.
