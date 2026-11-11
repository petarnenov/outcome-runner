# OR-5 implementation tasks

All implementation and verification below occur after specification binding. Product scope is src, test and README.md; OR-4 is the prerequisite. No product files or checks are changed or executed by this planning session.

## 1. Completion report contract

- [ ] Add typed completion input and output records and optional WorkerReport.completion.
- [ ] Extend outcome_report schema with summary and A/B/C/D/E grade; validate supplied completion at runtime.
- [ ] Distinguish planning and implementation review contexts explicitly; reject accepted implementation reviews without valid completion through the existing invalid-private-report path.
- [ ] Update implementation review instructions to request two or three English change-summary sentences and explain the whole-task complexity scale, A most complex through E easiest.
- [ ] Update scripted implementation review reports without making completion mandatory for planning review or nonaccepted reports.

## 2. Claim timing and durable completion

- [ ] Save the ledger claim's original claimedAt in Work before task effects; preserve it through saves, blocked recovery and restarts.
- [ ] Recover a missing unfinished-work timestamp from its matching owned durable claim; retain private diagnostics if unrecoverable.
- [ ] Add a small injectable wall clock for deterministic tests.
- [ ] At valid target receipt observation, calculate nonnegative whole durationSeconds and Hh Mm Ss text from original claim time.
- [ ] Append one English duration/grade sentence to the final accepted implementation review's completion summary.
- [ ] Atomically persist acceptedAt and the derived completion with completed work before emitting the accepted event.

## 3. Public output and compatibility

- [ ] Extend accepted events with summary, durationSeconds and grade.
- [ ] Add the final result completions map keyed by newly accepted task ID, using the identical persisted event values on every return path and after restart.
- [ ] Keep accepted IDs, statuses and baseline counting behavior intact; avoid exposing private reports or diagnostics.
- [ ] Preserve validation of old receipts without new completion or timing fields.

## 4. Regression coverage

- [ ] Test original claim timestamp persistence and duration including downtime across a simulated restart using a deterministic clock.
- [ ] Test recovery when merge succeeds before acceptance observation; verify completed duration remains unchanged on later restarts.
- [ ] Test missing accepted implementation-review completion, malformed completion and invalid grades are refused without receipt or acceptance; test valid grades and optional completion elsewhere.
- [ ] Assert schema and prompt requirements, including English sentence count instructions and A-to-E whole-task complexity.
- [ ] Assert a two-sentence and three-sentence reviewer summary each receives exactly one duration/grade sentence; cover 4325 seconds, zero, fractional seconds and hours beyond 24.
- [ ] Assert accepted stdout event content and final-result equality per newly accepted task ID, including multiple tasks, all result statuses, exclusion of baseline tasks and an empty completions map.
- [ ] Assert only the final accepted implementation review supplies public completion, and unrelated private text stays private.
- [ ] Retain regression coverage for historical receipts and dependency acceptance without new metadata.

## 5. Documentation and checks

- [ ] Document completion summaries, persisted wall-clock duration including downtime, A most complex to E easiest, accepted stdout events and final JSON completions in README.
- [ ] Run npm run typecheck and npm test successfully after implementation.
- [ ] Run the frozen project checks after binding and record implementation verification evidence.
