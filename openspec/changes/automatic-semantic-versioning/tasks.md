# Implementation Tasks

All items below are deferred until this specification is bound. This planning session creates only the four OpenSpec artifacts.

## 1. History and classification

- [ ] 1.1 Add scripts/release.ts with ESM, erasable TypeScript and Node built-ins only; use Git subprocess argument arrays and expose a guarded CLI entry point.
- [ ] 1.2 Select the latest reachable stable vMAJOR.MINOR.PATCH tag numerically; read complete HEAD-minus-tag history with full bodies and branch commits, excluding merge commits themselves.
- [ ] 1.3 Parse Conventional Commits 1.0.0 subjects/scopes and breaking footers; ignore release subjects and invalid messages; calculate major/minor/patch precedence and bootstrap current package version without bumping.

## 2. Local artifacts and CLI

- [ ] 2.1 Render version/date sections with Breaking changes, Features and Fixes, descriptions and short hashes, deterministic order and empty-group omission.
- [ ] 2.2 Implement structural, byte-preserving edits of the three metadata version slots; preserve existing changelog bytes after the prepended section and support a missing changelog.
- [ ] 2.3 Preflight actual release state; commit only package.json, package-lock.json and CHANGELOG.md as chore(release): vX.Y.Z and create the annotated tag; never push.
- [ ] 2.4 Implement stdout version/no-release plus section contract and --dry-run with zero repository mutations.

## 3. Integration and workflow

- [ ] 3.1 Add release:dry-run, include scripts/*.test.ts in npm test, retain existing test discovery and 85% line/branch/function coverage, and include scripts in typechecking without adding scripts to build output.
- [ ] 3.2 Add main push release workflow with release concurrency, cancel-in-progress false, contents write, release-head guard, exact-event checkout with full history/tags, Node 24, npm ci, typecheck and tests.
- [ ] 3.3 Configure bot identity, run release script and capture exact notes outside the repository; skip publication on no release.
- [ ] 3.4 Publish release commit and tag in one non-forced atomic push, fail without retry on rejection, and create the GitHub Release only after successful push.

## 4. Evidence and documentation

- [ ] 4.1 Add scripts/release.test.ts using temporary real Git repositories covering ! (scoped and unscoped), both breaking footer spellings and multiline body parsing, feat, fix, perf, precedence, scoped types, no release, invalid messages and ignored release commits.
- [ ] 4.2 Test merged branch inclusion, merge-message exclusion, tag boundary exclusion, reachable/latest stable tag selection, malformed/prerelease/unrelated tags, and bootstrap with no tags.
- [ ] 4.3 Assert all unrelated metadata bytes remain identical, including unusual formatting and nested version keys; verify old changelog preservation, missing changelog creation, section formatting, descriptions/hashes and omitted empty groups.
- [ ] 4.4 Assert release commit subject and changed paths, annotated tag object/target, no-release state preservation and dry-run byte/index/HEAD/tag preservation for tagged and bootstrap repositories.
- [ ] 4.5 Document bump rules, subject/body examples, merge/release exclusions, bootstrap behavior, workflow, dry run and rejected-push recovery in docs/releasing.md.
- [ ] 4.6 Run npm run typecheck and npm test through frozen checks after binding; read all check-output pages and confirm 85% line, branch and function thresholds.
- [ ] 4.7 Verify build output excludes scripts and review workflow guards, validation order, no-release handling, atomic push rejection and exact GitHub notes; exercise a temporary bare remote where feasible without publishing externally.

## 5. Specification review

- [x] 5.1 Review all four planning artifacts against OR-9 and applicable planning-directory instructions.
- [x] 5.2 Split oversized classification and changelog requirements into focused deltas with WHEN/THEN scenarios, preserving all acceptance criteria.
- [ ] 5.3 After specification binding, validate parsed OpenSpec deltas and complete implementation checks in the later session.
