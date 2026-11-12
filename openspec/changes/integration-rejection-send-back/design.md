# Design: Send a rejected integration back to the worker before blocking

## Context

The `integrate` stage in `src/runner.ts` is a loop over `activeWork().integration.step`:

- `merge` merges `integration.target`. It saves `base`, `integratedTargets` and the next step (`resolve` for
  conflicts, `checks` otherwise), then calls `afterEffect('integrate')`.
- `resolve` runs one conflict resolution session (`work` purpose). It stages only the conflicting paths and the task
  scopes.
- `checks` runs `assertWork`, the setup checks and the product checks, then saves `checks`, `documentationChecks` and
  step `review`.
- `review` runs the implementation review of the merged result. An acceptance saves `review` and step
  `document-review`.
- `document-review` runs the documentation review. An acceptance saves `integrations` (appending the record),
  clears `integration` and sets stage `receipt`.

Any error in these steps goes through `rejected(error)`. A cancellation rethrows the error. Otherwise the result is
`IntegrationFailure('target-conflict-unresolved', conflicts)` for a conflict integration and
`IntegrationFailure('target-integration-rejected', [])` for a clean one. The catch block of the task stores the
blocked entry, and `explainUnfinished` keeps the reason.

The failed check output is lost today, because `rejected` drops it. Review findings are saved in `work.findings`.

An integration only starts from the `publish` stage, which comes after the archive. By then `work.directory` has
been moved to `work.archive.directory`, and `manifestScopes(work)` allows only the task scopes, the archived change
directory and the archived spec files. A file written below the old `work.directory` would therefore make the
receipt manifest fail with `Empty or out-of-scope result manifest`.

## Goals / Non-Goals

Goals:

- One send-back session for a rejected clean integration, writing only inside the task scopes.
- The checks and both reviews run again after that session.
- The task blocks with `target-integration-rejected` and its last findings or check output when the result is still
  rejected.
- Durable steps, with no second session after a restart.
- Step lines and a README update.

Non-goals:

- Conflict integrations. They keep their one resolution session and `target-conflict-unresolved`.
- Outside-scope merges, which never enter the integrate stage.
- Final publish checks.
- More than one send-back per integration.
- Review or check budgets for integration sessions. The send-back session and the reviews after it use no budget,
  like the existing integration reviews.
- `--retry` granting another send-back. It resets budgets only.

## Decisions

### 1. Durable record (`src/model.ts`)

```ts
export type IntegrationStep = 'merge' | 'resolve' | 'checks' | 'review' | 'document-review' | 'send-back';

/** What did not accept the merged result: the setup or product checks, the implementation review or the
 * documentation review. */
export type SendBackCause = 'checks' | 'review' | 'document-review';

/** The one send-back of a clean integration. */
export interface SendBackRecord {
  /** What rejected the merged result before the session. */
  cause: SendBackCause;
  /** The review findings or the failed check output given to the session. */
  findings: string[];
  /** `pending`: not started. `started`: saved right before the session starts. `finished`: session done and
   * result committed. */
  session: 'pending' | 'started' | 'finished';
  /** Set when the checks and both reviews after the session decided. */
  outcome?: 'accepted' | 'rejected';
  /** The last rejection after the session: its cause and its findings or check output. */
  rejection?: { cause: SendBackCause; findings: string[] };
}

export interface IntegrationRecord {
  ...
  /** The one send-back of this integration; absent when none was needed. */
  sendBack?: SendBackRecord;
}
```

The record belongs to the integration entry of one target commit (`integration.target`). Its presence means that
this target commit has used its send-back. It is kept in `integrations` when the integration finishes. Integrations
that need no send-back have no `sendBack` field, so existing records and existing `deepEqual` assertions stay
unchanged.

### 2. Which failures send back

Only a *rejection* sends back:

- **checks**: a setup command or product check command of the `checks` step fails. The findings are
  `[failureDetail(error)]`, the check output (stdout and stderr of the failed command, as `failureDetail` already
  collects it), at most 16000 characters.
