# OR-7 implementation tasks

All boxes remain open in this planning session. Product edits and checks require later specification binding. Dependencies: OR-5 and OR-6.

## 1. Typed collection and resolution

- [ ] 1.1 Define schemaVersion 1 run/settings/task/usage types and an allowlisted statistics collector under src, using the field names, null semantics and types in design.md.
- [ ] 1.2 Capture execution UUID/start time, package version, hostname and best-effort Git metadata, invocation, authority reference and safe unavailable reason even when startup fails.
- [ ] 1.3 Capture resolved harness/version/model/effort/coverage/maxAccepted/leaves and per-field provenance at resolution; preserve saved provenance on resume without altering frozen config identity or breaking legacy state.
- [ ] 1.4 Collect task decisions, last stage, safe blocking reason, OR-5 accepted completion, PR number/URL, session starts, separate planning/implementation rounds and findings counts, and actual final check outcomes.
- [ ] 1.5 Normalize reported token usage with cumulative-event deduplication, component completeness and nulls for unknown usage; keep usage execution-local across restart.

## 2. Append and lifecycle

- [ ] 2.1 Implement XDG/default ledger path resolution, directory creation and file mode 0600, O_APPEND plus one complete JSON/newline write; preserve existing bytes.
- [ ] 2.2 Add a once-only CLI finalizer spanning startup, normal 0/3 results and unavailable 4; bypass the collector entirely for hash success and failure.
- [ ] 2.3 Coordinate SIGINT/SIGTERM cancellation before startup and during work with runner cleanup; cancel pending work, snapshot partial statistics, append once and retain cancellation exit semantics.
- [ ] 2.4 Handle ledger path/open/permission/write/short-write/close failures with safe stderr diagnostics while retaining the exact runner result and exit code.

## 3. Tests

Implement tests in grade order E, D, C, B, A (easiest first); ordering within a grade is not a complexity distinction. Every test below is (required) by OR-7 or a capability scenario and must be written even if the resolved coverage threshold has already passed. No required test may be skipped or marked `not needed: coverage reached`. Only future explicitly (coverage-only) tests may stop at the threshold. After binding, run the frozen checks after each implemented grade and inspect their output; continue through every required grade regardless of coverage. No checks run in this planning session.

All tests use a temporary XDG_STATE_HOME (or an isolated temporary home for default-path cases), deterministic fixtures where needed, and fake/scripted adapters; no test starts a real harness or touches the user's ledger.

- [ ] 3.1 Grade E (required): Verify an absolute XDG_STATE_HOME resolves to outcome-runner/runs.jsonl; unset, empty and relative values use the isolated ~/.local/state fallback.
- [ ] 3.2 Grade E (required): Assert every run/settings/task/usage schema field, type, enum and null convention from design.md, including schemaVersion 1, safe unavailable failureReason and nonaccepted null completion fields.
- [ ] 3.3 Grade E (required): Verify injected UTC start/end boundaries and nonnegative monotonic duration; package version, hostname, repository top-level, credential-free origin, target, invocation and authority reference are mapped correctly.
- [ ] 3.4 Grade E (required): Verify all unresolved metadata/settings pairs remain null on early failure and no undiscovered task entries are fabricated.

- [ ] 3.5 Grade D (required): Verify recursive directory creation, new-file mode 0600, securing an existing ledger, preservation of all prior bytes and exactly one append call containing the complete JSON plus newline.
- [ ] 3.6 Grade D (required): Verify flag-over-JSON precedence and cli-flag, invocation-json, interactive-answer and default provenance, Enter-as-default, effective expanded leaves, unbounded maxAccepted and observed CLI-version attribution without another harness probe.
- [ ] 3.7 Grade D (required): Verify task and run token usage for complete, partial and absent reports, cumulative-event deduplication, nonnegative numeric components and null rather than estimated or zero missing usage.
- [ ] 3.8 Grade D (required): Put distinct private markers in authority instructions, prompts, worker output, findings, check output, file bodies, environment and arbitrary error/event fields; verify none enters ledger bytes and only allowlisted safe failure/blocking codes and approved OR-5 completion summaries are serialized.
- [ ] 3.9 Grade D (required): Inject path, open, permissions, serialization, append and close failures; verify safe stderr diagnostics, no recursive persistence and unchanged result/stdout/exit code for each 0/3/4 and cancellation result.
- [ ] 3.10 Grade D (required): Inject a short write; verify a diagnostic, no second append attempt and unchanged runner result.

