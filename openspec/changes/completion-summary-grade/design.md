# Completion summary design

## Current Behavior

src/runner.ts records claimedAt in the shared claim ledger but omits it from Work. Work and review records are durably saved by RunStore in src/run-store.ts. Planning review and implementation review both use purpose review, so purpose alone cannot identify which accepted report needs completion.

The controller recognizes acceptance when a valid receipt appears on the target, moves current work to completed, and emits an accepted event. Its final results currently contain accepted IDs and remaining IDs. src/cli.ts serializes runner events and the final result directly. Receipt creation deliberately reduces review records to reviewer and outcome; completion need not become receipt evidence.

## Data and Report Contract

Add a completion input type with summary: string and grade: 'A' | 'B' | 'C' | 'D' | 'E', and optional completion on WorkerReport. Extend the tool schema with an optional object whose required members are summary and grade and whose grade enum is exactly that scale. Validate its shape at runtime as well as in the schema; reject null, arrays, missing members, wrong types, empty or whitespace-only summaries and unsupported grades as Invalid private report. Preserve the existing top-level summary, findings and inspected semantics.

Require completion when outcome is accepted in the implementation review context. Pass an explicit internal distinction for planning versus implementation review rather than infer it from prompt text; a small session argument is sufficient. Planning acceptance and nonaccepted reports may omit completion. If completion is supplied, validate it even when optional. Invalid reports must not become the session result or permit advancement into receipt creation.

The implementation review prompt requests two or three English sentences describing what the whole task changed, plus a grade for whole-task complexity: A is most complex, B next, C middle, D next easiest, E easiest. This is complexity, not correctness, quality or elapsed speed. The prompt carries the prose requirements; runtime validation enforces the structured fields without fragile language detection or punctuation-based sentence counting. A finding-free accepted review remains necessary.

## Durable Claim Time

Add claimedAt to Work and persist it before worktree creation or worker execution. Use the same ISO UTC timestamp as the successful ledger claim. When a matching claim owned by this invocation already exists, retain its original claimedAt rather than generating a restart timestamp. Blocked-work recovery and subsequent saves preserve it.

If unfinished work from an older state lacks claimedAt, recover it from the matching durable ledger claim after existing ownership and task identity validation. Do not substitute process startup time or silently fabricate an elapsed duration if the original timestamp cannot be recovered; retain private diagnostics. This is distinct from historical receipt acceptance, which requires no timing metadata.

Use a narrowly injectable wall-clock source in runner options, defaulting to Date.now, so restart and acceptance tests use known timestamps without real sleeps. Existing Date.now call sites unrelated to this feature need not change.

## Acceptance and Output

Acceptance time is when the controller first observes the valid receipt on the target and promotes the current work to completed, not when the reviewer returns accepted. This includes review, checks, publishing, merging, downtime and recovery.

Calculate durationSeconds as max(0, floor((acceptedAt - claimedAt) / 1000)). Format hours, minutes and seconds as Hh Mm Ss, retaining all three units, without wrapping hours at 24. For 4,325 seconds the text is 1h 12m 5s; for zero it is 0h 0m 0s. Clamp a backwards wall-clock adjustment to zero.

Use the final accepted implementation review's completion, not the planning report, a rejected review or private top-level summary. Append exactly one sentence, for example: "The task took 1h 12m 5s from claim to acceptance and has complexity grade B." The review's two or three sentences plus this sentence yield three or four English sentences.

Persist acceptedAt and the derived completion output (summary, durationSeconds, grade) with the completed work in the same state update that clears current. Emit only after that durable update. This freezes elapsed time and wording for restart results, including recovery after a merge that succeeded before the old process observed target acceptance. The feature does not promise exactly-once event delivery across a crash between state persistence and stdout emission.

The accepted event extends the existing shape:
```json
{"status":"accepted","id":"OR-5","summary":"The runner now reports completion details. Claim timing survives restarts. The task took 1h 12m 5s from claim to acceptance and has complexity grade B.","durationSeconds":4325,"grade":"B"}
```

Preserve the final result's accepted array and other existing fields; add completions: Record<string, { summary: string; durationSeconds: number; grade: Grade }>. Populate it for newly accepted IDs in the durable invocation, including those accepted before a same-invocation restart. Use the same persisted values as the event on every return path: exhausted, limit-reached, cancelled and incomplete. Exclude baseline accepted tasks, which are not newly accepted. Return an empty map when no task is newly accepted. Centralize map construction to avoid divergent exit paths. CLI serialization should continue passing these values through.

## Compatibility and Scope

Do not require timing, summary, grade or completion in receiptAt or existing version 1 receipts. No receipt schema migration or rewriting of historical receipts is needed. Baseline tasks proven complete by old receipts still unblock dependencies and count zero toward newly accepted tasks. Completion output is controller metadata and does not alter authority hashes, specification hashes, merge guards or the claim protocol.

Private report summaries, findings, check output and session text remain private. Only the explicitly requested reviewer completion summary and controller duration/grade are added to public output.

## Verification

Update scripted implementation reviewers to provide valid completion, leaving planning-only acceptance fixtures valid without it. Add deterministic tests for schema and runtime validation, missing accepted-review completion, invalid grades, prompt instructions, original claim time after simulated restart, merge-before-observation recovery, stable repeated results and public/private output boundaries. Assert exact event/result equality, formatting, selected final review and per-task map membership. Preserve receipt compatibility tests using receipts without the new metadata.

After specification binding, run npm run typecheck and npm test, plus the frozen project checks through the authorized controller. Planning makes no claim that these checks have run.
