# automatic-semantic-versioning delta

## MODIFIED Requirements

### Requirement: Validated release workflow
The system SHALL provide .github/workflows/release.yml triggered on push to main with concurrency group release, cancel-in-progress false and permissions contents write. The shared concurrency group SHALL serialize release runs through publication; a queued runnable run SHALL start after the active run finishes. The workflow SHALL obtain full history and tags, refresh current origin main before release preparation, use Node 24, and successfully run npm ci, npm run typecheck and npm test on the selected base before release mutation. When retrying on a newer base it SHALL repeat validation for that base. Existing pinned OpenSpec test prerequisites SHALL remain installed before tests.

#### Scenario: Queued main push
- **WHEN** another main push arrives while a release run is active
- **THEN** the release concurrency configuration SHALL prevent simultaneous release runs and SHALL not cancel the active run
- **AND** a queued runnable run SHALL start after it finishes and refresh current main rather than publish from its stale event SHA
- **AND** pending-run coalescing SHALL not lose qualifying merged commits because preparation uses current main history.

#### Scenario: Release head is skipped
- **WHEN** the pushed head commit's subject starts chore(release):
- **THEN** the workflow SHALL not perform a release.

#### Scenario: Validation fails
- **WHEN** installation, typechecking or tests fail for the selected base
- **THEN** the workflow SHALL not perform release mutation or publication for that attempt.

### Requirement: Atomic publication and GitHub notes
When a release is made, the workflow SHALL push its commit to main and its tag in one atomic push without force, then create a GitHub Release for that tag with notes exactly equal to the new changelog section. A no-release result SHALL perform no push or GitHub Release creation. Publication orchestration SHALL remain separate from the local-only scripts/release.ts executable. On a rejected push caused by main advancement, orchestration SHALL fetch main and tags, discard only its own unpublished attempt artifacts, revalidate and recompute version and changelog from the new main, and retry with at most three total publication attempts. Existing or published tags SHALL never be moved or deleted. Rejected attempts SHALL not leave duplicate changelog sections or entries in published history.

#### Scenario: Successful publication
- **WHEN** validation and local release succeed and the remote accepts the atomic push
- **THEN** the workflow SHALL publish the commit and tag together
- **AND** only after successful publication SHALL it create a GitHub Release using precisely the new section, excluding prior changelog sections and the CLI version line.

#### Scenario: Main advances during validation
- **WHEN** another commit advances main and the release push is rejected as non-fast-forward
- **THEN** neither candidate ref SHALL be published by that rejected atomic push
- **AND** within the remaining attempt budget the workflow SHALL fetch main and tags, validate the new base and recompute the release using its current eligible tag and unreleased commits
- **AND** a newly merged feature SHALL change a pending patch bump to the appropriate minor bump
- **AND** eventual publication SHALL contain each qualifying commit once with only the final attempt's notes.

#### Scenario: Another release already covers the commits
- **WHEN** refreshed main and tags show that another release already includes the qualifying commits
- **THEN** orchestration SHALL return a successful no-release result without pushing or creating notes
- **AND** existing tags and changelog sections SHALL remain unchanged.

#### Scenario: Existing tag remains immutable
- **WHEN** the candidate tag already exists on unrelated history
- **THEN** release preparation SHALL fail before changing release files or creating a new release commit
- **AND** the existing tag SHALL not be deleted, duplicated or moved.

#### Scenario: Retry limit and unrelated failures
- **WHEN** main advances before every permitted publication attempt or a rejection occurs without recoverable main advancement
- **THEN** the workflow SHALL stop after no more than three publication attempts with an actionable error
- **AND** it SHALL not force-push, publish notes for rejected candidates, or retry unrelated failures as main-advance conflicts.

#### Scenario: Publication result is uncertain
- **WHEN** transport fails without a definitive atomic push result
- **THEN** orchestration SHALL inspect remote refs before retrying or deleting owned local tags
- **AND** confirmed publication of both candidate refs SHALL not trigger a duplicate release
- **AND** indeterminate ref state SHALL stop with recovery guidance
- **AND** failure creating GitHub notes after publication SHALL leave the published commit and tag intact for notes-only recovery.

### Requirement: Release documentation
docs/releasing.md SHALL explain the bump rules, Conventional Commit subject/body formats with examples, workflow behavior, dry runs and recovery from a rejected release push. It SHALL describe serialized close-merge runs, current-main refresh, combined or consecutive releases, three total publication attempts, recomputation and duplicate avoidance.

#### Scenario: Maintainer previews and recovers
- **WHEN** a maintainer follows the release guide
- **THEN** it SHALL show scoped feat, fix/perf and both breaking marker styles, the bootstrap rule and npm run release:dry-run
- **AND** it SHALL explain pending-run coalescing, close-merge release outcomes and automatic bounded recovery from main advancement
- **AND** it SHALL explain that rejected atomic pushes publish neither ref and that exhaustion requires inspecting current main and running a fresh validated release
- **AND** it SHALL not recommend retrying a stale generated commit or force-pushing
- **AND** it SHALL distinguish an already-published tag with missing GitHub Release notes from a rejected push.

## ADDED Requirements

### Requirement: Local close-merge verification
Workflow-definition and release orchestration tests under scripts SHALL verify serialization and close-merge behavior locally with real Git fixtures. npm test SHALL pass the existing 85% line, branch and function coverage gates. Hosted GitHub Actions observations SHALL neither be required nor used as acceptance evidence.

#### Scenario: Two close merges produce consecutive releases
- **WHEN** a first qualifying fix merge is released and a second fix merge arrives before its queued run prepares a release from a stale event checkout
- **THEN** local fixtures SHALL show consecutive patch releases containing the respective commits once
- **AND** both publication runs SHALL finish successfully with consistent main, tags, metadata and changelog
- **AND** workflow-definition tests SHALL verify shared serialization through publication.

#### Scenario: Two close merges share a release
- **WHEN** two qualifying fix merges reach main before release preparation refreshes its base
- **THEN** local fixtures SHALL show one release containing both commits once
- **AND** a later queued stale-event run SHALL succeed as a no-op
- **AND** no duplicate tag or changelog section or terminal failed publication SHALL occur.

#### Scenario: Local acceptance evidence
- **WHEN** implementation is verified after specification binding
- **THEN** workflow-definition tests, real-Git recomputation, immutable existing-tag and bounded-retry tests, and both close-merge schedules SHALL pass locally
- **AND** Git fixtures SHALL use temporary repositories, a bare origin and independent clones
- **AND** npm test SHALL pass all three 85% coverage gates without hosted-run observation.
