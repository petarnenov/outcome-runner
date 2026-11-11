# invocation-disposal Specification

## Purpose
TBD - created by archiving change dispose-invocation. Update Purpose after archive.

## Requirements

### Requirement: Dispose releases unaccepted claims

`outcome-runner dispose <invocation file>` SHALL remove the claims of the invocation's claimant on tasks not accepted
at `origin/<target>` from the claims ledger in exactly one commit whose message names the invocation.

#### Scenario: Claims released and ownership freed

- **WHEN** an invocation holds a claim on an unaccepted, blocked task and is disposed
- **THEN** the claims ledger no longer holds that claim, one new ledger commit names the invocation, the ownership
  file has `released: true` and `state.json` `status` is `released`
- **AND** a new invocation whose leaf overlaps that task's scopes can claim and accept it

### Requirement: Dispose marks the invocation released

Dispose SHALL mark the invocation's ownership file released and SHALL leave `state.json` with `status` `released`
and, whenever it writes `state.json`, a `disposed` record listing the disposed unaccepted work, so a disposed
invocation is never resumed.

#### Scenario: Disposed state is not resumed

- **WHEN** the same invocation file is run after dispose released unaccepted work
- **THEN** the run exits 4 with reason `invocation-disposed` and claims nothing

#### Scenario: Unclaimed incomplete invocation

- **WHEN** an invocation whose leaf waited on another invocation's claim ended with `state.json` `status`
  `incomplete`, an unreleased ownership file and no claim of its own, and it is disposed
- **THEN** its ownership file has `released: true`, its `state.json` `status` is `released` with a `disposed`
  record, the summary `status` is `disposed` with empty `releasedClaims`, and the other invocation's claim is unchanged
- **AND** running the same invocation file again is refused with reason `invocation-disposed`

### Requirement: Dispose writes state only when needed

Dispose SHALL write `state.json` once atomically when the invocation has unaccepted work or claims to release or its
`status` is not `released`, and SHALL NOT write it otherwise.

#### Scenario: Fully accepted invocation

- **WHEN** an invocation whose tasks are all accepted is disposed
- **THEN** the summary `status` is `nothing-to-release`, `state.json` is byte-for-byte unchanged and holds no
  `disposed` record, and receipts and the claims ledger head are unchanged

#### Scenario: Status not yet released

- **WHEN** an invocation with `state.json` `status` `blocked` or `incomplete` is disposed
- **THEN** `state.json` is written once with `status` `released` and a `disposed` record, possibly with no tasks

### Requirement: Accepted work is untouched

Dispose SHALL NOT change accepted tasks, their claims, receipts, `completed` entries or merged pull requests.

#### Scenario: Accepted work untouched

- **WHEN** an invocation accepted one task and holds a claim on another unaccepted task and is disposed
- **THEN** only the unaccepted task's claim is removed; the accepted task's receipt, claim, `completed` entry and
  merged pull request are unchanged

### Requirement: Dispose refusals

Dispose SHALL exit with code 4, print `{ status: 'unavailable', reason, diagnostics }` and change nothing when a
process of the invocation is running (reason `invocation-running`) or when the file does not match a known invocation
state (reason `unknown-invocation`). The match SHALL be checked before any lock is taken, so an unknown invocation
creates no file.

#### Scenario: Running invocation refused

- **WHEN** dispose is called while a run of the same invocation is inside a session
- **THEN** it is refused with exit code 4 and reason `invocation-running`, and the claims ledger, ownership file and
  `state.json` are unchanged

#### Scenario: Unknown invocation refused

- **WHEN** the invocation file resolves to a state directory without a matching `state.json`
- **THEN** dispose exits 4 with reason `unknown-invocation` and creates no file: no state directory, no invocation
  lock file and no ownership file

### Requirement: Repeated dispose is safe

Disposing an already disposed invocation SHALL change no claim, ownership, `state.json` or receipt and SHALL report
status `nothing-to-release` with exit code 0.

#### Scenario: Dispose twice

- **WHEN** dispose runs a second time on the same invocation
- **THEN** it exits 0, the summary `status` is `nothing-to-release`, `releasedClaims` is empty and the claims ledger
  head is unchanged

### Requirement: Unaccepted work is kept by default

By default dispose SHALL keep and list the worktrees, local branches and remote branches of the invocation's
unaccepted tasks; with `--remove-work` it SHALL remove them. Open pull requests of the invocation SHALL be listed and
never merged.

#### Scenario: Work kept by default

- **WHEN** a blocked task's worktree and branches exist and dispose runs without flags
- **THEN** they still exist and the summary lists them with state `kept`

#### Scenario: Work removed with --remove-work

- **WHEN** dispose runs with `--remove-work`
- **THEN** the worktree, local branch and remote branch are gone and the summary lists them with state `removed`

#### Scenario: Open pull request listed

- **WHEN** a task of the invocation has an open pull request
- **THEN** the summary's `openPullRequests` lists it with state `OPEN` and the pull request host's `merge` is never
  called

#### Scenario: Pull request host unavailable

- **WHEN** the pull request host fails while dispose looks up a task branch that has a recorded pull request
- **THEN** dispose still succeeds and lists the recorded pull request with state `unknown`

### Requirement: Dispose is isolated

Dispose SHALL NOT change the ownership file, claims or `state.json` of another invocation or of another repository.

#### Scenario: Another invocation untouched

- **WHEN** two invocations of one repository each hold a claim and one is disposed
- **THEN** the other invocation's claim, ownership file and `state.json` are byte-for-byte unchanged and it can still
  resume and accept its task

### Requirement: Dispose summary

Dispose SHALL print one JSON line on stdout with `status`, `invocation`, `releasedClaims`, `ownership`, `work`
(worktree, local branch and remote branch with their state per task) and `openPullRequests`. `status` SHALL be
`nothing-to-release` exactly when no claim was released, the ownership file was not changed and `state.json` was not
written, and `disposed` otherwise.

#### Scenario: Summary through the CLI

- **WHEN** `dispose` runs from the command line on a blocked invocation
- **THEN** stdout holds exactly one JSON line with those fields and the exit code is 0

#### Scenario: Command dispatch

- **WHEN** `outcome-runner dispose <file> [--remove-work]` is invoked
- **THEN** the CLI dispatches to the dispose command with that file and those flags
