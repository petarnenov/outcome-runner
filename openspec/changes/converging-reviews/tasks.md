# Tasks

## 1. Model

- [x] 1.1 Add `BudgetLimits`, `BudgetSettings`, `RunConfig.budgets?` (documented as operational, not in the
  identity), the deeply frozen `DEFAULT_BUDGETS` (`plan` 6/4, `work` 4/4, `document` 4/0) and `resolveBudgets` with the
  `invalid-budget` refusal and `details: { setting, value }` to `src/model.ts` (design decision 3).
- [x] 1.2 Call `resolveBudgets(config.budgets)` in `validateConfig`.

## 2. Runner

- [x] 2.1 Export `EXHAUSTIVE_REVIEW`, `earlierFindingsPrompt`, `planningReviewPrompt(coverage, earlier)`,
  `implementationReviewPrompt(coverage, earlier)` (replacing `implementationReview`) and
  `documentationReviewPrompt(earlier)` (replacing `DOCUMENTATION_REVIEW`) from `src/runner.ts`; keep every existing
  sentence of the three prompts (decisions 1 and 2).
- [x] 2.2 Pass `activeWork().planningReviews`, `activeWork().reviews` and `activeWork().documentationReviews` as the
  earlier reviews of the planning, `work` stage implementation and `document-review` stage documentation reviews;
  the integration reviews pass none (decision 2).
- [x] 2.3 In `runSteps`, resolve `limits = resolveBudgets(requested.budgets)` right after `resolvePollSeconds`, before
  the OpenSpec preflight; make `guardRound`, `countReview`, `countCheck`, `afterRejection` and `budgetExhaustion`
  (new `limits` parameter defaulting to `DEFAULT_BUDGETS`) use the resolved limits; keep `REVIEW_ROUNDS` and
  `CHECK_ATTEMPTS` exported as defaults (decisions 4 and 5).

## 3. README

- [x] 3.1 Document the exhaustive review instruction, the earlier findings listed from the second review round of a
  stage, the `budgets` setting (fields, range 1 through 12, no `budgets.document.checks`, example, not part of the
  identity), the `invalid-budget` refusal in the exit code 4 reasons, the defaults with 6 planning review rounds, the
  resumption of an exhausted task without `--retry` after a raised limit, and that blockers report the limit in force
  (decision 6).

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Pure tests live in
`test/converging-reviews.test.ts`; runner tests live there too and use `runnerFixture`
(`test/support/runner-fixture.ts`) with the same scripted adapter pattern as `test/review-budgets.test.ts` (reviews
matched by `Review planning artifacts` / `Review actual implementation` / `Review the documentation`, rejected
reviews report `Fix <kind> <n>`, failing implementations make `checks.mjs` fail, incomplete plans omit the spec file).
Prompts are read from what the scripted adapter receives. Each test builds its own fixture; `budgets` is passed
through `f.config('one', { budgets })`. Existing test 5.13 of `test/review-budgets.test.ts` is updated in 4.14.

### Grade E

- [x] 4.1 (E) (required) `resolveBudgets(undefined)` equals `DEFAULT_BUDGETS` (`plan` `{ reviews: 6, checks: 4 }`,
  `work` `{ reviews: 4, checks: 4 }`, `document` `{ reviews: 4, checks: 0 }`) and is a copy; `{ work: { reviews: 7 } }`
  keeps every other default; the bounds 1 and 12 are accepted.
- [x] 4.2 (E) (required) Invalid budgets and budget shape refused by `resolveBudgets`: `budgets.plan.reviews` 0, 13,
  2.5, `'4'` and `null`; `budgets.document.checks` 1; `budgets.review`; `budgets.work.rounds`; `budgets.plan` `5`
  (stage value not an object, naming `budgets.plan`); `budgets` `[]` and `null`. Each throws `reason`
  `invalid-budget` with `details.setting` naming the field (`budgets` for the whole value) and `details.value` the
  value; `validateConfig` refuses the same way.
- [x] 4.3 (E) (required) Instruction in the prompt builders: `planningReviewPrompt(85, [])`,
  `implementationReviewPrompt(85, [])` and `documentationReviewPrompt([])` each contain `EXHAUSTIVE_REVIEW`, which
  contains `Report every finding you can find in this round, not only the first ones` and `report accepted only with
  zero findings`.
- [x] 4.4 (E) (required) Earlier findings text: `earlierFindingsPrompt([])` is `''`; for findings `['a']` and
  `['b', 'c']` it contains `[{"round":1,"findings":["a"]},{"round":2,"findings":["b","c"]}]`, the instruction to
  check first that each was resolved and the permission to report new findings; the three builders include it only
  when given earlier reviews.
- [x] 4.5 (E) (required) Identity without budgets: `invocationIdentity` of a configuration with `budgets` equals that
  of the same configuration without it; `budgetMessage(budgetExhaustion(budget, 'work', 'reviews', limits))` with
  `work.reviews` limit 2 gives `Implementation review budget exhausted: 2 of 2 review rounds and 0 of 4 check
  attempts used`.

