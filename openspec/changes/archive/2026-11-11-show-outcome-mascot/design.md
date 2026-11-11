# Design: runner mascot (OR-11)

## Context

- `mascot/mascot.ts` exports `playMascot(mood, caption, options)`. It writes to stderr by default and does nothing for a non-TTY stream, `OUTCOME_RUNNER_MASCOT=0`, an unknown mood or a signal that is already aborted. It hides the cursor while it plays, restores the cursor in `finally` (also on abort) and never rejects.
- `runQueue` (`src/runner.ts`) reports task events synchronously through `options.report`. It produces exactly two event statuses: `accepted` (the receipt is on the target, so the PR is merged) and `blocked`. The blocked event has no reason.
- `runQueue` returns the run statuses `limit-reached`, `incomplete`, `exhausted` (in the ternary `config.maxAccepted ? 'incomplete' : 'exhausted'`) and `cancelled`. Its `outcome_report` tool handler also returns `{ status: 'recorded' }` to the harness. That value is a tool acknowledgement, not a runner event or run status.
- `main` (`src/cli.ts`) writes every event and the terminal result as one JSON line on stdout. The final statuses are `exhausted`, `limit-reached`, `incomplete`, `cancelled` (exit 3) and `unavailable` (exit 4, `reportFailure`). Abort is sticky: if SIGINT/SIGTERM arrives after the terminal line was written (for example `exhausted`), `finally` sets `status = 'cancelled'` and `code = 3`. The stdout line keeps its original status, but the statistics ledger and the exit code say cancelled.
- `parseFlags` refuses every argument other than `--harness=`, `--model=`, `--effort=` and `--coverage=`.

## Decisions

### 1. Mapping module `src/mascot-events.ts`

This module holds pure functions and constants only, with no I/O:

- `TASK_EVENT_MOODS = { accepted: 'happy', blocked: 'angry' } satisfies Record<TaskEventStatus, MascotMood>`.
- `RUN_OUTCOME_MOODS = { exhausted: 'celebrating', 'limit-reached': 'content', 'incomplete-waiting': 'sleepy', 'incomplete-blocked': 'sad', cancelled: 'startled', unavailable: 'dizzy' } satisfies Record<RunOutcome, MascotMood>`.
- `RUN_STATUSES = ['exhausted', 'limit-reached', 'incomplete', 'cancelled', 'unavailable']` and `TASK_EVENT_STATUSES = ['accepted', 'blocked']`.
- `NON_OUTCOME_STATUSES = ['recorded']`. This explicit exclusion list holds status literals that are not runner events or run statuses. The only entry is the `outcome_report` tool acknowledgement.
- `runOutcome(status, code, blockers)` returns the outcome key from the **final** status and exit code. Exit code 4 always gives `unavailable` (dizzy). Status `cancelled` (or exit code 3 with status `cancelled`) gives `cancelled` (startled). `incomplete` gives `incomplete-blocked` when `blockers` has at least one entry, and `incomplete-waiting` otherwise, which covers waiting only for claimed or dependent work. Every other status maps to itself. An unknown status gives `undefined`, and then nothing is played.
- `taskMascot(event, detail)` returns `{ mood, caption }` or `undefined`. `runMascot({ status, code, line })` returns `{ mood, caption }` or `undefined`. Here `status` and `code` are the final sticky values and `line` is the terminal object written to stdout, which supplies the counts and `blockers`.

Each status therefore has exactly one mood, and `incomplete` is split by a single boolean.

**Exhaustiveness guard.** A test reads `src/runner.ts` and `src/cli.ts` and finds every `status:` property with the pattern `/\bstatus:\s*([^,}\n]+)/g`. From each captured value expression it collects **every** single-quoted string literal (`/'([^']+)'/g`), so a ternary such as `config.maxAccepted ? 'incomplete' : 'exhausted'` contributes both literals. Then:

- every collected literal must be in exactly one of `TASK_EVENT_STATUSES`, `RUN_STATUSES` or `NON_OUTCOME_STATUSES`;
- every task event status has a mood in `TASK_EVENT_MOODS`, and every run status resolves to a mood through `runOutcome` (`incomplete` with and without blockers);
- `NON_OUTCOME_STATUSES` is disjoint from both status lists, and each excluded literal is still found in the source, but only as `return { status: '<literal>' }` in the tool handler (the test asserts that `'recorded'` occurs only in the `result = input as WorkerReport; return { status: 'recorded' }` statement). An exclusion can therefore not hide a real event or run status.

A new status literal that is added without a mood, in a plain property or a conditional expression, makes the test fail.

### 2. Captions

- Accepted: `<id> merged`.
- Blocked: `<id> blocked: <reason>`. Whitespace runs in the reason, including newlines, are collapsed to one space and the result is trimmed. If it is longer than 60 characters (counted as code points), it becomes its first 59 characters followed by `…`, which makes exactly 60. If the reason is empty or missing, the caption is `<id> blocked`.
- Run: `<status>: <n> accepted, <m> remaining`. `<status>` is the **final sticky status**, the same value recorded in the statistics ledger (`cancelled` after a late signal, `unavailable` for exit 4). n and m are the lengths of the `accepted` and `remaining` arrays of the terminal line written to stdout. A missing array (for example on an `unavailable` line) counts as 0.

