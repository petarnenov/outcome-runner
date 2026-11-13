# Design: merge retries that tolerate pending checks, a behind pull request and release commits

## Context

The merge stage of `src/runner.ts` loops over pull request views: `host.find`, the state and local head checks,
`ready = pr.headRefOid === now.head`, `compareTarget(view === 1 || ready)`, then for a ready view the
`merge: merging #N` line and `host.merge(pr, head, guard)`. `GitHubHost.merge` (`src/git.ts`) settles the view and
throws `PR protection or identity blocks merge (<status>)` for every status other than `CLEAN`; the runner records
that as a blocked entry and `explainUnfinished` turns it into `operation-incomplete`. A failed comparison
(`advanced`) increments `targetAttempts`, logs `retry ... (attempt N)` and returns to `publish`; at
`TARGET_ATTEMPTS` (10) it blocks with `target-keeps-advancing`.

## Goals

- `BEHIND` returns to catch-up and publish like an advanced target.
- Pending required checks are waited for (at most 30 minutes); failed required checks block at once.
- Release-only advances are integrated without consuming an attempt.
- Every retry is durable before the next effect and logged; restarts resume the recorded attempt and wait.

Non-goals: no change to the stale-head polling budget, the guard, `--match-head-commit`, the integrate stage, or
the set of statuses that `GitHubHost.merge` accepts (still only `CLEAN`).

## Decisions

### 1. Eligibility data and host contract

`src/git.ts` exports:

```ts
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
export interface RequiredCheck { name: string; bucket: CheckBucket }
export interface MergeEligibility { status: string; checks: RequiredCheck[] }
export class MergeIneligible extends Error { status: string; checks: RequiredCheck[] }
```

`MergeIneligible`'s message stays `PR protection or identity blocks merge (<status>)`, so existing assertions on the
message keep holding.

`PullRequestHost` (in `src/runner.ts`) gains an optional
`eligibility?(pr: PullRequest, head: string): MergeEligibility | Promise<MergeEligibility>`. A host without it is
treated as eligible (`{ status: 'CLEAN', checks: [] }`), so the scripted host of `test/support/runner-fixture.ts`
and every existing test keep their behaviour and step lines. `merge` may additionally throw `MergeIneligible`.

`GitHubHost`:

- `requiredChecks(pr)`: `gh pr checks <n> --required --json name,bucket --repo <repo>`. `gh` exits 8 while checks
  are pending and 1 when a check failed, still printing the JSON; the method parses the captured stdout of such a
  failure. Empty stdout (for example "no required checks reported") gives `[]`. Any other unparsable output
  rethrows the command failure.
- `eligibility(pr, head)`: `settledMergeView(pr, head)` (unchanged stale-head and UNKNOWN polling). A view that is
  not `OPEN`, has another head or base, or is a draft throws as today. `CLEAN` returns `{ status: 'CLEAN',
  checks: [] }` without reading checks; any other status returns the status with `requiredChecks(pr)`.
- `merge(pr, head, guard)`: when the settled view passes state, head, base and draft but the status is not `CLEAN`,
  it throws `MergeIneligible(status, requiredChecks(pr))` instead of a plain `Error`; no guard call and no
  `gh pr merge`. Identity and other protection failures keep the plain error.

Existing GitHubHost tests: because a status-only refusal now issues `gh pr checks`, any existing `host.gh` stub
that returns a settled non-`CLEAN` view to `merge` must answer that call. In `test/git-stale-head.test.ts` the
`shared-exhaustion` scenario ends on a settled `UNKNOWN` view of the checked head; its stub asserts
`args[1] === 'view'` for every non-merge call and its final check only allows `view` and `merge`. The stub is
updated to return `'[]'` for `pr checks` (not counted as a view) and the call check allows `checks`; the expected
`/UNKNOWN/u` rejection still matches the `MergeIneligible` message. Stale, foreign and missing scenarios fail before
the status check and issue no `checks` call.

### 2. Pure classification (`src/merge-eligibility.ts`)

```ts
export type EligibilityClass = 'eligible' | 'behind' | 'pending' | 'failed' | 'refused';
export function classifyEligibility(e: MergeEligibility): { kind: EligibilityClass; checks: string[] }
```

Rules, first match wins:

1. `CLEAN` → `eligible`.
2. `BEHIND` → `behind`.
3. `BLOCKED`, `UNSTABLE` or `UNKNOWN` with a required check in bucket `fail` or `cancel` → `failed`, `checks` the
   sorted names of those checks.
