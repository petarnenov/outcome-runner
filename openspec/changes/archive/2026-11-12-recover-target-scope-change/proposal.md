# Proposal: Recover when the target advances into a task scope

## Why

When `origin/<target>` changes files inside a task's scopes after the task's base, the publish stage throws
`Target changed outcome scope` and blocks the task. Any concurrent merge that touches the same area (for example
another task or a person editing the README) therefore stops otherwise finished work, and a person has to rebase by
hand. The runner can do this itself: merge the new target into the task branch, check and review the merged result
again, and publish it.

## What Changes

- `integrateTarget` no longer throws `Target changed outcome scope`. When the target changed files inside the
  guarded task paths since `work.base`, the task enters a new durable `integrate` stage instead.
- The `integrate` stage merges the new target into the task branch in the task worktree, records the new base
  (`work.base`) and an `integration` record in `state.json`, and then:
  - clean merge: runs the setup and product checks, a new implementation review and a new documentation review;
  - conflicting merge: gives the worker one implementation session to resolve the conflicting paths inside the task
    scopes, concludes the merge, then runs the same checks and reviews.
- Earlier acceptances (`review`, `checks`, `finalChecks`, `documentationChecks`, `head`, `testedTarget`) are cleared
  when an integration starts, so the receipt, the pull request and the merge only use evidence for the new base.
  After the reviews accept, the receipt is recorded again (new base, new manifest, new review) and the normal
  publish, pull request and merge stages follow.
- A conflict that cannot be resolved (the session fails, conflict markers or unmerged paths remain, a conflicting path
  is outside the task scopes, or the checks or reviews do not accept the result) blocks the task with reason
  `target-conflict-unresolved` and the conflicting paths. These are in the blocked entry of `state.json`, the blocked
  report detail and the `blockers` entry of the run result.
- A clean merge whose checks or reviews do not accept the result blocks the task with reason
  `target-integration-rejected`.
- Recovery works the same whether the target advanced before publish, while waiting for checks or before merge (the
  merge stage already returns to publish when the target moves), and it resumes from the recorded step after a
  restart.
- A target change outside the task scopes is still merged as before (merge, setup checks, final checks, push). The
  base is not changed and no new reviews run.
- README describes what happens when the target advances during a run.

## Capabilities

### New Capabilities

- `target-scope-recovery`: merging an in-scope target advance into the task branch, re-checking and re-reviewing
  it, resolving conflicts with one worker session, and blocking with `target-conflict-unresolved` and the paths.

### Modified Capabilities

None. The `unfinished-results` rule that a blocked task normally has reason `operation-incomplete` still applies to
every other blocked task.

## Impact

- `src/runner.ts`: `integrateTarget`, a new `integrate` stage, receipt manifest, conflict detection, blocked entry
  reason and paths, `explainUnfinished`.
- `src/model.ts`: `Stage` gains `integrate`; `Work` gains `integration`.
- `src/run-store.ts`: `BlockedEntry` gains optional `paths`.
- `test/`: new Git fixture tests with scripted adapters and hosts; tests that expected
  `Target changed outcome scope` are updated.
- `README.md`: a section on target advances during a run.
