# Proposal: Merge the advanced target in the worktree and merge only while origin is unchanged

## Why

Owners want to keep merging pull requests into the target while invocations run, including changes inside a running
task's scopes. OR-20 already merges an advanced target into the task branch (in-scope advances get checks and
reviews again, conflicts get one resolution session) instead of blocking with `Target changed outcome scope`. Three
gaps remain:

1. The last comparison of `origin/<target>` with the checked target happens before `host.merge`, but
   `GitHubHost.merge` can then poll the pull request for minutes before `gh pr merge`. A target that advances in that
   window is merged untested together with the task head.
2. A target that keeps advancing makes the runner loop between merge and publish without a bound.
3. The durable state does not record which target commits were integrated, the comparisons (including the per-view
   comparison while waiting to merge) and retries are not logged, and a conflicting merge of an outside-scope advance
   fails with a generic error. The README still tells owners to avoid merging into the target during a run.

## What Changes

- Before publishing and again immediately before merging, the runner fetches `origin/<target>` and compares it with
  the target commit it last integrated and checked (`testedTarget`). The pre-merge comparison runs right before the
  merge command: the pull request host receives a target guard that `GitHubHost.merge` calls after its settled view
  and before `gh pr merge --match-head-commit <tested head>`; the runner also compares in the pull request view that
  leads to calling `host.merge`.
- A changed target is merged into the task branch inside the task worktree (never in the start checkout), and the
  frozen product checks run on the merged result; an in-scope change also gets the implementation review again
  (existing OR-20 integrate stage). The merge, checks and comparison then repeat.
- Consecutive failed comparisons are counted durably (`targetAttempts`). After 5 attempts without an unchanged
  target the task is blocked with reason `target-keeps-advancing`; its worktree and branches are kept and a restart
  continues with a fresh attempt count.
- Each integrated target commit is appended to `integratedTargets` in `state.json`, so a restart resumes from the
  last one.
- A conflicting merge of an outside-scope advance is handed to the integrate stage, so every conflict gets one
  resolution session or blocks with `target-conflict-unresolved` and its paths.
- Step lines: `compare` for each comparison with origin (no comparison is silent; every publish pass starts with
  one; while polling the pull request, the first view of each merge-stage entry, the view that leads to the merge
  request and every view that finds a difference are logged, unchanged repeats stay quiet), `retry` for each repeat
  (with the attempt number, directly after the `compare` line that found the difference), and the existing
  `integrate` line for each worktree merge, carrying the attempt number when retried. `merge: merging #N` directly
  follows its `compare` line and stays the last line before the merge request.
- README: replaces the advice not to merge into the target during a run with how the runner integrates an advanced
  target, the pre-merge comparison, the attempt limit and `target-keeps-advancing`.

## Capabilities

### New Capabilities

- `merge-when-target-unchanged`: integrating an advanced target in the task worktree and merging only while
  `origin/<target>` equals the checked target.

### Modified Capabilities

None. The OR-20 `target-scope-recovery` requirements stay as they are; this change adds the comparison, the retry
bound and the durable record around them.

## Impact

- `src/runner.ts`: merge stage comparison helper and guard, retry counter and blocking, publish attempt numbering,
  durable `integratedTargets`, conflict hand-off of outside-scope merges, new step lines, `target-keeps-advancing` in
  `explainUnfinished`.
- `src/git.ts`: `GitHubHost.merge(pr, head, guard?)` calls the guard right before `gh pr merge`.
- `src/model.ts`: `Work.integratedTargets`, `Work.targetAttempts`.
- `test/merge-when-target-unchanged.test.ts` (new) and adjustments of existing tests that assert exact or adjacent
  step-line sequences, per-call publish pass numbers or the step line before a host call (notably
  `test/runner-steps.test.ts`).
- `README.md`.
