# Completion summary with duration and complexity grade

## Why

OR-5 makes accepted outcomes understandable from the runner's public output. Today accepted events expose only status and task ID, while the work state does not retain the claim timestamp needed to measure elapsed time across restarts. The implementation review already assesses the completed task and is the source of the change summary and complexity grade.

## What Changes

- Persist the original claim time in task work state, reusing the claim ledger timestamp on recovery.
- Add an optional structured completion to private reports, mandatory for accepted implementation reviews, with runtime validation.
- Ask the implementation reviewer for two or three English sentences and a grade for the complexity of the whole task, from A (most complex) to E (easiest).
- At receipt-confirmed target acceptance, persist a summary that appends elapsed wall-clock time and grade in one English sentence.
- Include summary, durationSeconds and grade in accepted stdout events and a final-result completions map keyed by newly accepted task ID.
- Keep receipt validation compatible and document the output and grading scale in README.
- Cover restart timing, invalid reports, public output and receipt compatibility with deterministic tests.

## Scope and Dependency

Task: OR-5; priority: 5; dependency: OR-4. OR-4's durable claim ledger is already present and supplies claimedAt. Later implementation is confined to src, test and README.md. No queue changes, receipt migrations, release changes, new dependencies or unrelated harness behavior are needed.

This session creates only proposal.md, design.md, tasks.md and specs/completion-summary/spec.md in this change directory. Product writes and checks belong to a later session after specification binding.

## Acceptance Criteria (verbatim)

- The runner records the time a task is claimed in its work state; the record survives a restart.
- The outcome_report schema gains an optional completion object with summary (string) and grade (one of A, B, C, D, E). The implementation review session must provide it whenever it reports accepted; an accepted report without a valid completion is refused like any other invalid private report.
- The review prompt explains the grade: the complexity of the whole task from A (most complex) to E (easiest), and asks for a summary of two or three English sentences describing what the task changed.
- When the task is accepted, the controller builds a completion summary of three or four English sentences: the reviewer's summary followed by one sentence stating the wall-clock time from claim to acceptance (formatted like 1h 12m 5s) and the complexity grade.
- The accepted event printed to stdout contains summary, durationSeconds and grade, and the final result JSON contains the same data per newly accepted task ID.
- Existing receipts stay valid: receipt validation does not require the new data.
- Tests cover the duration across a simulated restart, an accepted review without completion being refused, an invalid grade being refused, and the content of the accepted event and the final result.
- README documents the completion summary, the A to E scale and where the summary appears.
- npm run typecheck and npm test pass.
