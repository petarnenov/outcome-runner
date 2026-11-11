# pull-request-merge Specification

## Purpose
Merge task pull requests reliably when GitHub briefly reports a stale head after a push.

## Requirements

### Requirement: Bound stale-head polling by authoritative origin identity

The runner merge stage and GitHubHost.merge SHALL tolerate a mismatched PR head only while a direct `git ls-remote origin refs/heads/<branch>` read confirms the recorded tested or expected head. Each mismatched view SHALL require a fresh origin-ref check.

#### Scenario: Runner sees several previous-head views

- **WHEN** the runner's recorded tested head is H, origin's task branch is H, and PR views report a previous head several times before reporting H within the limit
- **THEN** the runner rereads at the mergeability polling interval and merges H without blocking or restarting
- **AND** it uses the fresh matching PR view

### Requirement: Reject unconfirmed origin identity

A different or missing origin branch ref SHALL block with `Checked head or target changed` without merging. Failure to read origin SHALL prevent merging and retain private failure diagnostics.

#### Scenario: Origin was moved by someone else

- **WHEN** a PR view differs from recorded head H and origin's task branch resolves to another head
- **THEN** the task is blocked with `Checked head or target changed` immediately
- **AND** nothing is merged

#### Scenario: Origin moves during the wait

- **WHEN** an initial stale PR view is eligible for polling but a later stale view finds origin's task branch at another head
- **THEN** polling stops with `Checked head or target changed`
- **AND** nothing is merged

#### Scenario: Authoritative ref is unavailable

- **WHEN** origin does not expose the requested branch or the direct remote read fails while the PR head is mismatched
- **THEN** the runner does not merge or assume that the mismatch is stale
- **AND** a missing ref produces `Checked head or target changed` while a read failure retains private failure diagnostics

### Requirement: Bound stale-head views and polling cadence

Stale-head polling SHALL use the existing mergeability wait interval and total view limit: 3 seconds and 100 views by default, counting the first view. A mismatched head after the final allowed view SHALL block with `Checked head or target changed` without merging. Polling SHALL request no extra view or delay after exhaustion.

#### Scenario: Head converges on the final allowed view

- **WHEN** origin remains at H and the PR first reports H on view 100 with default settings
- **THEN** head identity is accepted without requesting view 101
- **AND** the remaining merge guards determine eligibility

#### Scenario: Stale head exhausts the view budget

- **WHEN** origin's task branch remains at H but all 100 default PR views report another head
- **THEN** the task is blocked with `Checked head or target changed`
- **AND** no further view or merge is requested

### Requirement: Survive target integration followed by stale PR metadata

When an unrelated target advance during the merge stage invokes the existing integration and publish path, the runner SHALL apply bounded stale-head polling to the resulting newly recorded tested head and SHALL complete the merge in the same invocation when metadata converges and all existing guards pass.

#### Scenario: Complete target-advance race

- **WHEN** a task reaches merge, the target advances outside its scope, the runner integrates and checks that target and pushes a new recorded head H, and GitHub initially continues reporting the pre-push head
- **THEN** the runner waits while origin's task branch equals H
- **AND** once a PR view reports H within budget it merges H without blocking or creating a second PR

### Requirement: GitHubHost settles head identity and mergeability together

GitHubHost.merge SHALL apply the same origin-confirmed stale-head rule to its settled merge view using the expected head argument and the actual PR head branch. Stale-head and UNKNOWN-mergeability polling SHALL share one total view budget per settled-view call. A mismatched origin head or exhausted stale PR head SHALL fail with `Checked head or target changed` before a merge command.

#### Scenario: Host waits for stale metadata despite CLEAN status

- **WHEN** GitHubHost.merge expects H, origin's branch equals H, and CLEAN PR views report a previous head several times before reporting H
- **THEN** the host continues polling until the head matches within budget
- **AND** an otherwise eligible PR is merged with `--match-head-commit H`

#### Scenario: Host rejects foreign origin movement

- **WHEN** GitHubHost.merge sees a mismatched PR head and the initial or a later origin read reports a different branch head
- **THEN** it fails with `Checked head or target changed`
- **AND** no gh merge command is issued

#### Scenario: Host exhausts stale-head views

- **WHEN** origin remains at H but the host's settled PR views report another head throughout the limit
- **THEN** it fails with `Checked head or target changed`
- **AND** no gh merge command is issued

#### Scenario: UNKNOWN and stale metadata share a budget

- **WHEN** the host sees a mixture of stale-head and UNKNOWN-mergeability views
- **THEN** it counts all views toward one limit without resetting on head convergence
- **AND** it merges only if the head matches and all merge protections pass within that limit

### Requirement: Preserve merge guards and observation-only waiting

The local HEAD check and merge command with `--match-head-commit <recorded head>` SHALL remain in force. Existing target validation and integration, missing/closed PR handling, receipt validation, OPEN/base/CLEAN/non-draft protections and mergeability waiting SHALL remain effective. Polling SHALL rerun no checks and create no commit, push or pull request.

#### Scenario: Local HEAD changed

- **WHEN** local HEAD differs from the recorded tested head even though origin and the PR can report that tested head
- **THEN** the runner blocks with `Checked head or target changed` without merging

#### Scenario: Target advances while observing stale metadata

- **WHEN** the tested target changes before the runner can merge a converged head
- **THEN** the existing target integration and publish path applies before a merge can proceed

#### Scenario: PR protection denies a matching head

- **WHEN** the head matches but the PR fails an existing state, base, mergeability or draft guard
- **THEN** the host refuses the merge without bypassing protections
- **AND** a matching head with a settled BLOCKED status is rejected without polling for that status to change

#### Scenario: Wait creates no additional effects

- **WHEN** a stale-head wait takes several views
- **THEN** the wait performs only PR reads, origin branch reads and polling delays
- **AND** check, commit, push and PR-creation counts do not increase during that wait

### Requirement: Verify the race without real-time waits

Automated tests SHALL use scripted hosts and Git fixtures to cover stale-head convergence, the full target-advance race, foreign origin movement and exhaustion in the runner, and corresponding direct GitHubHost.merge cases. Polling tests SHALL use fake or no-op delays rather than waiting in real time. `npm run typecheck` and `npm test` SHALL pass after implementation.

#### Scenario: Deterministic regression suite

- **WHEN** the bound implementation is verified
- **THEN** scripted responses and Git origins demonstrate successful merges only for the expected head and no merges on foreign movement or exhaustion
- **AND** tests assert view counts, guarded merge arguments, no added wait effects and the 3-second configured cadence without real-time sleeps
- **AND** npm run typecheck and npm test pass
