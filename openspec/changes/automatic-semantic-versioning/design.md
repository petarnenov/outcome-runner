# Design

## Context

The repository uses ESM, Node >=24, TypeScript erasable syntax, Node's test runner and 85% line/branch/function coverage gates. Current package version is 0.1.0. The main typecheck includes src, bin and test; the build config independently includes only src and bin. The lockfile uses lockfileVersion 3 with a root version and packages[""].version. No applicable AGENTS.md was present in the inspected planning ancestors.

## Goals and Non-goals

Implement all OR-9 acceptance criteria without dependencies beyond Node built-ins and the Git executable. Keep version updates byte-preserving and publication atomic. This change does not publish to npm, introduce prerelease channels, change application behavior, or execute implementation in this planning session.

## Decisions

### 1. History and release boundary

Enumerate tags with exact stable SemVer names vMAJOR.MINOR.PATCH (nonnegative decimal components, no leading zeroes except zero, no prerelease/build suffix). Only tags whose target commit is reachable from HEAD are eligible. Define latest as the greatest semantic version among eligible tags, using numeric rather than lexical comparison; both lightweight and annotated existing tags qualify. Unrelated, malformed and prerelease tags are ignored. Use the selected tag's version as the bump base, not a possibly stale package version.

Read full commit messages and hashes with unambiguous Git record framing over the revision set HEAD minus the selected tag's reachable history, without first-parent filtering. Read parent information so merge commits themselves are ignored while their constituent branch commits remain candidates. With no eligible tag, inspect all reachable commits for notes but release the current valid stable package.json version without increment, even when history has no bump-triggering commits. Use exact integer handling so version components are not rounded by JavaScript numbers.

### 2. Conventional Commit classification

Parse a valid subject as type, optional scope, optional ! immediately before the colon, colon-space, and nonempty description. Accept scoped subjects such as feat(work-queue): add scheduling. Ignore nonconforming messages, actual merge commits and every subject starting chore(release): before any footer analysis. A valid Conventional Commit can have any type; a breaking marker on a valid chore or refactor still triggers a major release.

Recognize BREAKING CHANGE: and BREAKING-CHANGE: in the footer portion of the body per Conventional Commits 1.0.0, including multiline footer values; do not infer a footer from prose or quoted examples. A breaking marker takes precedence over feat, then fix/perf, then no release. Major bumps apply even to 0.x.y. Reset subordinate components exactly as required.

Each relevant commit appears once in notes: breaking commits in Breaking changes, remaining feat in Features, remaining fix/perf in Fixes. Use the subject description with type/scope/! prefix removed and the abbreviated Git hash. Retain deterministic Git traversal order within groups. Other nonbreaking types are omitted.

### 3. Plan before mutation

Separate reading/classification/rendering from writes and Git mutation. Compute one release plan containing base/head, next version, changed buffers and the exact changelog section. Use UTC date YYYY-MM-DD, groups in Breaking changes / Features / Fixes order with ### headings, and bullets "- description (shortHash)". Omit empty headings. A bootstrap without eligible descriptions still has its version/date heading. Prepend the section with a blank line before the previous changelog, preserving previous content; create the file if absent.

Parse metadata to validate it but do not serialize the whole object. Locate JSON string value spans structurally and replace only package.json's top-level version and package-lock.json's top-level version and packages[""].version. Apply replacements from the end of each original buffer so offsets remain stable; preserve whitespace, newline style, final newline, key order and every dependency version. A scanner must distinguish nested properties and escaped keys/strings. Validate all expected slots and the target tag before any mutation; fail clearly on malformed metadata or an existing target tag.

Require a clean index and working tree for actual release mutation so existing staged changes cannot enter the commit. Stage only package.json, package-lock.json and CHANGELOG.md, and create chore(release): vX.Y.Z followed by an annotated vX.Y.Z tag on that commit. Unchanged files need not appear in the commit diff, notably bootstrap metadata already at the target version. Propagate Git failures; do not push or force/replace an existing tag.

### 4. CLI and preview contract

Execute with node scripts/release.ts, optionally --dry-run. Print either "no release" or the next version on the first stdout line; for a release print the exact new changelog section after it. Report errors on stderr with nonzero exit. Use the same computed plan for preview and actual execution. Dry run performs no writes, staging, commit, tag or push and is usable to inspect a dirty working tree. For a tagged repository with no qualifying commits, both modes return no release successfully and leave all state unchanged.

### 5. Workflow publication

Trigger release.yml on push to main, concurrency group release, cancel-in-progress false, permissions contents write. Guard the job on the pushed head subject not starting chore(release):. Check out the event's exact SHA with full history and tags so queued jobs cannot silently release a different head. Set up Node 24, then npm ci, npm run typecheck and npm test. Configure the GitHub Actions bot identity before executing the script.

Capture the script's successful stdout into a runner temporary file, never a tracked repository file. The first line discriminates no release from a version; the remaining content is the exact section used as GitHub Release notes. A no-release run ends without publication. On release, push HEAD:refs/heads/main and refs/tags/vX.Y.Z together via one git push --atomic origin invocation without force. Only after success create the GitHub Release for that existing tag with the captured section as notes, using the workflow token and GitHub CLI. Never interpolate commit descriptions into executable shell source; pass notes via a file and quote variables. A rejected atomic push fails the job immediately without retry, rebase or force. A GitHub API failure after a successful push is reported separately; documentation explains checking the already-published tag and restoring only the missing GitHub Release.

### 6. Integration and evidence

Add release:dry-run as node scripts/release.ts --dry-run. Extend npm test discovery to scripts/*.test.ts while retaining test/*.test.ts and all three existing 85% thresholds; exclude script test files from coverage just as existing test files are excluded, without excluding release implementation. Add scripts to tsconfig.json include. Keep the build include restricted to src and bin, verifying no scripts land in dist.

Use node:test and Node built-ins for isolated temporary Git repositories with local identities, deterministic fixture commits, annotated and lightweight tags, and real merges. Exercise CLI invocations and inspect Git/file state rather than mocking Git. Clean up fixtures. Ensure subprocess coverage contributes to release implementation coverage under Node's coverage environment.

## Risks and Mitigations

- History truncation loses branch commits: fetch full history/tags and test a non-fast-forward merge with a branch-only feature.
- Naive regex replacements corrupt metadata: use structural token spans and byte comparisons of adversarially formatted fixtures.
- False footer detection bumps versions: test real footer blocks, multiline values, ordinary prose and malformed subjects.
- Release feedback loops: skip both classification of release commits and workflow execution for a release head.
- Main advances during checks: publish exact event history with one non-forced atomic push and fail on rejection.
- Local commit/tag operations are sequential: preflight metadata and tag collisions, propagate failures, and document inspecting local state before a manual rerun.

## Specification Structure

The capability delta separates Conventional Commit parsing, breaking detection and bump precedence, and separates changelog section structure from entry classification. Each requirement states one behavior and has WHEN/THEN scenarios; examples and edge cases belong in those scenarios. This resolves the reported oversized-requirement warnings without changing OR-9 scope.

## Validation and Rollout

After specification binding, implement the tasks, run npm run typecheck and npm test under the frozen project checks, inspect coverage thresholds, and inspect build output for absence of scripts. Validate workflow configuration and publication ordering, with a temporary bare remote for atomic-push success/rejection evidence where feasible. Do not mutate the actual remote to validate the workflow. No product file writes or checks belong to this planning session.
