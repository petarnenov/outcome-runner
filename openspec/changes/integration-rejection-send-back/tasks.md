# Tasks: Send a rejected integration back to the worker before blocking

## 1. Model

- [ ] 1.1 In `src/model.ts`, add `send-back` to `IntegrationStep`. Add `SendBackCause` and `SendBackRecord`, and the
  optional `sendBack` field on `IntegrationRecord`, all with doc comments (design decision 1).

## 2. Runner

- [ ] 2.1 In the integrate loop of `src/runner.ts`, add `CAUSE_LABEL` and the async
  `sendBackOrReject(cause, findings)` (design decision 3). For conflict integrations it blocks with
  `target-conflict-unresolved` and the paths. On a second rejection it records `outcome: 'rejected'` and
  `rejection`, writes the `still rejected` line and throws `target-integration-rejected`. Otherwise it writes the
  send-back line, saves step `send-back` with `session: 'pending'`, and then calls `afterEffect('send-back-requested')`.
- [ ] 2.2 `checks` step: `assertWork` errors still go through `rejected`. A failing setup or product check calls
  `sendBackOrReject('checks', [failureDetail(error)])`, so the stdout and stderr of the failed command reach the
  session. Cancellations rethrow.
- [ ] 2.3 `review` step: a review that does not accept calls `sendBackOrReject('review', review.findings)` after
  saving `reviews`. A throwing session keeps `rejected`.
- [ ] 2.4 `document-review` step: the same with `'document-review'`. An acceptance with a `sendBack` record writes
  the accepted line and saves `outcome: 'accepted'` in the same `save` that appends to `integrations` and sets stage
  `receipt`.
- [ ] 2.5 Give `session` a last optional `writable?: string[]` parameter that replaces the purpose's default writable
  paths when given; all existing callers pass nothing. Add the `send-back` step (design decision 4): the session line,
  then `session: 'started'` saved before the session, then the `work` session with `sendBackPrompt` and writable
  paths `[...work.scopes]` only (never `${work.directory}/tasks.md`, `compliance.md` or `verification.md`, because
  the change directory is already archived), then `afterEffect('send-back')`. Then the commit line, `assertWork`,
  `commitSendBack`, which stages only `present(work, [...work.scopes])` (never `work.directory`), and save step
  `checks` with `session: 'finished'`. When the restart state is `started`, skip the session. A failing session that
  is not cancelled blocks through the second-rejection path with the original cause and findings. `sendBackPrompt`
  names the task scopes as the only writable paths.
- [ ] 2.6 Send-back sessions and the reviews after them use no review or check budget.

## 3. Documentation

- [ ] 3.1 Update every README passage on clean integration rejections (design decision 7):
  - `## When the target advances during a run`: add the `**Send-back after a rejected clean merge.**` paragraph
    after `**Conflicts.**` (one session writing only inside the task scopes, the sentence "After the send-back
    session the checks and both reviews run again.", the `target-integration-rejected` block, the `state.json`
    fields `findings` and `integration.sendBack`, no second session after a restart, none for conflicts); change the
    blocker table entry of `target-integration-rejected` to "A merge without conflicts whose checks or reviews are
    still rejected after the one send-back session"; and in `**Restarts.**` list the outstanding work as
    "resolution session, send-back session, checks and reviews" and state that a started send-back session is never
    started again.
  - `### Review and check budgets`: replace "The integration checks and reviews of an advanced target and the final
    checks have no budget; they block on their first failure as before." with the decision 7 text (no budget for the
    send-back session either; a clean integration gets one send-back session before it blocks; a conflict
    integration and the final checks block on their first failure).
  - `### Worktrees and cleanup`: the leftover-file sentence on integration reviews says a clean merge is sent back
    once before it blocks, and a conflict integration blocks at once.
  - `## Step lines`: add `send-back` to the list of task step names after `integrate`, and extend the sentence on the
    lines an in-scope integration writes with the `send-back` line, the `implementation` line before the send-back
    session, the `commit` line for its result, and the `send-back` outcome line (accepted, or still rejected followed
    by `blocked: stopped at send-back`).

## 4. Tests

The new tests go in `test/integration-send-back.test.ts`, using `runnerFixture`, scripted adapters, the scripted
host and Git fixtures, with an in-scope advance of `src/a/notes.md` or `src/a/broken.md` from
`afterEffect('archive')`. The adapter's `startAction` receives the whole prompt (runner preamble, task prompt, step
text), so send-back sessions are recognised with an `includes` helper, like `isResolution` / `isPostMergeReview`:
`const isSendBack = (prompt: string) => prompt.includes('Address the rejection of the merged result');`. Every
send-back session count below is `prompts.filter(isSendBack).length`; never a `startsWith` check. Tests are listed
from E (easiest) to A (most complex). Every (required) test is always written. (coverage-only) tests are written
grade by grade, starting with E, until the 85% coverage gate passes.

- [ ] 4.1 (E) (required) README. Read the README sections by heading and assert text that exists only after the
  change: the section `## When the target advances during a run` contains `send-back session`, the sentence
  `After the send-back session the checks and both reviews run again.`, and the blocker table entry `still rejected
  after the one send-back session` on the `target-integration-rejected` row; the section `### Review and check
  budgets` no longer contains `they block on their first failure as before` and mentions the send-back session; the
  section `## Step lines` lists `` `send-back` `` among the task step names and contains `blocked: stopped at
  send-back`. The existing README test in `test/target-scope-recovery.test.ts` still passes.
