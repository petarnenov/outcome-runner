## ADDED Requirements

### Requirement: Merge an in-scope target advance

When `origin/<target>` has changed files inside a task's guarded paths since the task's recorded base, the runner
SHALL NOT block the task with `Target changed outcome scope`. It SHALL merge the new target into the task branch in
the task worktree. The guarded paths are the task scopes, the change directory and, after the archive, the archived
change and the spec files the archive wrote.

#### Scenario: In-scope advance is merged

- **WHEN** a task reaches publish and the target has committed a change to a file inside the task's scope since the
  task's base
- **THEN** the task is not blocked with `Target changed outcome scope`
- **AND** the task branch contains the new target commit

### Requirement: New base recorded durably

After merging an in-scope target advance, the runner SHALL record the merged target as the task's new `base` in
`state.json`, together with an `integration` record holding the target, the previous base, the conflicting paths and
the current integration step.

#### Scenario: New base in state

- **WHEN** an in-scope target advance has been merged into the task branch
- **THEN** `state.json` records the merged target commit as the task's `base`
- **AND** an integration record names that target, the previous base and the conflicting paths

### Requirement: Checks and reviews run again after a clean merge

After merging an in-scope target advance without conflicts, the runner SHALL run the setup and product checks, a new
implementation review and a new documentation review before the pull request is published or updated.

#### Scenario: Clean merge is re-checked and re-reviewed

- **WHEN** the target advances inside the task scope without a conflict before publish
- **THEN** the product checks, one implementation review session and one documentation review session run after the
  merge and before the push
- **AND** the task is merged and accepted

### Requirement: Earlier acceptance never reused

When an integration starts, the runner SHALL clear the earlier review acceptance, checks, tested head and tested
target, and SHALL never reuse them for the new base.

#### Scenario: Earlier acceptance is not reused

- **WHEN** the implementation review after the merge reports `changes-required`
- **THEN** the pull request is not published or updated with the merged head and the task is not merged

### Requirement: Receipt recorded for the new base

After the checks and reviews accept an integration, the runner SHALL record the receipt again with the new base, the
new review and a manifest of the task's changes relative to the new base.

#### Scenario: Receipt names the new base

- **WHEN** a clean in-scope integration is accepted and the task is merged
- **THEN** the merged receipt names the new base and the new review, and it validates on the target

### Requirement: Rejected clean merge blocks

When the checks or a review after a clean in-scope merge do not accept the result, the runner SHALL block the task
with reason `target-integration-rejected`.

#### Scenario: Rejected clean merge

- **WHEN** the checks or a review after a clean merge do not accept the result
- **THEN** the task is blocked with reason `target-integration-rejected`

### Requirement: One worker session resolves a conflict

When the merge of an in-scope target advance conflicts, the runner SHALL give the worker exactly one implementation
session to resolve the conflicting paths inside the task scopes, conclude the merge, and then run the same checks and
reviews as after a clean merge.

#### Scenario: Conflict resolved by the worker

- **WHEN** the target changes a task file that the task also changed, and the resolution session writes a merged
  file without conflict markers
- **THEN** the merge is concluded, the checks and both reviews run, and the task is merged and accepted

### Requirement: Unresolved conflict blocks with its paths

The runner SHALL block a conflicting integration with reason `target-conflict-unresolved` and the conflicting paths
only when the resolution session fails, the merge cannot be concluded, or the checks or reviews do not accept the
result.

#### Scenario: Resolution session fails

- **WHEN** the resolution session fails
- **THEN** the task is blocked with reason `target-conflict-unresolved` and the conflicting paths in `state.json`
- **AND** the run result's blocker for the task has `kind` `blocked`, `reason` `target-conflict-unresolved` and
  the conflicting `paths`

#### Scenario: Conflict markers remain

- **WHEN** the resolution session reports ready but a conflicting file still contains conflict markers
- **THEN** the task is blocked with reason `target-conflict-unresolved` and the conflicting paths

#### Scenario: Conflict outside the task scopes

- **WHEN** a conflicting path lies outside the task scopes
- **THEN** the task is blocked with reason `target-conflict-unresolved` and that path without a resolution session

#### Scenario: Review rejects the resolution

- **WHEN** the conflict is resolved but the implementation review reports `changes-required`
- **THEN** the task is blocked with reason `target-conflict-unresolved` and the conflicting paths

### Requirement: Same recovery at every stage and after a restart

The recovery SHALL apply whether the target advanced before publish, while waiting for the pull request checks, or
before merge. Every integration step SHALL be recorded in `state.json` before the next effect, so a restart of the
invocation resumes at the recorded step without merging again or reusing an acceptance.

#### Scenario: Advance while waiting for merge

- **WHEN** the pull request is open and the target advances inside the task scope while the runner waits to merge
- **THEN** the runner merges the new target, runs the checks and reviews again, pushes the new head to the same pull
  request and merges it

#### Scenario: Recovery resumed after a restart

- **WHEN** an invocation is cancelled after the in-scope merge was recorded and before the reviews finished, and the
  same invocation is run again
- **THEN** the run resumes the integration at the recorded step with the recorded base, does not merge the target a
  second time, runs the outstanding checks and reviews, and the task is merged and accepted

### Requirement: Outside-scope advance unchanged

A target advance that changes no guarded path of the task SHALL still be merged with the setup checks and final
checks only, without new review sessions and without changing the recorded base.

#### Scenario: Target change outside the scopes

- **WHEN** the target commits a change outside the task's guarded paths before publish
- **THEN** the runner merges it, runs the setup and final checks, starts no extra review session, keeps the recorded
  base and the task is merged and accepted

### Requirement: Documented behaviour

The README SHALL describe what happens when the target advances during a run: outside-scope merges, in-scope merges
with a new base and repeated checks and reviews, conflict resolution with one session, the reasons
`target-conflict-unresolved` and `target-integration-rejected`, and recovery after a restart.

#### Scenario: README section

- **WHEN** a reader looks up target advances in the README
- **THEN** it explains the outside-scope and in-scope cases, conflicts, both blocking reasons and restarts
