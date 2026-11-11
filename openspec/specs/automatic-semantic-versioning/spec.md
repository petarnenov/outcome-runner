# automatic-semantic-versioning Specification

## Purpose
Derive each release from Conventional Commits on main so the version, changelog, release notes and Git tag are produced together and stay consistent.

## Requirements

### Requirement: Native TypeScript release executable
The system SHALL provide scripts/release.ts executable by Node 24 using erasable TypeScript syntax and Node built-ins only. Git operations MAY use the installed Git executable. The release script SHALL never push.

#### Scenario: Execute without runtime dependencies
- **WHEN** node scripts/release.ts is executed in the repository on Node 24
- **THEN** it SHALL calculate and perform a local release using only Node built-ins and Git, without requiring a transpilation step or third-party runtime package
- **AND** it SHALL make no network publication.

### Requirement: Complete release history and stable tag boundary
The system SHALL analyze the subject and body of every commit reachable from HEAD and not reachable from the latest eligible tag, including commits introduced by merged branches. Eligible tags SHALL match vMAJOR.MINOR.PATCH with valid stable Semantic Versioning 2.0.0 numeric components and SHALL be reachable from HEAD. Latest SHALL mean greatest semantic version among eligible tags. Existing annotated and lightweight tags SHALL both qualify.

#### Scenario: Merged feature remains visible
- **WHEN** a feature commit from a side branch is merged after v1.2.3 with a nonconventional merge message
- **THEN** the feature commit SHALL be analyzed even though it is not on the first-parent path
- **AND** the merge commit itself SHALL be ignored.

#### Scenario: Previous release history is excluded
- **WHEN** fix and breaking commits are reachable from the selected release tag and only a new fix is outside its ancestry
- **THEN** only the new fix SHALL affect the next version and notes.

#### Scenario: Stable numeric tag selection
- **WHEN** reachable tags include v1.9.0 and v1.10.0, and additional tags are malformed, prerelease, or on an unmerged branch
- **THEN** v1.10.0 SHALL define the boundary regardless of tag creation dates or lexical order
- **AND** ineligible tags SHALL not affect the calculation.

### Requirement: Conventional Commit parsing
The system SHALL parse Conventional Commits 1.0.0 subjects and bodies, accepting a type, optional scope, optional ! immediately before the colon, colon-space and a nonempty description. Merge commits and nonconforming messages SHALL be ignored.

#### Scenario: Scoped type
- **WHEN** a commit subject is feat(work-queue): add scheduling
- **THEN** it SHALL be classified as a feature with description add scheduling.

#### Scenario: Invalid subjects and merge commits
- **WHEN** a subject does not conform to Conventional Commits or the commit has multiple parents
- **THEN** that commit SHALL contribute neither a bump nor a changelog entry
- **AND** qualifying commits introduced by its merged branches SHALL still be considered.

### Requirement: Breaking change detection
A valid Conventional Commit SHALL request MAJOR when its subject has ! immediately before the colon or its body has a BREAKING CHANGE: or BREAKING-CHANGE: footer conforming to Conventional Commits 1.0.0.

#### Scenario: Breaking subject with scope
- **WHEN** the base tag is v1.2.3 and a commit subject is feat(work-queue)!: change claim ownership
- **THEN** the next version SHALL be 2.0.0.

#### Scenario: Unscoped breaking subject on another type
- **WHEN** the base tag is v1.2.3 and a commit subject is refactor!: remove legacy transport
- **THEN** the next version SHALL be 2.0.0.

#### Scenario: Breaking footer with full message
- **WHEN** the base tag is v1.2.3 and a valid refactor subject has a footer BREAKING CHANGE: remove legacy transport or BREAKING-CHANGE: remove legacy transport
- **THEN** the next version SHALL be 2.0.0
- **AND** footer detection SHALL inspect the body, including multiline footer values.

#### Scenario: Footer-looking prose is not a footer
- **WHEN** a nonbreaking Conventional Commit includes a quoted or embedded example of BREAKING CHANGE: in ordinary body prose rather than a footer
- **THEN** that example SHALL not request a major bump.

