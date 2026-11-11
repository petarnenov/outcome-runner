# completion-summary Specification

## Purpose
Report every accepted outcome with its duration across restarts, a short change summary and a complexity grade, so a run is understandable from public output.

## Requirements

### Requirement: Persist original task claim time

The runner SHALL persist the task's original claim timestamp in its work state before executing task work. It SHALL reuse the matching durable ledger claim timestamp when resuming an owned claim and preserve the timestamp across saves, blocked recovery and process restarts.

#### Scenario: Resume after downtime

- **WHEN** a task is claimed at time T, the runner saves its work state, stops and restarts with the same durable invocation
- **THEN** its work state retains the original claim time T
- **AND** eventual elapsed duration includes the stopped interval rather than starting at restart

#### Scenario: Recover the claim-to-work-state gap

- **WHEN** this invocation has an existing matching durable claim and creates or recovers work state after a restart
- **THEN** the runner records that claim's original claimedAt instead of the current time

#### Scenario: Recover older unfinished work

- **WHEN** unfinished work lacks claimedAt and its validated matching owned ledger claim retains the timestamp
- **THEN** the runner restores the original timestamp from that claim
- **AND** if it cannot recover the timestamp it retains private failure diagnostics rather than inventing a duration

### Requirement: Structured reviewer completion reports

The outcome_report schema SHALL allow an optional completion object containing a string summary and a grade in A, B, C, D or E. Both fields SHALL be required whenever the object is present. Supplied completion SHALL be validated at runtime. An accepted implementation-review report SHALL include valid completion; otherwise the runner SHALL refuse it as an invalid private report without advancing to receipt creation.

#### Scenario: Accepted implementation review omits completion

- **WHEN** an implementation reviewer reports accepted without completion
- **THEN** the controller refuses the report with the existing invalid-private-report behavior
- **AND** that report cannot authorize receipt creation or task acceptance

#### Scenario: Reject invalid completion

- **WHEN** a report supplies null or nonobject completion, omits either required field, supplies a nonstring or blank summary, or supplies a grade outside A, B, C, D and E
- **THEN** the controller refuses the report as an invalid private report
- **AND** an accepted implementation review with such a report cannot advance

#### Scenario: Valid completion

- **WHEN** a finding-free accepted implementation review supplies a nonblank summary and a grade in A, B, C, D or E
- **THEN** completion passes the new validation
- **AND** all existing acceptance guards still apply

#### Scenario: Completion remains optional outside accepted implementation review

- **WHEN** a planning review reports accepted or a session reports a nonaccepted outcome without completion
- **THEN** the new completion requirement does not invalidate that report
- **AND** existing report requirements still apply

### Requirement: Explain whole-task complexity and English summary

The implementation review prompt SHALL request two or three English sentences describing what the task changed and a complexity grade for the whole task. It SHALL explain the ordered scale from A (most complex) through B, C and D to E (easiest). The grade SHALL describe complexity rather than correctness, quality or execution speed.

#### Scenario: Implementation review receives instructions

- **WHEN** an implementation review session starts, including a review after repair
- **THEN** its prompt requests a two-or-three-sentence English change summary in completion.summary
- **AND** it explains the whole-task A-to-E complexity scale for completion.grade

### Requirement: Measure wall-clock duration at target acceptance

When the runner first recognizes a valid task receipt on the target and promotes its work to completed, it SHALL measure elapsed time from the original claim, including downtime. durationSeconds SHALL equal elapsed milliseconds divided by 1000, rounded down and clamped to zero. Displayed duration SHALL use Hh Mm Ss with all three units present and hours not wrapped at 24.

#### Scenario: Restart after merge before observation

- **WHEN** merging succeeds, the process stops before recognizing the target receipt, and a restart first observes valid target acceptance
- **THEN** elapsed time is measured from the original claim to that acceptance observation
- **AND** the stopped interval is included

#### Scenario: Duration boundaries

- **WHEN** elapsed time is 999 milliseconds, 25 hours and 5 seconds, or negative after a wall-clock adjustment
- **THEN** durationSeconds is respectively 0, 90005 or 0
- **AND** duration text is respectively 0h 0m 0s, 25h 0m 5s or 0h 0m 0s

### Requirement: Compose completion summary from the accepted review

At target acceptance, the controller SHALL append exactly one English sentence stating formatted duration and complexity grade to the final accepted implementation review's two-or-three-sentence completion summary, producing three or four English sentences. The summary and grade SHALL come from that review's completion.

#### Scenario: Compose summary with elapsed time

- **WHEN** the final implementation reviewer supplies two English sentences and grade B, and target acceptance occurs 4,325 seconds after claim
- **THEN** durationSeconds is 4325 and duration text is 1h 12m 5s
- **AND** the controller appends "The task took 1h 12m 5s from claim to acceptance and has complexity grade B."
- **AND** the resulting summary contains three English sentences