- [ ] 4.2 (E) (coverage-only) `explainUnfinished` still reports `target-integration-rejected` without `paths` for a
  blocked integration whose work has a `sendBack` record.
- [ ] 4.3 (D) (required) Accepted send-back is logged: after an implementation review rejection fixed by the
  session, the four lines of the "Accepted send-back is logged" scenario appear in order, and the setup or check
  line, the review line and the documentation review line of the merged result come between the commit line and the
  next `push` line.
- [ ] 4.4 (C) (required) Documentation review rejection fixed and accepted. The scripted documentation review of the
  merged result rejects until `src/a/fixed.md` exists, and the send-back session writes it. Assert:
  `prompts.filter(isSendBack).length === 1`, and that prompt contains the finding; status `exhausted`; one MERGED
  record; the completed integration has `sendBack` with cause `document-review`, session `finished` and outcome
  `accepted`; no blocked entry.
- [ ] 4.5 (C) (required) Implementation review rejection fixed and accepted. Same as 4.4 with the implementation
  review rejecting; cause `review`; `prompts.filter(isSendBack).length === 1`. The implementation review and the
  documentation review each run twice on the merged result. Also covers the target-scope-recovery scenario
  "Rejected clean merge repaired by the send-back session".
- [ ] 4.6 (C) (required) Failed check fixed and accepted. An extra project check prints a distinctive marker and
  fails while `src/a/broken.md` exists:
  `node -e "if (require('node:fs').existsSync('src/a/broken.md')) { console.error('broken.md present'); process.exit(1); }"`.
  The advance adds `src/a/broken.md`, and the send-back session deletes it. Assert:
  `prompts.filter(isSendBack).length === 1`, and that send-back prompt contains the marker `broken.md present` (so
  the real check output, not a generic command error, reaches the session); the `sendBack` record has cause
  `checks` and findings containing `broken.md present`; the checks pass afterwards; the task is merged and accepted.
- [ ] 4.7 (C) (required) Conflict integrations keep their own handling. The existing test 4.8 `review` case of
  `test/target-scope-recovery.test.ts` additionally asserts `prompts.filter(isSendBack).length === 0`, with the
  `isSendBack` `includes` helper defined in that file too, and still expects `target-conflict-unresolved` with the
  conflicting paths.
- [ ] 4.8 (C) (required) Send-back session writes only inside the task scopes. After an implementation review
  rejection, the scripted send-back session first calls `write_file` on `${work.directory}/tasks.md` and records the
  broker error, then writes `src/a/fixed.md`. Assert: the first write was refused; the old change directory does not
  exist in the task worktree and no commit after the archive touches it; the send-back commit contains only
  `src/a/fixed.md`; the receipt manifest paths are all inside the task scopes or the archived change; the task is
  merged and accepted (not blocked with `operation-incomplete`).
- [ ] 4.9 (B) (required) Still rejected after the send-back (also the modified target-scope-recovery scenario
  "Rejected clean merge"). The implementation review of the merged result always rejects with `The merged result
  needs repair.` Assert: status `incomplete`; blocked reason and blocker reason `target-integration-rejected` with
  kind `blocked` and no paths; `work.findings` and `work.integration.sendBack.rejection.findings` contain the
  finding; `outcome` is `rejected`; `prompts.filter(isSendBack).length === 1`; no push of the task branch, no merge
  record, no integrate merge on `origin/main`; the `still rejected` line is directly followed by `blocked: stopped at
  send-back`. Update the existing test 4.5 of `test/target-scope-recovery.test.ts` so that it expects exactly one
  send-back session, counted with the `isSendBack` helper.
- [ ] 4.10 (B) (coverage-only) A send-back session that fails (throws) blocks with `target-integration-rejected`
  through the second-rejection path, keeping the original findings, with `prompts.filter(isSendBack).length === 1`.
- [ ] 4.11 (A) (required) Restart after the send-back session. Cancel in `afterEffect('send-back')` after an
  implementation review rejection. Assert that `state.json` has stage `integrate`, step `send-back`, and `sendBack`
  with session `started`, cause `review` and the finding. Rerun: the rerun's prompts have
  `filter(isSendBack).length === 0` (one in total over both runs), the first task line is
  `commit: resuming committing the send-back result`, the checks and both reviews run, the task is merged and
  accepted, the completed integration keeps `sendBack` with outcome `accepted`, and there is exactly one integrate
  merge commit on `origin/main`.
- [ ] 4.12 (A) (required) Restart before the send-back session starts. Cancel in
  `afterEffect('send-back-requested')` after an implementation review rejection. Assert that `state.json` has step
  `send-back` with session `pending`. Rerun: `prompts.filter(isSendBack).length === 1` over both runs, its line is
  `implementation: resuming starting the send-back session of the merged result`, and the task is merged and
  accepted.

## 5. Verification

- [ ] 5.1 `npm run typecheck` and `npm test` pass, and coverage stays at or above 85%.
