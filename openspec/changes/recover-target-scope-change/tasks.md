# Tasks

## 1. Model and state

- [ ] 1.1 `src/model.ts`: add `integrate` to `Stage` (before `receipt`), `IntegrationStep`, `IntegrationRecord` and
  `Work.integration` / `Work.integrations` (design decision 2).
- [ ] 1.2 `src/run-store.ts`: `BlockedEntry` gains optional `paths: string[]`.

## 2. Runner

- [ ] 2.1 `integrateTarget` (decision 1): read the base from `activeWork()`; outside-scope advances unchanged
  (`'merged'`); in-scope advances save the `integrate` stage with a fresh `integration` record, clear `review`,
  `checks`, `finalChecks`, `documentationChecks`, `head`, `testedTarget` and `findings`, and return `'integrate'`;
  the publish block then `continue`s the loop. Remove `Target changed outcome scope`.
- [ ] 2.2 Integrate stage step `merge` (decision 3): restart-safe detection of `MERGE_HEAD` and of an already merged
  target, `git merge`, sorted unmerged paths, save `base` and the next step, `afterEffect('integrate', work)`.
- [ ] 2.3 Step `resolve` (decision 4): outside-scope conflicts fail at once; one `work` session with the
  `Resolve the merge conflicts` prompt; export `conflictMarkers(text)`; stage and conclude the merge; verify no
  unmerged path and that `HEAD` contains the target. `commit(work)` adds only existing or tracked paths.
- [ ] 2.4 Steps `checks`, `review`, `document-review` (decision 5), then append to `integrations` and move to
  `receipt`.
- [ ] 2.5 Receipt (decision 6): use `activeWork()` for `base`, exclude the receipt path from the manifest, commit only
  when the receipt changed.
- [ ] 2.6 Blocking (decision 7): `IntegrationFailure` with `code` and `paths`; the catch block stores `reason` and
  `paths`; `explainUnfinished` and `Blocker` carry `target-conflict-unresolved` / `target-integration-rejected` and
  `paths`; every other blocked task keeps `operation-incomplete`.
- [ ] 2.7 Update existing tests that expected `Target changed outcome scope` to the new behaviour.

## 3. README

- [ ] 3.1 Add the section "When the target advances during a run" (decision 9).

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Tests live in
`test/target-scope-recovery.test.ts` and use `runnerFixture` (Git fixture with a bare origin and an `integrator`
clone), scripted adapters (`scriptedWorker` plus a wrapper that writes the resolution through `handleTool` when the
prompt contains `Resolve the merge conflicts`, or reports `changes-required` / fails for chosen prompts) and the
scripted pull request host. The target is advanced by committing in `integrator` and pushing to `origin/main`, from
`afterEffect` (`archive`, `pr`, `integrate`) or from a wrapped host `find`. Session counts are taken from
`state.json` `sessions` by purpose. Order assertions ("after the merge and before the push") use the step log lines
of the task in written order: the `integrate` line, the product check and setup check lines, the review session lines
and the publish push line. Where a check run must be tied to a commit, the fixture's project setup command appends
`git rev-parse HEAD` of the worktree to a log file outside the worktree.

### Grade E

- [ ] 4.1 (E) (required) `explainUnfinished` with a blocked entry `{ reason: 'target-conflict-unresolved', paths:
  ['src/a/result.mjs'] }` gives `kind` `blocked`, that `reason` and `paths`; an entry with reason
  `target-integration-rejected` gives that reason; any other blocked reason still gives `operation-incomplete` and no
  `paths`.
- [ ] 4.2 (E) (coverage-only) `conflictMarkers` is true for text with a `<<<<<<< ` or `>>>>>>> ` line and false for
  plain text and Markdown containing a `=======` underline.

### Grade D

- [ ] 4.3 (D) (required) Outside-scope advance unchanged: from `afterEffect('archive')` the target commits
  `docs/other.md`; the task is accepted, the branch contains an `integrate main into A` merge, `state.json` has no
  `integrations`, the recorded base is unchanged, and the review and document-review session counts equal those of a
  run without an advance. The setup checks ran after the merge: the setup log contains the `integrate main into A`
  merge commit, and in the step log a setup check line follows the `integrate` merge line. The final checks ran for
  the merged head: the completed work's `finalChecks` rows are present and passing, and its `head` (the pushed head)
  is the merge commit or a descendant of it on the task branch.

