## MODIFIED Requirements

### Requirement: Bounded repeats

When `origin/<target>` advanced again before the merge, or the pull request is `BEHIND` the target, the runner SHALL
repeat the worktree merge, the checks and the comparison. An advance whose commits are only release commits changing
only the version fields of `package.json` and `package-lock.json` and `CHANGELOG.md` SHALL NOT count as an attempt.
After 10 consecutive counted attempts without an unchanged target the runner SHALL block the task with reason
`target-keeps-advancing`, keeping its worktree and branch so a restart continues.

#### Scenario: Attempt limit

- **WHEN** the target advances with non-release commits before every merge of 10 consecutive attempts
- **THEN** the task is blocked with reason `target-keeps-advancing` and the run result blocker has `kind` `blocked`
  and that reason
- **AND** nothing is merged, and the task worktree, local branch and remote branch still exist

#### Scenario: Restart after the attempt limit

- **WHEN** the same invocation is run again after `target-keeps-advancing` and the target stays unchanged
- **THEN** the task continues in its worktree, is merged and accepted

#### Scenario: Release-only advance is not counted

- **WHEN** a release-only advance reaches the target before a merge
- **THEN** it is integrated and checked, and `targetAttempts` is not increased
