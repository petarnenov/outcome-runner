# Tasks

## 1. Model and claims

- [x] 1.1 Add `RunConfig.leaseSeconds?`, `DEFAULT_LEASE_SECONDS = 1800` and `resolveLeaseSeconds` (reason
  `invalid-lease-seconds`, details `{ setting: 'leaseSeconds', value }`, integers 300 through 86400) to
  `src/model.ts`, and call it from `validateConfig` (design decision 4). Keep `leaseSeconds` out of the identity.
- [x] 1.2 Extend `Claim` with optional `renewedAt`, `leaseSeconds` and `blocked: { at }` and validate them in
  `assertClaim` (decision 1).
- [x] 1.3 Add `claimStale(claim, nowMs)` and the optional time argument of `foreignClaimsOf` (decision 2).
- [x] 1.4 Make `commitClaim` replace an existing `<id>.json` entry; add `takeOver`, `renew` and `markBlocked` with the
  compare-and-swap push (decision 3).

## 2. Runner

- [x] 2.1 Resolve `leaseSeconds` right after `pollSeconds` in `runSteps`; map `invalid-lease-seconds` to exit code 4
  in the CLI if the CLI keeps a reason list (decision 4). The thrown `details` (`{ setting: 'leaseSeconds', value }`)
  reach the diagnostics file that `reportFailure` in `src/cli.ts` writes (`error.json`).
- [x] 2.2 Pass `now()` to every `foreignClaimsOf` call; write `renewedAt` and `leaseSeconds` into new claims; take
  over a stale foreign claim during selection (decision 5).
- [x] 2.3 Add `holdClaim(work)` at the start of the task block and `RunOptions.leaseTimer` with the default
  `setInterval` timer, interval `Math.floor(leaseSeconds * 1000 / 3)`, stopped on accept, block, cancel, loss and in
  `finally` (decisions 5 and 6).
- [x] 2.4 Add `ClaimLost` and `assertClaimHeld(work)` before the push, before `host.create`, before the merge loop,
  in the merge guard and before `host.merge` (decision 7).
- [x] 2.5 Record `claim-lost` blocked work with `claimLostAt`, explain it with reason `claim-lost`, and move recovered
  claim-lost work of an accepted task to `state.claimLost` instead of recording an acceptance (decision 8).
- [x] 2.6 Mark the claim blocked after a task blocks, before the loop continues; failures only write a step line
  (decision 9).

## 3. README

- [x] 3.1 Add a "Claim leases" section: the lease and `leaseSeconds` (default 1800, 300 through 86400, refused with
  exit code 4 and `invalid-lease-seconds`, outside the identity), renewal every `leaseSeconds / 3`, stale claims and
  that the holder's lease decides, takeover with the compare-and-swap ledger update (exactly one winner), blocked
  claims (never expire, never taken over, continued only by their own invocation or released by dispose; other
  runners keep waiting for them), `claim-lost` (checked before push, pull request creation and merge), and legacy
  claims treated as renewed at `claimedAt`.

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Unit tests live in `test/claim-leases.test.ts`.
Runner tests use `runnerFixture` (`test/support/runner-fixture.ts`, Git fixtures with an origin), scripted adapters
wrapping `scriptedWorker`, a fake clock passed as `now`, a fake `leaseTimer` that records its interval and exposes
the renewal callback, and a scripted `host`. Ledger state is read with `ClaimLedger.pull()`; foreign, stale, blocked
and legacy claims are written directly with `ClaimLedger.acquire` / `commitClaim` on the fixture origin.

### Grade E

- [x] 4.1 (E) (required, scenario "Bounds accepted") `resolveLeaseSeconds()` returns 1800, `resolveLeaseSeconds(300)`
  300 and `resolveLeaseSeconds(86400)` 86400.
- [x] 4.2 (E) (required) `resolveLeaseSeconds` throws reason `invalid-lease-seconds` with details naming
  `leaseSeconds` for `299`, `86401`, `600.5`, `"1800"` and `null`; `validateConfig` rejects such a config.
