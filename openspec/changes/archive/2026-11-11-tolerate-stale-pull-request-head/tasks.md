# Tasks

## 1. Bounded stale-head polling

- [ ] 1.1 Define/reuse the mergeability poll interval and total view limit (3000 ms, 100 views by default), with a deterministic delay seam for tests.
- [ ] 1.2 Add exact origin branch-ref verification using `git ls-remote origin refs/heads/<branch>`; fail closed for foreign or missing refs and remote-read failures.
- [ ] 1.3 Update the runner merge stage to reread stale PR heads within that budget, retain target/local HEAD checks, and merge only the recorded tested head.
- [ ] 1.4 Extend the GitHub settled merge view with expected-head and branch identity, sharing one budget across stale heads and UNKNOWN mergeability.
- [ ] 1.5 Preserve PR protection checks and guarded merge arguments; use `Checked head or target changed` for foreign origin movement or exhausted stale-head waits.

## 2. Deterministic regressions

- [ ] 2.1 Add scripted-host/Git-fixture runner cases for several stale views then convergence, foreign branch movement, persistent stale heads and final-view convergence; assert exact block reasons and no merge on failure.
- [ ] 2.2 Reproduce unrelated target advancement during merge, integration/check/push, stale PR metadata and successful merge in the same invocation with one PR.
- [ ] 2.3 Add the corresponding direct GitHubHost.merge success, foreign-origin and exhaustion cases with scripted gh responses and Git origins.
- [ ] 2.4 Cover shared UNKNOWN/stale budget accounting, origin movement during polling, unchanged local HEAD protection, and unchanged match-head merge arguments.
- [ ] 2.5 Assert polling adds no checks, commits, pushes or PRs and that tests use fake/no-op delays without real-time waits; preserve existing protection and mergeability tests.

## 3. Verification after binding

- [ ] 3.1 Run `npm run typecheck`.
- [ ] 3.2 Run `npm test`.
- [ ] 3.3 Run frozen project checks through the bound implementation workflow and inspect their recorded output.

All implementation and executable validation tasks remain pending for the later bound session. This planning session creates only the four requested OpenSpec artifacts.
