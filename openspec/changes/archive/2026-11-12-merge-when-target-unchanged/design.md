# Design: Merge the advanced target in the worktree and merge only while origin is unchanged

## Context

`runSteps` in `src/runner.ts` (after OR-20):

- `publish`: `refresh(work.id)` fetches `origin/<target>` in the start checkout's repository (only remote-tracking
  refs change) and `integrateTarget(work, target, pass)` merges it in the task worktree. Outside the guarded paths the
  merge is committed and the setup checks run (`'merged'`); inside them the durable `integrate` stage starts
  (`'integrate'`: merge, optional resolution session, setup and product checks, implementation review, documentation
  review, receipt again). Then the final product checks run, the head is pushed and `head` / `testedTarget` are saved.
- `merge`: writes `wait: waiting for mergeability and checks of #N` once on entry, then a polling loop finds the pull
  request, checks the local head, compares `refresh().target` with `testedTarget` (a difference saves `publish` and
  continues), and when the PR head equals the tested head writes `merge: merging #N` and calls `host.merge(pr, head)`;
  otherwise it writes `wait: waiting for pull request head to match` once per entry. `GitHubHost.merge` polls
  `settledMergeView` (up to 100 views, 3 s apart) and then runs `gh pr merge --merge --match-head-commit <head>`.
- `publishPasses` counts publish passes per call only; `Target changed outcome scope` is no longer produced.

Gaps: no comparison right before the merge command, no bound on repeats, no durable record of integrated targets,
no compare/retry step lines (the per-view comparison in the merge stage is silent), and a conflicting outside-scope
merge throws a generic error.

## Goals / Non-Goals

Goals: merge only an exact checked combination (checked head on top of a checked target), bounded repeats with
`target-keeps-advancing`, durable integrated-target record and attempt counter, no silent comparison with origin
(every comparison that can lead to a merge or a retry is logged) while repeated polling stays quiet, logged retries,
conflicts of any worktree merge handled by the integrate stage, README update.

Non-goals: rebasing or force-pushing; changing the OR-20 integrate steps (in-scope advances keep both reviews);
budgets for integration checks; GitHub merge queues.

## Decisions

### 1. Durable fields (`src/model.ts`)

```ts
interface Work {
  ...
  /** Every origin/<target> commit merged into the task branch, oldest first. */
  integratedTargets?: string[];
  /** Consecutive comparisons that found origin/<target> different from the checked target. */
  targetAttempts?: number;
}
```

The attempt number of a publish pass is `(targetAttempts ?? 0) + 1`; it replaces the per-call `publishPasses` map, so
the numbering survives a restart. `testedTarget` stays the checked target compared before merging. Every step line
of the publish, `pr` and merge stages (`compare`, `integrate`, `check`, `push`, `pull request`, `wait`, `merge`)
carries this attempt number.

### 2. Recording integrated targets

A helper `recordIntegrated(target)` appends `target` to `integratedTargets` unless it is already the last entry, in the
same `save` as the effect it belongs to:

- outside-scope merge in `integrateTarget`: after the merge commit, before the setup checks;
- integrate stage step `merge`: in the existing `save({ base, integration })`.

A restart therefore resumes from the last integrated target: `integrateTarget` returns `'contained'` when `HEAD`
already contains it and the integrate stage never merges it twice (existing `MERGE_HEAD` / ancestor checks).

### 3. Conflicts of an outside-scope merge

When the outside-scope `git merge` fails and `unmergedPaths(work)` is non-empty, the runner runs `git merge --abort`
and starts the integrate stage exactly like an in-scope advance (same `save` as OR-20 decision 1) and returns
`'integrate'`. The integrate `merge` step merges again, records the conflicts and moves to `resolve`, so the worker
gets one resolution session (or the task is blocked with `target-conflict-unresolved` and the paths, also at once
when a path lies outside the scopes), followed by the checks and reviews. A failed merge without unmerged paths is
rethrown as before.

### 4. Comparison before publishing

In `publish`, after `assertWork` and before the refresh, the runner writes
`taskStep(id, 'compare', 'comparing origin/<target> with the integrated target', attempt)`, then refreshes and calls
`integrateTarget` (which writes its `integrate` line, with the same attempt number, only when the target differs).
The exact order of one publish pass is therefore:

1. `compare: comparing origin/<target> with the integrated target`
2. `integrate: integrating the advanced <target>` (only when the target differs and lies outside the guarded paths;
   an in-scope advance continues in the integrate stage, whose lines follow, and the next publish pass starts again
   at 1)
