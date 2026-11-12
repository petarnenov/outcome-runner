# Tasks

## 1. Model

- [x] 1.1 `src/model.ts`: add `Work.integratedTargets?: string[]` and `Work.targetAttempts?: number` (design decision 1).

## 2. Host

- [x] 2.1 `src/runner.ts` `PullRequestHost.merge(pr, head, guard?)`; `src/git.ts` `GitHubHost.merge` awaits `guard?.()`
  after `settledMergeView` and the protection checks and immediately before `gh pr merge --merge --match-head-commit
  <head>` (decision 5). The scripted host of `test/support/runner-fixture.ts` stays unchanged (it does not call the
  guard).

## 3. Runner

- [x] 3.1 Replace `publishPasses` with the durable attempt number `(targetAttempts ?? 0) + 1` on every publish, `pr`
  and merge-stage line (decision 1).
- [x] 3.2 `recordIntegrated(target)` in the outside-scope merge and in the integrate `merge` step (decision 2).
- [x] 3.3 Outside-scope merge conflict: `git merge --abort` and start the integrate stage (decision 3).
- [x] 3.4 `compare ... with the integrated target` line as the first line of every publish pass, after `assertWork`
  and before the refresh, `integrate`, `setup` and `check` lines (decision 4).
- [x] 3.5 Attempt number on every worktree-merge `integrate` line (decisions 4 and 7): the outside-scope merge line in
  `integrateTarget` and the integrate stage's `merge` step line (`merging the advanced <target> into the task scope`)
  are both written with `(targetAttempts ?? 0) + 1`, so a retried in-scope merge logs `integrate ... (attempt N)`;
  the integrate stage reads the attempt from the durable work, so a restart keeps the number.
- [x] 3.6 Merge-stage comparisons through one helper `compareTarget(log)` (decision 5), exactly one comparison per
  view, in this order per view: `host.find`, the state and local head checks, `ready = pr.headRefOid === now.head`,
  `compareTarget(view === 1 || ready)` (an unchanged, not ready later view writes nothing; a difference always writes
  its line and goes to 3.7, so `retry` follows directly), then when ready `merge: merging #N` and
  `host.merge(pr, head, guard)`, otherwise the once-per-entry `wait: waiting for pull request head to match`. The
  `merge: merging #N` line stays the last step line before `host.merge`. Remove the old silent check
  (`if (refresh(work.id).target !== now.testedTarget) { save({ stage: 'publish' }); break; }`). Add the guard
  (`compareTarget(true)` throwing the private `TargetAdvanced`) and its catch as a failed comparison.
- [x] 3.7 Export `TARGET_ATTEMPTS = 5`; failed comparison handling with `retry` line, durable `targetAttempts`, block with
  `IntegrationFailure('target-keeps-advancing', [])` after saving stage `publish` and `targetAttempts: 0`; add the
  code to `IntegrationCode` and `INTEGRATION_REASONS` (decision 6).
