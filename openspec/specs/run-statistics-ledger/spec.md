# run-statistics-ledger Specification

## Purpose
Keep a machine-readable JSONL ledger of every runner start, including failed startup and cancellation, without private data.

## Requirements

### Requirement: One record for each terminating runner execution

Every runner invocation except the hash command SHALL append exactly one JSON object followed by one newline when it terminates with exit code 0, 3 or 4, or cancellation by SIGINT or SIGTERM. A guarded finalizer SHALL cover startup failures and prevent duplicate records.

#### Scenario: Successful and incomplete runs

- **WHEN** a run finishes exhausted or limit-reached with code 0, or incomplete with code 3
- **THEN** exactly one line records that execution's final status and actual exit code
- **AND** existing stdout and result semantics are preserved

#### Scenario: Unavailable startup

- **WHEN** JSON parsing, flags, configuration, preflight or harness resolution fails and the runner returns 4
- **THEN** exactly one line has status unavailable, exitCode 4 and a safe failureReason code
- **AND** metadata not yet discovered is null and undiscovered tasks are omitted

#### Scenario: Signal before or after work starts

- **WHEN** SIGINT or SIGTERM arrives during startup or task work
- **THEN** pending activity is cancelled and the finalizer writes one cancelled record using the existing cancellation exit code, currently 3
- **AND** repeated signals or racing cleanup paths do not append another record
- **AND** SIGKILL and failures preventing cleanup are outside this termination guarantee

#### Scenario: Hash exclusion and resumed invocation

- **WHEN** hash succeeds or fails
- **THEN** no ledger line or ledger directories are created by that command
- **WHEN** a durable invocation is resumed in a new execution
- **THEN** the new execution appends its own line with a new runId

### Requirement: Append-only private local storage

The ledger SHALL be located at $XDG_STATE_HOME/outcome-runner/runs.jsonl, defaulting to ~/.local/state/outcome-runner/runs.jsonl for unset, empty or relative XDG_STATE_HOME. Missing directories SHALL be created. The ledger SHALL have mode 0600. Existing lines SHALL never be rewritten or removed. Each record SHALL be serialized before one append write on an O_APPEND file descriptor so concurrent executions on one machine do not interleave records.

#### Scenario: First and subsequent runs

- **WHEN** the first run ends with no ledger directory present
- **THEN** missing directories and the ledger are created and the file has mode 0600
- **WHEN** another run ends
- **THEN** the previous bytes remain unchanged and exactly one new JSON line follows

#### Scenario: Concurrent appends

- **WHEN** two runs on the same machine append concurrently
- **THEN** the ledger contains two complete independently parseable JSON lines with distinct runIds
- **AND** neither record is split across or interleaved with the other

### Requirement: Versioned run identity and timing

Every record SHALL include every field with its type and nullability from the schemaVersion 1 table in design.md. schemaVersion SHALL be 1 and runId SHALL uniquely identify the execution, including a resumed execution.

#### Scenario: Fully resolved execution

- **WHEN** a configured repository run ends
- **THEN** its record identifies the executing package version, hostname, canonical repository top-level, origin URL, target, invocation and authority reference
- **AND** all schema fields, including settings, tasks and tokenUsage, are present
- **AND** it includes no authority instruction text or origin URL userinfo credentials

### Requirement: Run timing

startedAt and endedAt SHALL be ISO 8601 UTC timestamps for execution start and finalization. durationSeconds SHALL be nonnegative elapsed execution seconds.

#### Scenario: Timing a completed execution

- **WHEN** an execution reaches finalization
- **THEN** startedAt and endedAt identify its UTC boundaries
- **AND** durationSeconds uses elapsed time from a monotonic clock

### Requirement: Terminal status and failure reason

exitCode SHALL record the actual returned code. status SHALL be exhausted, limit-reached, incomplete, cancelled or unavailable. failureReason SHALL be a safe nonnull reason code for unavailable and null otherwise.

