# test-framework-preflight Specification

## Purpose
Verify before claiming work that the target repository has a test framework enforcing line, branch and function coverage at the threshold for each technology it contains.

## Requirements

### Requirement: Analysis runs after selection and before any claim

The runner SHALL, after the OpenSpec preflight and after the harness, model,
effort and coverage are resolved, and before the lock, any claim or task
worktree, analyse the repository at `origin/<target>` in exactly one read-only
session of the selected harness with the selected model and effort.

#### Scenario: Order of startup steps

- **WHEN** a run starts with a passing OpenSpec preflight
- **THEN** the analysis session is created after harness selection and
  resolution, using the resolved harness, model and effort
- **AND** no lock is taken and no claim or task worktree is created before the
  analysis finishes

#### Scenario: Non-default coverage threshold passed to the analysis

- **WHEN** the resolved coverage threshold is 90
- **THEN** the analysis prompt states 90 as the threshold
- **AND** recommendations are required to use 90 for line, branch and function
  thresholds and a framework enforcing only 85 is not prepared

### Requirement: Temporary detached read-only worktree

The analysis SHALL run in a temporary detached worktree of `origin/<target>`
created outside the repository and SHALL remove it afterwards in every case.
The session SHALL use the existing broker with read access to every tracked
file, no write access, no `run_checks` and no shell, and SHALL report through
the private `test_framework_report` tool.

#### Scenario: Worktree location and removal

- **WHEN** the analysis runs
- **THEN** the worktree is detached at `origin/<target>` in a directory outside
  the repository
- **AND** it is removed after the session, whether the session succeeds, fails,
  returns an invalid report or the run then prompts, installs, refuses or exits

#### Scenario: Read-only tools

- **WHEN** the analysis session calls `read_file` on a tracked file
- **THEN** the content is returned
- **AND** `write_file`, `run_checks` and any other operation are refused
- **AND** only the broker tool and `test_framework_report` are offered

### Requirement: Report lists technologies with evidence

The report SHALL list every detected technology (language, runtime, framework
or build tool) with the tracked repository paths that prove it. The runner
SHALL refuse a report that misses this part.

#### Scenario: Technology without evidence

- **WHEN** the session reports no technologies, a technology without evidence,
  or evidence that is not a tracked path
- **THEN** the report is refused

### Requirement: Report lists existing test frameworks

For each technology the report SHALL list the test frameworks already present
and whether each enforces line, branch and function coverage thresholds. The
runner SHALL refuse a report that misses this part.

#### Scenario: Framework without thresholds

- **WHEN** a listed framework does not state its line, branch and function
  thresholds or states that none are enforced
- **THEN** the report is refused when the statement is missing
- **AND** a framework stating no thresholds is accepted but not prepared

### Requirement: Report recommends frameworks for unprepared technologies

For each technology without a prepared test framework the report SHALL give one
to three recommendations. Each SHALL have a one-sentence rationale, install
commands as command and argument arrays, and exact file changes that run the
tests with line, branch and function thresholds equal to the resolved coverage
threshold. The runner SHALL refuse a report that misses any of these parts.

#### Scenario: Wrong recommendation count

- **WHEN** an unprepared technology has zero or four recommendations
- **THEN** the report is refused

#### Scenario: Incomplete recommendation

- **WHEN** a recommendation lacks a rationale, install arrays, file changes or
  thresholds equal to the resolved coverage threshold
- **THEN** the report is refused

### Requirement: Prepared technologies need no prompt

A technology SHALL be prepared when one of its test frameworks enforces line,
branch and function thresholds of at least the resolved coverage threshold.
When every technology is prepared, startup SHALL continue without any test
framework prompt.

#### Scenario: All technologies prepared

- **WHEN** every reported technology has a framework enforcing line, branch and
  function thresholds of at least the threshold
- **THEN** nothing is asked, executed or written and startup continues to the
  lock and claims

### Requirement: Interactive choice

When interactive (stdin and stderr are TTYs; output on stderr), the runner SHALL
print the detected technologies with their evidence and existing frameworks,
then for each unprepared technology ask the user to choose one of its
recommendations, the first preselected, or to skip it.

#### Scenario: First recommendation accepted

- **WHEN** one technology is unprepared and the user answers with an empty line
  and then confirms
- **THEN** the first recommendation is applied

#### Scenario: Later recommendation chosen

- **WHEN** the user answers `2` and confirms
- **THEN** the install commands and file changes of the second recommendation
  are used and those of the first are not

#### Scenario: Two technologies

- **WHEN** the repository has two technologies and both are unprepared
- **THEN** both are printed with their evidence and one choice is asked per
  technology

