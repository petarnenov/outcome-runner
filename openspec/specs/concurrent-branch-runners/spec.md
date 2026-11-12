# concurrent-branch-runners Specification

## Purpose
TBD - created by archiving change many-runners-per-branch. Update Purpose after archive.

## Requirements

### Requirement: Target is the start branch

The run target SHALL be the branch checked out where the runner starts. When the invocation omits
`project.target` and `authority.target`, both SHALL resolve to that branch. Every valid Git branch name SHALL be
accepted as a target.

#### Scenario: Omitted targets resolve to the current branch

- **WHEN** the runner starts on branch `main`, which exists on origin, with an invocation that omits
  `project.target` and `authority.target`
- **THEN** both resolve to `main` and the run proceeds against `origin/main`

#### Scenario: Run from a feature branch

- **WHEN** the runner starts on `feature/x` and completes a task
- **THEN** the task pull request is created and merged with base `feature/x`, and the receipt is read from
  `origin/feature/x`

#### Scenario: Branch name with dots

- **WHEN** the runner starts on branch `release/1.2`, which exists on origin, with an invocation that omits the
  targets
- **THEN** the target resolves to `release/1.2` and configuration validation and the OpenSpec preflight accept it

### Requirement: Target refusals

The runner SHALL refuse with exit code 4 and a diagnostics reason when the target cannot be the start branch:
`target-differs-from-current-branch` when a given `project.target` or `authority.target` differs from it,
`detached-head` for a detached HEAD, `target-missing-on-origin` when the branch is missing on origin, and
`unsupported-target-name` when the branch name fails `git check-ref-format --branch` or the runner's branch name
rule.

#### Scenario: Given target differs from the current branch

- **WHEN** the runner starts on branch `feature/x` with `project.target` or `authority.target` set to `main`
- **THEN** the run is refused with exit code 4, the printed reason is `target-differs-from-current-branch`, the
  diagnostics file records that reason, and no lock, claim or worktree is created

#### Scenario: Detached HEAD

- **WHEN** the runner starts in a checkout with a detached HEAD
- **THEN** the run is refused with exit code 4 and reason `detached-head`

#### Scenario: Branch missing on origin

- **WHEN** the runner starts on a branch that does not exist on origin
- **THEN** the run is refused with exit code 4 and reason `target-missing-on-origin`

#### Scenario: Unsupported branch name

- **WHEN** the current branch name is rejected by `git check-ref-format --branch` or by the runner's branch name rule
- **THEN** the run is refused with exit code 4 and reason `unsupported-target-name`

### Requirement: Resolved target in identity and receipts

The resolved target SHALL be part of the frozen invocation identity and SHALL be recorded as `target` in every
receipt.

#### Scenario: Target in identity and receipts

- **WHEN** a task is accepted in a run whose resolved target is `feature/x`
- **THEN** the frozen invocation identity hash covers `feature/x`, and the task receipt contains
  `"target": "feature/x"`

### Requirement: Task worktrees and pull requests only

Every task SHALL be worked in its own worktree outside the checkout and SHALL reach the target only through a pull
request into that branch, merged by the runner. The runner SHALL NOT change the working tree, index or local branch
of the checkout it was started from, including during the interactive OpenSpec setup, whose
install commands and file writes SHALL happen in a setup worktree outside the checkout.

#### Scenario: Start checkout unchanged

- **WHEN** a run completes one or more tasks
- **THEN** HEAD, the current branch, the index and `git status --porcelain` of the start checkout are identical to
  their values before the run, and each task was worked in a worktree outside the checkout

#### Scenario: Interactive OpenSpec setup outside the checkout

- **WHEN** an interactive run finds `openspec/config.yaml` missing at `origin/<target>` and the user accepts layout
  creation
- **THEN** the layout files are written into the setup worktree on branch `outcome/setup-...`, the start checkout's
  HEAD, branch, index and porcelain status are unchanged, and the refusal message names the setup worktree path and
  branch

### Requirement: Per-invocation lock and ownership