### Grade D

- [x] 4.6 (D) (required) Value out of range through the CLI: `main` with an invocation file setting
  `budgets.plan.reviews` 0 returns 4, prints reason `invalid-budget`, and the diagnostics file has `details.setting`
  `budgets.plan.reviews`; `budgets.document.checks` 1 is refused the same way naming `budgets.document.checks`.
- [x] 4.7 (D) (required) Refused run leaves nothing behind: `runQueue` with `budgets.work.checks` 13 rejects with
  `invalid-budget` before the OpenSpec preflight, and no lock, `state.json`, ownership file, claim on the ledger,
  worktree or adapter prompt exists.
- [ ] 4.8 (D) (coverage-only) `main` with a spy runner passes `budgets` from the invocation file unchanged in the
  configuration. not needed: coverage reached

### Grade C

- [x] 4.9 (C) (required) Instruction in the three review prompts: an accepted run's planning review, implementation
  review and documentation review prompts each contain `EXHAUSTIVE_REVIEW`.
- [x] 4.10 (C) (required) Earlier findings: the first planning, implementation and documentation reviews each reject
  (`Fix planReview 1`, `Fix review 1`, `Fix documentReview 1`) and the second ones accept. The first review prompt of
  each stage lacks `Findings reported by the earlier review rounds of this stage`; the second review prompt of each
  stage contains it, the finding of round 1 of the same stage and no finding of another stage; the task is accepted.
- [x] 4.11 (C) (required) Plan accepted in its fifth review round: planning reviews 1 to 4 reject, the fifth accepts,
  no `budgets`; the task is accepted, five planning reviews ran and the completed work has `budget.plan.reviews` 5.
- [x] 4.12 (C) (required) Configured planning limits, each in its own fixture: `budgets.plan.reviews` 2 with every
  planning review rejecting blocks after 2 reviews with `review-budget-exhausted`, stage `plan`, `reviews`
  `{ used: 2, limit: 2 }` in blocker and blocked entry; `budgets.plan.checks` 1 with an incomplete plan blocks after 1
  planning session with `check-budget-exhausted`, `checks` `{ used: 1, limit: 1 }` and no planning review.
- [x] 4.13 (C) (required) Configured implementation limits, each in its own fixture: `budgets.work.reviews` 2 with
  every implementation review rejecting blocks after 2 reviews with the private reason `Implementation review budget
  exhausted: 2 of 2 review rounds and 0 of 4 check attempts used`; `budgets.work.checks` 2 with every implementation
  failing blocks after 2 check runs with `check-budget-exhausted`, `checks` `{ used: 2, limit: 2 }` and no review.

### Grade B

- [x] 4.14 (B) (required) Count kept across a restart (update of 5.13 in `test/review-budgets.test.ts`): planning
  reviews 1 and 2 reject and session 3 fails; the restart without `--retry` and without `budgets` starts exactly three
  more planning reviews, all rejecting; the task is blocked with `review-budget-exhausted`, `budget.plan.reviews` 6
  and `reviews` `{ used: 6, limit: 6 }`.
- [x] 4.15 (B) (required) Configured documentation review limit: `budgets.document.reviews` 1 and the documentation
  review rejects; after 1 documentation review the task is blocked with `review-budget-exhausted`, stage `document`,
  `reviews` `{ used: 1, limit: 1 }` and `checks` `{ used: 0, limit: 0 }`.
- [x] 4.16 (B) (required) Limit not raised enough: after every implementation review rejects and the task is blocked
  at 4 of 4, a restart without `--retry` with `budgets.work.reviews` 3 starts no session for the task and blocks it
  with `reviews` `{ used: 4, limit: 3 }` in the blocker and the blocked entry.

### Grade A

- [x] 4.17 (A) (required) Raised implementation review limit: after the task is blocked at 4 of 4 implementation
  reviews with default limits, a restart without `--retry` with `budgets.work.reviews` 6 (not refused as a different
  invocation) starts one new implementation session and one review, which accepts; the task is accepted, the
  completed work has `budget.work.reviews` 5, and `state.json`, the completed work and the receipt have no
  `retries`.
- [x] 4.18 (A) (required) Retry with configured limits: with `budgets.work.reviews` 2 the task is blocked after 2
  rejected implementation reviews; a restart with `retry: ['A']` and the same budgets accepts on the next review;
  the completed work has `budget.work.reviews` 1 and the retry record has `exhausted.reviews` `{ used: 2, limit: 2 }`.
- [ ] 4.19 (A) (coverage-only) Documentation resume after a raised limit: documentation reviews reject until the task
  is blocked at 4 of 4 in stage `document`; a restart with `budgets.document.reviews` 5 starts one documentation and
  one documentation review session, whose prompt lists the four earlier documentation findings, and the task is
  accepted. not needed: coverage reached

## 5. Verification after binding

- [x] 5.1 Run `npm run typecheck`.
- [x] 5.2 Run `npm test` with the coverage gate at 85%.
