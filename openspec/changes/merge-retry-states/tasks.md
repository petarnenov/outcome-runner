# Tasks

## 1. Model and store

- [ ] 1.1 `src/model.ts`: add `MergeRetryReason`, `MergeRetry`, `Work.mergeRetries?: MergeRetry[]` and
  `Work.mergeWait?: { since; status; checks; views }` (design decision 6).
- [ ] 1.2 `src/run-store.ts`: `BlockedEntry.eligibility?: { status: string; checks: string[] }` (decision 7).

## 2. Eligibility module and host

- [ ] 2.1 `src/git.ts`: export `CheckBucket`, `RequiredCheck`, `MergeEligibility`, `MergeIneligible` (message
  `PR protection or identity blocks merge (<status>)`); `MergePolling.eligibilityPollMs?` (decision 1).
- [ ] 2.2 `GitHubHost.requiredChecks(pr)` with `gh pr checks <n> --required --json name,bucket`, parsing the stdout of
  a nonzero exit, empty output as `[]` (decision 1).
- [ ] 2.3 `GitHubHost.eligibility(pr, head)` and `GitHubHost.merge` throwing `MergeIneligible` for a status-only
  refusal, without guard or `gh pr merge` (decision 1).
- [ ] 2.4 New `src/merge-eligibility.ts`: `classifyEligibility`, `releaseOnlyAdvance`, `MERGE_ELIGIBILITY_WAIT_MS`,
  `MERGE_ELIGIBILITY_POLL_MS` (decisions 2 and 4).

## 3. Runner

- [ ] 3.1 `PullRequestHost.eligibility?` (default eligible) and the per-view order of decision 3: eligibility when
  ready, `compareTarget(view === 1 || (ready && eligible) || behind)`, then merge / behind / pending / failed /
  refused. A `MergeIneligible` from `merge` is caught inside the merge stage, classified with `classifyEligibility`
  and handled like steps 4–7 of decision 3: `behind` → retry, `pending` → eligibility wait, `failed` →
  `MergeNotEligible(status, checks)`, `refused` (for example `DIRTY`) → `MergeNotEligible(status, [])`. It never
  reaches the generic catch and never ends as `operation-incomplete`.
- [ ] 3.2 One retry handler for `target-advanced` and `behind` with the release-only exemption, step lines, a single
  `save` of `mergeRetries`, `targetAttempts`, `stage: 'publish'` and cleared `mergeWait`, then
  `afterEffect('retry', work)` (decisions 4 and 6). `target-keeps-advancing` unchanged otherwise.
- [ ] 3.3 Eligibility wait with durable `mergeWait`, `wait: waiting for required checks of #<n> (<status>)` on start
  and status change, `options.now` as clock, `polling.eligibilityPollMs ?? MERGE_ELIGIBILITY_POLL_MS` delay, block
  after 30 minutes (decision 5).
- [ ] 3.4 `MergeNotEligible` error; catch block stores `eligibility` on the blocked entry; `explainUnfinished` keeps
  `merge-not-eligible` and copies `status` and `checks` into `Blocker` (decision 7).
- [ ] 3.5 Keep the existing `GitHubHost` tests passing (decision 1, "Existing GitHubHost tests"). In
  `test/git-stale-head.test.ts` the `shared-exhaustion` scenario ends with a settled, non-stale `UNKNOWN` view, a
  status-only refusal, so `merge` now calls `gh pr checks`. Update its `host.gh` stub to answer
  `args[0] === 'pr' && args[1] === 'checks'` with `'[]'` before the `assert.equal(args[1], 'view')` line (without
  incrementing `views`), and change the final call assertion to
  `calls.every(args => ['view', 'merge', 'checks'].includes(args[1]))`. The expected rejection `/UNKNOWN/u` still
  matches the `MergeIneligible` message, `views` stays 5 and `delays.length === views - 1` still holds. Also assert
  that only `shared-exhaustion` issues a `checks` call (stale, foreign, missing and `CLEAN` scenarios issue none).
- [ ] 3.6 Search the rest of `test/` for other `host.gh` stubs that return a non-`CLEAN` settled view to
  `GitHubHost.merge` and give them the same `pr checks` answer, and for runner-level assertions on a non-`CLEAN`
  refusal from the merge stage (`PR protection or identity blocks merge` / `operation-incomplete`) and update them to
  `merge-not-eligible`.

## 4. README

- [ ] 4.1 Extend "When the target advances during a run" with merge eligibility retries (`BEHIND`, pending required
  checks, `30 minutes`), `merge-not-eligible` and the release-commit exception; add `merge-not-eligible` to the
  blocker table and the new `retry` and `wait` lines to the step line list (decision 8).

## 5. Tests

