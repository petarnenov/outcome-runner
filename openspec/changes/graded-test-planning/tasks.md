# Implementation Tasks

All product work below is deferred until specification binding. Product scope: src/, test/ and README.md only.
Dependencies: OR-2, OR-5.

## 1. Prompt instructions

- [x] 1.1 Add `src/test-grading.ts` with pure functions returning the plan, planning review, work and implementation
  review graded test instructions for a given coverage threshold; each names the threshold as `<n>%`, uses the scale
  `A (most complex), B, C, D, E (easiest)`, the marks `(required)` and `(coverage-only)`, and the note
  `not needed: coverage reached` where applicable.
- [x] 1.2 Append the plan fragment to the plan session prompt and the planning review fragment to the plan-stage
  review prompt in `src/runner.ts`.
- [x] 1.3 Replace the work suffix sentence `Implement all approved OpenSpec scenarios and tests within product scope.`
  with `Implement all approved OpenSpec scenarios and every test marked (required) within product scope; write
  (coverage-only) tests only as the graded test rules below allow.`, then append the work fragment (including the
  precedence: required tests are always written; only coverage-only tests stop at the threshold).
- [x] 1.4 Append the implementation review fragment to the work-stage review prompt, keeping the existing completion
  summary and grade request.
- [x] 1.5 Compute fragments from the frozen `config.coverage` on every attempt so retries and resumed work keep the
  same instructions; keep the common-prefix threshold statement for all purposes.

## 2. Documentation

- [x] 2.1 Describe the graded test workflow in README: A–E grades, E-to-A test section, `(required)` versus
  `(coverage-only)` marks, grade-by-grade writing with run_checks until the coverage gate passes at the resolved
  threshold, required tests always written, the `not needed: coverage reached` note and the planning and
  implementation review rules.

## 3. Tests (graded, listed from E to A)

Write grade by grade starting with E and call run_checks after each grade. Tests marked (required) are demanded by
the source criteria or spec scenarios and are always written, whatever the coverage. Only (coverage-only) tests stop
once the coverage gate passes at the resolved threshold; leave those unchecked with the note
`not needed: coverage reached`.

All tests live in `test/test-grading.test.ts`. Both coverage-only tests were also written; the full suite passed the
coverage gate with every planned test present.

- [x] 3.1 [E] (coverage-only) Unit: each fragment function called with 90 contains `90%`, and with 85 contains `85%`.
- [x] 3.2 [E] (required) Scripted-adapter run with coverage 90: the captured plan prompt requires a tasks.md test
  section, a grade A (most complex) to E (easiest) per planned test, listing from E to A, the `(required)` and
  `(coverage-only)` marks, and states `90%`.
- [x] 3.3 [D] (required) Scripted-adapter run with coverage 90: the captured planning review prompt requires
  changes-required for a missing grade, for tests not listed from E to A and for a criterion-demanded test not marked
  `(required)`; it states `90%` and lacks the implementation review coverage gate rule.
- [x] 3.4 [D] (required) Scripted-adapter run with coverage 90: the captured work prompt requires starting with E,
  run_checks after each grade, continuing to the next harder grade until the gate passes at `90%`, always writing
  `(required)` tests and the `not needed: coverage reached` note for unwritten coverage-only grades; it does not
  contain the unqualified sentence `Implement all approved OpenSpec scenarios and tests`.
- [x] 3.5 [C] (required) Scripted-adapter run with coverage 90: the captured implementation review prompt requires
  changes-required when the gate did not pass at `90%`, when a harder grade was written while an easier grade is
  unchecked without the note, and when a `(required)` test is unwritten or carries the note; it still requests
  completion.summary and completion.grade.
- [x] 3.6 [C] (coverage-only) Unit: fragment functions are deterministic for the same coverage and each mentions no
  percentage other than the given threshold.
- [x] 3.7 [B] (required) Scripted-adapter runs with default and non-default coverage: every captured worker prompt,
  including investigation, states `85%` by default, and with coverage 90 states `90%` and none states `85%` as the
  threshold.
- [x] 3.8 [A] (required) Scripted-adapter run with a planning review changes-required round and a failed first work
  attempt: retried plan and work prompts keep the same instructions and percentage.

## 4. Validation

- [x] 4.1 Run npm run typecheck and npm test after binding through run_checks; inspect the checks context output and
  resolve failures within scope.