3. `setup` lines (only after an outside-scope merge, when setup commands exist)
4. `check: running i/n: ...` (final product checks)
5. `push: pushing the tested head`

The line is written on every publish pass, including the first one of a run without any advance.

### 5. Comparisons in the merge stage: none silent, polling quiet

Every comparison of `origin/<target>` with `testedTarget` in the merge stage goes through one helper; whether it
writes a `compare` line depends only on where it runs:

```ts
const attempt = (): number => (activeWork().targetAttempts ?? 0) + 1;
const compareTarget = (log: boolean): boolean => {
  const target = refresh(work.id).target;
  const unchanged = target === activeWork().testedTarget;
  if (log || !unchanged) taskStep(work.id, 'compare', `comparing origin/${project.target} with the checked target`, attempt());
  return unchanged;
};
```

Each view of the polling loop makes exactly one comparison. The loop's `view` counter starts at 1 on every entry into
the merge stage (each iteration of `runSteps` that reaches `merge`, including after a retry or a restart). Per view:

1. `host.find`, the PR state checks and the local head check (unchanged; no step line).
2. `ready = pr.headRefOid === now.head`.
3. `compareTarget(view === 1 || ready)`: the first view of the entry and the view that leads to the merge request are
   always logged; any other view writes a line only when it finds a difference. An unchanged later view that is not
   ready writes nothing, so repeated polling stays quiet.
4. A difference is a failed comparison (decision 6): its `compare` line is followed directly by the `retry` line
   and the stage becomes `publish`. No other step line is written in between.
5. When `ready`: `merge: merging #N`, then `host.merge(pr, head, guard)`. The comparison of step 3 is the one made
   right before calling `host.merge`; there is no second comparison in the same view.
6. When not ready: `wait: waiting for pull request head to match` (once per entry, as today), then the origin head
   assertion and the poll delay.

`host.merge(pr, head, guard)` receives `guard = () => { if (!compareTarget(true)) throw new TargetAdvanced(); }`.
`PullRequestHost.merge` gains the optional third parameter. `GitHubHost.merge` calls `await guard?.()` after
`settledMergeView` and the protection checks and immediately before `gh pr merge --merge --match-head-commit <head>`;
a throwing guard means no merge command. The runner catches `TargetAdvanced` (a private `Error` subclass) from
`host.merge` as a failed comparison, so the guard's `compare` line is followed directly by the `retry` line. The
scripted test host of `test/support/runner-fixture.ts` stays unchanged and does not call the guard; tests that need
the guard wrap `merge`.

The exact order of step lines in one merge-stage entry is therefore:

| # | Line | When |
|---|---|---|
| 1 | `wait: waiting for mergeability and checks of #N` | once on entry, before the first `host.find` |
| 2 | `compare: comparing origin/<target> with the checked target` | view 1 always; later views only when ready or when the target differs |
| 3a | `retry: origin/<target> advanced; integrating it again` | directly after a `compare` line that found a difference; the entry ends |
| 3b | `wait: waiting for pull request head to match` | after the `compare` line of the first view that is not ready (once per entry) |
| 3c | `merge: merging #N` | after the `compare` line of the ready view; it is the last step line before `host.merge` is called |
| 4 | `compare: comparing origin/<target> with the checked target` | inside `host.merge`, written by the guard right before `gh pr merge`; only for hosts that call the guard |
| 5 | `retry: ...` | directly after the guard's `compare` line when it found a difference |

For a run without any advance whose first view is ready, the publish and merge part of the log is exactly:

```
A commit: committing the receipt
A compare: comparing origin/main with the integrated target
A check: running 1/2: node
A check: running 2/2: node
A push: pushing the tested head
A pull request: finding the pull request
A pull request: creating the pull request
A wait: waiting for mergeability and checks of #1
A compare: comparing origin/main with the checked target
A merge: merging #1
A acceptance: recording the acceptance
A cleanup: removing the worktree and branches
```

The merge itself is unchanged: always the exact tested head with `--match-head-commit`, and a PR head that differs
from the tested head while origin's task branch is elsewhere still blocks with `Checked head or target changed`
without merging.

### 6. Retry and the attempt limit

Exported `TARGET_ATTEMPTS = 5`. On a failed comparison:

```ts
const attempts = (activeWork().targetAttempts ?? 0) + 1;
if (attempts >= TARGET_ATTEMPTS) {
  save({ stage: 'publish', targetAttempts: 0 });
  throw new IntegrationFailure('target-keeps-advancing', []);
}
taskStep(work.id, 'retry', `origin/${project.target} advanced; integrating it again`, attempts + 1);
save({ targetAttempts: attempts, stage: 'publish' });
```

So attempts 1 to 4 that end with an advanced target are repeated, and the fifth consecutive one blocks (its `compare`
line is the last task line before `blocked: stopped at publish`). The blocked entry keeps stage `publish` with a reset
counter, so the worktree, local branch and remote branch are kept (blocked work is never cleaned up) and a restart
that recovers the work continues with the worktree merge of the current target and five fresh attempts.
`IntegrationCode` gains `target-keeps-advancing`, and `INTEGRATION_REASONS` includes it, so `explainUnfinished`
reports the blocker with that reason (no paths). `targetAttempts` is reset to 0 only by the block; an accepted task
keeps its final count in `completed`.

### 7. Step lines

| Step | Message | When (order as in decisions 4 and 5) |
|---|---|---|
| `compare` | `comparing origin/<target> with the integrated target` | first line of every publish pass, before any `integrate`, `setup` or `check` line of that pass |
| `compare` | `comparing origin/<target> with the checked target` | merge stage, after `wait: waiting for mergeability ...`: the first view of each entry; the ready view, directly before `merge: merging #N`; every other view that finds a difference; and in the guard, after `merge: merging #N` and before `gh pr merge` |
| `retry` | `origin/<target> advanced; integrating it again` | each repeat, with the next attempt number, directly after the `compare` line of the failed comparison and directly before the next publish `compare` line |
| `integrate` | existing messages | each worktree merge, with the attempt number, after the publish `compare` line |

All `compare` lines carry the current attempt `(targetAttempts ?? 0) + 1`. Attempt suffixes follow `createStepLog`
(` (attempt N)` from 2 on). Lines name only the target branch, never commits. No comparison with origin is made
without a line except an unchanged, not ready later polling view of the same merge-stage entry, which follows an
already logged comparison of that entry. `merge: merging #N` stays the last step line written before `host.merge` is
called.

### 8. Start checkout untouched

All merges, commits and checks run with `cwd` = the task worktree. The start checkout only sees `git fetch origin
<target>`, which updates `refs/remotes/origin/<target>` and never its HEAD, branch, index or working tree.

### 9. README

The advice not to merge into the target during a run (and any equivalent wording) is replaced: owners may merge,
including inside a running task's scopes; the runner integrates the advance in the task worktree, checks (and for
in-scope changes reviews) the merged result, compares with origin before publishing and immediately before merging,
merges only the exact checked head with `--match-head-commit` while origin is unchanged, repeats up to 5 attempts,
then blocks with `target-keeps-advancing`; `integratedTargets` and `targetAttempts` in `state.json`; the new step
lines; the blocker table lists `target-keeps-advancing`.

## Risks / Trade-offs

- A busy target can block a task after 5 attempts; the restart continues where it stopped, so no work is lost.
- The guard adds a fetch right before every merge; it is one Git group under the lock.
- The documentation review still runs for in-scope advances (OR-20); kept to avoid weakening existing guarantees.
- Unchanged later polling views are not logged, to keep the log readable during long waits; the entry's first view,
  the ready view and every difference are logged, so the log still shows each comparison that decided anything.
- Existing tests that assert exact step-line sequences change (task 3.8); the new sequences are given in decision 5
  and task 3.8.

## Test approach

`test/merge-when-target-unchanged.test.ts` with `runnerFixture`, `scriptedWorker` hooks and the scripted host. The
target is advanced by committing in `integrator` and pushing to `origin/main` from `afterEffect('pr')`, from a wrapped
host `find`, or from a wrapped host `merge` that pushes and then calls the guard before delegating (mimicking
`GitHubHost.merge`). When the target is advanced from `afterEffect('pr')`, the difference is found by the first
merge-stage view comparison, so the tests assert its `compare` line directly before `retry (attempt 2)`.
`GitHubHost.merge` guard ordering is tested with the stubbed `gh` used by `test/git-stale-head.test.ts`. Restarts run
`runQueue` again after an `AbortController` cancellation. Merge commits of a target are counted in the history of
`origin/main` after a fetch (the task branch is deleted on acceptance). `checkoutState(root)` is compared before and
after each run.
