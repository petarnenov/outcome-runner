# runner-mascot Specification

## Purpose
Show the terminal mascot when tasks and runs end so a person sees the outcome at a glance, without changing stdout.

## Requirements

### Requirement: Mood when a task ends

The runner SHALL play the mascot from `mascot/mascot.ts` once for every task event it reports. It SHALL play `happy` for an `accepted` event, which means the task was accepted and its Pull Request merged, and `angry` for a `blocked` event.

#### Scenario: Accepted task

- **WHEN** the runner reports `{"status":"accepted","id":"OR-1",...}`
- **THEN** the mascot plays mood `happy` with caption `OR-1 merged`

#### Scenario: Blocked task with a short reason

- **WHEN** the runner reports a `blocked` event for `OR-1` whose private reason is `Worker plan incomplete`
- **THEN** the mascot plays mood `angry` with caption `OR-1 blocked: Worker plan incomplete`

#### Scenario: Blocked reason longer than 60 characters

- **WHEN** the private blocked reason, after whitespace runs are collapsed to one space and the result is trimmed, is longer than 60 characters
- **THEN** the caption reason is its first 59 characters followed by `…`, exactly 60 characters
- **AND** the caption contains no newline

#### Scenario: Blocked without a reason

- **WHEN** a blocked event has no reason or an empty reason
- **THEN** the caption is `<id> blocked`

### Requirement: Mood when a run ends

After the terminal JSON line is written, the runner SHALL play exactly one mood for the run. The mood SHALL be chosen from the final status and exit code after the sticky abort adjustment (the same values recorded in the statistics ledger) and from the presence of blockers in the terminal line. Exit code 4 SHALL always give `dizzy`, and a final status of `cancelled` SHALL always give `startled`.

#### Scenario: Exhausted run

- **WHEN** a run ends `exhausted`
- **THEN** the mascot plays `celebrating`

#### Scenario: Limit reached

- **WHEN** a run ends `limit-reached`
- **THEN** the mascot plays `content`

#### Scenario: Incomplete while only waiting

- **WHEN** a run ends `incomplete` with no blockers, only waiting for claimed or dependent work
- **THEN** the mascot plays `sleepy`

#### Scenario: Incomplete with blockers

- **WHEN** a run ends `incomplete` with a non-empty `blockers` object
- **THEN** the mascot plays `sad`

#### Scenario: Cancelled run

- **WHEN** a run is cancelled by SIGINT or SIGTERM
- **THEN** the mascot plays `startled`

#### Scenario: Signal after the terminal line

- **WHEN** SIGTERM arrives after the `exhausted` terminal line was written and before `main` finishes
- **THEN** the stdout line stays `exhausted` byte-for-byte
- **AND** the exit code is 3 and the ledger records `cancelled`
- **AND** the mascot plays `startled` with caption `cancelled: <n> accepted, <m> remaining`, not `celebrating`

#### Scenario: Exit code 4

- **WHEN** `main` returns exit code 4 with the line `{"status":"unavailable",...}` and the mascot is enabled
- **THEN** the mascot plays `dizzy`

### Requirement: Run caption

The run caption SHALL be `<status>: <n> accepted, <m> remaining`. `<status>` SHALL be the final status after the sticky abort adjustment. n and m SHALL be the lengths of the `accepted` and `remaining` arrays of the terminal line written to stdout. A missing array SHALL count as 0.

#### Scenario: Caption with counts

- **WHEN** a run ends `exhausted` with 2 accepted and 0 remaining
- **THEN** the caption is `exhausted: 2 accepted, 0 remaining`

#### Scenario: Caption without arrays

- **WHEN** the terminal line is `{"status":"unavailable",...}` without `accepted` or `remaining`
- **THEN** the caption is `unavailable: 0 accepted, 0 remaining`

### Requirement: Every status has exactly one mood

Every task event status and every final run status the runner can produce SHALL map to exactly one mood. A test SHALL fail when such a status has no mood.

#### Scenario: Task event and run statuses

- **WHEN** the mapping is checked for the task event statuses `accepted` and `blocked` and the run statuses `exhausted`, `limit-reached`, `incomplete`, `cancelled` and `unavailable`
- **THEN** each resolves to exactly one mood
- **AND** `incomplete` resolves to `sad` with blockers and to `sleepy` without blockers

#### Scenario: Exhaustive mapping guard

- **WHEN** the test collects every single-quoted string literal inside the value expression of each `status:` property in `src/runner.ts` and `src/cli.ts`, including both branches of conditional expressions such as `config.maxAccepted ? 'incomplete' : 'exhausted'`
- **THEN** every collected literal is a task event status or a run status with a defined mood, or is listed in `NON_OUTCOME_STATUSES`
- **AND** adding a new status literal without a mood, as a plain value or inside a conditional expression, makes the test fail

