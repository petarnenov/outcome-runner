# Run statistics ledger design

## Context

`src/cli.ts` owns exit mapping: exhausted/limit-reached return 0, incomplete/cancelled return 3, and startup/run failure returns unavailable with 4. Its catch currently creates private diagnostics. The hash route bypasses main and must continue bypassing statistics. `runQueue` performs preflight and selection before opening RunStore or installing its current cancellation handlers, so recording only inside RunStore would miss early failures and signals.

Work already retains stages, sessions, planningReviews, reviews, finalChecks, claimedAt, completion and PR metadata. Session text, arbitrary adapter events, check output, authority instructions and failure detail are private. Completion from OR-5 is the deliberately approved completion summary. OR-6 supplies foreign-claim decisions. Applicable AGENTS.md files were queried and were absent.

## Specification structure

The capability delta uses `## ADDED Requirements`. Each requirement states a bounded behavior and has at least one WHEN/THEN scenario. Run identity, timing, terminal status and undiscovered metadata are separate requirements; task inclusion, outcomes, accepted completion data and PR references are also separate. The schema tables below retain the complete field/type contract without repeating it in long requirement paragraphs.

## Ownership and lifecycle

Create a small statistics collector and append writer under src. The CLI main boundary starts a fresh UUID and timestamp before reading invocation JSON or parsing flags. One execution of main is one run even when it resumes the same durable invocation; invocation name is not run identity. The hash branch creates no collector and never touches the ledger, including hash failures.

Use one guarded finalization path for normal results, caught failures and SIGINT/SIGTERM. Capture exitCode/status before appending and preserve ordinary stdout/result behavior. Register cancellation handling before startup awaits; coordinate with runner stop/adapter.close instead of adding competing handlers. Cancellation during startup must terminate pending selection/preflight work and finalize once even before a store or adapter exists. Repeated signals, a cancellation racing with an exception, and runner cleanup must not append twice. Once cancellation is recorded it remains cancelled; use the existing cancellation exit convention, currently 3, rather than introducing signal-derived exit codes. Remove handlers on completion. SIGKILL, power loss and process crashes which cannot execute cleanup are outside this termination guarantee.

The collector gets typed, explicit updates at resolution, scheduling, session start, review completion, checks and acceptance. Do not assemble data by serializing RunConfig, RunState, Work, WorkerReply, errors or raw events. Snapshot state needed for statistics before stores close, including partial progress on exceptions.

## Schema version 1

All listed keys are present. Null means unavailable/not reached, not an empty string or fabricated zero. Lists are empty when there are no entries. README must enumerate this full contract, including nested fields and enums.

| Field | Type and meaning |
| --- | --- |
| schemaVersion | integer literal 1 |
| runId | string, fresh UUID per execution |
| runnerVersion | string, executing package version, not a hardcoded release |
| hostname | string, machine hostname |
| repositoryTopLevel | string or null, canonical Git top-level path once discovered |
| originUrl | string or null, origin remote once discovered; omit embedded credentials from URL userinfo |
| targetBranch | string or null, resolved project target |
| invocation | string or null, invocation name |
| authorityReference | string or null, reference only |
| startedAt | string, ISO 8601 UTC execution start |
| endedAt | string, ISO 8601 UTC finalization time |
| durationSeconds | number, nonnegative elapsed run seconds from a monotonic clock |
| exitCode | integer, actual returned code (0, 3 or 4) |
| status | exhausted, limit-reached, incomplete, cancelled or unavailable |
| failureReason | string or null, safe failure reason code for unavailable, null otherwise |
| settings | object described below |
| tasks | array of task statistics described below |
| tokenUsage | token usage object or null, described below |

Settings uses a uniform `{value, source}` pair per field. source is `cli-flag`, `invocation-json`, `interactive-answer`, `default`, or null when unresolved. value types are harness: string|null (claude/codex when resolved), harnessCliVersion: string|null, model: string|null, effort: string|null, coverage: integer|null (1–100), maxAccepted: integer|null, leaves: string[]|null. For maxAccepted, value null with source default means no limit; null/null means startup never resolved it. For leaves, default means the expanded authorized task IDs, not a raw omitted value. harnessCliVersion is observed, not chosen: use the selected harness's source for this paired metadata and document that rule.

Capture provenance where values are chosen, before CLI overrides erase JSON attribution. CLI beats JSON; unanswered noninteractive selection and Enter accepting a suggested choice count as default, explicit nonempty interactive choices as interactive-answer. Harness config/catalog defaults count as default. Preserve original sources with saved resolved selection for a resumed durable invocation; do not mislabel a saved interactive choice as a JSON value. Historical state without source metadata may use default as the documented legacy fallback; do not require destructive state migration. Statistics-only provenance must not change authority/config identity hashes or invalidate older invocation state. Harvest selected CLI version from existing probes rather than starting another harness session.

Each tasks entry has:

| Field | Type and meaning |
| --- | --- |
| id | string, task ID |
| change | string, task change name |
| outcome | accepted, blocked, claimed-elsewhere or not-started |
| lastStage | string or null; claim, investigate, plan, work, receipt, publish, pr or merge |
| blockingReason | string or null; safe controller reason code when blocked |
| durationSeconds | nonnegative number or null; OR-5 persisted claim-to-acceptance duration for accepted tasks |
| complexityGrade | A, B, C, D, E or null |
| completionSummary | string or null; OR-5 approved completion summary |
| workerSessions | object with integer investigate, plan, work and review counts |
| planningReviewRounds | integer |
| implementationReviewRounds | integer |
| planningFindingsPerRound | integer[] in review order |
| implementationFindingsPerRound | integer[] in review order |
| finalChecks | array of {command: string, args: string[], outcome: string} |
| pr | {number: integer, url: string} or null |
| tokenUsage | token usage object or null |

Include one entry per task worked on or explicitly decided about during this execution, deduplicated by task ID; exclude unrelated queue tasks and historical baseline acceptances. Include evaluated selected leaves left pending due to dependencies/limit/cancellation as not-started, and foreign claim or scope-conflict decisions as claimed-elsewhere. Preflight failures before queue discovery may have no task entries. Work begun but not accepted by termination is blocked with a safe cause such as cancelled or operation-incomplete. Actual final acceptance outranks earlier blocked/foreign decisions. lastStage is the last persisted controller stage; review rounds carry the separate review distinction. Unstarted/foreign tasks have null stage unless owned work was actually reached.

Task session/review counts, findings arrays and final checks describe known durable task history as of the decision, including resumed history; count each recorded review once, not again when read on restart. Count session starts even if interrupted before reply by persisting a small start counter; do not infer counts only from successful WorkerReply entries. finalChecks contains the latest actual final gate results, including failure outcomes without output; no invented passing result when a command throws. Capture PR URL from host metadata or a validated repository web URL plus PR number, never from arbitrary diagnostics. Completed tasks reuse persisted OR-5 duration/summary/grade; nonaccepted tasks have these three fields null.

Token usage object is `{inputTokens: integer|null, outputTokens: integer|null, totalTokens: integer|null}`, with nonnegative counts. Extract only documented numeric usage fields from adapter events into a typed normalization boundary. Deduplicate cumulative usage updates per session; do not add every cumulative event. Per-task and run token usage describe only sessions in the current execution, so restart history is not double counted across ledger lines. Missing usage is null, never zero. If coverage is partial, a component sum is null unless all relevant sessions reported that component; preserve any complete component. Run usage includes every session of this execution. With no reported usage the entire object is null. No prompt/token estimation or extra harness calls.

## Append writer

Resolve the ledger independently of invocation stateDirectory: nonempty absolute XDG_STATE_HOME, otherwise homedir()/.local/state, then outcome-runner/runs.jsonl. Ignore an unset, empty or relative XDG_STATE_HOME under XDG rules. Read only that named setting; never serialize environment objects.

Create missing directories recursively (0700) and open the file with append/create semantics and creation mode 0600. Ensure owner-only permissions for the ledger; do not truncate, replace, rotate, read/rewrite historical lines or insert headers. Build the entire compact JSON plus newline as a UTF-8 buffer before writing. Perform one low-level append write on the O_APPEND descriptor per record. Do not use stream/chunked writes or retry a short write with a second append; report a short write as failure. Parallel writers use this single append boundary on one machine; tests verify no interleaved records.

Catch errors across path preparation, open, permissions, serialization, append and close. Emit a concise safe stderr diagnostic about ledger persistence, preserve the original exit/result and never recursively attempt to ledger the ledger failure. No shell output, error stack or arbitrary error.message enters a record or the stderr warning.

## Privacy and compatibility

Use strict allowlists at every nested object. Store only safe failure/blocking codes, findings counts and command/outcome fields. Do not copy private summary fields as completion summaries. Never include authority.instruction, prompts, private worker text, findings bodies, check output, file contents, environment variables, raw errors or arbitrary event keys. Known schema metadata such as hostname, package version and the expressly required completion summary are allowed; they do not authorize dumping their source objects.

The append file is best-effort statistics, not a source of truth for claims, receipts, acceptance or recovery. No new CLI flags, analytics transport, reader/dashboard, dependencies, receipt migrations or ledger rotation. Product changes stay within src, test and README.md.

## Verification after binding

Use temporary XDG_STATE_HOME for all new tests and isolate existing CLI fixtures from the real user ledger. Inject clocks, UUIDs, metadata, stderr and append effects where needed; use scripted/fake adapters only. Child-process signal tests use existing fixture patterns and a startup readiness barrier, never a real harness. Cover early JSON/flag/preflight failure, both signals during startup and work, repeated signal/finalization races, resumed provenance/history versus current-run usage, accepted/blocked/foreign/not-started decisions, failed checks and missing PR/usage metadata.

Assert exactly one line for exit 0, 3 and 4 and each cancellation; hash success/failure produces none. Verify append preserves prior bytes, sequential and concurrent runs create two parseable complete lines with distinct IDs, and new-file mode is 0600. Inject EACCES (deterministic even under elevated test users) and exercise an invalid ledger parent to verify unchanged 0/3/4 outcomes and stderr. Place distinct secret markers in authority instruction, prompts, private output, findings, check output and environment; assert none appear in serialized bytes. Verify every required field/type, every provenance class and complete/partial/absent token usage. Run npm run typecheck and npm test only during authorized implementation after binding.
