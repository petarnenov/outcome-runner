# invocation-evolution Specification

## Purpose
TBD - created by archiving change evolve-invocation. Update Purpose after archive.

## Requirements

### Requirement: Identity covers only what the owner authorised

The frozen invocation identity SHALL consist of the invocation name, the repository root, the authority (reference,
instruction, target and the task ids with their hashes), the project target with its queue, changes and receipts
paths, the harness, model, effort and coverage, the checks (`checks`, `planningCheck`, `setup`) and the leaves. Runner
defaults, operational settings and settings introduced by a newer runner SHALL NOT be part of it.

#### Scenario: Unknown and default settings do not change the identity

- **WHEN** two resolved configurations differ only in `project.archive`, `maxAccepted`, `commitScope`,
  `commitSuffix`, `repository` or a key unknown to this runner
- **THEN** their invocation identities are equal

#### Scenario: Authorised settings change the identity

- **WHEN** two resolved configurations differ in a task hash, the harness, the model, the effort, the coverage or a
  check
- **THEN** their invocation identities differ

### Requirement: A newer runner resumes unfinished work

Upgrading the runner SHALL NOT by itself make an unfinished invocation unrecoverable. State recorded by an older
runner SHALL be migrated in place when its recorded identity is intact and matches. Harness, model, effort and
coverage values the invocation does not set SHALL be taken from the frozen identity, not from newer defaults.

#### Scenario: Resumed by a newer runner with unchanged settings

- **WHEN** an invocation was interrupted with state written by an older runner, and it is run again by a newer
  runner with the same invocation file
- **THEN** the run resumes the recorded task at its recorded stage with the same claim, branch and worktree
- **AND** the operations, reviews and accepted tasks recorded before are kept
- **AND** `state.json` records an `identity-upgraded` change

#### Scenario: Newer default does not replace the frozen model

- **WHEN** an unfinished invocation froze a model the invocation file does not name, and the runner's default model
  differs
- **THEN** the run resumes with the frozen model and is not refused

#### Scenario: Tampered legacy state is refused

- **WHEN** legacy state has an identity whose hash differs from its recorded identity hash
- **THEN** the run is refused with `Run state is incompatible` and `state.json` is unchanged

### Requirement: Missing required setting is refused and then accepted

When the runner requires a setting the invocation file lacks, the run SHALL be refused with exit code 4 and an
unavailable line with reason `missing-setting`, the missing `setting` and an `example`, before any state, lock, claim
or worktree is changed. Adding exactly that setting SHALL keep the durable state and resume the unfinished work. The
addition SHALL be recorded in `state.json` and in every receipt written afterwards.

#### Scenario: Missing setting reported

- **WHEN** the runner requires `project.example` and an unfinished invocation file lacks it
- **THEN** the CLI exits with code 4 and prints `reason` `missing-setting`, `setting` `project.example` and an
  `example`
- **AND** `state.json`, the worktree and the claim are unchanged

#### Scenario: Added setting resumes the work

- **WHEN** the owner adds exactly `project.example` to that invocation file and runs it again
- **THEN** the unfinished task resumes at its recorded stage and is accepted
- **AND** `state.json` `changes` holds a `setting-added` record for `project.example`
- **AND** the task's receipt lists that record in `invocationChanges`

### Requirement: Tasks can be added to an unfinished invocation

The owner SHALL be able to add tasks to `authority.tasks` (and to `leaves`, when given) of an unfinished invocation.
Existing claims, worktrees, reviews and accepted tasks SHALL be kept and resumed first. The new tasks SHALL be worked
after them in queue order. The addition SHALL be recorded in `state.json` and in later receipts.

#### Scenario: Added task worked after resumed work

- **WHEN** an invocation of task A is interrupted during its work, and the owner adds task B to `authority.tasks`
  and runs it again
- **THEN** task A resumes at its recorded stage without a second claim or investigation, and is accepted
- **AND** task B is claimed after that and accepted
- **AND** `state.json` `changes` holds a `tasks-added` record naming B

### Requirement: Removing or changing a task is still refused

Removing a task from `authority.tasks` or changing a task hash of an unfinished invocation SHALL still be refused
without changing durable state.

#### Scenario: Changed task hash refused

- **WHEN** the owner changes the hash of a task of an unfinished invocation
- **THEN** the run is refused and `state.json`, the worktree and the claim are unchanged

#### Scenario: Removed task refused

- **WHEN** the owner removes a task from `authority.tasks` of an unfinished invocation
- **THEN** the run is refused with `Run state is incompatible` and `state.json` is unchanged

### Requirement: Documented upgrades and additions

The README SHALL describe upgrading the runner during an unfinished invocation, the `missing-setting` refusal and its
remedy, and adding tasks to an unfinished invocation.

#### Scenario: README section

- **WHEN** a reader looks up runner upgrades or added tasks in the README
- **THEN** it explains the frozen identity, the `missing-setting` refusal, adding tasks, what is still refused and
  where the changes are recorded
