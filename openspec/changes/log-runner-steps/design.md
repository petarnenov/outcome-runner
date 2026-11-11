# Design: Log every logical step before it starts

## Context

`runQueue` (`src/runner.ts`) is a durable stage machine (`claim`, `investigate`, `plan`, `work`, `document`,
`document-review`, `final-checks`, `archive`, `receipt`, `publish`, `pr`, `merge`) preceded by the OpenSpec
preflight, harness selection (which probes the harness version) and the test framework preflight. stdout carries
only JSON event and result lines written by `src/cli.ts`; stderr carries the optional mascot. Nothing tells a
person what the runner is doing in between.

## Goals / Non-Goals

Goals: one short, safe, English stderr line before each logical step; waits logged once; retries logged with the
attempt; resumed work not re-announcing completed steps; injectable output for tests.

Non-goals: changing stdout, exit codes, the diagnostics file, receipts, durable state, statistics or the mascot;
logging inside preflight modules beyond one line before each preflight; progress bars or per-poll output.

## Decisions

### D1. Step logger module

`src/step-log.ts` exports `formatStep(time: Date, subject: string, step: string, message: string): string`,
`runStartMessage({ invocation, harness, model, effort }): string` and `createStepLog({ write, now })`, returning
`step(subject, step, message, { attempt?, resuming? })`.

- Format: `[outcome-runner] HH:MM:SS <subject> <step>: <message>` with local 24-hour time, zero-padded.
- Subject is `run` for run-level steps and the task id for task steps.
- `attempt` (2 or more) appends ` (attempt N)`; `resuming` prefixes the message with `resuming `.
- Every control character (including CR/LF and ESC) in any part is replaced by a space, runs of spaces are
  collapsed, and a line longer than 120 characters has its message cut and ended with `...` so the whole line
  is exactly 120 characters. The written text is the line plus one `\n`.
- A failing `write` is swallowed: step logging never changes the run result.

### D2. Safe content only

Messages are composed only from fixed English text and these values: task id, invocation id, harness, model,
effort (or `auto` when not yet chosen), the basename of a configured setup/check command program with its index
(`setup 1/2: npm`), pull request number, stage name, attempt number and the run status. Error messages, block
reasons, worker/session text, command output, arguments, file contents, URLs and paths are never interpolated.
The blocked line names the step only.

### D3. Injection and default

`RunOptions.steps?: (line: string) => void`. The default writes to `process.stderr`. The clock is the existing
`RunOptions.now`. `src/cli.ts` keeps calling `runQueue` without `steps`, so the CLI writes step lines to stderr and
its stdout is untouched. Steps never go through `report`.

### D4. Step vocabulary and placement

Each line is written immediately before the code that produces the step's first effect (process spawn, Git
command, ledger push, session start, host call, state save for that step):

| Subject | Step | When |
| --- | --- | --- |
| run | start | first statement of `runQueue`: `runStartMessage` of the requested values (`auto` when unset) |
| run | preflight | before `openspecPreflight` (`OpenSpec`), `selectHarness` (`harness version`), `testFrameworkPreflight` (`test framework`) |
| run | cleanup | before sweeping each leftover accepted worktree (names the task id) |
| id | claim | before `ledger.acquire` |
| id | worktree | before `git worktree add` |
| id | setup | before each setup command (investigation and target integration) |
| id | investigation | before the investigation session |
| id | planning | before each planning session |
| id | planning check | before `packet()`/planning check |
| id | planning review | before the planning review session |
| id | implementation | before each implementation session |
| id | commit | before committing implementation, documentation, archive or receipt changes |
| id | check | before each product check command, wherever `checks()` runs it |
| id | review | before the implementation review session |
| id | documentation / documentation review | before each documentation session |
| id | final checks | before the documentation-stage product checks |
| id | archive | before the archive command |
| id | receipt | before writing the receipt |
| id | integrate | inside `integrateTarget`, only when the target advanced, before `git merge` |
| id | push | before pushing the tested head |
| id | pull request | before `host.find`; `creating` before `host.create`, `reusing #N` when found |
| id | wait | once on entering the merge stage: waiting for mergeability and checks of #N |
| id | wait | once per merge stage when a stale pull request head first triggers polling |
| id | merge | before `host.merge` |
| id | acceptance | before recording the accepted completion in state |
| id | cleanup | before removing the worktree and branches |
| id | blocked | after a task is blocked: `stopped at <last step>` |
| run | end | immediately before `runQueue` returns or throws: the result status, or `unavailable` on a throw |

