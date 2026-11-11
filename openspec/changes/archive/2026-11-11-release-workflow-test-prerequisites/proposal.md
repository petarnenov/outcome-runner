# Install test prerequisites in the release workflow

## Why

OR-12 follows OR-9's release workflow. The test suite invokes `openspec validate` through the runner's planning check, so a clean GitHub Actions runner needs the OpenSpec CLI in addition to npm dependencies. The task reports that the first Release run on main failed with 27 failing tests because that CLI was missing.

## What Changes

- Install the globally available OpenSpec CLI with `npm install -g @fission-ai/openspec@1.17.0` before `npm test`.
- Run `openspec --version` in a separate workflow step before tests so CLI availability failures are visible before the suite starts.
- Document the workflow test prerequisite, its pinned version, and the workflow file as the place to update that version.
- Preserve every existing workflow step and all release behavior.

## Capabilities

### New Capabilities

- `release-workflow-test-prerequisites`: pinned CLI installation, explicit availability check, prerequisite documentation, and validation of the minimal workflow change.

### Modified Capabilities

None. This additive capability supplements OR-9 without rewriting its release specification.

## Impact

Future implementation changes only `.github/workflows/release.yml` and `docs/releasing.md`. No package metadata, lockfile, runner, tests, release scripts or runtime behavior changes are needed.

## Delivery Boundary

Source: OR-12, priority 12, dependency OR-9. OR-9 has accepted evidence in `evidence/results/OR-9.json`. This session creates only the four planning artifacts under `openspec/changes/release-workflow-test-prerequisites`. Implementation and frozen checks occur only after specification binding in a later session.
