# diagnostic-leftovers Specification

## Purpose
TBD - created by archiving change no-diagnostic-leftovers. Update Purpose after archive.

## Requirements

### Requirement: Worker deletes its scratch and diagnostic files

The implementation session prompt SHALL tell the worker to delete, with the `delete_file` operation, every scratch or
diagnostic file it created before finishing. The instruction SHALL be identical on every implementation attempt.

#### Scenario: Implementation prompt mentions leftover files

- **WHEN** the runner starts an implementation session
- **THEN** the prompt contains the exported `LEFTOVER_FILES_WORK` text, which names `delete_file` and scratch or
  diagnostic files

#### Scenario: Retried implementation keeps the instruction

- **WHEN** an implementation session starts again after a rejecting review
- **THEN** its prompt contains the same `LEFTOVER_FILES_WORK` text as the first attempt

### Requirement: Implementation review rejects leftover diagnostic files

The implementation review prompt SHALL ask the reviewer to report `changes-required` when the task changes contain a
file that only served diagnosis, such as a temporary debug test, and to name each such file in its findings.

#### Scenario: Review prompt mentions leftover files

- **WHEN** the runner starts an implementation review session
- **THEN** the prompt contains the exported `LEFTOVER_FILES_REVIEW` text, which names temporary debug tests and asks
  for each such file to be named in findings

### Requirement: A review naming a leftover file sends the task back

An implementation review that reports `changes-required` with a finding naming a leftover file SHALL send the task back
to the worker with that finding, and the deleted file SHALL NOT reach the target.

#### Scenario: Leftover file is named, deleted and not published

- **WHEN** the first implementation session creates `src/a/debug-capture.test.mjs` and the first implementation
  review reports `changes-required` with the finding `Remove leftover diagnostic file src/a/debug-capture.test.mjs`
- **THEN** a second implementation session starts whose prompt contains that finding
- **AND** after that session deletes the file with `delete_file` and the next review accepts, the task is accepted
- **AND** `src/a/debug-capture.test.mjs` does not exist on the target branch

### Requirement: No leftover diagnostic file on the target

The repository SHALL NOT contain `test/zz-debug-capture.test.ts` or any other file in `src` or `test` that only served
diagnosis and has no dependants. Checks that such a file carried and that are still useful SHALL be moved to the
test file of the feature they check.

#### Scenario: Debug capture file removed, its README check kept

- **WHEN** the test suite runs
- **THEN** `test/zz-debug-capture.test.ts` does not exist
- **AND** `test/openspec-preflight.test.ts` contains the test that README.md documents the OpenSpec preflight, and
  it passes
