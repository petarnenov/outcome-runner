# Show the mascot when tasks and runs end

## Why

OR-10 and OR-15 built a terminal mascot (`mascot/mascot.ts`, `playMascot`) with eight moods, but the runner never shows it. OR-11 connects the mascot to the runner so that a person watching a terminal sees at a glance how each task and the whole run ended. The JSON lines on stdout stay the machine contract and must not change. OR-5 (CLI flags and statistics) and OR-10 (the mascot module) are prerequisites.

## What Changes

- A new module `src/mascot-events.ts` maps every task event status and every final run outcome to exactly one mascot mood and builds the captions. Non-outcome status literals (only the `outcome_report` acknowledgement `recorded`) are listed explicitly so that the exhaustiveness test stays precise.
- `main` in `src/cli.ts` plays the mood when a task ends (accepted and merged: happy; blocked: angry) and when the run ends (exhausted: celebrating; limit-reached: content; incomplete without blockers: sleepy; incomplete with blockers: sad; cancelled by SIGINT/SIGTERM: startled; exit code 4: dizzy). The run mood is chosen from the final sticky status and exit code, so a signal that arrives after the terminal line still gives startled.
- Captions: `<id> merged`, `<id> blocked: <reason of at most 60 characters>` and `<final status>: <n> accepted, <m> remaining`.
- The runner passes the private blocked reason to the CLI through an optional second `report` argument that is never serialized, so stdout stays byte-for-byte unchanged.
- The mascot is written to stderr only. It is switched off with the new flag `--no-mascot`, which is accepted together with the other CLI flags, or with `OUTCOME_RUNNER_MASCOT=0`. Any argument that requests the off switch, even a refused `--no-mascot=1`, keeps the mascot off.
- SIGINT/SIGTERM aborts a running animation through its abort signal, and the cursor is restored before the cancelled result is written.
- A failing mascot player never changes the result line, the exit code, the run state or the statistics ledger.
- An injected mascot player (`MainOptions.mascot`) makes all of this testable.
- README documents the moods, links `mascot/README.md` for the previews and explains how to turn the mascot off.

## Capabilities

### New Capabilities

- `runner-mascot`: the runner shows the terminal mascot when tasks and runs end.

## Impact

- Product: `src/mascot-events.ts` (new), `src/cli.ts`, `src/runner.ts` (the optional second `report` argument only), new tests under `test/`, and `README.md`.
- `mascot/mascot.ts` is used as it is and is not changed (it is outside the task scopes).
- No new dependencies. The stdout JSON lines, exit codes, run state and statistics ledger keep their existing meaning and bytes.

## Session Boundary

This planning session writes only proposal.md, design.md, tasks.md and specs/runner-mascot/spec.md in this change directory. Specification binding, product edits and frozen project checks happen in a later session. That deferral is expected and is not a blocker.
