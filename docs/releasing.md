# Releasing

Releases use Conventional Commits 1.0.0 and Semantic Versioning 2.0.0. Write a subject as `type(scope): description` (scope is optional), with a blank line before the body and before footers.

- `feat(work-queue): add scheduling` requests MINOR and resets PATCH.
- `fix: avoid duplicate claims` and `perf(queue): reduce polling` request PATCH.
- `refactor!: remove legacy transport` or `feat(queue)!: change ownership` requests MAJOR and resets MINOR and PATCH, including on 0.x versions.
- Other nonbreaking types, such as docs and chore, request no release.

Types are case-insensitive: `FEAT(queue): add scheduling`, `Fix: repair` and `PERF: reduce polling` request the same bumps as their lowercase forms. Breaking footer markers must use uppercase `BREAKING CHANGE` or `BREAKING-CHANGE`. Footer tokens may contain digits, such as `Issue-123: migration reference`, before a breaking footer in the same block.

A valid subject can also declare a breaking change in a footer:

```text
refactor: replace transport

Explain the motivation here.

BREAKING CHANGE: callers must use the new transport.
  Additional migration instructions can continue on subsequent lines.
```

`BREAKING-CHANGE: callers must use the new transport.` is an equivalent footer spelling. Quoted or embedded examples in prose are not breaking footers. The greatest requested bump wins.

The base is the greatest numeric stable tag reachable from HEAD, matching exactly vMAJOR.MINOR.PATCH. Prerelease, build-suffixed, malformed and unrelated tags are ignored. All commits reachable from HEAD but not the base tag are read, including merged branch commits. Merge commits themselves and invalid subjects are ignored. Subjects starting `chore(release):` are ignored even if their bodies contain breaking notes.

Without an eligible tag, the first release uses the current stable package.json version without bumping it, even when there are no qualifying entries. Otherwise, no qualifying commits means no release.

## Preview and local releases

Run `npm run release:dry-run`. It prints the next version followed by the exact proposed changelog section, or `no release`. It changes no files, index entries, commits or tags, and works with a dirty working tree.

To create a local release, use Node 24 and `node scripts/release.ts` from the repository root with a clean working tree and index and a configured Git identity. It updates only version tokens in package.json and package-lock.json, prepends the UTC-dated CHANGELOG.md section, commits only those files as `chore(release): vX.Y.Z`, and creates an annotated tag on that commit. Empty changelog groups are omitted. The script never pushes. Git errors propagate; inspect local HEAD, files and tags after a failure before deciding how to recover.

## Automated publication

A push to main starts .github/workflows/release.yml unless its head is a release commit. The constant release concurrency group serializes runs through publication with cancellation disabled. GitHub supports pending-run coalescing and does not guarantee FIFO: a newer pending event can replace an older pending event. Close merges produce consecutive releases or one combined release containing both changes.

The workflow uses Node 24 and installs the pinned OpenSpec prerequisite with `npm install -g @fission-ai/openspec@1.17.0`, then checks `openspec --version`. It invokes `node scripts/publish-release.ts`. The orchestrator refreshes current main and tags in a disposable clone even for a stale queued-event checkout. Each selected base passes npm ci, npm run typecheck and npm test before release generation.

Publication uses one non-forced atomic push of the release commit and its annotated tag. Notes are created only after confirmed publication and contain exactly the new changelog section. A no-release result performs no push or notes creation. Existing tags are immutable; unrelated tag collisions fail before release mutation.

## Rejected pushes and recovery

When main advances, a rejected atomic push publishes neither candidate ref. The orchestrator discards its owned unpublished attempt, fetches main and tags, repeats validation, and recomputes the version and changelog. A feature merged during a patch attempt can therefore change the release to a minor version. Already released entries are excluded by the refreshed tag boundary.

There are three total attempts (initial plus two retries). Unchanged-main rejection, authentication failure and validation failure stop immediately. There is no force push. Exhaustion requires inspecting current main and starting a fresh validated release; never retry a stale generated commit. Temporary clones keep cleanup separate from the caller's checkout and pre-existing tags.

If transport reports an uncertain outcome, remote refs are inspected first. Confirmed publication proceeds to notes; indeterminate state stops for inspection without retrying publication.

If publication succeeded but GitHub Release notes are missing, verify the annotated tag and restore only the missing GitHub Release using the exact new CHANGELOG.md section, for example `gh release create vX.Y.Z --verify-tag --notes-file /path/to/new-section.md`. Do not create another release commit or move the existing tag.
