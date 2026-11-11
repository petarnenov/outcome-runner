# Design

## Current behavior
.github/workflows/release.yml serializes through group release and cancel-in-progress: false, skips release-commit events, checks out github.sha, installs Node 24 and pinned OpenSpec, and validates before local release creation. scripts/release.ts calculates from reachable stable tags and writes one local release commit and annotated tag; it deliberately never pushes. The workflow separately pushes both refs atomically and creates GitHub notes. docs/releasing.md currently prescribes immediate failure for stale pushes. These last workflow and documentation requirements must be modified, not supplemented with contradictory requirements.

## Serialization and freshness
Retain the workflow-level constant concurrency group release and cancellation disabled, covering validation through publication. A queued runnable job starts only after the active job ends. GitHub may replace an older pending run with a newer one and does not guarantee FIFO; coverage of merged commits comes from fetching current main, not from promising a run for every event. Two qualifying merges may therefore yield two releases or one release containing both.

Use a separate Node 24 publication orchestrator under scripts (for example publish-release.ts), leaving release.ts and its local-only CLI contract intact. Workflow integration invokes this orchestrator instead of the separate stale local-create/push sequence. Retain event release-commit filtering, full history/tags, bot identity, permissions and pinned OpenSpec prerequisites.

## Attempt lifecycle
1. In a clean disposable CI checkout, fetch origin main and tags without force-updating existing tags, select fetched main and record the exact base SHA. Use an isolated temporary worktree or equivalent disposable checkout for each attempt; never reset a developer's checkout.
2. Validate the selected base with npm ci, npm run typecheck and npm test with the existing OpenSpec prerequisite. Validation failure stops publication. Repeat validation for a changed base on retry; a previous successful check of a stale SHA is insufficient.
3. Invoke the existing release calculation on that base. No release is a successful no-op. Otherwise capture the exact tag object ID, generated commit and new notes outside the tracked tree.
4. Push HEAD:refs/heads/main and only the candidate tag together using --atomic, without force. Return publication metadata only on success; create GitHub Release notes only for that successful tag.
5. On rejection fetch main and tags again. Retry only when main demonstrably advanced beyond the recorded base and the failed push published neither candidate ref. Recompute from the new base, including its latest eligible tag and unreleased commits. Do not rebase the old generated release commit or reuse its notes.
6. Permit three total publication attempts (initial plus two retries). Stop with an actionable diagnostic on exhaustion, unchanged-main rejection, authentication failure, tag conflict or validation failure. No stale push loop.

Track tags created by this invocation. Before fetching a colliding remote tag, remove only an unpushed locally generated candidate tag whose object ID still matches the recorded object, after confirming it is not published; discard its temporary worktree. Never delete or move pre-existing or remote tags. A remote release that already covers the qualifying commits yields no release on refresh. A same-name tag on unrelated history is an error, never permission to overwrite it.

An ambiguous transport failure needs remote-ref inspection before any cleanup or retry: if both generated refs are already published, treat publication as completed; if ref state is uncertain, stop with recovery guidance. Atomic push remains the invariant preventing a rejected attempt from publishing only a tag. GitHub Release creation failures after a successful push retain existing recovery: restore missing notes for that tag without generating another release.

## Local verification
The delta states the local verification requirement concisely; its scenarios carry fixture details and required cases so the acceptance contract stays readable.

Keep new tests under scripts/*.test.ts using node:test and real temporary bare origins and independent clones. Inject controlled hooks/barriers around attempt preparation and push, rather than time delays. Test doubles may drive validation and GitHub Release calls; Git ref acceptance/rejection and release generation must use real Git. Workflow-definition assertions check the actual concurrency, cancellation, trigger, validation prerequisites and orchestrator wiring. They establish configuration evidence, not a simulated claim to have observed GitHub's scheduler.

Fixture schedules:
- Release first fix, merge second fix after publication, then run queued stale event: v1.2.4 and v1.2.5, each commit listed once.
- Merge both fixes before refreshed preparation: v1.2.4 includes both; the later queued run is a successful no-op.
- Advance main with a feature between preparation and push: observe the recoverable non-fast-forward attempt, then assert recomputation from current main yields v1.3.0 containing both qualifying changes and no stale section.
- Publish another release during the rejection window: refresh tags and base; assert already released commits do not reappear and the published tag object is unchanged.
- Advance main before all three pushes: finite failure and no refs or entries from rejected attempts.

“No failed push” for the close-merge acceptance fixtures means no final failed publication/run or lost release; the deliberately forced rejection fixture necessarily observes an intermediate rejected Git command to verify recovery.

## Scope and rollout
Only .github/workflows/release.yml, scripts release orchestration/tests, and docs/releasing.md are planned implementation edits. Existing versioning semantics and package configuration remain applicable. Planning artifacts are bound in a later session; product edits and frozen checks are intentionally deferred. After binding, implement tests from grade E toward A, always completing required cases, then run frozen checks and inspect their results. The coverage gate is 85% for lines, branches and functions. No hosted Actions access is needed.
