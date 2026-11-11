# Design: Recover when the target advances into a task scope

## Context

`runSteps` in `src/runner.ts` handles a target advance only in the `publish` stage, through `integrateTarget(work,
target)`:

- if `HEAD` already contains the target, nothing happens;
- otherwise the files changed between `work.base` and the target are compared with the guarded paths (task scopes,
  the change directory, and after the archive the archived directory and the spec files the archive wrote). An
  overlap throws `Target changed outcome scope`, which blocks the task. Without an overlap the target is merged with
  a `chore(...): integrate <target> into <id>` commit and the setup checks run; publish then runs the final checks and
  pushes.

The `merge` stage already returns to `publish` when `origin/<target>` differs from `testedTarget` (that covers "while
waiting for checks" and "before merge"), so every advance passes through `integrateTarget`. The receipt is written
in the `receipt` stage *before* `publish`, with `base: work.base` and a manifest of `git diff work.base..HEAD`.
`receiptAt` checks the manifest hashes at the first-parent commit of the target that added the receipt, so a receipt
written before an in-scope merge would no longer match the merged files.

## Goals / Non-Goals

Goals: replace the in-scope block with an automatic merge plus new checks and reviews; one worker session to resolve
conflicts; a precise blocker (`target-conflict-unresolved` with the paths) when that fails; restart-safe durable
steps; outside-scope advances behave as before.

Non-goals: rebasing or force-pushing (the branch only gets merge commits, so pushes stay fast-forward); integrating
the target during the stages before `publish`; more than one resolution session per attempt; repair sessions after a
failed re-check of a clean merge.

## Decisions

### 1. Detection in `integrateTarget`

`integrateTarget(work, target, attempt)` keeps its first two steps (already contained: return; changed files from
`activeWork().base` to `target`, compared with the guarded paths). Without an overlap it still merges, runs the setup
checks and returns `'merged'`; `work.base` is not changed (unchanged behaviour). With an overlap it no longer throws.
It saves:

```ts
save({ stage: 'integrate', integration: { target, previousBase: activeWork().base, conflicts: [], step: 'merge',
  outcome: 'clean' }, review: undefined, checks: undefined, finalChecks: undefined, documentationChecks: undefined,
  head: undefined, testedTarget: undefined, findings: [] });
```

and returns `'integrate'`. The publish block then `continue`s the outer loop (like the merge stage does when it
returns to publish), so the next iteration enters the `integrate` block. Clearing the earlier acceptance here is what
guarantees that it is never reused: the receipt stage requires `now.review` and the pull request body and merge use
`head` and `testedTarget`, which are only set again after the new checks and reviews.

The `pr` record is kept, so the open pull request is reused and updated by the next push.

### 2. Durable integration record

`src/model.ts`:

```ts
export type Stage = ... | 'integrate' | 'receipt' | 'publish' | 'pr' | 'merge';
export type IntegrationStep = 'merge' | 'resolve' | 'checks' | 'review' | 'document-review';
export interface IntegrationRecord {
  target: string;          // the origin/<target> commit being merged
  previousBase: string;    // work.base before this integration
  conflicts: string[];     // sorted conflicting paths; [] for a clean merge
  outcome: 'clean' | 'conflict';
  step: IntegrationStep;
}
interface Work { ...; integration?: IntegrationRecord; integrations?: IntegrationRecord[] }
```

Each finished integration is appended to `integrations` (history, also used by tests) when the integrate stage moves
to `receipt`. `src/run-store.ts`: `BlockedEntry` gains `paths?: string[]`.

Every step saves its successor before the next effect, so a restart (a new `runQueue` of the same invocation, or a
later run that recovers the blocked or current work) resumes at the recorded step. The `integrate` block sits in
`runSteps` before the `receipt` block and is a `while (activeWork().stage === 'integrate')` over the steps below.

### 3. Step `merge`

Under the Git lock nothing is needed (the worktree is task-local). In the task worktree:

1. If `MERGE_HEAD` exists (`git rev-parse -q --verify MERGE_HEAD`), the merge was started before a restart: go to
   the conflict branch with the current unmerged paths.
2. Else if `git merge-base --is-ancestor <integration.target> HEAD` succeeds, the merge was committed before a
   restart: treat it as clean.
3. Else run `git merge --no-edit -m <chore integrate subject> <integration.target>`.
   - Success: clean.
   - Failure: `conflicts = git diff --name-only --diff-filter=U` (split, sorted, unique). If empty, the failure is
     not a conflict and is rethrown (normal blocked entry).

Then `save({ base: integration.target, integration: { ...integration, conflicts, outcome, step } })` with `step`
`checks` for clean and `resolve` for a conflict. This is the point where the new base is recorded. A step line
`integrate` (`merging the advanced <target> into the task scope`) is written first, and `afterEffect('integrate',
activeWork())` runs after the save so tests can interrupt between steps.

### 4. Step `resolve` (conflicts only)

1. If a conflicting path is outside `work.scopes` (for example the archived change directory, the receipt or spec
   files), the worker cannot write it: throw the unresolved-conflict error (decision 7) without a session.
2. One `work` session (`taskStep(id, 'implementation', 'starting the conflict resolution session')`) with the task
   prompt plus: `Resolve the merge conflicts of the advanced <target> in these paths: <JSON paths>. Keep the intent of
   both sides, remove every conflict marker and keep all approved OpenSpec scenarios and tests passing. Write only
   inside the task scopes.` and the work test instructions. A thrown session (`Worker work incomplete` or any
   non-interrupted error) is converted to the unresolved-conflict error. A cancelled or interrupted session keeps the
   step, so a restart runs the session again; only a session that ended counts as the one session.
3. After the session: every conflicting path that exists must contain no line starting with `<<<<<<< ` or
   `>>>>>>> ` (helper `conflictMarkers(text): boolean`, exported for unit tests). Then `git add -A --` the
   conflicting paths; if `MERGE_HEAD` still exists, `git commit --no-edit -m <chore integrate subject>`. Any remaining
   unmerged path, a missing `MERGE_HEAD` while `HEAD` does not contain the target, or markers throw the
   unresolved-conflict error.
4. `save({ integration: { ...integration, step: 'checks' } })`.

`commit(work)` (used by `run_checks` inside the session) adds only those of `work.scopes` and `work.directory` that
exist in the worktree or are tracked, so it no longer fails after the archive removed `work.directory`. Inside an
unfinished merge such a commit concludes the merge; step 3 accepts that because it checks that `HEAD` contains the
target.

### 5. Steps `checks`, `review`, `document-review`

- `checks`: `checks(work, project.setup)` then `runProductChecks(work)`; the rows are saved as `checks` and
  `documentationChecks` (the receipt uses `documentationChecks ?? checks`). A failure throws.
- `review`: one `review` session with `implementationReview = true` and the implementation review prompt used by the
  work stage (it starts with `Review actual implementation`) plus `The task branch was merged with the advanced
  <target> (previous base <previousBase>, new base <base>, conflicts <JSON paths>); review the merged result.`.
  Accepted with zero findings: `save({ review: { ...review, accepted: true }, reviews: [...reviews, review] })`.
  Otherwise the findings are saved and the step throws.
- `document-review`: one `document-review` session with the documentation review prompt (`Review the documentation
  changes ...`) plus the same integration sentence. Accepted with zero findings: append to `documentationReviews`,
  append the integration to `integrations`, and `save({ integration: undefined, stage: 'receipt' })`. Otherwise the
  step throws.

The `diff` context section uses `work.base`, which is now the merged target, so the reviewers see the task's changes
relative to the new target.

### 6. Receipt after an integration

The receipt stage reads `activeWork()` (not the loop's `work` object, whose `base` is stale) for `base` and the
manifest. The manifest excludes `receiptPath(work.id)`, because after an integration the earlier receipt commit is
in `base..HEAD`. The receipt is written again and committed only when it changed (`git diff --cached --name-only`).
Then publish runs: `integrateTarget` finds the target contained (or starts another integration if the target
advanced again), the final checks run, the head is pushed fast-forward and `head`/`testedTarget` are recorded.

### 7. Blocking reasons

An `IntegrationFailure extends Error` carries `code` and `paths`:

- conflict (`outcome: 'conflict'`): any failure of steps `resolve`, `checks`, `review` or `document-review` throws
  `code: 'target-conflict-unresolved'`, `paths: integration.conflicts`, message `target-conflict-unresolved`;
- clean (`outcome: 'clean'`): a failure of `checks`, `review` or `document-review` throws
  `code: 'target-integration-rejected'`, `paths: []`.

The catch block of the task loop stores `{ reason: error.message, paths, work }` in `blocked` (paths only when
present), writes the usual blocked step line and reports `{ status: 'blocked', id }` with detail `{ reason }`. Other
errors are unchanged. Cancellation still returns `cancelled` without blocking.

`explainUnfinished` accepts `blocked[id].reason` and `paths`: when the reason is `target-conflict-unresolved` or
`target-integration-rejected`, the blocker has that `reason` and (for the conflict) `paths`; every other blocked
task keeps reason `operation-incomplete`. `Blocker` gains `paths?: string[]`.

A later run that recovers the blocked work resumes at the recorded step like any other blocked work (so it gets
another resolution session); this is the existing retry behaviour for blocked tasks.

### 8. Where the advance is noticed

- before publish: the target moved before the `publish` stage started;
- while waiting for checks / before merge: the merge stage sees `refresh().target !== testedTarget`, saves `publish`
  and continues; publish then calls `integrateTarget`.

All three enter the same `integrate` stage; nothing in the merge stage changes.

### 9. README

A section "When the target advances during a run" explains: outside-scope changes are merged and checked; in-scope
changes are merged, the new base is recorded, checks plus implementation and documentation reviews run again before
the pull request is published or updated; conflicts get one worker session; reasons `target-conflict-unresolved`
(with paths) and `target-integration-rejected`; recovery resumes after a restart; earlier acceptances are never
reused.

## Risks / Trade-offs

- Extra review sessions cost tokens on every in-scope advance; that is the price of not reusing stale acceptances.
- A conflict in the archived change or spec files cannot be resolved by the worker and blocks at once; such conflicts
  mean another change edited the same OpenSpec files, which needs a person anyway.
- A clean merge that fails its re-check blocks without a repair session (kept simple; a later run retries).

## Test approach

Git fixture tests with `runnerFixture`, scripted adapters (`scriptedWorker` hooks plus a wrapper that writes the
resolution through `handleTool`) and the scripted host. The target is advanced by committing in the fixture's
`integrator` clone and pushing to `origin/<target>`, triggered from `afterEffect` (`archive`, `pr`, `integrate`) or
from a wrapped host `find` during the merge wait. Restarts run `runQueue` again with the same config after a
cancellation through an `AbortController`.
