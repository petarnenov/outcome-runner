# Design: claim leases

## Context

The claims ledger (`src/claims.ts`) is a branch `work-queue-claims-<target>` with one `<id>.json` file per claim. Every
change is one commit pushed with a plain (non-force) push, which is the compare-and-swap: a push on top of a ledger
head that moved is rejected and `acquire`/`release` return false. The runner (`src/runner.ts`) pulls the ledger when it
chooses work; `foreignClaimsOf` lists claims of other claimants whose task is not done, and those tasks are skipped and
explained as `waiting-for-claim`. Claims are removed only by `disposeInvocation` (`src/dispose.ts`). Nothing ever
expires, so a crashed or abandoned runner freezes its task.

## Goals / Non-Goals

Goals: a lease with periodic renewal, safe takeover of stale claims by exactly one runner, durable blocked claims that
never expire, detection of a lost claim before any push or merge, compatibility with claims of earlier runners.

Non-goals: aborting a harness session in flight when the claim is lost (the loss is acted upon before the next effect
on the target or the pull request); changing dispose; changing how other runners wait for a foreign blocked claim (they
keep waiting for it as `waiting-for-claim`, as the existing "Claim released by dispose" scenario requires).

## Decisions

### 1. Claim record

The record keeps `version: 1` (earlier runners validate only the required fields, so they still read new records) and
gains optional fields:

- `renewedAt?: string` — ISO time of the last renewal; a new claim sets it equal to `claimedAt`.
- `leaseSeconds?: number` — the lease of the holder, written on every acquire, takeover and renewal.
- `blocked?: { at: string }` — present while the task is blocked in the holder's invocation.

`assertClaim` additionally rejects a present `renewedAt` that is not a string, a present `leaseSeconds` that is not a
positive safe integer and a present `blocked` that is not an object with a string `at`.

### 2. Staleness

`claimStale(claim, nowMs)` in `src/claims.ts`:

- a claim with `blocked` is never stale;
- the renewal time is `renewedAt`, or `claimedAt` for a claim without `renewedAt` (a legacy claim);
- the lease is the claim's own `leaseSeconds`, or `DEFAULT_LEASE_SECONDS` (1800) when absent — the holder's lease
  decides, not the observer's;
- a claim without a parseable renewal time is never stale (conservative);
- otherwise the claim is stale when `nowMs - Date.parse(renewal) > lease * 1000` (strictly older than its lease).

`foreignClaimsOf(snapshot, done, claimant, nowMs?)` gains an optional time: when given, stale claims are omitted. The
runner always passes `now()`, so task selection, the `claimed-elsewhere` statistics decision, `explainUnfinished`,
`waitMessage` and `claimedElsewhere` all ignore stale claims.

### 3. Ledger operations

- `commitClaim` replaces an existing `<id>.json` tree entry instead of appending a duplicate.
- `takeOver(snapshot, stale, claim, message)`: refuses (returns false without a commit) unless
  `snapshot.claims.get(claim.id)` is deep-equal to `stale`; otherwise commits the new claim on top of `snapshot.head`
  and pushes with the compare-and-swap. Two runners that both read the same stale claim build commits on the same
  head, so only the first push succeeds; the other gets false, pulls again and now sees a fresh claim.
- `renew(id, claimant, branch, at, leaseSeconds, message)`: up to 5 tries of pull, check, commit and compare-and-swap
  push. It returns `lost` when the ledger has no claim of `id` or its `claimant` or `branch` differ, `renewed` after a
  successful push (the new record has `renewedAt: at`, `leaseSeconds` and no `blocked`), and `deferred` when every
  try lost the compare-and-swap to unrelated ledger commits.
- `markBlocked(id, claimant, branch, at, message)`: the same loop, writing `blocked: { at }` and keeping
  `renewedAt`; returns `blocked`, `lost` or `deferred`.

All ledger operations run under the existing Git lock wrapper.

### 4. `leaseSeconds`

`RunConfig.leaseSeconds?: number`, `DEFAULT_LEASE_SECONDS = 1800` and `resolveLeaseSeconds(value)` in `src/model.ts`,
modelled on `resolvePollSeconds`: anything but a safe integer from 300 through 86400 throws with `reason`
`invalid-lease-seconds` and `details: { setting: 'leaseSeconds', value }`. `runSteps` resolves it directly after
`pollSeconds`, before the preflight, lock, state, ownership file, claim or worktree, and `validateConfig` calls it.
The CLI maps the reason to exit code 4 like `invalid-poll-seconds` (the work session adds it to any reason list the
CLI keeps). `leaseSeconds` is operational and never enters the invocation identity.

