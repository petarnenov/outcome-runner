# Design: graded test planning

## Context

`runQueue` in `src/runner.ts` builds each worker prompt as a common prefix (tool rules plus
`Resolved coverage threshold: <n>%.`) followed by a purpose-specific suffix. Planning review and implementation
review both run with purpose `review`; they are distinguished only by the stage that starts them (plan stage versus
work stage). `run_checks` is available to work and review sessions after specification binding and runs all frozen
`project.checks`, including the mandatory `{coverage}` gate expanded to the resolved threshold. A failing check makes
`run_checks` return an error to the worker.

The current work suffix begins with `Implement all approved OpenSpec scenarios and tests within product scope.`
Taken literally, that sentence demands every planned test, which contradicts a rule that stops writing graded tests
once the coverage gate passes. This change must resolve that conflict explicitly.

## Goals / Non-Goals

**Goals**

- Add graded test instructions to the plan, planning review, work and implementation review prompt suffixes.
- Every graded instruction names the resolved threshold as a percentage, e.g. `90%`, in addition to the existing
  common-prefix statement, so investigation and every other prompt keep stating the threshold.
- Keep tests demanded by source criteria and spec scenarios mandatory regardless of coverage; only extra tests
  written for coverage stop at the threshold.
- Make the instructions verifiable by tests that capture prompts through a scripted adapter.

**Non-Goals**

- The controller does not parse tasks.md or enforce grade ordering itself; enforcement is through the planning and
  implementation reviewers, which already gate binding and acceptance.
- No change to the report schema, the OR-5 whole-task completion grade, check execution or frozen identity.

## Decisions

1. **Prompt fragments as pure functions.** Add a small module `src/test-grading.ts` exporting
   `planTestInstructions(coverage)`, `planningReviewTestInstructions(coverage)`, `workTestInstructions(coverage)` and
   `implementationReviewTestInstructions(coverage)` returning English sentences. `runner.ts` appends each fragment to
   the matching existing suffix. Pure functions keep the wording in one place and allow direct unit tests in
   addition to the scripted-adapter tests. Alternative (inline strings in runner.ts) was rejected because the same
   grade definitions would be duplicated across four prompts.
2. **Shared grade definition.** Each fragment states the scale as `A (most complex), B, C, D, E (easiest)`, which
   matches the OR-5 wording, and the ordering rule `listed from E to A`.
3. **Required versus coverage-only tests (precedence).** Every planned test carries a grade and one of two marks:
   `(required)` when a source criterion or spec scenario demands it, or `(coverage-only)` when it exists only to
   raise coverage. Precedence, stated in the work fragment: tests marked `(required)` are always written, whatever
   the coverage; the stop-early rule applies only to `(coverage-only)` tests. Work still proceeds grade by grade from
   E: within each grade the worker writes the required tests and, while the coverage gate has not yet passed, the
   coverage-only tests; after the gate passes at `<n>%`, remaining coverage-only tests stay unchecked with the note
   `not needed: coverage reached`, while required tests of harder grades are still written in E-to-A order.
4. **Work suffix rewording.** The existing sentence `Implement all approved OpenSpec scenarios and tests within
   product scope.` is replaced by `Implement all approved OpenSpec scenarios and every test marked (required) within
   product scope; write (coverage-only) tests only as the graded test rules below allow.` The work prompt therefore
   contains no unqualified instruction to write all tests. `Preserve bound specs.` and the findings tail stay.
5. **Required wording.** Fragments contain these literal phrases so tests can assert them:
   - plan: a test section in tasks.md; every planned test has a grade A (most complex) to E (easiest); tests listed
     from E to A; each test marked `(required)` or `(coverage-only)`.
   - planning review: report changes-required when a planned test lacks a grade, the tests are not listed from E to
     A, or a test demanded by a source criterion or spec scenario is not marked `(required)`.
   - work: write tests grade by grade starting with E; call run_checks after each grade; continue with the next
     harder grade until the coverage gate passes at `<n>%`; tests marked `(required)` are always written; leave
     unwritten coverage-only grades unchecked in tasks.md with the note `not needed: coverage reached`.
   - implementation review: report changes-required when the coverage gate did not pass at `<n>%`, when a harder
     grade was written while an easier planned grade is still unchecked without the note
     `not needed: coverage reached`, or when a `(required)` test is unwritten or carries that note.
6. **Stage selects the review fragment.** The planning review session (plan stage) gets the planning review fragment
   only; the implementation review session (work stage) gets the implementation review fragment only. Both keep
   purpose `review` and the existing accept/changes-required wording and OR-5 completion request.
7. **Retries keep the fragments.** Fragments are computed from the frozen `config.coverage` on every attempt, so
   replanning, work retries and resumed invocations receive identical instructions and percentage.

## Risks / Trade-offs

- Workers may misjudge grades or marks; reviewers check presence, order and that criterion-demanded tests are
  marked required, not the absolute correctness of each grade.
- A coverage gate that fails for unrelated reasons looks like insufficient coverage to the worker; the existing
  check output in the `checks` context section and private findings already expose the failure detail.
- Prompt length grows by a few sentences; it stays far below the 65536-character prompt limit.

## Testing Strategy

Tests use only scripted adapters (an injected `createAdapter` whose `startAction` records the prompt and calls the
`outcome_report` handler) and direct calls of the pure fragment functions. No real harness is started. A
non-default threshold (e.g. 90) proves the resolved value, not the default 85, is used. The scripted-adapter prompt
assertions are required tests and are written regardless of whether the existing suite already passes the gate.
