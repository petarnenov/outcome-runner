# OR-25 tasks

## Planning and binding
- [x] Inspect release workflow, release scripts/tests, canonical specification, package test gates and release guide.
- [x] Preserve source acceptance criteria in proposal.md and define delta scenarios.
- [x] Resolve the local-verification requirement length warning by moving fixture details and required cases into its scenarios.
- [x] Bind this specification in a later work session before product writes or frozen checks.

## Implementation (after binding)
- [x] Preserve shared release concurrency group, cancellation disabled and release-event skip in .github/workflows/release.yml.
- [x] Add scripts publication orchestration around the local-only release generator: refresh main/tags, isolated attempt state, validation of each selected base, atomic publication and three total attempts.
- [x] Recompute after main advancement; discard only owned unpublished artifacts; preserve existing tag objects and published changelog history.
- [x] Gate notes/output on confirmed successful publication; handle no-op, terminal rejection, exhaustion and ambiguous publication outcomes.
- [x] Update docs/releasing.md with combined/consecutive releases, pending-run coalescing, retry bounds and recovery.

## Tests (easiest E to hardest A)
Each item is one planned test or explicitly parameterized test family. Grades measure fixture/control complexity: E easiest, A most complex. All cases below are required by source criteria or delta scenarios; none may be skipped when coverage is already sufficient. Implement grade by grade starting with E. Add only useful (coverage-only) tests at the appropriate grade if needed until all 85% coverage gates pass; required tests are always written, including grades above the grade where coverage first passes.

- [x] **E (required) T1 — Workflow definition:** assert main push trigger, one constant release group, cancel-in-progress false, release-head skip, full history/tags, Node 24, pinned OpenSpec prerequisites, validation and orchestrator wiring, and notes gated on publication. Maps criterion 1 and “Queued main push”, “Release head is skipped”, “Validation fails”.
- [x] **E (required) T2 — Documentation contract:** verify release guide describes close merges, three total attempts, recomputation, immutable tags, pending-run coalescing, no force push, and missing-notes recovery; review against implemented behavior. Maps criterion 5 and “Maintainer previews and recovers”.
- [x] **D (required) T3 — Attempt bounds and failure gates:** controlled orchestration cases assert three-attempt cap, no retry for unchanged-main rejection, and zero release mutation/publication after installation/typecheck/test failure. Maps “Validation fails” and “Retry limit and unrelated failures”.
- [x] **C (required) T4 — Existing tag and no-op:** real Git fixtures verify an already covered range performs no push or notes creation, an unrelated existing candidate tag fails before mutation, and its tag object/commit/files remain unchanged. Maps criterion 4 and “Existing tag remains immutable”.
- [x] **C (required) T5 — Publication outputs:** real atomic publication plus stubbed GitHub notes verifies commit/tag consistency, exact final section, no premature notes, and a missing-notes error never creates another release. Include confirmed-published and indeterminate transport outcomes. Maps “Successful publication”, “Publication result is uncertain”.
- [x] **B (required) T6 — Main advances and changes bump:** bare origin and two clones force main advancement with a feature after local patch preparation; assert rejected refs absent, fresh validation, recomputation to minor release, both entries once, and only final notes published. Maps criteria 2–4 and “Main advances during validation”.
- [x] **B (required) T7 — Remote release appears during retry:** independently publish a release between attempts, then assert refreshed boundary, no duplicate tag or old entries, preservation of tag object IDs and successful no-op or next release as appropriate. Maps criteria 2/4 and “Another release already covers the commits”.
- [x] **B (required) T8 — Retry exhaustion with real Git:** deterministically advance main before all three pushes; assert exactly three attempts, bounded terminal diagnostic, no forced update or candidate remote tag, and no GitHub notes. Maps “Retry limit and unrelated failures”.
- [x] **A (required) T9 — Two close merges, consecutive schedule:** drive the actual orchestrator with two merged PR branches and a stale queued-event checkout; serialize execution and assert v1.2.4 then v1.2.5, all changes preserved and entries unique, with both runs successful. Pair with T1 for the scheduler configuration evidence. Maps criteria 1/3 and “Two close merges produce consecutive releases”.
- [x] **A (required) T10 — Two close merges, combined schedule:** merge both branches before refresh; assert one release contains both commits, queued stale-event run exits successfully without a push, and no duplicate section/tag exists. Maps criteria 1/3 and “Two close merges share a release”.

## Verification and completion (after binding)
- [x] Run npm test and retain existing 85% line, branch and function thresholds; all required tests must pass irrespective of coverage.
- [x] Run frozen project checks, inspect all checks output and fix in-scope failures; preserve required typecheck and existing release regression coverage.
- [x] Review source criteria 1–5 against T1–T10 and local Git evidence; do not require hosted Actions observations.
- [x] Confirm edits stay within .github, scripts and docs for implementation and record remaining limitations honestly.

## Local verification evidence

Required tests T1–T10 were implemented in E, D, C, B, A order, with frozen checks after each grade. All required tests ran even though the global coverage gate already passed at E; no coverage-only tests were added. Final frozen typecheck and the package's npm-test command passed: 455 passed, 0 failed, 6 existing live-test skips; global coverage 99.05% lines, 94.67% branches, 95.03% functions.

Real bare-origin/independent-clone fixtures establish patch-to-minor recomputation, immutable tags, no-op and notes recovery, three-attempt exhaustion, consecutive v1.2.4/v1.2.5 releases, and one combined v1.2.4 release followed by a no-push no-op. Workflow assertions establish serialization configuration; no hosted Actions observations were used. GitHub notes calls are stubbed in local tests. Initial event-checkout checks and pinned OpenSpec ordering remain; the orchestrator independently validates every freshly selected main base.

Implementation changes are confined to .github, scripts and docs. Bound proposal, design and delta specification remain unchanged; only this task checklist records completion.
