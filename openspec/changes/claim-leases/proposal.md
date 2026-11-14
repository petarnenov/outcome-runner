# Claim leases

## Why

A claim in the claims ledger currently lives until its task is accepted or the invocation is disposed. A runner that
crashes, is cancelled or is abandoned therefore freezes the task for every other runner forever: they see a foreign
claim, explain the task as `waiting-for-claim` and wait. At the same time a task that blocks for a lasting reason must
keep its claim, so that other runners do not start it again one after another.

## What Changes

- Claims get a lease. The holder renews its claim in the ledger at least every `leaseSeconds / 3` while it works the
  task. `leaseSeconds` is a new operational invocation setting: an integer from 300 through 86400, 1800 when omitted,
  outside the invocation identity; an invalid value is refused at startup with exit code 4 and reason
  `invalid-lease-seconds`.
- A claim whose last renewal is older than its lease is stale. Other runners ignore stale claims when choosing free
  work and when explaining blockers, and may take over the task with a compare-and-swap ledger update that only
  succeeds while the stale claim is still the current ledger state, so exactly one of several competing runners wins.
- When a task blocks, its holder marks the claim as blocked in the ledger. A blocked claim never expires and is never
  taken over; only its own invocation continues it (the mark is cleared when it resumes) or dispose releases it.
- A runner whose claim was taken over notices it before its next effect on the target or the pull request (push,
  pull request creation, merge), stops the task without pushing or merging and records the blocked reason
  `claim-lost`.
- Claims written by earlier runner versions (no `renewedAt`, no `leaseSeconds`) are treated as renewed at
  `claimedAt` with the default lease.
- README documents claim leases, renewal, takeover, blocked claims, `claim-lost` and `leaseSeconds`.

## Capabilities

### New Capabilities

- `claim-leases`: lease, renewal, staleness, takeover, blocked claims, claim loss and the `leaseSeconds` setting.

### Modified Capabilities

- None. The claims ledger branch, claim file layout and `version: 1` records stay compatible; new fields are
  optional.

## Impact

- `src/claims.ts`: optional claim fields `renewedAt`, `leaseSeconds`, `blocked`; staleness helper; replace-in-place
  commits; `renew`, `markBlocked` and `takeOver` operations with the existing compare-and-swap push.
- `src/model.ts`: `RunConfig.leaseSeconds`, `DEFAULT_LEASE_SECONDS`, `resolveLeaseSeconds`, validation.
- `src/runner.ts`: lease renewal timer, takeover during selection, claim checks before push, pull request creation
  and merge, blocked marking, `claim-lost` handling and blocker explanation, `RunOptions.leaseTimer`.
- `test/`: new `test/claim-leases.test.ts` with scripted adapters, a fake clock and Git fixtures.
- `README.md`: new "Claim leases" section.
