# Release workflow test prerequisites

## Context

The Release job currently checks out the pushed SHA, sets up Node 24, runs `npm ci`, typecheck and tests, then performs release creation and publication. OpenSpec is not a package dependency. The test suite reaches `openspec validate` through the runner's planning check; installing npm dependencies alone does not provide the CLI. OR-12 reports 27 failing tests in the first main Release run from this missing prerequisite.

OR-9 is already accepted. This change addresses its workflow environment without changing release semantics or the test suite.

## Goals and non-goals

Provide OpenSpec CLI 1.17.0 on PATH before tests, expose its version in a dedicated step, and document how the pin is maintained. Implementation is limited to `.github/workflows/release.yml` and `docs/releasing.md`.

Preserve triggers, concurrency, permissions, job guard, checkout settings, Node 24, npm ci, typecheck, tests, release script, atomic push and GitHub Release steps exactly. Do not add package dependencies, alter tests, introduce caches, change release logic or update unrelated documentation.

## Decisions

### Install the exact CLI version globally

Insert an installation step running exactly `npm install -g @fission-ai/openspec@1.17.0` after the existing typecheck step and immediately before a separate version step. The resulting command order is:

1. `npm ci`
2. `npm run typecheck`
3. `npm install -g @fission-ai/openspec@1.17.0`
4. `openspec --version`
5. `npm test`

The existing Node setup supplies npm and the global executable path. An exact package version makes the CI prerequisite explicit and avoids unreviewed CLI upgrades. Global installation supplies the command used by existing tests without changing package metadata or invoking a different validation path.

### Check availability in a separate step

Use a dedicated step running exactly `openspec --version` after installation and before tests. Retain normal GitHub Actions failure propagation: neither added step uses `continue-on-error` or an unconditional execution guard. An installation failure or unusable executable stops the job before tests and release mutation. The version output is visible independently in the job log.

### Document the pin at its source

Update the automated publication section of `docs/releasing.md` to identify OpenSpec CLI `@fission-ai/openspec@1.17.0` as a prerequisite of the workflow's test step, explain the planning check's `openspec validate` invocation, and state that maintainers update the pinned version in `.github/workflows/release.yml`. Explain the separate version check before tests. Keep all other release guidance intact.

## Risks and tradeoffs

The install requires npm registry availability; a failed download correctly blocks a release before tests. The explicit version check detects an unavailable or broken executable early. Updating the pin remains a deliberate workflow edit, accompanied by matching documentation. No fallback to an unpinned version or bypass of planning validation is introduced.

## Validation after binding

Inspect the workflow diff: removing only the two new steps must reproduce the original workflow byte for byte. Verify installation then version check both precede the unchanged test step and retain default failure behavior. Inspect documentation for the exact package/version and workflow update location. Run the frozen project checks for `npm run typecheck` and `npm test` and record their results. A local environment used for those checks needs the same CLI available.

The present session must not modify product files or invoke checks. Review the four planning artifacts now; implement and verify in a later session after specification binding.
