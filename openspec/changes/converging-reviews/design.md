# Design: reviews that converge within their budget

## Context

`src/runner.ts` builds three review prompts: the planning review (inline in the `plan` stage loop), the
implementation review (`implementationReview(coverage)`, used by the `work` stage and by the integration review) and
the documentation review (`DOCUMENTATION_REVIEW`, used by the `document-review` stage and by the integration
documentation review). The durable budget (`Work.budget`, `budgetOf`, `guardRound`, `countReview`, `countCheck`,
`afterRejection`, `budgetExhaustion`, `BudgetExhausted`) reads the fixed limits `REVIEW_ROUNDS = 4` and
`CHECK_ATTEMPTS = { plan: 4, work: 4, document: 0 }`. Review records of each stage are kept in `planningReviews`,
`reviews` and `documentationReviews`.

The operational setting `pollSeconds` already shows the pattern for a validated setting that is not part of the
identity: `resolvePollSeconds` throws an error with `reason` and `details`, `runSteps` calls it before the OpenSpec
preflight, and `reportFailure` in `src/cli.ts` prints the reason (exit code 4) and writes `details` to the private
diagnostics file.

## Goals / Non-Goals

Goals: exhaustive reviews, earlier findings from the second round, configurable limits, a planning default of 6,
resumption after a raised limit, and README coverage. Non-goals: a new identity schema, new CLI flags for budgets,
changing the retry record layout, earlier findings in the integration reviews.

## Decisions

### 1. Exhaustive review instruction

Export `EXHAUSTIVE_REVIEW` from `src/runner.ts`:

`Report every finding you can find in this round, not only the first ones, so that the next round can address them
all; report accepted only with zero findings.`

It is appended to the planning review prompt, to `implementationReview` and to the documentation review text, so the
integration reviews, which reuse those texts, carry it too. The existing sentences stay, so existing prompt matchers
(`Review planning artifacts`, `Review actual implementation`, `Review the documentation`) keep working.

The three prompts become exported pure builders so the instruction and the earlier findings can be unit tested:
`planningReviewPrompt(coverage, earlier)`, `implementationReviewPrompt(coverage, earlier)` (replacing
`implementationReview`) and `documentationReviewPrompt(earlier)` (replacing `DOCUMENTATION_REVIEW`). `earlier` is a
`ReviewRecord[]`, empty by default.

### 2. Earlier findings

Export `earlierFindingsPrompt(reviews: Pick<ReviewRecord, 'findings'>[]): string`. It returns `''` for an empty list,
otherwise:

`Findings reported by the earlier review rounds of this stage: <JSON>. Check first that each of them was resolved and
report every one that was not resolved; you may also report new findings.`

where `<JSON>` is `JSON.stringify` of `[{ round: 1, findings: [...] }, { round: 2, findings: [...] }, ...]` in
recorded order (round = 1-based position in the record list). The earlier rounds of a stage are the review records
of that stage recorded for the task before the review being started: `planningReviews` for the planning review,
`reviews` for the `work` stage implementation review and `documentationReviews` for the `document-review` stage. The
first review round of a stage has no records and therefore no earlier findings text. A review session that failed
before reporting has no record and contributes nothing. Records from before an owner retry stay earlier rounds of the
stage, because they are findings the task was asked to resolve.

Integration reviews pass no earlier records: they are the `integrate` stage, whose single send-back already carries
the findings, and the criterion names the planning, implementation and documentation stages.

### 3. Budget limits and the `budgets` setting

`src/model.ts` adds:

- `type BudgetLimits = Record<BudgetStage, StageBudget>` (limits use the same shape as used counts).
- `type BudgetSettings = Partial<Record<'plan' | 'work', Partial<StageBudget>>> & { document?: { reviews?: number } }`
  and `RunConfig.budgets?: BudgetSettings`, documented as operational and not part of the identity.
- `DEFAULT_BUDGETS: Readonly<BudgetLimits> = { plan: { reviews: 6, checks: 4 }, work: { reviews: 4, checks: 4 },
  document: { reviews: 4, checks: 0 } }` (frozen deeply).
- `resolveBudgets(value: unknown): BudgetLimits`: `undefined` returns a copy of the defaults. Otherwise, in this
  order, the first violation throws `Object.assign(new Error('Invalid <field>: expected ...'), { reason:
  'invalid-budget', details: { setting: <field>, value } })`:
  - `budgets` that is not a plain object (null, array, primitive) -> field `budgets`;
  - a key other than `plan`, `work`, `document` -> field `budgets.<key>`;
  - a stage value that is not a plain object -> field `budgets.<stage>`;
  - a stage key other than `reviews` and `checks`, or `checks` under `document` -> field `budgets.<stage>.<key>`;
  - a value that is not a safe integer from 1 through 12 -> field `budgets.<stage>.<key>`.
  Given values replace the defaults; omitted ones keep them.

`validateConfig` calls `resolveBudgets(config.budgets)`. `runSteps` calls it right after `resolvePollSeconds`, before
the OpenSpec preflight, so an invalid value is refused before any preflight, lock, state, ownership file, claim,
worktree or session. The CLI needs no change: `reportFailure` already prints the `reason` with exit code 4 and keeps
`details` (naming the field) in the diagnostics file.

`invocationIdentity` projects only the listed fields, so `budgets` never enters the identity; a restart with changed
budgets is `same` and is never refused as incompatible. The identity schema stays 2.

### 4. Limits in the runner

`runSteps` keeps `const limits = resolveBudgets(requested.budgets)`. `guardRound`, `countReview`, `countCheck`,
`afterRejection` and `budgetExhaustion` read `limits[stage].reviews` and `limits[stage].checks` instead of the
constants. `budgetExhaustion(budget, stage, exhausted, limits = DEFAULT_BUDGETS)` gets the limits as a parameter, so
the blocked entry, the private reason (`budgetMessage`) and the public blocker carry the limit in force for the run
that blocked the task. The documentation check limit stays 0 and is never checked (guardRound already skips a zero
check limit).

`REVIEW_ROUNDS` (4) and `CHECK_ATTEMPTS` stay exported for compatibility, now documented as the implementation and
documentation review default and the check defaults; the planning default is `DEFAULT_BUDGETS.plan.reviews` (6).

### 5. Resumption after a raised limit

No new state is needed. A restart moves blocked work back to recovery as today; the stage loop calls `guardRound`
with the limits of the restart. When the used count is below the configured limit the round starts (the next
worker session of the stage, with the recorded findings), so the task resumes without `--retry` and without a retry
record, keeping its used counts. When the used count is not below the limit, the task blocks again before any session
with a `BudgetExhausted` naming the limits of the restart. `--retry` keeps its behaviour: it resets the used counts to
zero and records the previous budget and the exhausted budget (with the limits in force when it was blocked).

`retry-not-blocked` validation is unchanged.

### 6. README

The review and check budget section states the exhaustive instruction, the earlier findings from the second round,
the `budgets` setting with an example, its range, the `invalid-budget` refusal (added to the exit code 4 reasons),
that it is not part of the identity, the defaults table (planning 6 review rounds), and that a restart with a raised
limit resumes an exhausted task without `--retry`.

## Risks / Trade-offs

- Longer review prompts on later rounds; bounded by at most 12 rounds of findings per stage.
- Lowering a limit below a used count blocks a task again on restart; the blocker shows `used` above `limit`, which
  is accurate and documented.
- Existing test 5.13 (count kept across a restart) expected a planning block after 4 rounds; it is updated to the new
  default of 6.
