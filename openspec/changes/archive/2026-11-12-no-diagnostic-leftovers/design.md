# Design: No temporary diagnostic files in published work

## Context

`src/runner.ts` builds the implementation session prompt inline in the `work` stage loop and the implementation review
prompt with `implementationReview(coverage)`, which is shared by the work stage review and the integration review.
A rejecting implementation review stores its findings, and the next implementation session receives them through
`Address private findings: [...]`. Work sessions may already call `delete_file` inside the task scopes (the common
session preamble documents it). `commit` stages deletions because it runs `git add -- <scopes>` on present or tracked
paths.

`test/zz-debug-capture.test.ts` is a leftover of a diagnostic step from OR-3. Its only test checks that README.md
documents the OpenSpec preflight; no other file imports or references it.

## Decisions

1. **Two exported prompt fragments in `src/runner.ts`.**
   - `LEFTOVER_FILES_WORK = 'Before finishing, delete with delete_file every scratch or diagnostic file you created ' +
     'during this task, such as temporary debug tests, captures or notes; keep only files the task needs.'`
   - `LEFTOVER_FILES_REVIEW = 'Report changes-required when the task changes contain a file that only served ' +
     'diagnosis, such as a temporary debug test, capture or scratch file, and name each such file by path in findings.'`
   The work prompt appends `LEFTOVER_FILES_WORK` after `Preserve bound specs.` and before `Address private findings`,
   so retries keep identical instructions. `implementationReview(coverage)` appends `LEFTOVER_FILES_REVIEW` before the
   graded test instructions, so the integration review gets it too. Exporting them lets tests assert the exact text
   without copying it. Planning, investigation and documentation prompts are unchanged. Neither fragment contains a
   percentage, so the existing threshold tests in `test/test-grading.test.ts` keep passing.
2. **No new runner mechanism.** A review that names a leftover file is an ordinary `changes-required` review: its
   findings are saved and the next implementation session receives them, counted by the existing review budget. The
   runner does not detect leftover files itself; deciding what "only served diagnosis" means is left to the reviewer.
3. **Remove `test/zz-debug-capture.test.ts` without losing coverage.** The README preflight test moves verbatim (same
   name and assertions) to the end of `test/openspec-preflight.test.ts`, which already covers the preflight and
   already imports `readFileSync`; then the work session deletes `test/zz-debug-capture.test.ts` with `delete_file`.
   Before deleting, the worker confirms that no file in `src`, `test`, `scripts`, `bin` or `package.json` references
   `zz-debug-capture`, and scans the `src` and `test` file lists for other files that only served diagnosis. The
   current listing has none; any found later with no dependants is deleted the same way and named in the session
   report.
4. **README.** One short paragraph in the section that describes the implementation stage and review: workers delete
   their scratch and diagnostic files with `delete_file`, and the implementation review rejects leftover diagnostic
   files and names them in its findings.

## Testing approach

New `test/diagnostic-leftovers.test.ts` uses `runnerFixture` from `test/support/runner-fixture.ts` (with `ids: ['A']`)
and a scripted adapter that wraps `scriptedWorker` and records every prompt. For the send-back scenario the wrapper:
- in the first implementation session (prompt contains `Implement all approved` and no leftover finding) also writes
  `src/a/debug-capture.test.mjs` with a passing assertion, so checks still pass;
- makes the first implementation review (`Review actual implementation`) report `changes-required` with the finding
  `Remove leftover diagnostic file src/a/debug-capture.test.mjs`;
- in the next implementation session, when the prompt contains that finding, reads the file and deletes it with
  `delete_file` and its `hash`;
- accepts every later review.
No real harness runs.

## Risks

- A reviewer might over-reject legitimate test helpers. The fragment says "only served diagnosis", so files the task
  needs are not affected.
- Prompt length grows slightly; the prompt limit applies only to the task source, so it is unaffected.