- [x] 4.3 (E) (required, scenarios "Stale claim ignored", "Claim at its lease is not stale", "Legacy claim without a
  timestamp") `claimStale`: renewed 1801 s ago with lease 1800 is stale; exactly 1800 s is not; a claim with
  `blocked` renewed 10 leases ago is not; a claim with `leaseSeconds` 300 renewed 301 s ago is stale; a legacy claim
  (no `renewedAt`, no `leaseSeconds`) uses `claimedAt` and 1800; a claim without a parseable time is not stale. The
  runner-level behaviour of the first two scenarios is covered by 4.13.
- [ ] 4.4 (E) (coverage-only) `assertClaim` (through `pull`) rejects a record with a non-string `renewedAt`, a
  non-integer `leaseSeconds` or a `blocked` without `at`, and accepts a legacy record. not needed: coverage reached

### Grade D

- [x] 4.5 (D) (required) `foreignClaimsOf` with a time omits stale foreign claims and keeps fresh, blocked and own
  claims excluded/included as before; without a time it is unchanged.
- [x] 4.6 (D) (required) `explainUnfinished` maps a blocked entry with reason `claim-lost` to
  `{ kind: 'blocked', reason: 'claim-lost' }`.
- [x] 4.7 (D) (required, scenario "Invalid leaseSeconds refused") Parameterised over every value in the scenario —
  `299`, `86401`, `600.5` and `"1800"` — a run with that `leaseSeconds` is refused with reason
  `invalid-lease-seconds` and no `state.json`, ledger claim or worktree exists afterwards; for each value the CLI
  exits 4 and prints the reason, and the test reads the diagnostics file named by the printed `unavailable` line
  (the `error.json` that `reportFailure` in `src/cli.ts` writes) and asserts that its `details` contain
  `setting: 'leaseSeconds'` (and the refused `value`), so the run's diagnostics name `leaseSeconds`.
- [x] 4.8 (D) (required, scenario "Lease outside the identity") Resuming an invocation with a different valid
  `leaseSeconds` keeps the identity and resumes.

### Grade C

- [x] 4.9 (C) (required) Ledger operations on a Git fixture: `commitClaim` replaces an existing entry (one file per id);
  `renew` writes `renewedAt`, `leaseSeconds` and drops `blocked`; `renew` returns `lost` for another claimant's or
  another branch's claim; `markBlocked` writes `blocked.at` and keeps `renewedAt`; both return `deferred` when the
  compare-and-swap keeps failing (a test lock wrapper pushes an unrelated ledger commit before every push).
- [x] 4.10 (C) (required, scenario "Takeover refused when the stale claim changed") `takeOver` with a snapshot whose
  claim differs from the observed stale claim makes no commit and returns false.
- [x] 4.11 (C) (required, scenario "Configured lease sets the interval") With `leaseSeconds` 300 the fake timer is
  started with 100000 ms and the acquired claim records `leaseSeconds` 300 and `renewedAt` equal to `claimedAt`.

### Grade B

- [x] 4.12 (B) (required, scenario "Renewal during long work") Renewal during long work, with the session lasting
  longer than the default lease of 1800 s: the scripted implementation session, four times, advances the fake clock by
  600 s and invokes the fake timer callback, then reports, so the last tick happens 2400 s after `claimedAt` (past
  `claimedAt + 1800 s`). The timer interval is 600000; after each tick the ledger claim has `renewedAt` equal to that
  fake time and `leaseSeconds` 1800, and `claimStale(claim, now)` is false at each tick, including the last one at
  `claimedAt + 2400 s`. As a control at that last tick, the same claim with `renewedAt` reset to its `claimedAt`
  (what it would be without renewal) gives `claimStale` true, so the assertion distinguishes renewal from no renewal.
  The task is accepted and the timer was stopped.
- [x] 4.13 (B) (required, scenarios "Stale claim ignored", "Claim at its lease is not stale", "Legacy claim without
  renewal data") Runner-level staleness, each case a separate run on a fresh fixture with leaf `B` and a foreign
  claim of `B` by invocation `zero`:
  - non-legacy claim with `leaseSeconds` 1800 and `renewedAt` exactly 1800 s before the fake time (sleep aborting the
    wait): `B` is not started, its unfinished explanation is `waiting-for-claim` naming `zero`'s host, `B` is listed
    in `claimedElsewhere` and named in the wait step line, and the ledger claim still names `zero`;
  - non-legacy claim with `leaseSeconds` 1800 and `renewedAt` 1801 s before the fake time: `B` is chosen as free work
    and taken over, it is never explained as `waiting-for-claim`, it is absent from `claimedElsewhere` and from every
    wait step line, a session prompt for `B` is received, and the task is accepted;
  - legacy claim (no `renewedAt`, no `leaseSeconds`) with `claimedAt` 1000 s before the fake time: `B` is
    `waiting-for-claim`;
  - legacy claim with `claimedAt` 1801 s before: the runner takes over and accepts `B`, and the new claim names its
    claimant with `renewedAt` and `leaseSeconds`.
- [x] 4.14 (B) (required, scenario "Blocked claim older than its lease is not taken over") Invocation `one` blocks
  `B` (a failing session); its ledger claim has `blocked`. Invocation `two` with leaf `B` and a fake clock 10 leases
  later (sleep aborting the wait) does not start `B`, explains it `waiting-for-claim`, and the claim still names
  `one`.
- [x] 4.15 (B) (required, scenario "Own invocation resumes a blocked claim") Restarting `one` after 4.14's block clears
  `blocked` and writes a new `renewedAt` before the first session prompt is received.

### Grade A

- [x] 4.16 (A) (required, scenario "Exactly one of two competing runners takes over") Takeover by exactly one of two
  runners: a stale claim of `B` by invocation `zero`; invocations `one` and `two` run concurrently over the same
  fixture (or `two`'s takeover is driven from `one`'s `afterEffect`/lock wrapper after both pulled the same
  snapshot); exactly one takeover push succeeds, the ledger names one winner, the loser never receives a session prompt
  for `B`, the losing run's unfinished explanation for `B` is `waiting-for-claim` and names the winning claimant's
  host, and `B` is merged exactly once.
- [x] 4.17 (A) (required, scenario "claim-lost stops the previous holder before merge") `one` reaches the merge stage;
  the scripted host's `eligibility` (or `afterEffect('pr')`) takes over `B`'s claim with another claimant; `one`
  issues no `host.merge` call, records `B` blocked with `claim-lost` in `state.json`, the run's blocker reason is
  `claim-lost`, and the ledger claim stays the taker's.
- [x] 4.18 (A) (required, scenario "Lost claim noticed by renewal before the push") During the implementation session
  the claim is replaced by another claimant and the fake timer ticks; the timer is stopped, no task branch exists on
  origin, the host's `create` is never called and `B` is blocked with `claim-lost`.
- [ ] 4.19 (A) (coverage-only) A restart of `one` after 4.17 while the taker's claim is fresh blocks `B` with
  `claim-lost` again without a session; after the taker's task is accepted on the target, the restart moves the work
  to `state.claimLost` and records no acceptance of `B` for `one`. not needed: coverage reached

## 5. Verification after binding

- [x] 5.1 Run `npm run typecheck`.
- [x] 5.2 Run `npm test` with the coverage gate at 85%.
