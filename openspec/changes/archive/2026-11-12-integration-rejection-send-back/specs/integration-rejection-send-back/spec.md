## ADDED Requirements

### Requirement: One send-back session for a rejected clean integration

When the checks, the implementation review or the documentation review do not accept the result of a clean
integration, the runner SHALL give the worker one implementation session whose prompt contains the failed check
output or the review findings, instead of blocking the task at once with `target-integration-rejected`.

#### Scenario: Documentation review rejection fixed and accepted

- **WHEN** a clean in-scope target advance is merged and the documentation review of the merged result reports
  `changes-required` with a finding
- **AND** the send-back session fixes the finding
- **THEN** exactly one send-back session starts, and its prompt contains that finding
- **AND** the task is merged and accepted with no blocked entry

#### Scenario: Implementation review rejection fixed and accepted

- **WHEN** a clean in-scope target advance is merged and the implementation review of the merged result reports
  `changes-required` with a finding
- **AND** the send-back session fixes the finding
- **THEN** exactly one send-back session starts, and its prompt contains that finding
- **AND** the task is merged and accepted with no blocked entry

#### Scenario: Failed check fixed and accepted

- **WHEN** a clean in-scope target advance is merged and a product check fails on the merged result
- **AND** the send-back session fixes the cause
- **THEN** exactly one send-back session starts, and its prompt contains the failed check output
- **AND** the task is merged and accepted with no blocked entry

### Requirement: Send-back session limited to the task scopes

The send-back session SHALL be able to write only inside the task scopes, and only task scope paths SHALL be
committed after it.

#### Scenario: Send-back session writes only inside the task scopes

- **WHEN** the send-back session tries to write the `tasks.md` file of the task's OpenSpec change directory
- **THEN** the write is refused and the change directory is not recreated in the task worktree
- **AND** a fix it writes inside the task scopes is committed, and the task is merged and accepted with a receipt
  manifest inside the task scopes and the archived change

### Requirement: Conflict integrations keep their own handling

An integration with conflicts SHALL NOT get a send-back session. Its rejection SHALL still block with
`target-conflict-unresolved` and the conflicting paths.

#### Scenario: Conflict integration rejected by the review

- **WHEN** a conflicting in-scope target advance is resolved and the implementation review of the merged result
  rejects it
- **THEN** no send-back session starts and the task is blocked with `target-conflict-unresolved` and the
  conflicting paths

### Requirement: Checks and reviews run again after the send-back

After the send-back session the runner SHALL commit its result and run the frozen setup and product checks, the
implementation review and the documentation review on the result again. The task SHALL continue to the receipt,
publishing and merging only when all of them accept. Otherwise the runner SHALL block the task with reason
`target-integration-rejected` and record the last findings or check output.

#### Scenario: All three run again after the send-back

- **WHEN** the send-back session of a rejected clean integration finishes
- **THEN** a `setup` or `check` line, an implementation review line and a documentation review line of the merged
  result follow the send-back session line and come before the next `push` line

#### Scenario: Still rejected after the send-back

- **WHEN** the implementation review of the merged result still reports `changes-required` with a finding after the
  send-back session
- **THEN** the task is blocked with reason `target-integration-rejected` and the run result blocker has `kind`
  `blocked` and that reason
- **AND** the blocked entry's work records that last finding in `findings` and in
  `integration.sendBack.rejection.findings`, and `integration.sendBack.outcome` is `rejected`
- **AND** nothing is pushed or merged, and only one send-back session started

### Requirement: Durable send-back without a second session

The runner SHALL record the send-back step and its session state in the integration entry of the durable state
before each next effect. A restart SHALL resume at the recorded step and SHALL NOT start a second send-back session
for the same integrated target commit.

#### Scenario: Restart after the send-back session

- **WHEN** an invocation is cancelled after the send-back session of a rejected clean integration finished, and the
  same invocation is run again
- **THEN** `state.json` records the integration with step `send-back` and a `sendBack` record whose session is
  `started`, with the cause and findings
- **AND** the rerun starts no send-back session, commits the result, runs the checks and both reviews, and the task
  is merged and accepted
- **AND** the finished integration in `integrations` keeps the `sendBack` record with outcome `accepted`

#### Scenario: Restart before the send-back session starts

- **WHEN** the durable state records step `send-back` with session `pending` and the invocation is run again
- **THEN** exactly one send-back session starts, and its step line carries `resuming`

### Requirement: Send-back step lines

The runner SHALL log the send-back, its session, its commit and its outcome as step lines.

#### Scenario: Accepted send-back is logged

- **WHEN** a rejected clean integration is fixed by the send-back session and accepted
- **THEN** the step log contains, in order, `send-back: the <cause> did not accept the merged result; sending it
  back`, `implementation: starting the send-back session of the merged result`, `commit: committing the send-back
  result` and `send-back: the merged result was accepted after the send-back session`

#### Scenario: Rejected send-back is logged

- **WHEN** the merged result is still rejected after the send-back session
- **THEN** the line `send-back: the merged result is still rejected after the send-back session` is directly
  followed by `blocked: stopped at send-back`

### Requirement: README describes the send-back

The README integration section SHALL describe the send-back session and the `target-integration-rejected` reason.

#### Scenario: README section

- **WHEN** a reader looks up target advances in the README
- **THEN** the section `## When the target advances during a run` mentions the send-back session, the checks and
  both reviews running again, and `target-integration-rejected`
