# Tasks: OR-11

These are implementation tasks for the later session after specification binding. All are unchecked in this planning-only session.

## 1. Bind and confirm scope

- [ ] 1.1 Bind OR-11 to this proposal, design and the runner-mascot delta. Dependencies are OR-5 and OR-10.
- [ ] 1.2 Confirm the product changes are confined to `src/`, `test/` and `README.md`. `mascot/mascot.ts` is used unchanged.

## 2. Implement

- [ ] 2.1 Add `src/mascot-events.ts` with `TASK_EVENT_STATUSES`, `RUN_STATUSES`, `NON_OUTCOME_STATUSES = ['recorded']`, `TASK_EVENT_MOODS` and `RUN_OUTCOME_MOODS` (both checked with `satisfies` against their status types), plus `runOutcome(status, code, blockers)`, `taskMascot`, `runMascot({ status, code, line })` and the caption and reason truncation helpers described in design.md.
- [ ] 2.2 In `src/runner.ts`, widen `RunOptions.report` to `(event, detail?: { reason?: string })` and pass `{ reason: (error as Error).message }` at the blocked call site only. The event object stays unchanged.
- [ ] 2.3 In `src/cli.ts`, make `parseFlags` accept the exact `--no-mascot` at most once together with the value flags, refuse duplicates and `--no-mascot=...`, and update the refusal message.
- [ ] 2.4 In `main`, add `MainOptions.mascot` (default: `playMascot` on stderr with the signal and env). At the start of `main`, before reading the invocation file and parsing flags, set `enabled` to false when any argument equals `--no-mascot` or starts with `--no-mascot=`, or when `OUTCOME_RUNNER_MASCOT=0`. A refused `--no-mascot=1` or duplicate `--no-mascot` therefore exits 4 without calling the player.
- [ ] 2.5 Wrap `report`: write the JSON line exactly as today, then queue the task animation on a serialized `pending` chain, with its own AbortController in an `active` set.
- [ ] 2.6 Make `stop` abort every active animation controller. Await `pending` before the terminal line in both the normal and the catch paths. Keep the written terminal object in a local `line`.
- [ ] 2.7 In `finally`, after the sticky abort adjustment, the terminal line and `appendStatistics`, play `runMascot({ status, code, line })` using the final sticky `status` and `code`, with a fresh controller that `stop` can abort, before the signal listeners are removed. Isolate every player call with `Promise.resolve().then(...).catch(() => {})`.
- [ ] 2.8 Add a README section "Mascot" with the mood table (task and run), the captions, a link to `mascot/README.md` for the previews, `--no-mascot` and `OUTCOME_RUNNER_MASCOT=0`, and the note that output goes only to a terminal's stderr. Add `[--no-mascot]` to the start command synopsis and the flags text.

## 3. Tests (graded, easiest first)

- [ ] 3.1 (E) (required) `test/mascot-events.test.ts`: `accepted` maps to happy with caption `OR-1 merged`, and `blocked` with a short reason maps to angry with caption `OR-1 blocked: <reason>`.
- [ ] 3.2 (E) (required) `test/mascot-events.test.ts`: each run outcome gives its mood and the caption `<status>: <n> accepted, <m> remaining`. Covered: exhausted is celebrating, limit-reached is content, incomplete without blockers is sleepy, incomplete with blockers is sad, cancelled is startled, and exit code 4 / unavailable is dizzy with missing arrays counted as 0. Also covered: final status `cancelled` with code 3 and an `exhausted` line gives startled with caption `cancelled: ...`.
- [ ] 3.3 (D) (required) A blocked reason longer than 60 characters, with embedded newlines, is collapsed and truncated to exactly 60 characters ending in `…`. An empty or missing reason gives `<id> blocked`.
- [ ] 3.4 (D) (coverage-only) An unknown event or run status gives no mascot. An empty `blockers` object counts as no blockers.
- [ ] 3.5 (C) (required) Exhaustiveness guard: read `src/runner.ts` and `src/cli.ts`, match each `status:` value expression with `/\bstatus:\s*([^,}\n]+)/g`, and collect every single-quoted literal inside it, including both branches of ternaries. Assert that each literal is a task event or run status with exactly one mood, or is in `NON_OUTCOME_STATUSES`. Assert that `NON_OUTCOME_STATUSES` is disjoint from both status lists and that `'recorded'` occurs only in the `outcome_report` handler's `return { status: 'recorded' }`. Also assert that the collected set contains `exhausted` (from the ternary), so the ternary handling is proven.
- [ ] 3.6 (C) (required) `parseFlags` accepts `--no-mascot` in any position with the other flags, and refuses it when duplicated or written as `--no-mascot=1`.
- [ ] 3.7 (B) (required) `test/cli-mascot.test.ts`: `main` with a fake runner and an injected recording player records the expected mood and caption for accepted and blocked events and for each final status. This includes cancellation by SIGTERM and exit code 4 from an invalid invocation (dizzy). It also checks that `main` with `--no-mascot=1` or a duplicate `--no-mascot` returns 4 with zero player calls.
- [ ] 3.8 (B) (required) `--no-mascot` and `OUTCOME_RUNNER_MASCOT=0` each result in zero player calls.
- [ ] 3.9 (B) (required) The stdout lines of the same fake run with the mascot on and with `--no-mascot` are byte-for-byte identical. The blocked reason is not present on stdout.
- [ ] 3.10 (A) (required) A player that throws synchronously and a player that rejects leave the stdout lines, the exit code and the recorded statistics status and code identical to a run with the mascot off.
- [ ] 3.11 (A) (required) SIGINT during a task animation aborts that animation's signal. With a player wrapping the real `playMascot` on an in-memory TTY stream and an abort-aware fake wait, show-cursor is written before the `cancelled` stdout line, `startled` follows, and the exit code is 3.
- [ ] 3.12 (A) (required) Late-signal race: an output function emits SIGTERM right after it writes the `exhausted` terminal line. stdout still holds the unchanged `exhausted` line, the exit code is 3, the ledger records `cancelled`, and the player records exactly one run mood, `startled`, with caption `cancelled: <n> accepted, <m> remaining`.

## 4. Gates

- [ ] 4.1 Run `npm run typecheck` and `npm test` and confirm that the 85% line, branch and function coverage gates pass.
- [ ] 4.2 Review the final diff against every OR-11 criterion and the delta. Confirm that stdout bytes, exit codes and run state semantics are unchanged.
