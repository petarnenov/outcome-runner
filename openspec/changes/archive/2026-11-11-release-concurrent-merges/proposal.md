# OR-25: Release workflow survives merges close together

## Why
The workflow already uses concurrency group `release` with cancellation disabled, but checks out the event SHA and fails on an atomic push rejected after main advances. Serial execution alone does not prevent a merge during validation or a queued event from using stale history.

## What changes
- Preserve shared release serialization and refresh main and tags before preparing releases.
- Add a publication orchestrator under scripts that retries main-advance rejections by rebuilding from freshly fetched main, with at most three publication attempts.
- Preserve local-only scripts/release.ts, atomic non-forced publication, immutable existing tags, and unique changelog entries.
- Add local workflow-definition checks and deterministic real-Git fixtures for sequential and combined releases, retries and existing tags.
- Update docs/releasing.md to explain close merges, retry limits and recovery.

## Capabilities
### Modified capabilities
- automatic-semantic-versioning: validated workflow, atomic publication, local verification and release documentation.

## Scope and evidence
Implementation scope is .github, scripts and docs. No product edits occur in this session: only proposal.md, design.md, tasks.md and specs/automatic-semantic-versioning/spec.md are written. No dependency or package configuration change is planned. Existing npm test discovery includes scripts/*.test.ts and enforces 85% lines, branches and functions. Hosted Actions observations are neither required nor evidence.

## Source acceptance criteria (verbatim)
1. Release runs triggered by pushes to main never run at the same time; a queued run starts after the previous one finishes.
2. When the release push is rejected because main advanced, the workflow fetches, recomputes the version from the new main and retries a bounded number of times, without creating a duplicate tag or changelog entry.
3. Tests of the workflow definition and the release scripts with Git fixtures show that two pull requests merged within a few minutes produce two consecutive releases or one release containing both, and no failed push. All criteria are verified locally with these tests; observing hosted GitHub Actions runs is not required and is not part of the evidence.
4. The release scripts have tests for recomputing after main advanced and for not duplicating an existing tag; npm test passes.
5. docs describe the release behaviour for close merges.