### Requirement: Explicit non-outcome statuses

Status literals that are neither task events nor run statuses SHALL be listed in `NON_OUTCOME_STATUSES`. The list SHALL contain only `recorded`, the `outcome_report` tool acknowledgement.

#### Scenario: Exclusion cannot hide an outcome

- **WHEN** the guard checks `NON_OUTCOME_STATUSES`
- **THEN** it is disjoint from the task event and run statuses
- **AND** `recorded` occurs in the source only as the `outcome_report` tool handler's `return { status: 'recorded' }`

### Requirement: Stderr only and unchanged stdout

The mascot SHALL be written to stderr only. The JSON lines written to stdout SHALL be byte-for-byte identical whether the mascot is on or off. The blocked reason SHALL reach the mascot through an argument that is not serialized and SHALL NOT appear on stdout.

#### Scenario: Identical stdout

- **WHEN** the same fake run with accepted and blocked events is executed once with the mascot enabled and once with `--no-mascot`
- **THEN** the stdout lines are byte-for-byte identical
- **AND** the default player targets `process.stderr` and never stdout

### Requirement: Turning the mascot off

The flag `--no-mascot` SHALL turn the mascot off. It SHALL be accepted at most once, in any order, together with `--harness=`, `--model=`, `--effort=` and `--coverage=`. `OUTCOME_RUNNER_MASCOT=0` in the environment SHALL also turn it off. Any argument equal to `--no-mascot` or starting with `--no-mascot=` SHALL turn the mascot off before flag parsing, even when `parseFlags` then refuses it. When the mascot is off, the player SHALL NOT be called.

#### Scenario: Flag

- **WHEN** `main` runs with `--model=claude-sonnet-5-5 --no-mascot --effort=high`
- **THEN** the flags are accepted, the model and effort apply and the player is never called

#### Scenario: Repeated or valued flag

- **WHEN** `--no-mascot` is given twice, or as `--no-mascot=1`
- **THEN** the arguments are refused with exit code 4 as for any other invalid flag
- **AND** the mascot is off because the argument requests it, so the player is never called and no `dizzy` is played

#### Scenario: Environment

- **WHEN** `main` runs with `OUTCOME_RUNNER_MASCOT=0` in its environment
- **THEN** the player is never called

### Requirement: Abort on SIGINT and SIGTERM

Every animation SHALL receive an abort signal. A SIGINT or SIGTERM during an animation SHALL abort it through that signal. The runner SHALL wait for the aborted animation to finish, so that the cursor is shown again, before it writes the cancelled result and finishes cancelling.

#### Scenario: SIGINT during a task animation

- **WHEN** SIGINT arrives while the animation for an `accepted` event is playing
- **THEN** that animation's signal is aborted
- **AND** with the real `playMascot` on an in-memory TTY stream, the show-cursor sequence is written before the `cancelled` terminal line
- **AND** the run then plays `startled` and ends with exit code 3

### Requirement: Mascot failure is harmless

A mascot failure (a player that throws synchronously or rejects) SHALL NOT change the runner result line, its exit code, the run state or the statistics ledger entry.

#### Scenario: Failing player

- **WHEN** the injected player throws or rejects for every call
- **THEN** the stdout lines and the exit code equal those of the same run with the mascot off
- **AND** the recorded statistics status and exit code are unchanged

### Requirement: Mascot test coverage

Tests SHALL use an injected mascot player. They SHALL cover the mood and caption for every task event and run status, including exit code 4, the signal-after-terminal-line race and a blocked reason longer than 60 characters; `--no-mascot` and `OUTCOME_RUNNER_MASCOT=0`; stdout identity with and without the mascot; abort on SIGINT during an animation; and a failing player.

#### Scenario: Injected player tests

- **WHEN** the test suite runs
- **THEN** a recording player injected through `MainOptions.mascot` observes each mood and caption listed in this specification
- **AND** the off switches, stdout identity, SIGINT abort, late-signal race and failing player cases each have a test

### Requirement: Mascot documentation

README.md SHALL document when each mood appears, link `mascot/README.md` for the previews and explain how to turn the mascot off.

#### Scenario: README section

- **WHEN** a reader opens README.md
- **THEN** it contains the task and run mood table, a link to `mascot/README.md`, `--no-mascot` and `OUTCOME_RUNNER_MASCOT=0`

### Requirement: Quality gates

`npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Gates pass

- **WHEN** the implementation is complete
- **THEN** `npm run typecheck` and `npm test` pass with the existing coverage thresholds