### 5. Holding a claim: acquire, resume, takeover

When choosing work, for the first free candidate (stale foreign claims are not "foreign" any more):

- an own claim in the snapshot is reused, as today;
- a stale foreign claim is taken over with `takeOver`;
- no claim: `acquire` as today.

The new record has `claimedAt = renewedAt = now()`, `leaseSeconds` of this run and no `blocked`. A lost
compare-and-swap continues the loop (pull again), as today.

At the start of the task block, for new and resumed work alike, `holdClaim(work)` makes sure the claim is this
runner's before anything else happens: an own claim is renewed (which also clears a `blocked` mark, so a resumed
blocked task gets a lease again); an absent claim is acquired with the compare-and-swap; a stale foreign claim is taken
over; a fresh or blocked foreign claim throws `ClaimLost`. Only then is the renewal timer started.

### 6. Renewal timer

`RunOptions.leaseTimer?: (renew: () => void, intervalMs: number) => () => void` starts a periodic callback and returns
its stop function; the default uses `setInterval` (unref'd) and `clearInterval`. The interval is
`Math.floor(leaseSeconds * 1000 / 3)`, so with the default lease a renewal happens every 600000 ms. The callback calls
`ledger.renew` with `new Date(now()).toISOString()`; `lost` sets the run-local flag `claimLost` and stops the timer;
`deferred` and thrown errors write the step line `lease: renewal failed; retrying` and wait for the next tick. The
timer is stopped when the task is accepted, blocked, cancelled or lost, and in the run's `finally`. Tests pass a fake
timer that records `intervalMs` and invoke `renew` after advancing the fake `now`.

### 7. Claim check before effects on the target or the pull request

`assertClaimHeld(work)` throws `ClaimLost` when `claimLost` is set, or after a ledger pull when the claim of
`work.id` is absent or its `claimant` or `branch` differ. It is called immediately before the push of the tested head
(publish stage), before `host.create` (pr stage), before the merge loop of the merge stage, inside the merge `guard`
(so a host that waits calls it right before its merge command) and immediately before `host.merge` for hosts without a
guard call. No push, pull request creation or merge happens after a failed check.

### 8. `claim-lost`

`ClaimLost` (message `claim-lost`) is handled in the task catch block: the work is recorded as blocked with reason
`claim-lost` and `claimLostAt` on the blocked work, the timer is stopped, the claim is not marked blocked (it is not
this runner's), the `blocked` step line and event are written. `explainUnfinished` reports reason `claim-lost` (kind
`blocked`) instead of `operation-incomplete`. On a later start the blocked work is recovered as usual and passes
`holdClaim`: it continues only when the claim is absent or stale again; otherwise it is blocked with `claim-lost` again
before any effect. Recovered work with `claimLostAt` whose task is already accepted on the target is not recorded as
an acceptance of this invocation: it is moved to `state.claimLost[id]` and removed from `current`.

### 9. Blocked claims

After a task is recorded as blocked (any reason except `claim-lost`, cancellation and a task already accepted on the
target), the runner stops the renewal timer and calls `ledger.markBlocked` before the loop continues. A `lost` or
`deferred` result or an error writes the step line `claim: could not mark the claim blocked` and never changes the
result. A blocked claim is never stale and therefore never taken over. It is continued only by its own invocation
(`holdClaim` renews it and clears the mark) or released by dispose, which removes own claims unchanged.

### 10. Legacy claims

A claim without `renewedAt` is renewed at `claimedAt`; without `leaseSeconds` it has the default lease. An own legacy
claim is upgraded on its first renewal.

## Risks / Trade-offs

- Each renewal is one ledger commit (every 10 minutes by default); the ledger history grows accordingly.
- Clock skew between hosts shortens or extends the effective lease; the 300 second minimum keeps skew small relative
  to the lease.
- A renewal runs Git synchronously under the Git lock and may block the event loop briefly during a session.
- A holder whose renewals keep failing (network) can lose its claim to a takeover; it then stops with `claim-lost`
  before any push or merge, so no task is merged twice.
- If marking a claim blocked fails, the claim can expire and be taken over; that is the safe direction (the task is
  worked again rather than frozen).