#### Scenario: Three-sentence reviewer summary

- **WHEN** the final accepted implementation review supplies three English sentences
- **THEN** the controller preserves that summary and appends exactly one duration-and-grade sentence
- **AND** the resulting summary contains four English sentences

#### Scenario: Use the final implementation review

- **WHEN** planning review and rejected implementation reviews precede the final accepted implementation review
- **THEN** the completion summary and grade come only from the final accepted implementation review's completion
- **AND** private top-level report summaries are not substituted

### Requirement: Persist completion before emitting acceptance

The runner SHALL durably save the acceptance timestamp and resulting summary, durationSeconds and grade with completed work before emitting the accepted event. Subsequent results for the same invocation SHALL reuse these saved values.

#### Scenario: Acceptance is saved before public output

- **WHEN** the controller promotes a task to completed at target acceptance
- **THEN** it persists the acceptance timestamp and derived completion in the same state update
- **AND** it emits the accepted event only after that update succeeds

#### Scenario: Restart after completion is saved

- **WHEN** a task already has a persisted completion and the same invocation restarts later
- **THEN** the final result uses the saved summary, durationSeconds and grade without recomputing elapsed time
- **AND** no exactly-once stdout delivery guarantee is introduced

### Requirement: Include completion in accepted events

Each newly accepted task event printed to stdout SHALL retain status accepted and its task id and SHALL include the persisted summary, durationSeconds and grade.

#### Scenario: Accepted stdout event

- **WHEN** OR-5 becomes newly accepted
- **THEN** its stdout event has status accepted and id OR-5
- **AND** it includes the completed summary, numeric durationSeconds and valid grade

### Requirement: Include identical completion data in final results

Final result JSON SHALL retain its existing accepted ID array and other fields and SHALL add a completions object keyed by newly accepted task ID. Each entry SHALL contain the identical persisted summary, durationSeconds and grade used by that task's accepted event.

#### Scenario: Event and final result agree

- **WHEN** OR-5 becomes newly accepted
- **THEN** finalResult.completions["OR-5"] contains exactly the same summary, durationSeconds and grade as its accepted stdout event
- **AND** finalResult.accepted still contains OR-5

### Requirement: Preserve completion membership across return paths and restart

Every final result SHALL include persisted completions for the durable invocation's newly accepted tasks, including after a restart. Previously accepted baseline tasks SHALL be excluded. The completions object SHALL be empty when no task is newly accepted.

#### Scenario: Multiple tasks and later interruption

- **WHEN** several tasks become newly accepted and the invocation later returns exhausted, limit-reached, cancelled or incomplete
- **THEN** completions contains each newly accepted task's own saved values keyed by its ID
- **AND** a same-invocation restart retains these values in subsequent results

#### Scenario: Existing receipts count as baseline

- **WHEN** a task was already accepted before the invocation started
- **THEN** it is absent from the newly accepted array and completions map
- **AND** if no task is newly accepted the completions map is empty

### Requirement: Preserve private information boundaries

Public completion output SHALL expose only the requested completion summary, durationSeconds and grade in addition to existing event and result fields. Other private report content, session text and check output SHALL remain private.

#### Scenario: Unrelated private details stay private

- **WHEN** reports, session text or check output contain private details unrelated to completion
- **THEN** the accepted event and final completion entry expose only the requested completion summary, durationSeconds and grade
- **AND** they do not expose those other private details

### Requirement: Preserve receipt compatibility

Receipt validation SHALL NOT require completion, summary, durationSeconds, claim time, acceptance time or grade. Existing valid receipts SHALL remain valid without the new data. Completion metadata SHALL NOT replace existing receipt, review, check, scope or merge guards.

#### Scenario: Old receipt remains accepted

- **WHEN** an otherwise valid existing receipt contains none of the new completion or timing fields
- **THEN** it continues proving historical acceptance
- **AND** it continues satisfying dependency checks without a receipt migration

### Requirement: Document and verify completion behavior

README SHALL document the completion summary, the A-to-E whole-task complexity scale, elapsed time including downtime, accepted stdout event fields and the per-ID final JSON completions map. Automated tests SHALL cover restart duration, refused missing or invalid completion, grade validation and event/result content. npm run typecheck and npm test SHALL pass after implementation.

#### Scenario: Read documented output

- **WHEN** a user reads README
- **THEN** they can identify A as most complex and E as easiest
- **AND** they can locate completion data in accepted events and final result completions

#### Scenario: Verify implementation after binding

- **WHEN** the bound implementation is checked
- **THEN** deterministic tests demonstrate timing across a simulated restart, refusal of accepted review without completion, refusal of invalid grades, and accepted event/final result equality
- **AND** existing receipt compatibility is covered
- **AND** npm run typecheck and npm test pass
