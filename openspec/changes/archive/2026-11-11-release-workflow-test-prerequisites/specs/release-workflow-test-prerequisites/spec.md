# Release Workflow Test Prerequisites

## ADDED Requirements

### Requirement: Pinned OpenSpec CLI before release tests

The Release job in `.github/workflows/release.yml` SHALL install the OpenSpec CLI by running exactly `npm install -g @fission-ai/openspec@1.17.0`. It SHALL run exactly `openspec --version` in a separate subsequent step. Both new steps SHALL follow the existing typecheck step and precede the existing `npm test` step. The installed CLI SHALL be available to the runner planning check invoked by the test suite, which runs `openspec validate`.

#### Scenario: Tests run with the required CLI

- **WHEN** the Release job reaches tests on a clean GitHub Actions runner
- **THEN** the job SHALL have installed `@fission-ai/openspec@1.17.0` globally and printed `openspec --version` in a separate step
- **AND** `npm test` SHALL have the `openspec` executable available for its runner planning check.

### Requirement: CLI prerequisite failures stop before tests

Both added steps SHALL retain normal GitHub Actions failure propagation. An installation or version-command failure SHALL fail the job before tests, release mutation, atomic push or GitHub Release creation.

#### Scenario: CLI installation fails

- **WHEN** `npm install -g @fission-ai/openspec@1.17.0` exits unsuccessfully
- **THEN** the Release job SHALL fail without running tests or any release creation or publication step.

#### Scenario: CLI is missing or broken after installation

- **WHEN** `openspec --version` exits unsuccessfully because the executable is unavailable or broken
- **THEN** the separate version step SHALL fail before `npm test`
- **AND** no release mutation or publication SHALL execute.

### Requirement: Existing release workflow is preserved

The implementation SHALL change the workflow only by adding the installation and version steps. All existing content SHALL remain unchanged, including triggers, concurrency, permissions, job guard, checkout, Node 24, `npm ci`, `npm run typecheck`, `npm test`, release script execution, atomic push and GitHub Release creation.

#### Scenario: Review the workflow change

- **WHEN** the two new prerequisite steps are removed from the resulting workflow for comparison
- **THEN** the remaining workflow SHALL be byte-identical to the original
- **AND** the original steps SHALL retain their commands, settings and relative order.

### Requirement: Release documentation explains the prerequisite and pin

`docs/releasing.md` SHALL list the OpenSpec CLI package `@fission-ai/openspec@1.17.0` as a prerequisite of the workflow test step, explain that the suite invokes `openspec validate` through the runner planning check, and describe the separate version step before tests. It SHALL identify `.github/workflows/release.yml` as the place to update the pinned CLI version.

#### Scenario: Maintainer reviews or updates test prerequisites

- **WHEN** a maintainer reads the automated publication guidance
- **THEN** the guide SHALL identify OpenSpec CLI version 1.17.0 and its use by the workflow test step
- **AND** it SHALL explain the installation and separate version check before tests
- **AND** it SHALL direct version updates to the pin in `.github/workflows/release.yml`.

### Requirement: Project checks pass after implementation

After specification binding and implementation, `npm run typecheck` and `npm test` SHALL pass with the pinned OpenSpec CLI available. Implementation SHALL remain limited to `.github/workflows/release.yml` and `docs/releasing.md` without modifying product code, tests or package metadata to avoid the prerequisite.

#### Scenario: Validate the bound change

- **WHEN** the later implementation session runs the frozen project checks with OpenSpec CLI 1.17.0 available
- **THEN** `npm run typecheck` and `npm test` SHALL both pass
- **AND** their results SHALL be recorded as implementation evidence.
