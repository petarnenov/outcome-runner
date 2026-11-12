# Tasks

## 1. Prompts

- [ ] 1.1 Export `LEFTOVER_FILES_WORK` and `LEFTOVER_FILES_REVIEW` from `src/runner.ts` with the text of design
  decision 1.
- [ ] 1.2 Append `LEFTOVER_FILES_WORK` to the implementation session prompt after `Preserve bound specs.` and before
  `Address private findings`.
- [ ] 1.3 Append `LEFTOVER_FILES_REVIEW` inside `implementationReview(coverage)` before the graded test instructions,
  so both the work-stage review and the integration review carry it.

## 2. Leftover files on the target

- [ ] 2.1 Confirm that nothing in `src`, `test`, `scripts`, `bin` or `package.json` references `zz-debug-capture`,
  and that `src` and `test` contain no other file that only served diagnosis.
- [ ] 2.2 Move the test `README documents the OpenSpec preflight, install offer, layout creation and non-interactive
  refusals` verbatim to the end of `test/openspec-preflight.test.ts` (`readFileSync` is already imported there).
- [ ] 2.3 Delete `test/zz-debug-capture.test.ts` with `delete_file`.

## 3. README

- [ ] 3.1 Add one paragraph to README.md where the implementation stage and review are described: workers delete their
  scratch and diagnostic files with `delete_file` before finishing, and the implementation review rejects leftover
  diagnostic files such as temporary debug tests and names them in its findings.

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. New tests live in
`test/diagnostic-leftovers.test.ts` and use `runnerFixture` (`test/support/runner-fixture.ts`, `ids: ['A']`) with a
scripted adapter wrapping `scriptedWorker` that records every prompt (design, Testing approach). No real harness runs.

### Grade E

- [ ] 4.1 (E) (required) `LEFTOVER_FILES_WORK` mentions `delete_file` and scratch or diagnostic files;
  `LEFTOVER_FILES_REVIEW` mentions `changes-required`, temporary debug tests and naming each file in findings.
- [ ] 4.2 (E) (required) `test/zz-debug-capture.test.ts` does not exist (checked relative to the test file with
  `existsSync`), and the moved README preflight test in `test/openspec-preflight.test.ts` passes.

### Grade C

- [ ] 4.3 (C) (required) Scripted run of task `A` that is accepted: every recorded implementation prompt contains
  `LEFTOVER_FILES_WORK`, every implementation review prompt contains `LEFTOVER_FILES_REVIEW`, and the planning,
  investigation and documentation prompts contain neither.

### Grade B

- [ ] 4.4 (B) (required) A review naming a leftover file sends the task back: the first implementation session also
  writes `src/a/debug-capture.test.mjs`; the first implementation review reports `changes-required` with the finding
  `Remove leftover diagnostic file src/a/debug-capture.test.mjs`. Assert a second implementation session starts whose
  prompt contains that finding and `LEFTOVER_FILES_WORK` (instructions before `Address private findings` identical
  to the first attempt); it deletes the file with `delete_file`; the second review accepts; the run accepts `A`; two
  implementation and two implementation review prompts were recorded; and `git ls-tree -r --name-only origin/main` in
  the fixture has no `src/a/debug-capture.test.mjs`.

### Grade A

- [ ] 4.5 (A) (coverage-only) Integration review carries the instruction: after an in-scope target advance during
  the task, the integration's implementation review prompt contains `LEFTOVER_FILES_REVIEW`.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with the coverage gate at 85%.