4. `BLOCKED`, `UNSTABLE` or `UNKNOWN` with a required check in bucket `pending` → `pending`, `checks` the sorted
   pending names.
5. `UNKNOWN` without pending or failed checks → `pending` (GitHub is still computing), `checks` `[]`.
6. Anything else (`BLOCKED`/`UNSTABLE` with only passing or skipped checks, `DIRTY`, `DRAFT`, `HAS_HOOKS`, …) →
   `refused`, `checks` `[]`.

Constants: `MERGE_ELIGIBILITY_WAIT_MS = 30 * 60 * 1000` and `MERGE_ELIGIBILITY_POLL_MS = 15000`.
`MergePolling` gains `eligibilityPollMs?: number`; the delay is `polling.delay ?? delay` like the stale-head wait.

### 3. Merge-stage flow

Per view, after the state and local-head checks and `ready`:

1. When `ready`, read `host.eligibility?.(pr, head)` (default eligible) and classify it.
2. `compareTarget(view === 1 || (ready && kind === 'eligible') || kind === 'behind')`. A difference is the existing
   advanced path (decision 4) regardless of the class.
3. `eligible`: `merge: merging #N` (still the last line before the merge request), `host.merge(pr, head, guard)`.
   A `MergeIneligible` thrown by `merge` (a race between the eligibility read and the merge) is caught inside the
   merge stage, before the generic catch of the loop. Its `{ status, checks }` is classified with
   `classifyEligibility` and handled exactly like steps 4–7 for that class: `behind` → the retry of step 4 (after a
   fresh `compareTarget`, so an advanced target takes the advanced path); `pending` → the eligibility wait of step
   5; `failed` → step 6; `refused` (for example `DIRTY`, or `BLOCKED` with only passing checks) →
   `MergeNotEligible(status, [])` of step 7. A `CLEAN` status on a `MergeIneligible` cannot occur from
   `GitHubHost`; if a scripted host throws one it is treated as `refused`. Thus a `MergeIneligible` from `merge`
   never reaches the generic catch and never ends as `operation-incomplete`. Errors from `merge` that are not
   `MergeIneligible` keep today's handling.
4. `behind`: a retry with reason `behind` (decision 4), back to `publish`.
5. `pending`: the eligibility wait (decision 5).
6. `failed`: `MergeNotEligible(status, checks)` at once — no delay, no further view.
7. `refused`: `MergeNotEligible(status, [])` at once. (Before this change it was `operation-incomplete`; the new
   reason names the status.)

Not ready views keep the stale-head wait unchanged.

### 4. Retries, release-only advances and the attempt count

A failed comparison (also from the guard) and a `behind` view both lead to one retry handler with a reason:
`target-advanced` or `behind`. Before counting, the runner checks whether the advance is release-only:

```ts
export function releaseOnlyAdvance(cwd: string, from: string, to: string): boolean
```

in `src/merge-eligibility.ts`, with `from` = the work's `testedTarget` and `to` = the freshly fetched
`origin/<target>`. It is true only when all hold:

- `from !== to` and `from` is an ancestor of `to`;
- every commit of `git rev-list from..to` is a non-merge commit whose subject matches
  `^chore\(release\): v\d+\.\d+\.\d+$` (the subject written by `scripts/release.ts`);
- `git diff --name-only from to` is non-empty and only lists `package.json`, `package-lock.json` and
  `CHANGELOG.md`;
- `package.json`, if changed, exists on both sides and the parsed JSON is equal after removing the top-level
  `version`;
- `package-lock.json`, if changed, exists on both sides and the parsed JSON is equal after removing the top-level
  `version` and `packages[""].version`.

Any Git or JSON error gives false (the advance then counts, which is the safe side).

Handler:

- release-only: reason `release-commit`, `targetAttempts` unchanged, step line
  `retry: origin/<target> advanced with a release commit; integrating it without using an attempt (attempt N)`
  where N is the unchanged current attempt.
- otherwise `attempts = targetAttempts + 1`; at `TARGET_ATTEMPTS` save `stage: 'publish', targetAttempts: 0` and
  throw `target-keeps-advancing` as today. Else the line is the existing
  `retry: origin/<target> advanced; integrating it again (attempt N+1)` for `target-advanced`, and
  `retry: #<n> is behind origin/<target>; catching up (attempt N+1)` for `behind`.