- **review**: the implementation review of the merged result reports something other than `accepted`, or reports
  findings. The findings are the review findings.
- **document-review**: the same for the documentation review.

Other errors keep the current `rejected(error)` behaviour and block at once. These include `assertWork` failures, a
review session that throws (for example `Worker review incomplete`) and cancellations. A conflict integration
(`outcome: 'conflict'`) never sends back; its rejections still block with `target-conflict-unresolved` and the
conflicting paths.

### 3. `sendBackOrReject(cause, findings)`

An async helper in the integrate loop, used by the three rejection points and by a failing send-back session:

```ts
const sendBackOrReject = async (cause: SendBackCause, findings: string[]): Promise<void> => {
  const integration = activeWork().integration!;
  if (integration.outcome === 'conflict') {
    save({ findings });
    throw new IntegrationFailure('target-conflict-unresolved', integration.conflicts);
  }
  if (integration.sendBack) {
    // Second rejection of this target commit: record it and block.
    save({ findings, integration: { ...integration, sendBack: { ...integration.sendBack, outcome: 'rejected',
      rejection: { cause, findings } } } });
    taskStep(work.id, 'send-back', 'the merged result is still rejected after the send-back session', currentAttempt());
    throw new IntegrationFailure('target-integration-rejected', []);
  }
  taskStep(work.id, 'send-back', `the ${CAUSE_LABEL[cause]} did not accept the merged result; sending it back`,
    currentAttempt());
  save({ findings, integration: { ...integration, step: 'send-back',
    sendBack: { cause, findings, session: 'pending' } } });
  await cancellable(afterEffect('send-back-requested', activeWork()), signal);
};
```

`CAUSE_LABEL` is `{ checks: 'checks', review: 'implementation review', 'document-review': 'documentation review' }`.
After a send-back the loop continues and reaches the `send-back` step in its next iteration. The blocked entry gets
reason `target-integration-rejected` without paths. Its `work.findings` and
`work.integration.sendBack.rejection` hold the last findings or check output.

The `try`/`catch` blocks of the steps call `sendBackOrReject` outside the `rejected(error)` conversion. A cancellation
inside the `afterEffect` rethrows through the task's catch block, which keeps the recorded step. A failing check
stores its output in `work.findings`, so the session can also read it through the `findings` context section.

### 4. The `send-back` step, limited to the task scopes

`session(work, purpose, prompt, implementationReview, attempt)` gains a last optional parameter
`writable?: string[]`. When it is given, it replaces the purpose's default writable paths; every other session passes
nothing and keeps its current paths. The send-back session passes `[...work.scopes]`, so the broker refuses writes to
`${work.directory}/tasks.md`, `compliance.md`, `verification.md` and every other path outside the task scopes. After
the archive the old change directory can therefore never be recreated.

```ts
} else if (integration.step === 'send-back') {
  const sendBack = integration.sendBack!;
  if (sendBack.session === 'pending') {
    taskStep(work.id, 'implementation', 'starting the send-back session of the merged result', currentAttempt());
    save({ integration: { ...integration, sendBack: { ...sendBack, session: 'started' } } });
    let failed = false;
    try {
      await session(activeWork(), 'work', prompt + sendBackPrompt(integration, sendBack), false, undefined,
        [...work.scopes]);
    } catch (error) {
      if (stopped || signal?.aborted || (error as InterruptedFailure).interrupted) throw error;
      failed = true;
    }
    // A failed session is the rejection after the send-back: it blocks with the original cause and findings.
    if (failed) await sendBackOrReject(sendBack.cause, sendBack.findings);
    await cancellable(afterEffect('send-back', activeWork()), signal);
  }
  taskStep(work.id, 'commit', 'committing the send-back result', currentAttempt());
  assertWork(activeWork()); commitSendBack(work);
  save({ integration: { ...activeWork().integration!, step: 'checks',
    sendBack: { ...activeWork().integration!.sendBack!, session: 'finished' } } });
}
```

