# OR-12 implementation tasks

These unchecked tasks are for a later session after specification binding. This planning session writes only the proposal, design, tasks and capability delta; product edits and checks are intentionally deferred.

## 1. Add the workflow prerequisite

- [ ] 1.1 In `.github/workflows/release.yml`, insert a step running `npm install -g @fission-ai/openspec@1.17.0` after the existing typecheck step and before tests.
- [ ] 1.2 Add a separate subsequent step running `openspec --version`, still before `npm test`, with default failure propagation for both new steps.
- [ ] 1.3 Confirm every pre-existing workflow byte remains unchanged outside the two inserted steps, including triggers, concurrency, permissions, job guard, checkout, Node 24, npm ci, typecheck, test, release script, atomic push and GitHub Release.

## 2. Document the test prerequisite

- [ ] 2.1 Update `docs/releasing.md` to list OpenSpec CLI `@fission-ai/openspec@1.17.0` as a prerequisite of the workflow test step because the runner planning check invokes `openspec validate`.
- [ ] 2.2 Explain installation and the separate version check before tests, and state that the pinned version is updated in `.github/workflows/release.yml`.

## 3. Verify the bound implementation

- [ ] 3.1 Review the diff for only the two scoped product paths; confirm exact install command, separate version command, ordering and failure propagation, without changing the suite to avoid the missing CLI.
- [ ] 3.2 With the pinned CLI available, run the frozen project checks and confirm `npm run typecheck` and `npm test` pass; record results and resolve any in-scope failures.
- [ ] 3.3 Check that the documentation pin matches the workflow and that all capability scenarios are satisfied.

## Acceptance criteria mapping

- Reported missing-CLI failure and the planning check dependency: proposal context, design context, task 2.1, CLI requirement.
- Exact pinned install and separate version step before tests: tasks 1.1–1.2, CLI and failure requirements.
- All other workflow steps unchanged: task 1.3, workflow preservation requirement.
- Documentation prerequisite and pin maintenance location: tasks 2.1–2.2 and 3.3, documentation requirement.
- Passing typecheck and tests: task 3.2, verification requirement.
