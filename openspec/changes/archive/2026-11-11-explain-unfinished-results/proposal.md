# Proposal: Refuse incomplete task sets and explain every unfinished result

## Why

A run whose leaves (or authority tasks) depend on a task outside that set, and not yet accepted, can never finish:
the runner picks nothing, returns `incomplete` with exit code 3 and an empty or partial `blockers` map, and the user
cannot tell why. Incomplete results in general only name tasks blocked in this invocation; tasks waiting for a
dependency, for another runner's claim or stopped by `maxAccepted` are listed in `remaining` without a reason. A
failed acceptance recording stops the run at once and leaves independent tasks unworked and unexplained.
`state.json` keeps `status: "starting"` forever, so the durable state never says how the invocation ended.

## What Changes

- Before creating run state, claiming or working anything, the runner checks every dependency of every task it
  will work (the leaves, or all authority tasks when no leaves are given). A dependency that is neither in that set
  nor already accepted on `origin/<target>` refuses the run with exit code 4 and diagnostics reason
  `dependencies-outside-invocation`; the diagnostics list each task with its missing dependencies.
- Every result with a nonempty `remaining` list that the runner returns as `incomplete` or `limit-reached` carries a
  `blockers` entry for every remaining task, with a `kind`:
  `blocked` (stage, reason and diagnostics), `waiting-for-dependency` (named dependencies),
  `waiting-for-claim` (named foreign claim with overlapping scopes and its host),
  `waiting-for-blocked-scope` (named blocked task of this invocation with overlapping scopes) or `max-accepted`.
  Each return path takes its own claims ledger snapshot for the classification.
- `maxAccepted` counts only tasks of the invocation accepted during the run, including a merged task whose
  acceptance recording failed. When such a failure does not reach the limit, the run keeps working the other tasks
  and still ends with exit code 3 and a `blocked` entry for the failed task.
- `state.json` `status` records the invocation status the runner last reached: `running` once work starts, then
  `incomplete`, `blocked`, `completed` or `released`, written before `runQueue` returns.
- README documents the dependency check, the unfinished reasons and the state status.

## Capabilities

### New Capabilities

- `unfinished-results`: dependency check of the invocation's task set, per-task unfinished reasons in results and
  the invocation status in `state.json`.

## Impact

- `src/runner.ts` (dependency check, accepted count, acceptance-failure flow, blocker classification, status writes
  and the `RunResult.blockers` entry type); `src/run-store.ts` only if its status type needs narrowing.
- Tests in `test/` with scripted adapters and Git fixtures; existing tests that assert the exact `blockers` shape
  are updated for the added `kind` field.
- `README.md`.
- Exit code 3 is no longer produced by a dependency outside the invocation; such runs exit 4.
