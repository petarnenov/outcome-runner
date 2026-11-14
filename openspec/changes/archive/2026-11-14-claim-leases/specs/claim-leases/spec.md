## ADDED Requirements

### Requirement: Claim renewal

A runner that holds a claim SHALL renew it in the claims ledger at least every `leaseSeconds / 3` while it works the
task, by writing `renewedAt` (the current time) and its `leaseSeconds` into the claim record. A new or taken-over claim
SHALL be written with `renewedAt` equal to `claimedAt`. Renewal SHALL stop when the task is accepted, blocked, cancelled
or its claim is lost.

#### Scenario: Renewal during long work

- **WHEN** a runner with the default lease works a task whose implementation session lasts longer than the lease, and
  the fake clock advances by 600 seconds before each tick of the renewal timer
- **THEN** the renewal timer was started with an interval of 600000 milliseconds, after each tick the ledger claim of
  the task has `renewedAt` equal to the fake time of that tick and `leaseSeconds` 1800, the claim is never stale for
  another runner during the session, and the task is accepted

#### Scenario: Configured lease sets the interval

- **WHEN** the invocation sets `leaseSeconds` to 300
- **THEN** the renewal timer is started with an interval of 100000 milliseconds and the claim records `leaseSeconds`
  300

### Requirement: leaseSeconds setting

`leaseSeconds` SHALL default to 1800 and SHALL be set by the invocation as an integer from 300 through 86400. An
invalid value SHALL be refused at startup, before any preflight, lock, state, ownership file, claim or worktree, with
exit code 4, reason `invalid-lease-seconds`, and diagnostics naming `leaseSeconds`. `leaseSeconds` SHALL NOT be part of
the invocation identity.

#### Scenario: Invalid leaseSeconds refused

- **WHEN** the invocation sets `leaseSeconds` to `299`, `86401`, `600.5` or `"1800"`
- **THEN** the run exits 4, the printed reason is `invalid-lease-seconds`, the diagnostics name `leaseSeconds`, and no
  `state.json`, claim or worktree is created

#### Scenario: Bounds accepted

- **WHEN** `resolveLeaseSeconds` is given `300`, `86400` or nothing
- **THEN** it returns `300`, `86400` and `1800`

#### Scenario: Lease outside the identity

- **WHEN** an invocation is resumed with a different valid `leaseSeconds`
- **THEN** its identity is unchanged and the run resumes

### Requirement: Stale claims

A claim that is not blocked and whose last renewal is older than its lease SHALL be stale. The last renewal SHALL be
`renewedAt`, and the lease SHALL be the claim's own `leaseSeconds`, or 1800 when the claim has none. Other runners SHALL
ignore stale claims when choosing free work and when explaining blockers (they are not `waiting-for-claim`, not listed
in `claimedElsewhere` and not named in the wait step line).

#### Scenario: Stale claim ignored

- **WHEN** another invocation's claim of task `B` was last renewed 1801 seconds ago with lease 1800
- **THEN** `B` is not explained as `waiting-for-claim` and is chosen as free work

#### Scenario: Claim at its lease is not stale

- **WHEN** another invocation's claim of task `B` was last renewed exactly 1800 seconds ago with lease 1800
- **THEN** `B` is explained as `waiting-for-claim`

### Requirement: Takeover of a stale claim

A runner MAY claim a task whose claim is stale with a ledger update that only succeeds if the stale claim is still the
current one, so that two runners never both win a takeover. A runner that loses the takeover SHALL pull the ledger
again and treat the new claim like any other claim.

#### Scenario: Exactly one of two competing runners takes over

- **WHEN** task `B` has a stale claim of invocation `zero`, and invocations `one` and `two` both read that ledger state
  and both attempt the takeover
- **THEN** exactly one takeover succeeds, the ledger claim of `B` names exactly one of their claimants, the other
  runner does not start `B` (it explains `B` as `waiting-for-claim` with the winner's host), and `B` is merged into
  the target exactly once

#### Scenario: Takeover refused when the stale claim changed

- **WHEN** a runner attempts a takeover with a snapshot whose claim of `B` differs from the stale claim it observed
- **THEN** no ledger commit is made and the takeover returns false

### Requirement: Blocked claims

When a task is blocked, the runner that holds its claim SHALL mark the claim as blocked in the ledger before
continuing. A blocked claim SHALL NOT expire and SHALL never be taken over. It SHALL be continued only by its own
invocation, which clears the blocked mark when it resumes the task, or released by dispose.

#### Scenario: Blocked claim older than its lease is not taken over

- **WHEN** invocation `one` blocks task `B` and its ledger claim has `blocked`, and invocation `two` with leaf `B`
  runs with a fake clock 10 lease lengths later
- **THEN** `two` does not take over or start `B`, explains `B` as `waiting-for-claim`, and the ledger claim of `B`
  still names `one`'s claimant

#### Scenario: Own invocation resumes a blocked claim

- **WHEN** invocation `one` restarts and resumes its blocked task `B`
- **THEN** the ledger claim of `B` no longer has `blocked` and has a new `renewedAt` before any session starts

### Requirement: Claim lost

A runner whose claim was taken over SHALL notice it before its next effect on the target or the pull request (pushing
the tested head, creating the pull request, merging), SHALL stop that task without pushing or merging, and SHALL record
the blocked reason `claim-lost`. A renewal that finds the claim held by another claimant SHALL stop renewing. The
unfinished explanation of such a task SHALL have reason `claim-lost`.

#### Scenario: claim-lost stops the previous holder before merge

- **WHEN** invocation `one` reaches the merge stage of task `B`, and before its merge another runner takes over `B`'s
  claim
- **THEN** `one` issues no merge command, the pull request stays unmerged by `one`, `one`'s `state.json` records `B`
  blocked with reason `claim-lost`, the run's blocker for `B` has reason `claim-lost`, and the ledger claim of `B` is
  unchanged by `one`

#### Scenario: Lost claim noticed by renewal before the push

- **WHEN** a renewal tick of invocation `one` finds `B`'s claim held by another claimant during the implementation
  session
- **THEN** the renewal timer is stopped, and `one` pushes no task branch, creates no pull request and blocks `B` with
  `claim-lost`

### Requirement: Legacy claims

Claims written by earlier runner versions without renewal data SHALL be treated as renewed at `claimedAt` with a lease
of 1800 seconds.

#### Scenario: Legacy claim without renewal data

- **WHEN** the ledger holds another claimant's claim of `B` written without `renewedAt` and `leaseSeconds`, with
  `claimedAt` 1000 seconds before the fake time
- **THEN** `B` is explained as `waiting-for-claim`; and when `claimedAt` is 1801 seconds before the fake time, `B` is
  taken over and accepted

#### Scenario: Legacy claim without a timestamp

- **WHEN** another claimant's claim has neither `renewedAt` nor a parseable `claimedAt`
- **THEN** it is never stale