### Requirement: Semantic version bump precedence
Among analyzed commits, the greatest requested bump SHALL win: breaking changes request MAJOR, otherwise feat requests MINOR, otherwise fix or perf requests PATCH. Other types SHALL request no bump. MAJOR SHALL reset MINOR and PATCH to zero; MINOR SHALL reset PATCH to zero. The selected tag version SHALL be the bump base, including for 0.x versions.

#### Scenario: Feature outranks patches
- **WHEN** the base tag is v1.2.3 and the range contains feat: add transport together with fix and perf commits and no breaking change
- **THEN** the next version SHALL be 1.3.0.

#### Scenario: Breaking outranks features and patches before 1.0
- **WHEN** the base tag is v0.2.3 and the range contains a breaking commit, a feat and a fix
- **THEN** the next version SHALL be 1.0.0.

#### Scenario: Fix and performance request patch
- **WHEN** the base tag is v1.2.3 and the range contains fix(work-queue): avoid duplicate claims or perf: reduce polling, with no feature or breaking change
- **THEN** the next version SHALL be 1.2.4.

#### Scenario: No qualifying release
- **WHEN** an eligible base tag exists and the range contains only nonbreaking docs/chore commits, invalid subjects or no commits
- **THEN** the result SHALL be no release
- **AND** no files, index entries, commits or tags SHALL change.

### Requirement: Release commits are ignored
The system SHALL ignore every commit whose subject starts with chore(release): before inspecting its body for bump markers.

#### Scenario: Release body contains breaking notes
- **WHEN** an analyzed commit starts chore(release): v1.2.3 and its body includes BREAKING CHANGE:
- **THEN** that commit SHALL request no bump and SHALL not appear in release notes.

### Requirement: Bootstrap version
When no eligible vMAJOR.MINOR.PATCH tag exists, the first release SHALL use the current valid stable package.json version without incrementing it, independently of bump requests. All reachable history SHALL be considered for eligible changelog entries.

#### Scenario: Bootstrap with feature or breaking commits
- **WHEN** no eligible tag exists and package.json is version 0.1.0
- **THEN** the next release SHALL be 0.1.0 even if reachable commits contain features or breaking changes.

#### Scenario: Bootstrap without qualifying entries
- **WHEN** no eligible tag exists and history contains only nonbreaking documentation commits
- **THEN** the system SHALL still release the current package version with a version/date heading and no empty groups.

### Requirement: Byte-preserving metadata changes
On release the system SHALL set package.json's top-level version and package-lock.json's root version and packages[""].version to the release version. Every other byte of both files SHALL remain unchanged.

#### Scenario: Preserve formatting and dependency metadata
- **WHEN** metadata uses unusual indentation, newline style, key order or nested dependency version fields
- **THEN** only the three designated version value tokens SHALL change
- **AND** all remaining bytes, including whitespace and dependency versions, SHALL remain identical.

#### Scenario: Bootstrap metadata already matches
- **WHEN** all three version fields already equal the bootstrap version
- **THEN** both metadata files SHALL remain byte-identical while the changelog, release commit and tag are created.

### Requirement: Grouped changelog section
On release the system SHALL prepend a section headed exactly ## X.Y.Z - YYYY-MM-DD to CHANGELOG.md, creating the file if absent and preserving existing content. The date SHALL be the release's UTC calendar date. Groups SHALL be headed ### Breaking changes, ### Features and ### Fixes in that order, omitting empty groups.

#### Scenario: Empty groups and prior content
- **WHEN** only fix commits qualify and CHANGELOG.md already exists
- **THEN** the new section SHALL contain only the Fixes group
- **AND** the existing changelog content SHALL follow the new section unchanged.

#### Scenario: Missing changelog
- **WHEN** a release is made and CHANGELOG.md does not exist
- **THEN** it SHALL be created with the new section.

### Requirement: Changelog commit entries
Entries SHALL list commit subject descriptions without the type/scope/! prefix and include short Git hashes. Each breaking commit SHALL appear only under Breaking changes; nonbreaking feat under Features; nonbreaking fix and perf under Fixes. Other commits SHALL be omitted.