#### Scenario: Skip

- **WHEN** the user answers `s`
- **THEN** nothing is executed or written for that technology
- **AND** the run exits with code 4 and reason `test-framework-missing` naming it

### Requirement: Confirmed setup without a shell

Before running anything, the runner SHALL show the exact install commands and
file changes of the chosen recommendation and ask for confirmation. Only after
yes SHALL it run the install commands as argument arrays without a shell in the
working tree and apply the file changes. A file change outside the repository
or inside `.git`, the queue, the receipts or the OpenSpec changes directories
SHALL refuse the recommendation.

#### Scenario: Declined confirmation

- **WHEN** the user answers no or an empty line to the confirmation
- **THEN** nothing is executed or written
- **AND** the run exits with code 4 and reason `test-framework-missing`

#### Scenario: Failing install command

- **WHEN** an install command exits nonzero
- **THEN** later commands and the file changes of that recommendation are not
  applied
- **AND** the run exits with code 4 and reason `test-framework-missing` naming
  the technology

#### Scenario: File change outside the allowed paths

- **WHEN** a chosen recommendation changes a path outside the repository, under
  `.git`, the queue file, the receipts or the OpenSpec changes directory
- **THEN** the recommendation is refused without asking for confirmation and
  nothing is executed or written
- **AND** the technology is reported as unprepared

### Requirement: No commit or push after setup

The runner SHALL NOT commit or push the setup. After a successful setup it
SHALL print on stderr a message listing the changed files to commit and push,
and then exit with code 4.

#### Scenario: Successful setup

- **WHEN** every unprepared technology is set up
- **THEN** no git add, commit or push is run
- **AND** a message listing the changed files to commit and push to
  `origin/<target>` is printed on stderr
- **AND** the run exits with code 4

### Requirement: Changed files exclude pre-existing changes

The listed changed files SHALL contain only paths that the installs or file
changes created or modified, compared with a working-tree snapshot taken before
them.

#### Scenario: Pre-existing changes are not listed

- **WHEN** a file is already modified or untracked before the preflight and the
  setup does not change it
- **THEN** the printed list of changed files does not contain it
- **AND** the files written by the setup and the files changed by its install
  commands are listed

### Requirement: Unprepared technologies reported

When a technology is skipped or declined or an install fails, the runner SHALL
print on stderr a message naming the unprepared technologies and exit with code
4 and reason `test-framework-missing`.

#### Scenario: Unprepared summary on stderr

- **WHEN** an interactive run leaves a technology unprepared
- **THEN** a message naming the unprepared technologies is printed on stderr
  before the run exits with code 4 and reason `test-framework-missing`

### Requirement: Non-interactive refusal

When non-interactive the analysis SHALL still run, but nothing SHALL be asked,
installed or changed; when any technology is unprepared the run SHALL exit with
code 4 and reason `test-framework-missing` with the analysis report.

#### Scenario: Non-interactive unprepared technology

- **WHEN** startup is non-interactive and a technology is unprepared
- **THEN** nothing is asked, executed or written
- **AND** the run exits with code 4, reason `test-framework-missing`, and the
  diagnostics contain the analysis report

### Requirement: Analysis failure

When the analysis session fails or returns no valid report, the runner SHALL
exit with code 4 and reason `test-framework-analysis-failed`, and no claim SHALL
be made.

#### Scenario: Session failure

- **WHEN** the harness is not ready, the session throws, or it ends without a
  valid report
- **THEN** the run exits with code 4 and reason `test-framework-analysis-failed`
- **AND** no lock, claim or task worktree is created and the temporary worktree
  is removed

### Requirement: Injectable effects

The harness session, prompt input, command execution and file writes SHALL be
injectable; no test SHALL start a real harness, run a package manager or use a
real TTY.

#### Scenario: Scripted preflight

- **WHEN** tests supply a scripted adapter, scripted answers, a recording
  executor and in-memory file writes
- **THEN** every path is exercised without spawning a harness or package manager

#### Scenario: Checks pass

- **WHEN** `npm run typecheck` and `npm test` run
- **THEN** both pass

### Requirement: Documentation

The README SHALL document the harness-based technology analysis, how
recommendations are chosen and confirmed, the coverage thresholds they apply
and the non-interactive behaviour.

#### Scenario: README content

- **WHEN** a reader consults the README
- **THEN** it explains the read-only analysis of `origin/<target>`, the choice
  and confirmation, the line, branch and function thresholds equal to the
  resolved coverage threshold, that nothing is committed or pushed, and the
  reasons `test-framework-missing` and `test-framework-analysis-failed`
