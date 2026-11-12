## ADDED Requirements

### Requirement: Target advances never block by themselves

Owners MAY merge pull requests into the target while invocations run, including changes inside a running task's
scopes. The runner SHALL NOT block a task only because the target advanced and SHALL NOT produce the reason
`Target changed outcome scope`.

#### Scenario: Advance inside the scopes while waiting to merge

- **WHEN** the target commits a change inside the task's scope while the runner waits to merge the pull request
- **THEN** the task is not blocked, no blocked entry or state field contains `Target changed outcome scope`, and the
  task is merged and accepted

### Requirement: Integrate the advanced target in the task worktree

Before publishing and again before merging, the runner SHALL fetch `origin/<target>`. When it differs from the commit
the task branch was last integrated with, the runner SHALL merge `origin/<target>` into the task branch inside the
task worktree, never in the checkout it was started from, and SHALL run the frozen product checks on the merged
result. When the merge brought changes inside the task scopes, the implementation review SHALL run again on the
merged result.

#### Scenario: Advance inside the scopes is merged, checked and reviewed

- **WHEN** the target commits a change to a file inside the task's scope after the pull request was opened
- **THEN** the task branch contains the new target commit through a merge made in the task worktree
- **AND** the product checks and one implementation review session run after that merge and before the next push
- **AND** the task is merged and accepted

#### Scenario: Advance outside the scopes is merged and checked without a new review

- **WHEN** the target commits a change outside the task's guarded paths after the pull request was opened
- **THEN** the runner merges it in the task worktree and runs the product checks on the merged result
- **AND** no additional implementation or documentation review session starts
- **AND** the task is merged and accepted

#### Scenario: Start checkout untouched

- **WHEN** a run integrates an advanced target and merges the task
- **THEN** the HEAD, current branch, index and working tree status of the checkout the runner was started from are
  the same as before the run

### Requirement: Merge only while origin is unchanged

Immediately before merging the pull request, the runner SHALL fetch `origin/<target>` again and compare it with the
target commit it merged and checked. It SHALL merge only when they are equal, and SHALL merge with the exact checked
pull request head (`gh pr merge --match-head-commit <head>`), so no unchecked combination reaches the target.

#### Scenario: Origin advances between the check and the merge

- **WHEN** the target advances after the comparison that preceded the merge request and before the merge command
- **THEN** the merge command is not issued for that head
- **AND** the runner merges the new target in the worktree, runs the checks, compares again and then merges the new
  checked head

#### Scenario: Guard runs right before the merge command

- **WHEN** `GitHubHost.merge` has a settled, eligible pull request view and a target guard
- **THEN** it calls the guard after the settled view and immediately before `gh pr merge --merge
  --match-head-commit <head>`
- **AND** when the guard throws, no `gh pr merge` command is issued

#### Scenario: Changed pull request head refuses the merge

- **WHEN** the task branch on origin is moved by someone else to a head other than the checked head
- **THEN** the task is blocked with `Checked head or target changed` and nothing is merged

### Requirement: Bounded repeats

When `origin/<target>` advanced again before the merge, the runner SHALL repeat the worktree merge, the checks and the
comparison. After 5 consecutive attempts without an unchanged target the runner SHALL block the task with reason
`target-keeps-advancing`, keeping its worktree and branch so a restart continues.

#### Scenario: Attempt limit

- **WHEN** the target advances before every merge of 5 consecutive attempts
- **THEN** the task is blocked with reason `target-keeps-advancing` and the run result blocker has `kind` `blocked`
  and that reason
- **AND** nothing is merged, and the task worktree, local branch and remote branch still exist

#### Scenario: Restart after the attempt limit

- **WHEN** the same invocation is run again after `target-keeps-advancing` and the target stays unchanged
- **THEN** the task continues in its worktree, is merged and accepted

### Requirement: Conflicts in a worktree merge

A worktree merge with conflicts SHALL give the worker one implementation session to resolve them inside the task
scopes, followed by the checks and the review; otherwise the task SHALL be blocked with reason
`target-conflict-unresolved` naming the conflicting paths.

#### Scenario: Conflict resolved

- **WHEN** the target changes a task file differently while the runner waits to merge and the resolution session
  writes a merged file without conflict markers
- **THEN** the merge is concluded, the checks and the implementation review run, and the task is merged and accepted

#### Scenario: Unresolved conflict

- **WHEN** the resolution session fails
- **THEN** the task is blocked with reason `target-conflict-unresolved` and the conflicting paths

### Requirement: Durable integrated targets

The durable state SHALL record each integrated target commit in `integratedTargets` and the consecutive failed
comparisons in `targetAttempts`, so a restart resumes from the last integrated target and the current attempt.

#### Scenario: Restart resumes from the recorded target commit

- **WHEN** an invocation is cancelled after a worktree merge of an advanced target was recorded, and the same
  invocation is run again
- **THEN** `state.json` names that commit last in `integratedTargets`
- **AND** the rerun does not merge that commit a second time, continues with the recorded attempt number, and the
  task is merged and accepted

### Requirement: Step lines for integration and comparison

Each worktree merge, comparison with origin and retry SHALL be logged as a step line (`integrate`, `compare`,
`retry`), with the attempt number when retried.

#### Scenario: Retry is logged

- **WHEN** the target advances once while the runner waits to merge the pull request
- **THEN** the step log contains a `compare` line before the merge request
- **AND** the line directly before the `retry` line with `(attempt 2)` is the merge-stage `compare` line whose
  comparison found the difference
- **AND** `integrate` and `compare` lines with `(attempt 2)` come before the next merge request

### Requirement: Publish passes begin with a comparison line

Every publish pass SHALL begin with a `compare` step line comparing `origin/<target>` with the integrated target.

#### Scenario: Publish comparison without an advance

- **WHEN** a task is published while the target never advances
- **THEN** a `compare ... with the integrated target` line comes directly after `commit: committing the receipt` and
  directly before the first final `check` line

### Requirement: Merge request follows its comparison line

The `merge: merging #N` step line SHALL directly follow the `compare` line of the comparison that preceded it and
SHALL be the last step line written before the merge request.

#### Scenario: Order without an advance

- **WHEN** a task is merged while the target never advances and the first pull request view is ready
- **THEN** the lines `wait: waiting for mergeability and checks of #1`, `compare: comparing origin/main with the
  checked target` and `merge: merging #1` follow each other directly, and `merge: merging #1` is the last step line
  before the merge request

### Requirement: Merge-stage polling stays quiet

While waiting to merge, the runner SHALL log the first comparison of each merge-stage entry, the comparison that leads
to the merge request and every comparison that finds a difference. Other comparisons that find the target unchanged
MAY stay unlogged.

#### Scenario: Polling stays quiet

- **WHEN** the runner views the pull request several times while the target stays unchanged
- **THEN** only the first view of that merge-stage entry and the view that leads to the merge request write a
  `compare` line

### Requirement: README describes target integration

The README SHALL replace the advice not to merge into the target during a run with how the runner integrates an
advanced target, compares before merging, repeats up to 5 attempts and blocks with `target-keeps-advancing`.

#### Scenario: README section

- **WHEN** a reader looks up target advances in the README
- **THEN** it says owners may merge into the target during a run and explains the worktree merge, checks, review,
  pre-merge comparison, attempt limit and `target-keeps-advancing`