#### Scenario: Mapping terminal results

- **WHEN** the runner terminates normally, incompletely, by cancellation or because it is unavailable
- **THEN** exhausted and limit-reached use exitCode 0, incomplete and cancelled use 3, and unavailable uses 4
- **AND** only unavailable has a nonnull failureReason

### Requirement: Undiscovered metadata

Required repository and invocation metadata not discoverable before early failure SHALL be null according to the design schema.

#### Scenario: Failure before invocation discovery

- **WHEN** invocation JSON cannot be parsed before repository discovery
- **THEN** repositoryTopLevel, originUrl, targetBranch, invocation and authorityReference are null where not yet discovered
- **AND** schemaVersion, runId, runnerVersion, hostname and execution timing remain present

### Requirement: Resolved settings and provenance

settings SHALL contain harness, harnessCliVersion, model, effort, coverage, maxAccepted and leaves as {value, source} pairs with the types in design.md. source SHALL be cli-flag, invocation-json, interactive-answer, default or null when unresolved. Values SHALL be the effective resolved settings, not merely raw requested values. Observed harnessCliVersion SHALL inherit the harness source. Unbounded maxAccepted SHALL be null/default; unexpanded leaves SHALL be null/null.

#### Scenario: Resolution and precedence

- **WHEN** a flag overrides a JSON value, another setting comes from JSON, another from an explicit interactive choice and another from a default
- **THEN** each effective value has respectively cli-flag, invocation-json, interactive-answer or default attribution
- **AND** pressing Enter for a suggested value counts as default
- **AND** the selected leaves are the effective expanded task IDs and harness version comes from an existing probe

#### Scenario: Partial resolution and restart

- **WHEN** resolution fails before some settings are available
- **THEN** unresolved pairs have null value and source
- **WHEN** selection resumes from saved state with provenance
- **THEN** its original setting sources are preserved
- **AND** legacy state without provenance remains compatible using the documented default fallback without altering frozen authority/config identity

### Requirement: Task decisions and completion statistics

tasks SHALL contain one entry per task worked on or explicitly decided about during the execution, deduplicated by id. Each entry SHALL contain all fields with the types and nullability in the task table in design.md. Unrelated queue tasks and historical baseline acceptances SHALL be excluded.

#### Scenario: Accepted and blocked tasks

- **WHEN** one task is accepted and another is blocked after work begins
- **THEN** both task entries identify their task/change, final outcome and last stage
- **AND** the accepted entry includes its persisted duration, complexity grade and completion summary
- **AND** the blocked entry includes a safe blocking reason and null acceptance data
- **AND** each entry includes available check outcomes and PR number/URL

#### Scenario: Foreign claims and pending leaves

- **WHEN** evaluated selected tasks are unavailable due to foreign claims or scope conflicts, or remain pending due to dependencies, a limit or cancellation
- **THEN** their outcomes are respectively claimed-elsewhere or not-started
- **AND** owned work interrupted before acceptance is blocked with a safe cancellation or incomplete reason
- **AND** later acceptance in the same execution supersedes an earlier nonaccepted decision for that task

### Requirement: Task outcomes and progress

Task outcome SHALL be accepted, blocked, claimed-elsewhere or not-started. Blocked tasks SHALL have a safe blockingReason. lastStage SHALL identify the last persisted controller stage reached, or null before owned work.

#### Scenario: Interrupted owned work

- **WHEN** work begins but does not reach acceptance before cancellation
- **THEN** its task entry is blocked with a safe cancellation reason
- **AND** lastStage preserves the last controller stage reached

### Requirement: Accepted completion data

Accepted entries SHALL reuse OR-5 persisted claim-to-acceptance durationSeconds, complexityGrade and approved completionSummary. These three fields SHALL be null for nonaccepted entries.

#### Scenario: Acceptance after recovery

