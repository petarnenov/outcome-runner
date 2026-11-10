# Automatic semantic versioning from Conventional Commits

## Why

OR-9 needs repeatable releases derived from repository history, with version metadata, release notes and Git tags kept together. Manual version selection and separate pushes can leave those artifacts inconsistent.

## What Changes

- Add a Node 24 executable TypeScript release script using erasable syntax and Node built-ins only.
- Analyze complete reachable history since the latest stable release tag, including merged branch commits, using Conventional Commits 1.0.0 and Semantic Versioning 2.0.0.
- Produce a local release commit and annotated tag, updating only version tokens in package metadata and prepending grouped changelog notes. Support a completely nonmutating dry run.
- Add a main push workflow that validates, skips release heads, and publishes commit and tag atomically before creating a GitHub Release.
- Extend test discovery and typechecking to scripts while retaining 85% coverage thresholds and excluding scripts from distribution build output.
- Document commit conventions, release behavior, dry runs and rejected-push recovery.

## Capabilities

### New Capabilities

- `automatic-semantic-versioning`: history classification, version calculation, local release artifacts, preview, CI publication, tests and release documentation.

### Modified Capabilities

None.

## Impact

Future implementation is confined to `scripts/release.ts`, `scripts/release.test.ts`, `.github/workflows/release.yml`, `docs/releasing.md`, `package.json`, `tsconfig.json`, and release-generated `package-lock.json` / `CHANGELOG.md`. Existing `tsconfig.build.json` already restricts compilation to src and bin and needs no change. No runtime dependency, npm publication, force push or script-driven push is introduced.

## Delivery Boundary

This session writes only proposal, design, tasks and the capability delta under `openspec/changes/automatic-semantic-versioning`. Product implementation and frozen checks are deferred until specification binding in a later session. Source: OR-9, priority 9, dependencies none; all acceptance criteria are specified by the capability delta and mapped to implementation tasks. Parsing, breaking detection, bump precedence, changelog grouping and changelog entries have separate requirements with WHEN/THEN scenarios.