### Grade C

- [ ] 4.4 (C) (required) Clean in-scope merge before publish: from `afterEffect('archive')` the target commits
  `src/a/notes.md`; no blocked entry, the task is accepted. `integrations[0]` has `outcome` `clean`, the pushed target
  as `target`, and `previousBase` equal to the task's base recorded before the advance; the completed work's `base`
  equals that target. The product checks ran again after the merge and before the push: in the step log the product
  check lines follow the `integrate` line and precede the publish push line, the setup log contains the merge
  commit, and the completed work's `checks` and `documentationChecks` rows (cleared when the integration started) are
  present and passing. One extra implementation review and one extra documentation review session ran after the merge
  and before the push. The merged receipt's `base` is the new target and its `review.reviewer` is the new review's
  reviewer, and `receiptAt` validates it on `origin/main`.
- [ ] 4.5 (C) (required) Earlier acceptance not reused: same advance, the post-merge implementation review reports
  `changes-required`; the task is blocked with `target-integration-rejected`, the remote task branch was not pushed
  with the merged head, no pull request was created or merged, and `state.json` `review` is unset.
- [ ] 4.6 (C) (required) Advance before merge and while waiting: (a) from `afterEffect('pr')` and (b) from the first
  `find` of the merge wait, the target commits `src/a/notes.md`; in both cases the checks and both reviews run again
  after the `integrate` line and before the next push line, the new head is pushed to the same pull request (one pull
  request in `records`), it is merged, and the task is accepted.

### Grade B

- [ ] 4.7 (B) (required) Conflict resolved by the worker: from `afterEffect('archive')` the target commits a
  different `src/a/result.mjs`; the resolution session (prompt contains `Resolve the merge conflicts` and
  `src/a/result.mjs`) writes a merged file; `integrations[0]` has `outcome` `conflict`, `conflicts`
  `['src/a/result.mjs']`, the pushed target as `target` and `previousBase` equal to the base before the advance; the
  checks and both reviews run after the resolution session and before the push, and the task is merged and accepted
  with the resolved content on `origin/main`.
- [ ] 4.8 (B) (required) Unresolved conflict blocks with its paths: (a) the resolution session fails; (b) it reports
  ready without writing, so markers remain; (c) it resolves but the implementation review reports
  `changes-required`. In each case `state.json` `blocked.A` has `reason` `target-conflict-unresolved` and `paths`
  `['src/a/result.mjs']`, the result is `incomplete` with that blocker reason and paths, the report detail reason is
  `target-conflict-unresolved`, and nothing is merged. In (a) exactly one resolution session ran.
- [ ] 4.9 (B) (required) Conflict outside the task scopes: the target edits the archived change's `tasks.md`
  in a conflicting way; the task is blocked with `target-conflict-unresolved` and that path without a resolution
  session.

### Grade A

- [ ] 4.10 (A) (required) Recovery resumed after a restart: a conflicting advance from `afterEffect('archive')`;
  the run is cancelled with an `AbortController` (a) from `afterEffect('integrate')` right after the merge step is
  recorded and (b) from `onSession` when the post-merge implementation review starts. In (a), at
  `afterEffect('integrate')` `state.json` holds stage `integrate`, the `integration` record with `target`,
  `previousBase`, `conflicts` `['src/a/result.mjs']` and step `resolve`, and the recorded `base` equals the advanced
  target. Running the same invocation again resumes at stage `integrate` with the recorded `base`, creates no second
  `integrate main into A` merge, runs the outstanding steps (the resolution session in (a), the reviews in (b)), and
  accepts the task.
- [ ] 4.11 (A) (coverage-only) Two in-scope advances: the target advances again inside the scope after the first
  integration finished; a second integration runs, `integrations` has two records and the task is accepted.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with the coverage gate at 85%.
