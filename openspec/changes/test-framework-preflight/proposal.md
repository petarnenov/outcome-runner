# Proposal: Harness-analysed test framework preflight

## Why

The runner enforces a resolved coverage threshold (85 by default) through the
project checks, but it never verifies that the target repository actually has a
test framework that enforces line, branch and function coverage at that
threshold for every technology it contains. Work sessions then fail late, after
a claim, when the coverage gate cannot pass or does not exist. The selected
harness can inspect the repository and recognise its technologies and test
setup far better than fixed heuristics.

## What Changes

- After the OpenSpec preflight and the harness, model, effort and coverage
  selection, and before the lock and any claim, the runner fetches
  `origin/<target>`, creates a temporary detached worktree of it outside the
  repository and runs one read-only analysis session with the selected
  harness, model and effort. The worktree is always removed afterwards.
- The session uses the existing file broker with read access to every tracked
  file, no write access, no `run_checks`, no shell, and reports through a new
  private structured tool `test_framework_report`.
- The runner validates the report: every technology with evidence paths, its
  existing test frameworks with their line, branch and function thresholds, and
  for each unprepared technology one to three recommendations, each with a
  one-sentence rationale, install commands as command and argument arrays, exact
  file changes, and thresholds equal to the resolved coverage threshold.
- A technology is prepared when an existing framework enforces line, branch and
  function thresholds of at least the resolved coverage threshold. When every
  technology is prepared, startup continues without any prompt.
- Interactive runs (stdin and stderr are TTYs; output on stderr) print the
  analysis, let the user choose a recommendation (first preselected) or skip
  per unprepared technology, show the exact install commands and file changes
  and ask for confirmation, then run the installs without a shell and apply the
  file changes in the working tree. File changes outside the repository or
  inside `.git`, the queue, the receipts or the OpenSpec changes directories
  refuse the recommendation. Nothing is committed or pushed; the run prints on
  stderr and exits with code 4 listing only the files the setup changed
  (compared with a working-tree snapshot taken before it, so pre-existing
  changes are not listed), or with reason `test-framework-missing` naming the
  technologies left unprepared.
- Non-interactive runs analyse only and exit with code 4 and reason
  `test-framework-missing` (with the report in the diagnostics) when any
  technology is unprepared.
- A failing analysis session or an invalid report exits with code 4 and reason
  `test-framework-analysis-failed`.
- All effects (harness session, worktree, prompts, command execution, file
  writes) are injectable; README documents the behaviour.

## Scope

`src` (new `src/test-framework-preflight.ts`, wiring in `src/runner.ts`,
diagnostics details in `src/cli.ts`, new reasons in `src/statistics.ts`),
`test` (new `test/test-framework-preflight.test.ts`, scripted option in existing
runner tests) and `README.md`.

## Out of Scope

Committing, pushing or opening pull requests for the framework setup; verifying
the installed framework by running it; changing the project checks or the
OpenSpec preflight.

## Dependencies

OR-4 (selectable harness, model and effort) provides the resolved harness,
model, effort and coverage used by the analysis session.
