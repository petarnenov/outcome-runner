# Many runners per branch, each in its own worktree

## Why

Today one clone runs one invocation at a time: `runQueue` takes a per-clone exclusive SQLite lock
(`<lockRoot>/<hash(primary)>.sqlite`) for the whole run and a per-clone ownership file
(`<hash(primary)>-owner.json`) that refuses every other invocation while unfinished work exists. The target branch
is whatever `project.target` says, independent of the branch the user is on, and finished task worktrees and
branches pile up next to the checkout. Users who want several runners on one branch must create one clone per
runner, and running from a feature branch requires editing the invocation file. The interactive OpenSpec and test
framework setup also writes into the start checkout.

## What Changes

- The run target becomes the branch checked out where the runner starts. Omitted `project.target` and
  `authority.target` resolve to it; a different given target is refused (exit 4, reason
  `target-differs-from-current-branch`); a detached HEAD is refused (`detached-head`); a branch missing on origin is
  refused (`target-missing-on-origin`). The resolved target is part of the frozen invocation identity and is
  recorded in every receipt as `target`.
- Target validation accepts every valid Git branch name (for example `release/1.2`), following
  `git check-ref-format --branch`; a name Git or the runner's rule rejects is refused with
  `unsupported-target-name`.
- The per-clone exclusive lock and ownership file are replaced by a per-invocation lock and per-invocation ownership
  file. A second process of the same invocation is still refused at once (`invocation-running`); different
  invocations run concurrently in one clone on one branch.
- Git operations on the shared repository (fetch, worktree add/remove, branch create/delete, claims ledger commits
  and pushes, task branch pushes) are serialized between runners of the same clone by a short per-clone Git lock,
  held only for one group of operations, waited for up to 60 seconds and released when its holder exits or crashes.
- Runners keep sharing tasks through the existing claims ledger, each invocation with its own claimant.
- The runner never changes the start checkout: the interactive OpenSpec layout creation and test framework setup
  write into a kept setup worktree `<primary>-outcomes/setup-<operation>` on `outcome/setup-...` instead.
- After a merged task's acceptance is confirmed, the runner removes the task worktree, the local task branch and
  the remote task branch; a cleanup failure is reported in the `accepted` event and never changes the result.
  Blocked and unfinished tasks keep their worktrees and branches.
- On start, the runner removes leftover worktrees and local branches of tasks its invocation already accepted.
- README replaces "Give each machine its own clone" with how to run many runners on one branch, explains that the
  target is the start branch and describes worktree cleanup and the setup worktree.

## Capabilities

### New Capabilities

- `concurrent-branch-runners`: start-branch target resolution and branch name rule, per-invocation locking and
  ownership, the shared per-clone Git lock, an unchanged start checkout, and task worktree and branch cleanup.

## Impact

- `src/run-paths.ts`: target resolution and refusal reasons.
- `src/model.ts`: `validBranchName` used by `validateConfig`.
- `src/runner.ts`: per-invocation lock and ownership, Git lock around shared Git groups, cleanup after
  acceptance, leftover sweep on start, receipt `target`.
- `src/git.ts`: receipt `target` field, `gc.auto=0` for runner Git commands; new `src/git-lock.ts` and
  `src/setup-worktree.ts`.
- `src/claims.ts`: ledger pull/acquire run under the Git lock.
- `src/openspec-preflight.ts`, `src/test-framework-preflight.ts`: Git operations under the Git lock, widened target
  rule, setup writes and install commands in the setup worktree.
- `test/`: new Git-fixture and scripted-adapter tests, updated preflight tests; `README.md`.
- No change to the claims ledger format or the queue format; exit code 4 gains the new refusal reasons.
