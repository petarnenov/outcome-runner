# JSONL ledger of all runs for statistics

## Why

OR-7 needs a machine-readable history of every runner start, including failed startup and cancellation. The durable per-invocation store currently supports recovery, but is not a cross-run statistics ledger and contains private data that must not be exported.

## What Changes

- Append one schema-versioned JSON object per non-hash runner execution to the XDG state ledger at termination.
- Capture run identity, safe repository metadata, resolved settings and provenance, task decisions, review/check/session metrics, completion data and optional harness token usage.
- Specify lifecycle, timing, terminal status, task outcomes and acceptance data as separate requirements with WHEN/THEN scenarios.
- Handle startup failure and both supported cancellation signals through one guarded finalizer; ledger failure only reports on stderr.
- Document every field and type in README and add isolated tests using scripted harnesses.

## Capabilities

### New Capabilities

- `run-statistics-ledger`: append-only run statistics, explicit privacy boundary, best-effort persistence and documented schema.

### Modified Capabilities

None. Existing completion and claim behavior are reused.

## Impact

Implementation is limited to `src`, `test` and `README.md`. OR-5 completion data and OR-6 cross-machine claim decisions are dependencies. No change to authority content, receipts, claim ownership, acceptance gates or existing result/exit-code semantics is required. This session creates only this OpenSpec packet; implementation and checks follow specification binding.