- `session: 'started'` is saved before the session starts. A restart that finds `started` never starts another
  session. It commits what is in the worktree and goes on to the checks, which decide the outcome. A restart that
  finds `pending` starts the session; its first line carries `resuming`. A restart that finds step `checks`,
  `review` or `document-review` with a `sendBack` record runs that step, and a rejection there blocks (decision 3).
  So one target commit never gets a second send-back session.
- A session that fails (`Worker work incomplete`, adapter error) and is not a cancellation is a rejection after the
  send-back. Because `sendBack` is already recorded, `sendBackOrReject` blocks with `target-integration-rejected`.
  The findings are the original send-back findings, the record has `outcome: 'rejected'` and
  `rejection: { cause: sendBack.cause, findings }`, and the `send-back: ... still rejected` line is written.
- `commitSendBack` stages `present(work, [...work.scopes])` with `git add -A --`, only the task scopes, like the
  resolution session's staging. It never stages `work.directory`. It commits with
  `commitSubject('fix', `address the integration findings of ${work.id}`)` only when something is staged. The
  receipt manifest after a send-back therefore stays inside `manifestScopes(work)`.
- `run_checks` is available (the specification is bound). Its implicit `commit(work)` stages `work.directory` only
  when it exists or is tracked. After the archive it does neither, because the session cannot write there, so
  `run_checks` also commits only task scope files.
- The session uses no review or check budget.
- The prompt (`sendBackPrompt`) contains the sentence `Address the rejection of the merged result:` after the runner
  preamble and the task prompt. It names the advanced target commit and the cause, and lists the findings as JSON. It
  asks for fixes written only inside the task scopes `JSON.stringify(work.scopes)`, says that writes to the OpenSpec
  change or any other path are refused, and asks that all approved OpenSpec scenarios and tests keep passing. It
  appends `workTestInstructions(config.coverage)` and `LEFTOVER_FILES_WORK`.

### 5. Re-running the checks and the reviews

After the send-back step the loop runs the existing `checks`, `review` and `document-review` steps unchanged. All
three run again, whichever one rejected first. They are given the same `merged` context sentence.

When the `document-review` step accepts and the integration has a `sendBack` record, the runner writes
`send-back: the merged result was accepted after the send-back session`. It then saves `outcome: 'accepted'` in the
same `save` that appends the integration to `integrations` and sets stage `receipt`. Publishing and merging continue
as before (OR-27). If the target advances again later, the new target commit gets a new integration entry with its
own send-back allowance.

### 6. Step lines

All of these lines carry the current attempt `(targetAttempts ?? 0) + 1`, like the integrate `merge` line.

| Step | Message | When |
|---|---|---|
| `send-back` | `the <checks\|implementation review\|documentation review> did not accept the merged result; sending it back` | first rejection of a clean integration, before the `send-back` step is saved |
| `implementation` | `starting the send-back session of the merged result` | before the session starts |
| `commit` | `committing the send-back result` | after the session (or on a restart that found `started`) |
| `send-back` | `the merged result was accepted after the send-back session` | the documentation review after the session accepts |
| `send-back` | `the merged result is still rejected after the send-back session` | a rejection after the session; directly followed by `blocked: stopped at send-back` |

The usual `setup`, `check`, `review: starting the implementation review session of the merged result` and
`documentation review: ...` lines appear between the commit line and the outcome line.

### 7. README

Every README passage that describes a clean integration rejection is updated, so no sentence still says that it
blocks on its first failure:

- **`## When the target advances during a run`.**
  - A new paragraph `**Send-back after a rejected clean merge.**`, after the `**Conflicts.**` paragraph. It explains
    that a clean integration rejected by the checks, the implementation review or the documentation review gets one
    send-back session: one worker session (an implementation session) with the failed check output or the review
    findings, which may write only inside the task scopes. It contains the sentence "After the send-back session the
    checks and both reviews run again." When they accept, the task continues to publishing and merging; otherwise it
    is blocked with `target-integration-rejected`, and the last findings stay in `state.json` (`findings`,
    `integration.sendBack`). A restart never grants a second send-back session for the same target commit. Merges
    with conflicts get no send-back session.
  - The blocker table entry for `target-integration-rejected` becomes "A merge without conflicts whose checks or
    reviews are still rejected after the one send-back session".
  - The `**Restarts.**` paragraph lists the outstanding work as "resolution session, send-back session, checks and
    reviews", and adds that a recorded send-back session that already started is never started again.