Example race: a signal arrives after `{"status":"exhausted","accepted":["OR-1"],"remaining":[],...}` was written. stdout is unchanged, the exit code is 3, and the mascot plays `startled` with caption `cancelled: 1 accepted, 0 remaining`.

### 3. Blocked reason without changing stdout

`RunOptions.report` becomes `(event: RunEvent, detail?: { reason?: string }) => void`. The blocked call site passes `{ reason: (error as Error).message }` as the second argument. The event object is unchanged and the CLI keeps serializing only the first argument. The reason goes only to the stderr caption and is never written to stdout. Existing callers that ignore the second argument still work.

### 4. CLI integration

- `MainOptions` gains `mascot?: MascotPlayer`, with `type MascotPlayer = (mood: MascotMood, caption: string, options: { signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<void> | void`. The default is `(mood, caption, o) => playMascot(mood, caption, { signal: o.signal, env: o.env })`, which writes to `process.stderr`. The player never gets stdout.
- Enabled state: `enabled = !args.some(arg => arg === '--no-mascot' || arg.startsWith('--no-mascot=')) && (env ?? process.env).OUTCOME_RUNNER_MASCOT !== '0'`. This is computed at the start of `main`, before the invocation file is read and before flag parsing. Any spelling of the off switch, even one that `parseFlags` later refuses (`--no-mascot=1`, or `--no-mascot` given twice), shows that the person wants the mascot off, so it is respected. When the mascot is disabled, the player is never called, so a refused `--no-mascot=1` ends with exit code 4 and no `dizzy`.
- `parseFlags` accepts the exact argument `--no-mascot` at most once, in any position among the other flags. It returns it as `noMascot: true` (the flag has no value). A duplicate or a valued form such as `--no-mascot=1` is refused with the existing error, whose message gains `--no-mascot`. Statistics sources stay keyed by the four value flags only.
- Task events: the `report` wrapper first writes the JSON line exactly as today and then queues the animation. Animations are serialized on a `pending` promise chain, so they never overlap.
- Each animation gets its own `AbortController`, which is held in an `active` set. The existing `stop` handler for SIGINT/SIGTERM aborts `cancellation` and every active animation controller.
- After `runner` returns or throws, `main` awaits `pending` before it writes the terminal line. After an abort, the animation's `finally` has therefore restored the cursor (show-cursor written) before the cancelled result is printed and `main` finishes cancelling.
- `main` keeps the terminal object it wrote in a local `line` variable (the runner result, the cancelled fallback, or the `unavailable` object returned from `reportFailure`).
- The run mood is played in `finally`, after the sticky abort adjustment, after the terminal line and after `appendStatistics`, and before the signal listeners are removed. It calls `runMascot({ status, code, line })` with the final `status` and `code`, the same values given to `statistics.finish`. It uses a fresh controller, which `stop` also aborts. The cancellation signal is already aborted at that point and would suppress `startled`, so the fresh controller is needed for the startled mood to play.
- Failure isolation: every player call is wrapped as `Promise.resolve().then(() => player(...)).catch(() => {})`, which also catches synchronous throws. `code`, `status`, the result line and `appendStatistics` are computed independently of the player. A failure can never reach them.
- The `hash` subcommand (`printTaskHashes`) is not a task or a run and plays no mascot.

### 5. Known trade-off

The runner keeps working while a task animation plays, because `report` is synchronous. A later stdout event line can therefore appear on the terminal between redraws. The stdout bytes and their order are unchanged. Only the terminal rendering can interleave, and only when both streams are the same TTY. The terminal line itself always waits for pending animations.

## Testing approach

The tests are in `test/mascot-events.test.ts` (pure mapping, captions and the exhaustiveness guard) and `test/cli-mascot.test.ts` (`main` with a fake runner, an injected recording player, a temporary invocation file and an isolated statistics ledger, using the existing test support). Process signals are simulated with `process.emit('SIGINT')` and `process.emit('SIGTERM')`. No real timers or TTYs are used.

- One cancel test injects a player that wraps the real `playMascot` with an in-memory TTY stream and a wait that rejects on abort. It checks that show-cursor is written before the cancelled stdout line.
- One race test uses an output function that emits SIGTERM right after it writes the `exhausted` terminal line. It checks that stdout still holds the `exhausted` line, the exit code is 3, and the player records `startled` with caption `cancelled: <n> accepted, <m> remaining`.

## Risks

- If stdout and stderr share a terminal, rendering can interleave (see the trade-off above). This is accepted as cosmetic.
- Blocked reasons are internal error messages. They are shown only on the local stderr, truncated to 60 characters, and never written to stdout or receipts.
