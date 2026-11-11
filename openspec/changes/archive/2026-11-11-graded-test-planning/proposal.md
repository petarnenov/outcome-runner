# Graded test planning up to the coverage threshold

## Why

Workers currently plan and write tests without any ordering, so sessions often start with the most complex
integration tests and keep writing tests after the coverage gate already passes. The runner already resolves a
coverage threshold (OR-2) and freezes it per invocation, and the implementation review already grades whole-task
complexity on an A–E scale (OR-5). Using the same A–E scale for individual planned tests lets workers write the
easiest tests first and stop writing extra coverage tests as soon as the coverage gate passes at the resolved
threshold, while tests demanded by the source criteria or spec scenarios are always written.

## What Changes

- The plan session prompt requires tasks.md to contain a test section where every planned test carries a
  complexity grade from A (most complex) to E (easiest), listed from E to A, and is marked `(required)` when a source
  criterion or spec scenario demands it, otherwise `(coverage-only)`.
- The planning review prompt requires changes-required when a planned test lacks a grade, the tests are not listed
  from E to A, or a criterion-demanded test is not marked `(required)`.
- The work session prompt requires writing tests grade by grade starting with E, calling run_checks after each
  grade and continuing with the next harder grade until the coverage gate passes at the resolved threshold.
  Required tests are always written; coverage-only grades left unwritten because the threshold was reached stay
  unchecked in tasks.md with the note `not needed: coverage reached`. The existing sentence
  `Implement all approved OpenSpec scenarios and tests within product scope.` is reworded so it no longer demands
  every test unconditionally.
- The implementation review prompt requires changes-required when the coverage gate did not pass at the resolved
  threshold, when a harder grade was written while an easier planned grade is still unchecked without that note, or
  when a required test is unwritten or carries that note.
- All prompts keep stating the resolved coverage threshold as a percentage, and the graded instructions themselves
  name that percentage.
- Tests assert the four prompts contain these instructions and the resolved threshold, using scripted adapters only.
- README describes the graded test workflow.

## Capabilities

### New Capabilities

- `graded-test-planning`: graded test planning, grade-ordered test writing up to the coverage threshold with
  mandatory criterion-demanded tests, and the matching planning and implementation review rules in worker prompts.

### Modified Capabilities

- None. The existing coverage threshold prompt statement (OR-2) and completion grade (OR-5) stay unchanged.

## Impact

- Product scope: `src/` (worker prompt text in the runner, a small prompt-fragment module), `test/` and
  `README.md`.
- No change to the invocation schema, frozen identity, check execution, report schema or receipts.
- Dependencies: OR-2 (resolved coverage threshold) and OR-5 (A–E complexity scale).