Graded from E (easiest) to A (most complex), listed easiest first. New tests live in
`test/merge-retry-states.test.ts`. Runner tests use `runnerFixture` with a scripted host wrapped around
`f.hostFor('main')` that adds `eligibility` (scripted status sequence) or a throwing `merge`, `mergePolling` with a
fake `delay` that advances a fake clock passed as `now`, and step lines captured through `RunOptions.steps`. Target
advances are commits pushed from `f.integrator`. `GitHubHost` tests stub `host.gh` like the existing guard test.
The updated `test/git-stale-head.test.ts` (task 3.5) must keep passing as part of `npm test`.

### Grade E

- [ ] 5.1 (E) (required) `classifyEligibility` table (spec "Classification of refused statuses"): `CLEAN` →
  eligible; `BEHIND` → behind; `BLOCKED` with `build` fail and `lint` pass → failed `['build']`; `UNSTABLE` with a
  `cancel` check → failed; `BLOCKED`/`UNSTABLE`/`UNKNOWN` with a pending check → pending with its name; `UNKNOWN`
  without checks → pending; `BLOCKED` with only passing checks → refused; `DIRTY` → refused.
- [ ] 5.2 (E) (required) `explainUnfinished` with a blocked entry `{ reason: 'merge-not-eligible', eligibility:
  { status: 'BLOCKED', checks: ['build'] } }` gives `kind` `blocked`, reason `merge-not-eligible`, `status` and
  `checks`; other reasons are unchanged.
- [ ] 5.3 (E) (required) README section (spec "README section"): the section "When the target advances during a
  run" names `BEHIND`, `pending required checks`, `30 minutes`, `merge-not-eligible`, `release commit` and that they
  do not count toward the attempt limit; the blocker table lists `merge-not-eligible`.
- [ ] 5.4 (E) (coverage-only) `MERGE_ELIGIBILITY_WAIT_MS` is 1800000 and a directly constructed `MergeIneligible`
  keeps `status` and `checks`.

### Grade D