- [ ] 3.11 Grade C (required): Verify exactly one record for exhausted and limit-reached exits 0 with the matching status and unchanged stdout/result.
- [ ] 3.12 Grade C (required): Verify exactly one incomplete record for exit 3 with unchanged stdout/result.
- [ ] 3.13 Grade C (required): Verify exactly one unavailable record for exit 4 across malformed JSON, invalid flags/configuration, preflight and harness-resolution failures; assert safe reasons and partial statistics.
- [ ] 3.14 Grade C (required): Verify hash success and failure create neither ledger lines nor ledger directories.
- [ ] 3.15 Grade C (required): Run twice sequentially and assert two independently parseable lines, distinct runIds and unchanged first-record bytes.
- [ ] 3.16 Grade C (required): Verify accepted and blocked task entries include id/change/outcome/last stage, safe blocking reasons, OR-5 duration/grade/approved summary for acceptance and null acceptance fields for blocked work.
- [ ] 3.17 Grade C (required): Verify one entry per decided/worked task, foreign claims and scope conflicts as claimed-elsewhere, pending dependencies/limits/cancellation as not-started, exclusion of unrelated and baseline-accepted tasks, and final acceptance superseding an earlier decision.
- [ ] 3.18 Grade C (required): Verify per-purpose session starts including interruption before reply, separate planning/implementation review rounds and ordered finding counts.
- [ ] 3.19 Grade C (required): Verify final check commands/args and actual success/failure outcomes, thrown checks never fabricated as passing, no check output, known PR number/URL and null pr when absent.
- [ ] 3.20 Grade C (required): Exercise deterministic EACCES and an invalid ledger parent using isolated filesystem fixtures; verify stderr and unchanged exit/result for 0/3/4 and cancellation without relying on user permissions.

- [ ] 3.21 Grade B (required): Resume a durable invocation and verify a fresh runId/line, saved original setting provenance, legacy fallback compatibility and unchanged frozen config/authority identity.
- [ ] 3.22 Grade B (required): Resume task work and verify original claim-to-acceptance duration and OR-5 completion data, durable session/review/check history counted once, and token totals containing only current-execution sessions at task and run levels.
- [ ] 3.23 Grade B (required): Start two concurrent fake-harness runs against one isolated ledger and assert exactly two complete parseable noninterleaved lines with distinct runIds.
- [ ] 3.24 Grade B (required): Parameterize SIGINT and SIGTERM during startup using child-process readiness barriers; assert pending selection/preflight cancellation, one cancelled record, exit 3 and no unresolved-data fabrication.
- [ ] 3.25 Grade B (required): Parameterize SIGINT and SIGTERM during task work with scripted adapters; assert cleanup, one cancelled record, exit 3 and a blocked task preserving its last stage and safe cancellation reason.

- [ ] 3.26 Grade A (required): Exercise repeated signals and cancellation racing with exceptions, cleanup and normal finalization; verify the once-only finalizer, cancelled status when cancellation wins, handler cleanup and no duplicate append.

## 4. Documentation and gates

- [ ] 4.1 Update README.md with ledger path/default, one-line-per-execution and hash exception, all nested fields/types/enums, null/provenance meanings, resume/counting semantics and best-effort failure behavior.
- [ ] 4.2 After implementation and binding, run npm run typecheck and npm test and the frozen authorized project checks; inspect check output and fix failures.
- [ ] 4.3 Confirm changes remain within src, test and README.md plus authorized OpenSpec task tracking; no private content or claim/receipt/exit-code changes.
- [ ] 4.4 At the later bound verification gate, validate the OpenSpec delta structure and scenarios; preserve separate concise requirements for lifecycle, identity, timing and task statistics.
