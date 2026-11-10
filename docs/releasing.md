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

A push to main starts .github/workflows/release.yml unless its head is a release commit. The release concurrency group queues jobs without canceling a running job. Each job checks out the exact pushed SHA with all history and tags, uses Node 24, runs npm ci, typecheck and tests, then creates a local release with the Actions bot identity.

A release publishes HEAD to main and its tag in one non-forced atomic push. Only after that push succeeds does the workflow create a GitHub Release. Its notes are exactly the newly prepended changelog section, without the CLI version line or previous sections. No-release results skip publication. Notes are captured outside the working tree.

## Rejected pushes and recovery

If main advances during validation, the atomic push may be rejected. The job fails immediately without retrying, rebasing or force-pushing. Neither the release commit nor its tag is published by a rejected atomic push.

Inspect the current remote main and tags and the failed job log. Use a fresh validated workflow on the current main head (rerun the workflow associated with that current head, or let its queued job run). Rerunning the stale event still checks out its stale SHA: do not retry that stale push or force-push. If necessary, make a new appropriate commit on current main to trigger a new run.

If the atomic push succeeded but GitHub Release creation failed, the commit and tag are already published. Verify that the annotated tag points to the expected release commit and restore only the missing GitHub Release using the exact new CHANGELOG.md section as notes, for example with `gh release create vX.Y.Z --verify-tag --notes-file /path/to/new-section.md`. Do not create another release commit or move the existing tag.