- [ ] 5.5 (D) (required) `releaseOnlyAdvance` on Git fixtures (spec "Release-only advance does not consume an
  attempt", "A dependency change is not release-only"): true for a `chore(release): v0.0.2` commit changing only
  `version` in `package.json`, `version` and `packages[""].version` in `package-lock.json` and adding a
  `CHANGELOG.md` section; false when `package.json` also changes a dependency, when the subject is not a release
  subject, when another file changes, when the range contains a merge commit, and when `from` equals `to`.
- [ ] 5.6 (D) (required) `GitHubHost` eligibility (spec "CLEAN reads no checks", "Pending checks are parsed from a
  nonzero exit", "Merge refused by the status"): stubbed `gh` — `CLEAN` issues no `gh pr checks`; `BLOCKED` with a
  `gh pr checks` stub that throws an error carrying stdout JSON (pending and pass) returns both checks; `merge` on a
  `BEHIND` view rejects with an error that is an instance of `MergeIneligible`, has status `BEHIND` and has the
  exact message `PR protection or identity blocks merge (BEHIND)` (asserted on the error thrown by `merge` itself),
  and neither the guard nor `gh pr merge` is called.
- [ ] 5.7 (D) (coverage-only) `GitHubHost.requiredChecks`: a failure with empty stdout gives `[]`; a failure with
  non-JSON stdout rethrows.

### Grade C

- [ ] 5.8 (C) (required) Failed required check blocks at once (spec "Failed required check"): eligibility returns
  `BLOCKED` with `build` fail and `lint` pass; result `incomplete`, blocked reason `merge-not-eligible`,
  `eligibility` `{ status: 'BLOCKED', checks: ['build'] }`, result blocker with `status` and `checks`, no delay after
  that view, host `merge` never called, worktree and branches exist.
- [ ] 5.9 (C) (required) Refused statuses block at once in the runner (spec "Classification of refused statuses"):
  run twice in separate fixtures, once with eligibility `BLOCKED` with only a passing `lint` check and once with
  `DIRTY` and no checks; each run ends `incomplete` with blocked reason `merge-not-eligible`, blocked entry
  `eligibility` `{ status: <that status>, checks: [] }`, run result blocker with `kind` `blocked`, reason
  `merge-not-eligible`, that `status` and empty `checks`; no delay was requested, host `merge` was never called,
  nothing records `operation-incomplete`, and the worktree and branches exist.
- [ ] 5.10 (C) (required) Merge refused after an eligible read (spec "Merge refused after an eligible read"): in a
  third fixture, eligibility returns `CLEAN` and the wrapped `merge` throws `MergeIneligible('DIRTY', [])` without
  pushing anything; the run ends `incomplete` with blocked reason `merge-not-eligible`, blocked entry `eligibility`
  `{ status: 'DIRTY', checks: [] }`, run result blocker with `kind` `blocked`, reason `merge-not-eligible`, status
  `DIRTY` and empty `checks`; `merge` was called exactly once, no delay was requested, nothing records
  `operation-incomplete`, and the worktree and branches exist.
- [ ] 5.11 (C) (required) Pending checks turn green and merge (spec "Pending checks turn green and merge" and "One
  wait line and no effects while pending"): eligibility returns `BLOCKED` with a pending check twice, then `CLEAN`;
  two delays with the eligibility poll interval; exactly one `wait: waiting for required checks of #1 (BLOCKED)`
  line; check, push and create counts do not change during the wait; a `mergeRetries` entry with reason
  `checks-pending`; `mergeWait` cleared on the accepted work; task accepted.
- [ ] 5.12 (C) (required) Pending for more than 30 minutes (spec "Pending for more than 30 minutes"): eligibility
  always returns `UNSTABLE` with a pending check `build`, the fake delay advances the clock by the poll interval; the
  run ends `incomplete` only once 30 minutes have passed since the first pending view (the clock at the last view
  before blocking is under 30 minutes past it, the blocking view at or over 30 minutes); the blocked entry has
  reason `merge-not-eligible` and `eligibility` `{ status: 'UNSTABLE', checks: ['build'] }`; the run result blocker
  has `kind` `blocked`, reason `merge-not-eligible`, `status` `UNSTABLE` and `checks` `['build']`; host `merge` was
  never called and `origin/main` does not contain the task.

### Grade B

- [ ] 5.13 (B) (required) BEHIND leads to catch-up and a merge (spec "BEHIND leads to catch-up and a merge"):
  eligibility returns `BEHIND` on the first merge-stage call and `CLEAN` afterwards; the step log has
  `retry: #1 is behind origin/main; catching up (attempt 2)` followed by the publish `compare` line with
  `(attempt 2)`, checks and push of attempt 2; `mergeRetries[0]` has reason `behind` and attempt 2;
  `targetAttempts` 1; the task is accepted and nothing records `operation-incomplete`.
- [ ] 5.14 (B) (required) Merge refusal `BEHIND` after an advance (spec "Merge refusal BEHIND after an advance"):
  the wrapped `merge` pushes `docs/other.md` to the target and throws `MergeIneligible('BEHIND', [])` on its first
  call; the advance is integrated, the second `merge` receives a new head, and the task is accepted.
- [ ] 5.15 (B) (required) Release-only advance does not consume an attempt (spec "Release-only advance does not
  consume an attempt"): before the run the target gains `package.json`, `package-lock.json` and `CHANGELOG.md`; the
  wrapped `merge` pushes a release commit on its first call and calls the guard; the retry line names the release
  commit with `(attempt 1)`; `targetAttempts` is 0 or absent on the accepted work; `mergeRetries` has reason
  `release-commit`; `origin/main` contains the release commit and the task.
- [ ] 5.16 (B) (required) Attempt limit with target-keeps-advancing (spec "Attempt limit reached with
  target-keeps-advancing" and "Durable merge retries"): the wrapped `merge` alternates a release-only advance and a
  `docs/other-<n>.md` advance, starting with a release-only one, and calls the guard every time; the task blocks
  with `target-keeps-advancing` after the tenth counted attempt; the number of `merge` calls is 10 plus the release
  retries; nothing is merged, and the worktree and branches exist. Step lines: the counted `retry` lines carry
  attempts 2 to 10 in order; every `retry: origin/main advanced with a release commit; integrating it without using
  an attempt (attempt N)` line carries the same N as the attempt it interrupted (the attempt of the preceding publish
  `compare` line), and the next counted `retry` line after it carries N+1, so release-only retries never raise the
  attempt number. Durable state: after the block, read `state.json` and check that `mergeRetries` has one entry with
  reason `target-advanced` for each counted retry, with attempts 2 to 10 in order, and one entry with reason
  `release-commit` for each release-only retry whose attempt equals the unchanged current attempt at that retry
  (the same N as its step line), in the same order as the step lines.

### Grade A

- [ ] 5.17 (A) (required) Restart resumes at the recorded attempt (spec "Restart resumes at the recorded attempt"):
  eligibility returns `BEHIND` once; the first run is cancelled from `afterEffect('retry')`; `state.json` `current` has
  `targetAttempts` 1, one `behind` entry and stage `publish`; the rerun's publish `compare` line carries
  `(attempt 2)`, no second `behind` entry is added, and the task is accepted.
- [ ] 5.18 (A) (required) Restart during an eligibility wait keeps its start (spec "Restart during an eligibility
  wait keeps its start"): the first run is cancelled from the fake delay of the pending wait; the rerun keeps
  `mergeWait.since` and blocks with `merge-not-eligible` once the clock is 30 minutes past it, not before.

## 6. Verification after binding

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run `npm test` with the coverage gate at 85%, including the updated `test/git-stale-head.test.ts`.