- **`### Review and check budgets`.** The sentence "The integration checks and reviews of an advanced target and the
  final checks have no budget; they block on their first failure as before." becomes: "The integration checks and
  reviews of an advanced target, the send-back session and the final checks have no budget. A clean integration gets
  one send-back session before it blocks; a conflict integration and the final checks block on their first
  failure."
- **`### Worktrees and cleanup`.** The sentence "An integration review that names a leftover file blocks the task with
  the usual integration reason" becomes: an integration review of a clean merge that names a leftover file sends it
  back once (the send-back session deletes it), and the task is blocked with the usual integration reason only when
  it is still rejected afterwards; a conflict integration blocks at once.
- **`## Step lines`.** `send-back` is added to the list of task step names (after `integrate`). The sentence on the
  lines an in-scope integration writes is extended: a `send-back` line when a clean integration is sent back, an
  `implementation` line before the send-back session, a `commit` line for its result, and a `send-back` line with the
  outcome (accepted, or still rejected followed by `blocked: stopped at send-back`).

## Risks / Trade-offs

- A send-back session may change task files in ways the earlier reviews never saw. That is why both reviews always
  run again, and the implementation review sees the whole task diff.
- The send-back session cannot update the archived change's `tasks.md` or `verification.md`. This is intended: the
  archived change is bound, and the session repairs only the task scopes.
- An interrupted send-back session is not repeated. Its partial writes are judged by the checks and reviews, which
  may block the task. This keeps the "at most one session per target commit" guarantee simple and durable.
- Existing test 4.5 of `test/target-scope-recovery.test.ts` (a review that always rejects the merged result) now
  sees one send-back session before the same block; its assertions are extended rather than weakened.

## Test approach

`test/integration-send-back.test.ts` uses `runnerFixture`, `scriptedWorker` and the scripted host, with the
`scenario` / `advance` / `worker` pattern of `test/target-scope-recovery.test.ts`. The target is advanced in-scope
(`src/a/notes.md`) from `afterEffect('archive')`.

- A failing check: the project gets an extra check that prints a distinctive marker before failing:
  `node -e "if (require('node:fs').existsSync('src/a/broken.md')) { console.error('broken.md present'); process.exit(1); }"`.
  The advance adds `src/a/broken.md`, and the send-back session deletes it through `delete_file`. The test asserts
  that the send-back prompt contains `broken.md present`, which proves the real check output (not a generic command
  error message) reaches the session.
- Rejecting reviews: the scripted implementation review or documentation review of the merged result reports
  `changes-required` with a finding until `src/a/fixed.md` exists. The send-back session writes that file.
- The adapter's `startAction` receives the whole prompt: the runner preamble (`OFF. Never ask a person anything…`),
  then the task prompt, then the step text. So send-back sessions are recognised with an `includes` helper, like
  `isResolution` / `isPostMergeReview`:
  `const isSendBack = (prompt: string) => prompt.includes('Address the rejection of the merged result');`.
  Every session count uses `prompts.filter(isSendBack).length`, and "no send-back session" is asserted as a count
  of 0.
- Scope limit: the scripted send-back session first tries to write `${work.directory}/tasks.md` and records the
  broker's refusal, then writes the fix inside `src/a`.
- Restarts cancel with an `AbortController` in `afterEffect('send-back')` (session `started`) or in
  `afterEffect('send-back-requested')` (session `pending`), then run `runQueue` again.
- README: the test reads the README sections by heading and asserts text that exists only after the change (decision
  7), and the absence of the stale budget sentence.
