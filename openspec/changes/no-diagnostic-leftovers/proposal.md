# Proposal: No temporary diagnostic files in published work

## Why

Workers sometimes create scratch or diagnostic files while they investigate a failure (for example a temporary debug
test) and leave them behind. Such a file was published to the target as `test/zz-debug-capture.test.ts`. Nothing in
the worker or implementation review prompts asks for these files to be removed or rejected, so they can reach the
pull request and the target branch.

## What Changes

- The implementation (work) session prompt tells the worker to delete, with the `delete_file` operation, every scratch
  or diagnostic file it created before it finishes, and to keep only files the task needs.
- The implementation review prompt (used after the work stage and after an integration) tells the reviewer to report
  `changes-required` when the task's changes contain files that only served diagnosis, such as temporary debug tests,
  and to name each such file in its findings.
- A rejecting review that names a leftover file sends the task back to the worker through the existing findings loop;
  no new runner state is needed.
- `test/zz-debug-capture.test.ts` is removed from the target. Its only content, a check that README.md documents the
  OpenSpec preflight, is moved unchanged into `test/openspec-preflight.test.ts` so no coverage of the README is lost.
  No test or product code imports or references the file. No other leftover diagnostic file exists in `src` or `test`.
- README.md mentions that workers delete their scratch and diagnostic files and that the implementation review rejects
  leftover ones.

## Capabilities

### New Capabilities

- `diagnostic-leftovers`: worker and implementation review instructions about scratch and diagnostic files, and the
  absence of such files on the target.

## Impact

- `src/runner.ts`: two exported prompt fragments, appended to the work prompt and to `implementationReview`.
- `test/zz-debug-capture.test.ts` deleted; its README check moved to `test/openspec-preflight.test.ts`.
- New `test/diagnostic-leftovers.test.ts` using scripted adapters.
- README.md: one short paragraph.
- No change to state, receipts, budgets or the CLI.