Several invocations SHALL be able to run at the same time in one clone and on one branch. The per-clone exclusive
lock and per-clone ownership file SHALL be replaced by a per-invocation lock and per-invocation ownership. A second
process of the same invocation SHALL be refused at once, and a different invocation SHALL never inherit or override
another invocation's unfinished work.

#### Scenario: Second process of the same invocation

- **WHEN** a process of invocation `a` is running and a second process of invocation `a` starts in the same clone
- **THEN** the second process is refused immediately with exit code 4 and reason `invocation-running`, and the first
  process continues unaffected

#### Scenario: Different invocations run concurrently

- **WHEN** invocations `a` and `b` start at the same time in one clone on one branch
- **THEN** both acquire their own lock and ownership and both run

#### Scenario: Unfinished work of another invocation

- **WHEN** invocation `a` left unreleased ownership with unfinished work and invocation `b` starts in the same clone
- **THEN** `b` runs without reading or changing `a`'s ownership, state, claims, worktrees or branches

### Requirement: Serialized shared Git operations

Git operations on the shared repository (fetch, worktree add and remove, branch creation and deletion, claims
ledger commits and pushes) SHALL be serialized between runners of the same clone with a lock held only for one
group of Git operations. A runner SHALL wait up to 60 seconds for it, and the lock SHALL be released when its holder
exits or crashes. The Git lock SHALL never be held while waiting for an invocation lock. Concurrent runners SHALL NOT
fail because of Git index or ref lock files.

#### Scenario: Concurrent fetch and worktree operations

- **WHEN** several processes of one clone repeatedly fetch, add and remove worktrees and create and delete branches
  at the same time through the Git lock
- **THEN** every operation succeeds and no error mentions `index.lock`, `.lock` ref files or `packed-refs.lock`

#### Scenario: Holder crashes

- **WHEN** a process holding the Git lock is killed
- **THEN** another runner acquires the lock without waiting for the timeout

#### Scenario: Wait exceeds the limit

- **WHEN** the Git lock stays held longer than the wait limit
- **THEN** the waiting runner stops waiting with the error `Git lock wait exceeded 60 seconds` (the limit is
  injectable in tests)

### Requirement: Shared tasks through the claims ledger

Runners of the same clone SHALL share tasks through the existing claims ledger, each invocation with its own
claimant, so that two runners never work on the same task or on tasks with overlapping scopes at the same time.

#### Scenario: Two invocations complete different tasks

- **WHEN** two invocations run concurrently in one clone over a queue of tasks with disjoint scopes
- **THEN** the claims ledger shows a distinct claimant per invocation, no task is claimed twice, no two
  overlapping-scope tasks are in progress at the same time, and every task is merged into the start branch exactly
  once

### Requirement: Cleanup after acceptance

After a task's pull request is merged and its acceptance is confirmed, the runner SHALL remove the task worktree,
delete the local task branch and delete the remote task branch. A cleanup failure SHALL be reported in the
`accepted` event and SHALL NOT change the result. Worktrees and branches of blocked or unfinished tasks SHALL be
kept so the task can resume.

#### Scenario: Removed after merge

- **WHEN** a task's pull request is merged and its receipt is confirmed on the target
- **THEN** its worktree directory is gone from disk and from `git worktree list`, `refs/heads/<task branch>` no longer
  exists locally, and the task branch no longer exists on origin

#### Scenario: Cleanup failure reported

- **WHEN** removing the worktree, the local branch or the remote branch fails after acceptance
- **THEN** the `accepted` event contains `cleanupFailed` listing the failed steps, and the run status, accepted list,
  remaining list and exit code are the same as without the failure

#### Scenario: Blocked task keeps its worktree

- **WHEN** a task is blocked
- **THEN** its worktree, local branch and any pushed remote branch remain, and a later run of the same invocation
  resumes it in that worktree

### Requirement: Leftover removal on start

On start, the runner SHALL remove leftover worktrees and local branches of tasks its invocation already has
accepted.

#### Scenario: Leftovers removed on start

- **WHEN** the invocation state lists an accepted task whose worktree or local branch still exists, and the runner
  starts again
- **THEN** that worktree and local branch are removed before task selection, and worktrees of other invocations, of
  unfinished tasks and the setup worktree are untouched