A `behind` view whose fetched target is unchanged still counts an attempt (nothing release-only to exempt), so a
GitHub view that stays `BEHIND` is bounded by the same limit. The catch-up then finds the target contained,
re-runs the checks, pushes and reaches the merge stage again.

### 5. Eligibility wait

On a `pending` view:

- If `work.mergeWait` is absent, save `mergeWait: { since: <ISO now()>, status, checks, views: 1 }` and append a
  `mergeRetries` entry with reason `checks-pending`; write `wait: waiting for required checks of #<n> (<status>)`.
  A later pending view with a different status writes that line again; same-status views stay quiet (no compare
  line either, decision 3 step 2).
- Otherwise save the updated `status`, `checks` and `views + 1`.
- When `now() - Date.parse(mergeWait.since) >= MERGE_ELIGIBILITY_WAIT_MS`, throw
  `MergeNotEligible(lastStatus, pendingChecks)`; otherwise delay `polling.eligibilityPollMs ??
  MERGE_ELIGIBILITY_POLL_MS` and take the next view. The pending loop is bounded by time, not by the stale-head
  view limit; the view counter for stale heads is not advanced by eligibility polls.
- `mergeWait` is cleared when the merge stage ends in any way (merge, retry to publish, block). A restart in the
  middle of a wait keeps `since`, so the 30 minutes are not restarted; a restart after a block starts a new wait.

The clock is `options.now`, so tests advance it from the fake `mergePolling.delay`.

### 6. Durable records and step lines

`src/model.ts`:

```ts
export type MergeRetryReason = 'target-advanced' | 'behind' | 'release-commit' | 'checks-pending';
export interface MergeRetry { attempt: number; reason: MergeRetryReason; at: string; status?: string;
  target?: string; checks?: string[] }
Work.mergeRetries?: MergeRetry[];
Work.mergeWait?: { since: string; status: string; checks: string[]; views: number };
```

`attempt` is the attempt the retry leads to (unchanged for `release-commit` and `checks-pending`). Each retry writes
its step line and then one `save` with the new `mergeRetries`, `targetAttempts`, `stage` and cleared `mergeWait`,
then calls `afterEffect('retry', work)` (new hook, used by the restart test) before `continue`. Nothing else
happens between the step line, the save and the hook, so the save precedes every next effect. The owner retry
records (`Work.retries`, `--retry`) are unrelated and unchanged.

### 7. Blocking with `merge-not-eligible`

`MergeNotEligible extends Error` with message `merge-not-eligible`, `status` and `checks`. The catch block of the
loop stores `eligibility: { status, checks }` on the blocked entry (`BlockedEntry.eligibility?` in
`src/run-store.ts`), with `work.mergeWait` cleared and the stage left at `merge`. `explainUnfinished` keeps the
reason `merge-not-eligible` (added to the kept reasons) and copies `status` and `checks` into the blocker
(`Blocker.status?: string`, `Blocker.checks?: string[]`); other blockers are unchanged. Nothing is merged, and the
worktree and branches stay so a restart continues at the merge stage. This applies to `failed`, `refused` (from the
eligibility read or from a `MergeIneligible` thrown by `merge`) and an expired `pending` alike; required runner tests
cover each of them.

### 8. README

Extend "When the target advances during a run" with a merge eligibility part: `BEHIND` catches up like an advance;
pending required checks are waited for up to 30 minutes; a failed required check or a status that cannot become
eligible blocks with `merge-not-eligible` (status and check names in the blocker); release commits that only change
version fields and `CHANGELOG.md` do not count toward the 10 attempts. Add `merge-not-eligible` to the blocker
table and the new `retry`/`wait` lines to the step line list.

## Risks

- `gh pr checks` exit codes: handled by parsing stdout of the failure; a real failure without JSON still throws.
- A stream of release commits could loop without consuming attempts; each loop still requires a new release commit
  on the target, which only happens after another merge, so it is bounded in practice.
- 30 minutes of polling at 15 s is 120 eligibility reads, within GitHub API limits.
- Existing `GitHubHost` stubs that return non-`CLEAN` settled views must answer `gh pr checks` (see decision 1).
- A status change between the eligibility read and the merge is handled by classifying the `MergeIneligible` from
  `merge` (decision 3 step 3), so it cannot fall through to `operation-incomplete`.