#### Scenario: Mixed release notes
- **WHEN** the range contains a breaking feat, a nonbreaking scoped feat, a fix, a perf and a docs commit
- **THEN** notes SHALL contain the breaking description in Breaking changes, the other feature description in Features and the fix/perf descriptions in Fixes
- **AND** each eligible commit SHALL appear once with its short hash and without the Conventional Commit prefix
- **AND** the docs commit SHALL be omitted.

### Requirement: Local release commit and annotated tag
The system SHALL create a commit with subject chore(release): vX.Y.Z containing changes only to package.json, package-lock.json and CHANGELOG.md, then create annotated tag vX.Y.Z pointing to that commit. It SHALL validate metadata and target tag availability before mutation and SHALL refuse actual releases from a dirty index or working tree.

#### Scenario: Inspect release objects
- **WHEN** a release succeeds
- **THEN** HEAD SHALL have the exact release subject, its changed paths SHALL be limited to the three release files, and vX.Y.Z SHALL be an annotated tag targeting HEAD
- **AND** no push SHALL have occurred.

#### Scenario: Existing state cannot contaminate release
- **WHEN** the target tag already exists or unrelated staged or working changes exist
- **THEN** the actual release SHALL fail before modifying files or creating a commit or tag.

### Requirement: Nonmutating dry run and output
With --dry-run the system SHALL print the next version and exact proposed changelog section, or no release. Both preview and actual execution SHALL use a first stdout line of X.Y.Z or no release, followed by the section only when a release is planned. Dry run SHALL change no file, index entry, commit or tag.

#### Scenario: Preview a tagged release
- **WHEN** node scripts/release.ts --dry-run is executed with qualifying commits after a base tag
- **THEN** it SHALL print the computed version and section
- **AND** repository file bytes, index, HEAD and tag refs SHALL remain unchanged.

#### Scenario: Preview bootstrap or no release
- **WHEN** dry run is executed without an eligible tag or with a tagged range that requests no bump
- **THEN** it SHALL respectively print the unchanged bootstrap version and section, or no release
- **AND** all repository state SHALL remain unchanged.

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

### Requirement: Project integration and verification
package.json SHALL provide release:dry-run running node scripts/release.ts --dry-run. npm test SHALL discover both existing test/*.test.ts and scripts/*.test.ts and retain 85% line, branch and function coverage thresholds. tsconfig.json SHALL include scripts for npm run typecheck. Build output in dist SHALL exclude scripts.

#### Scenario: Typecheck, tests and build boundaries
- **WHEN** implementation validation runs after specification binding
- **THEN** npm run typecheck and npm test SHALL pass with all three 85% coverage gates retained
- **AND** script implementation and tests SHALL be typechecked, release tests SHALL execute and dist SHALL contain no scripts output.

### Requirement: Real Git release tests
scripts/release.test.ts SHALL exercise temporary real Git repositories and cover breaking ! and both footer spellings, feat, fix, perf, no release, scopes, merged branch history and merge commit exclusion, ignored release commits, bootstrap, byte-limited metadata edits, changelog sections and empty-group omission, annotated tags and nonmutating dry runs.

#### Scenario: Fixture evidence
- **WHEN** the release test suite runs
- **THEN** assertions SHALL inspect actual file bytes and Git commit/tag/index state for the required cases
- **AND** fixtures SHALL isolate repository identities and clean up temporary repositories.

### Requirement: Release documentation
docs/releasing.md SHALL explain the bump rules, Conventional Commit subject/body formats with examples, workflow behavior, dry runs and recovery from a rejected release push. It SHALL describe serialized close-merge runs, current-main refresh, combined or consecutive releases, three total publication attempts, recomputation and duplicate avoidance.

#### Scenario: Maintainer previews and recovers
- **WHEN** a maintainer follows the release guide
- **THEN** it SHALL show scoped feat, fix/perf and both breaking marker styles, the bootstrap rule and npm run release:dry-run
- **AND** it SHALL explain pending-run coalescing, close-merge release outcomes and automatic bounded recovery from main advancement
- **AND** it SHALL explain that rejected atomic pushes publish neither ref and that exhaustion requires inspecting current main and running a fresh validated release
- **AND** it SHALL not recommend retrying a stale generated commit or force-pushing
- **AND** it SHALL distinguish an already-published tag with missing GitHub Release notes from a rejected push.

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
