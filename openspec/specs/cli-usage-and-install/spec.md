# cli-usage-and-install Specification

## Purpose
TBD - created by archiving change cli-usage-and-install. Update Purpose after archive.

## Requirements

### Requirement: Version output

`outcome-runner --version` SHALL print the version of the executing installation, read from its `package.json`, as
one line on stdout and exit with code 0 without reading any queue, invocation or state file.

#### Scenario: Version is printed

- **WHEN** `outcome-runner --version` is run
- **THEN** stdout is exactly the package version followed by a newline
- **AND** the exit code is 0
- **AND** no ledger record is appended and no diagnostics file is created

### Requirement: Help output

`outcome-runner --help` and `outcome-runner -h` SHALL print the commands and their arguments on stdout and exit
with code 0.

#### Scenario: Help lists every command

- **WHEN** `outcome-runner --help` is run
- **THEN** stdout names the run command with `<invocation file>` and its flags `--harness=`, `--model=`,
  `--effort=`, `--coverage=`, `--no-mascot` and `--retry <task id>`, the `hash <queue file> [<task id>...]`
  command, the `dispose <invocation file> [--remove-work]` command, `--version` and `--help`
- **AND** the exit code is 0

#### Scenario: Short help flag

- **WHEN** `outcome-runner -h` is run
- **THEN** the same text is printed and the exit code is 0

### Requirement: Selective task hashing

`outcome-runner hash <queue file> [<task id>...]` SHALL print one JSON line mapping only the given task ids to
their hashes, or every task when no id is given. A missing queue file or an unknown task id SHALL be reported as
one line on stderr naming the argument, with exit code 4, nothing on stdout and no stack trace.

#### Scenario: Hash of selected tasks

- **WHEN** `outcome-runner hash queue.json B` is run for a queue with tasks `A` and `B`
- **THEN** stdout is one JSON line `{"B": "<hash of B>"}` without `A`
- **AND** the exit code is 0

#### Scenario: Hash of all tasks

- **WHEN** `outcome-runner hash queue.json` is run
- **THEN** stdout maps every task id to its hash and the exit code is 0

#### Scenario: Missing queue file

- **WHEN** `outcome-runner hash missing.json` is run and `missing.json` does not exist
- **THEN** stderr is exactly one line naming `missing.json`
- **AND** the line contains no stack trace
- **AND** stdout is empty and the exit code is 4

#### Scenario: Unknown task id

- **WHEN** `outcome-runner hash queue.json X` is run and the queue has no task `X`
- **THEN** stderr is exactly one line naming `X`
- **AND** the line contains no stack trace
- **AND** stdout is empty and the exit code is 4

### Requirement: Runner version in run and diagnostics files

The run state file `state.json`, the per-invocation ownership file, every diagnostics file and every run statistics
ledger record SHALL include `runnerVersion`, the version of the runner that wrote it.

#### Scenario: Diagnostics file names the version

- **WHEN** a command fails with an `unavailable` line
- **THEN** the diagnostics file it names contains `runnerVersion` equal to the package version

#### Scenario: State file names the version

- **WHEN** a run writes `state.json`
- **THEN** `state.json` contains `runnerVersion` equal to the version of the runner that wrote it
- **AND** a state without `runnerVersion` written by an older runner still resumes

#### Scenario: Ownership file names the version

- **WHEN** a run writes its ownership file, or dispose rewrites it as released
- **THEN** the ownership file contains `runnerVersion` equal to the version of the runner that wrote it
- **AND** an ownership file without `runnerVersion` written by an older runner is still read as before

### Requirement: Install and update guidance

The README SHALL give the exact global install and update command
`npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner` and SHALL say to update
the global runner only while no invocation is unfinished or after checking that the unfinished invocation can
resume.

#### Scenario: Owner installs or updates the runner

- **WHEN** the owner reads the README install section
- **THEN** it shows the command with `--allow-git=root` and `--allow-scripts=outcome-runner`
- **AND** it says the same command updates the runner and to update only while no invocation is unfinished or after
  checking that it can resume