- **WHEN** a resumed task is accepted
- **THEN** durationSeconds uses the original claim through acceptance
- **AND** complexityGrade and completionSummary match the persisted OR-5 completion

### Requirement: Task pull request reference

Task pr SHALL contain the PR number and URL when a PR exists, otherwise null.

#### Scenario: Published and unpublished work

- **WHEN** a task has a known PR
- **THEN** pr contains its integer number and string URL
- **WHEN** a task has no PR
- **THEN** pr is null

### Requirement: Session, review and check metrics

workerSessions SHALL contain integer counts for investigate, plan, work and review, counting starts including sessions interrupted before reply. Review round counts SHALL distinguish planning from implementation, with one findings count per completed round in order. Task counts/reviews SHALL describe known durable history, without duplicating entries upon recovery. finalChecks SHALL retain the latest actual final check commands and outcomes, including failure without check output.

#### Scenario: Repair and interruption

- **WHEN** a task receives multiple planning and implementation reviews and a later worker session is interrupted
- **THEN** each purpose count includes all started sessions
- **AND** each review category reports its own rounds and ordered findings counts
- **AND** resuming does not count stored review records twice

#### Scenario: Failed final gate

- **WHEN** a final check fails
- **THEN** its executable, argument array and failure outcome are recorded
- **AND** neither output nor a fabricated passing outcome is recorded

### Requirement: Reported token usage only

Run and task tokenUsage SHALL be null when unavailable, otherwise {inputTokens, outputTokens, totalTokens} with nonnegative integer or null components. Usage SHALL include only sessions from this execution, deduplicate cumulative harness updates and preserve null for components lacking complete reporting across relevant sessions. Missing usage SHALL never be estimated or treated as zero.

#### Scenario: Reported, partial and absent usage

- **WHEN** all sessions report numeric usage
- **THEN** task and run usage contain correctly summed components
- **WHEN** some sessions do not report a component
- **THEN** that aggregate component is null
- **WHEN** no usage is reported
- **THEN** task and run tokenUsage are null
- **AND** repeated cumulative updates and resumed historical usage are not added twice

### Requirement: Strict private-content exclusion

Records SHALL be built from allowlisted metadata only. They SHALL never contain authority instruction text, worker prompts, private worker output, finding text, check output, file contents, environment variables, raw errors or arbitrary harness event payloads. Only safe controller reason codes SHALL populate failureReason and blockingReason. The requested OR-5 approved completion summary SHALL be used instead of private report summaries.

#### Scenario: Private markers

- **WHEN** authority instructions, prompts, private worker text, findings, check output, file bodies and environment contain distinct secret markers
- **THEN** none of those markers appears in ledger bytes
- **AND** findings are represented only by counts and checks only by commands/args/outcomes

### Requirement: Ledger persistence cannot change results

A failure to create, open, secure, serialize, append or close the ledger SHALL be reported on stderr and SHALL NOT change the runner exit code, stdout result or task result. A short write SHALL be reported without another append retry.

#### Scenario: Unwritable ledger

- **WHEN** ledger persistence fails for a run otherwise returning 0, 3 or 4, including cancellation
- **THEN** stderr reports the persistence failure safely
- **AND** the original exit code and result remain unchanged
- **AND** no recursive ledger attempt occurs

### Requirement: Document and verify the contract

README SHALL document the ledger path and default, one line per non-hash execution, every record field and nested field with its type and enums, null/provenance meanings and best-effort failure behavior. Tests SHALL use temporary XDG_STATE_HOME and no real harness. npm run typecheck and npm test SHALL pass after implementation.

#### Scenario: Isolated verification after binding

- **WHEN** the bound implementation is verified
- **THEN** tests cover exits 0/3/4, SIGINT/SIGTERM, two sequential and concurrent appends, permissions, schema, accepted/blocked tasks, settings provenance, usage/nulls, privacy and unwritable-ledger result preservation
- **AND** npm run typecheck and npm test pass
- **AND** README permits every field and its type to be understood without reading product code