The step names and messages are fixed strings so tests compare them exactly.

### D4a. Run-start values always fit

The run-start message is `invocation=<I> harness=<H> model=<M> effort=<E>`. Each value is shortened on its own
before composing: invocation and model to at most 16 characters, harness and effort to at most 8 characters; a
longer value keeps its first characters and ends with `...` inside its cap. With the fixed prefix
`[outcome-runner] HH:MM:SS run start: ` (37 characters) and the fixed labels (35 characters) the line is at most
120 characters, so the general message cut of D1 never applies to it and all four values always appear.

### D5. Waits logged once

- Merge stage: one `wait` line on entry; the poll loop does not log per view. A first stale-head view adds one
  `wait` line (`waiting for pull request head to match`); later views do not log. A target advance that sends the
  task back to `publish` is a retry of the publish steps (D6).
- Git lock: `withGitLock(primary, fn, { timeoutMs, onWait })` first tries `BEGIN EXCLUSIVE` with
  `busy_timeout=0`; when busy it calls `onWait()` once, then sets the remaining timeout and retries once.
  Timeout and nested-lock behaviour are unchanged. The runner passes `onWait` writing
  `<subject> git lock: waiting for the Git lock` through a local `lockGit(subject, fn)` wrapper used for all its own
  Git groups (refresh, worktree, push, cleanup) and, through the `ClaimLedger` lock function, for claims.
  No line is written when the lock is free.

### D6. Retries and attempts

Every step that the runner repeats for the same task logs again with ` (attempt N)` for N of 2 or more:

- Planning and implementation loops pass `attempt: attempt + 1` to the session line and to the lines of that
  attempt's steps (planning check, planning review, commit, checks, review). On resume N is derived from the
  recorded `sessionStarts` so a retried attempt is still numbered.
- Documentation rounds: the round number is `documentationReviews.length + 1` from durable state, so round N of
  at most `DOCUMENTATION_ROUNDS` (4) passes `attempt: N` to its documentation, commit and documentation review
  lines. Round 1 has no suffix; a resumed round keeps its number.
- Publish after a target advance: when the merge stage returns the task to `publish`, the repeated integrate,
  setup, check, push, pull request and wait lines carry `attempt: N`, where N counts the publish passes of that
  task within this `runQueue` call (an in-memory counter; durable state is unchanged). A run that resumes in
  `publish` starts counting at 1 and its first line carries `resuming` instead.

### D7. Resume

Completed stages are skipped by the stage machine, so their lines are never written. `resuming` applies only to
the first step line written for a task whose work was found in durable state when this `runQueue` call started:
`store.state.current` at start or a recovered blocked work. The runner records those task ids once, before the
loop, and clears an id after its first line. Later passes of the same `runQueue` call that read
`store.state.current` (the acceptance pass after a merge, or a `continue` back to `publish`) never carry
`resuming`; work claimed in this call never carries it.

## Risks / Trade-offs

- Mascot animation also uses stderr; step lines may interleave with an animation frame. Lines are whole and
  newline-terminated, so the effect is cosmetic; the mascot is optional.
- Existing tests that assert stderr would see new lines; they inject `steps` (capture or no-op).
- Long invocation and model ids are shown shortened on the run-start line; the full values remain in the
  configuration and statistics.
- The publish attempt counter is not durable, so a resumed run renumbers publish retries from 1 (marked
  `resuming`).

## Migration

None. No state, receipt or output format changes.