- [x] 3.8 Adjust every existing test that asserts exact or adjacent step-line sequences, per-call publish pass
  numbers, the old merge-stage retry lines, or the step line written before a host call. Search all of `test/` for
  `deepEqual` / `slice` / `indexOf` / `lastStep` over step lines. Known changes, in `test/runner-steps.test.ts`:
  - `A (required): an accepted task writes the ordered step lines, each before the first effect of its step` (planned
    test 5.16): the expected list gains `'A compare: comparing origin/main with the integrated target'` between
    `'A commit: committing the receipt'` and the following `'A check: running 1/2: node'`, and
    `'A compare: comparing origin/main with the checked target'` between
    `'A wait: waiting for mergeability and checks of #1'` and `'A merge: merging #1'`; nothing else changes. The rule
    "the last step line before the `host merge` event is `A merge: merging #1`" stays as it is (the test's host does
    not call the guard, and the merge-stage `compare` line precedes `merge: merging #1`). The `host find` rule keeps
    its allowed set (`host.find` precedes the view's `compare` line). The line format regex already matches
    `A compare: ...` and `A retry: ...`.
  - `B (required): a target advance during the merge stage repeats the publish steps with (attempt 2)` (planned test
    5.13): the slice from `'A wait: waiting for mergeability and checks of #1'` becomes exactly
    `wait ... of #1`, `compare: comparing origin/main with the checked target`,
    `retry: origin/main advanced; integrating it again (attempt 2)`,
    `compare: comparing origin/main with the integrated target (attempt 2)`,
    `integrate: integrating the advanced main (attempt 2)`, `check: running 1/2: node (attempt 2)`,
    `check: running 2/2: node (attempt 2)`, `push: pushing the tested head (attempt 2)`,
    `pull request: finding the pull request (attempt 2)`, `pull request: reusing #1 (attempt 2)`,
    `wait: waiting for mergeability and checks of #1 (attempt 2)`,
    `compare: comparing origin/main with the checked target (attempt 2)`, `merge: merging #1 (attempt 2)`,
    `acceptance: recording the acceptance`, `cleanup: removing the worktree and branches` (each prefixed `A `).
  - Checked and expected unchanged (they filter by step or use relative indexes): the stale-views C test (filters
    `wait` and `merge` lines), the C test of a target advanced before publish, the implementation and documentation
    attempt C tests (their slices end before publishing), the resumed-run B test, and the tests of
    `test/target-scope-recovery.test.ts` (relative `at(...)` indexes; the resumed line after an integrate restart is
    still the integrate stage line). Any other sequence assertion found by the search is updated to decisions 4 and 5.

## 4. README

- [x] 4.1 Replace the advice not to merge into the target during a run; extend "When the target advances during a
  run", the blocker table, the step line list and the Development section (decision 9).

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. New tests live in
`test/merge-when-target-unchanged.test.ts` (the `GitHubHost` test may sit beside the stale-head tests in
`test/git-stale-head.test.ts` with the same stubbed `gh`); 5.13 and 5.16 are the adjusted existing tests of
`test/runner-steps.test.ts`. They use `runnerFixture` (bare origin, start checkout and `integrator` clone),
`scriptedWorker` hooks (`onSession`, `fail`, plus a wrapper that writes a resolution through `handleTool` when the
prompt contains `Resolve the merge conflicts`) and the scripted host, wrapped where needed: `find` or
`afterEffect('pr')` push a target commit from `integrator`; a wrapped `merge` pushes a target commit, then calls the
guard and only then delegates, like `GitHubHost.merge`. Step lines are captured with `RunOptions.steps`; session counts
come from `state.json` `sessions` by purpose; `checkoutState(root)` is compared before and after. Merge commits of a
target are counted on `origin/main` after `git fetch` in the start checkout, because acceptance deletes the task
worktree and branches.

### Grade E

- [x] 5.1 (E) (required) `explainUnfinished` with a blocked entry `{ reason: 'target-keeps-advancing' }` gives `kind`
  `blocked`, that `reason` and no `paths`; `TARGET_ATTEMPTS` is 5.
- [x] 5.2 (E) (required) No file under `src/` contains `Target changed outcome scope`.
- [x] 5.3 (E) (required) README section (spec scenario "README section", source criterion 8): `README.md` is read and
  its section under the heading `When the target advances during a run` is extracted. The README no longer advises
  against merging into the target during a run (no `do not merge` / `don't merge` / `avoid merging` wording about the
  target, case-insensitive, anywhere in the README), and the section names: owners may merge during a run (including
  inside a running task's scopes), the merge in the task worktree, the product checks, the implementation review for
  in-scope changes, the comparison with origin before merging, `--match-head-commit`, the limit of 5 attempts and
  `target-keeps-advancing`.

### Grade D

- [x] 5.4 (D) (required) Guard right before the merge command: `GitHubHost.merge` with a stubbed `gh` returning a
  CLEAN view calls the guard after the view and before `gh pr merge ... --match-head-commit <head>`; with a guard
  that throws, no `gh pr merge` call is recorded.
- [x] 5.5 (D) (required) Changed pull request head refuses the merge: from `afterEffect('pr')` a foreign commit is
  pushed to the task branch on origin; the task is blocked with `Checked head or target changed`, the host `merge`
  was never called and `origin/main` has no merge of the task.
- [x] 5.6 (D) (required) Advance outside the scopes merged and checked without review (spec scenarios "Advance
  outside the scopes is merged and checked without a new review" and "Retry is logged"): from `afterEffect('pr')`
  the target commits `docs/other.md`; the task is accepted, `integratedTargets` ends with that commit, the product
  check lines follow the `integrate` line with `(attempt 2)` and precede the second push, review and document-review
  session counts equal those of a run without an advance, and `checkoutState(root)` is unchanged. Step log: a
  publish `compare` line (`... with the integrated target`) before the first merge request; the step line directly
  before `retry (attempt 2)` is a merge-stage `compare` line (`comparing origin/main with the checked target`)
  without an attempt suffix, i.e. the comparison that found the difference is logged; directly after the retry
  comes `compare: comparing origin/main with the integrated target (attempt 2)`, then `integrate ... (attempt 2)`;
  the line directly before the second `merge: merging #1 (attempt 2)` is
  `compare: comparing origin/main with the checked target (attempt 2)`.
- [x] 5.7 (D) (required) Polling stays quiet (spec scenario "Polling stays quiet"): the scripted host's `find` is
  wrapped so that on the first two merge-stage views it returns the recorded pull request with a `headRefOid` that
  differs from the tested head (for example a constant 40-character fake SHA), and from the third view on it
  delegates to the scripted host. It must not return `null` (the merge stage treats a missing pull request as
  `Recorded PR missing` and blocks) and must not rely on mergeability (the merge stage keeps polling only while
  `pr.headRefOid !== tested head`). Origin's task branch is left at the tested head, so `assertOriginHead` passes,
  and `mergePolling.delay` is the fixture's no-op. The target stays unchanged. Assertions: the merge-stage task lines
  from `wait: waiting for mergeability and checks of #1` to `merge: merging #1` are exactly `wait: waiting for
  mergeability and checks of #1`, `compare: comparing origin/main with the checked target` (view 1),
  `wait: waiting for pull request head to match`, `compare: comparing origin/main with the checked target` (view 3,
  the ready view), `merge: merging #1` (view 2 wrote nothing); no `retry` line appears; and the task is accepted.

### Grade C

- [x] 5.8 (C) (required) Advance inside the scopes while waiting: from `afterEffect('pr')` the target commits
  `src/a/notes.md`; `origin/main` (after fetch) contains the commit through an `integrate main into A` merge made in
  the task worktree; the step log has a merge-stage `compare ... with the checked target` line directly before
  `retry (attempt 2)`, then `compare ... with the integrated target (attempt 2)` and the integrate stage's merge-step
  line `A integrate: merging the advanced main into the task scope (attempt 2)`; the product checks and one extra
  implementation review session run after that `integrate` line and before the next push; no blocked entry or state
  field contains `Target changed outcome scope`; the task is accepted; and `checkoutState(root)` is unchanged.
- [x] 5.9 (C) (required) Origin advances between the check and the merge: the wrapped host `merge` pushes an
  outside-scope target commit and calls the guard on its first call only; the first merge is not delegated, the
  step lines around it are `compare ... with the checked target`, `merge: merging #1`, the guard's
  `compare ... with the checked target`, `retry ... (attempt 2)` in that order with nothing between them; the runner
  integrates, checks and compares again, the second `merge` call receives the new tested head (different from the
  first), `completed.A.targetAttempts` is 1, and `origin/main` contains both the advance and the task.

### Grade B

- [x] 5.10 (B) (required) Attempt limit: the wrapped host `merge` advances the target and calls the guard on every
  call; after the fifth failed comparison the task is blocked with `target-keeps-advancing` (state and result
  blocker), no merge was delegated, `retry` lines carry attempts 2 to 5, the blocked work has stage `publish` and
  `targetAttempts` 0, and the worktree, local branch and remote branch exist. Running the same invocation again
  with the plain scripted host merges and accepts the task in the same worktree.
- [x] 5.11 (B) (required) Conflict while waiting: from `afterEffect('pr')` the target commits a different
  `src/a/result.mjs`; the merge-stage `compare` line that finds the difference comes directly before
  `retry (attempt 2)`; (a) the resolution session writes a merged file, the checks and the implementation review
  run after it and the task is accepted with the resolved content on `origin/main`; (b) the resolution session fails
  and the task is blocked with `target-conflict-unresolved` and `paths` `['src/a/result.mjs']`, nothing merged.
- [ ] 5.12 (B) (coverage-only) Conflicting outside-scope merge is handed to the integrate stage: from
  `afterEffect('pr')` the integrator commits a file at `evidence/results/A.json/extra` on `origin/main`. The task
  branch already has the receipt file `evidence/results/A.json` (an unguarded path the task changed), so the
  worktree merge hits a directory/file conflict there, while `receiptAt` on the target finds no receipt file at
  `evidence/results/A.json` (it is a directory) and `accepted(target, task)` does not throw. The outside-scope merge
  is aborted (no `MERGE_HEAD` left by it), the integrate stage records the conflict and, because the path lies
  outside the task scopes, blocks with `target-conflict-unresolved` without any resolution session. The blocked
  `paths` are asserted loosely, because Git's merge-ort strategy may record the file side under a renamed path such
  as `evidence/results/A.json~HEAD`: `paths` is non-empty and every entry starts with `evidence/results/A.json`
  (the exact path `evidence/results/A.json` is not required). not needed: coverage reached
- [x] 5.13 (B) (required) Adjusted existing test `B (required): a target advance during the merge stage repeats the
  publish steps with (attempt 2)` in `test/runner-steps.test.ts` (spec scenario "Retry is logged"; task 3.8): the
  slice from `A wait: waiting for mergeability and checks of #1` equals the 15 lines listed in task 3.8, `advanced`
  is 1 and no line contains `resuming`.

### Grade A

- [x] 5.14 (A) (required) Restart resumes from the recorded target commit: an in-scope advance from
  `afterEffect('pr')` whose target commit `T` is remembered; the first run is cancelled from
  `afterEffect('integrate')` right after the merge step is recorded. The first run's step log has the integrate line
  `A integrate: merging the advanced main into the task scope (attempt 2)`. `state.json` `current` has `T` last in
  `integratedTargets` and `targetAttempts` 1. Running the same invocation again accepts the task, and no second
  merge of `T` was made: after `git fetch -q origin` in the start checkout,
  `git rev-list --merges --parents origin/main` lists exactly one commit whose second parent is `T` (the integrate
  merge; the pull request merge has the task head as its second parent), and `T` appears exactly once in
  `state.json` `completed.A.integratedTargets`. The task branch itself is not inspected, because acceptance deletes
  the worktree, the local branch and the remote task branch. The rerun's first `A` step line matches
  `/A (setup|check): resuming/`; the rerun's publish `compare ... with the integrated target` line carries
  `(attempt 2)`.
- [ ] 5.15 (A) (coverage-only) Two advances then an unchanged target: the wrapped `merge` advances the target on its
  first two calls; `targetAttempts` reaches 2, `integratedTargets` has two entries and the task is accepted on the
  third attempt. not needed: coverage reached
- [x] 5.16 (A) (required) Adjusted existing test `A (required): an accepted task writes the ordered step lines, each
  before the first effect of its step` in `test/runner-steps.test.ts` (spec scenarios "Publish comparison without an
  advance" and "Order without an advance"; task 3.8): the expected list has the two new `compare` lines at the
  positions given in task 3.8 (and in design decision 5), the last step line before every `host merge` event is still
  exactly `A merge: merging #1`, the `host find` allowed set is unchanged, and all other assertions of the test stay
  as they are.

## 6. Verification after binding

- [x] 6.1 Run `npm run typecheck`.
- [x] 6.2 Run `npm test` with the coverage gate at 85%.
