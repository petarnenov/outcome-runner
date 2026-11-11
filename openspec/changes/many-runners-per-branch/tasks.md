# Tasks

## 1. Target resolution

- [ ] 1.1 Add `resolveRunTarget` (current branch via `git symbolic-ref --quiet --short HEAD`, mismatch check against
  given `project.target`/`authority.target`, `git ls-remote --exit-code origin refs/heads/<branch>`) with errors
  carrying `reason` `detached-head`, `target-differs-from-current-branch` or `target-missing-on-origin`.
- [ ] 1.2 Call it from `resolveRunPaths` so omitted targets are filled before hashing and the resolved target is in
  the frozen invocation identity; refusals reach `reportFailure` (exit 4, diagnostics reason). It is the first
  startup step, before the OpenSpec preflight.
- [ ] 1.3 Add `target` to the `Receipt` interface and to written receipts; `receiptAt` accepts receipts without it
  and requires a nonempty string when present.

## 2. Target names

- [ ] 2.1 Add `validBranchName(name)` to src/model.ts implementing the `git check-ref-format --branch` rules for a
  plain branch name (design decision 2) and use it in `validateConfig` and `openspecPreflight` instead of
  `/^[A-Za-z0-9][A-Za-z0-9/_-]*$/`, so names such as `release/1.2` and `fix/v2.0` are accepted.
- [ ] 2.2 In `resolveRunTarget`, run `git check-ref-format --branch <branch>` and refuse with exit 4 and reason
  `unsupported-target-name` when Git rejects the name or `validBranchName` disagrees with Git.
- [ ] 2.3 Audit every ref and file name built from the target (`origin/<target>`, `refs/heads/<target>`,
  `work-queue-claims-<target>`, state, statistics or lock file names) and make file names that embed it use a
  digest or the existing safe encoding.

## 3. Per-invocation lock and ownership

- [ ] 3.1 Replace `<hash(primary)>.sqlite` with `<hash(primary)>-<hash(stateDirectory)>.sqlite` (`busy_timeout=0`,
  whole run) and refuse a second process with reason `invocation-running`.
- [ ] 3.2 Replace the per-clone ownership file with `<hash(primary)>-<hash(stateDirectory)>-owner.json`; keep the
  identity check and `released` handling per invocation; never read other invocations' files.

## 4. Per-clone Git lock

- [ ] 4.1 Add `src/git-lock.ts` with `withGitLock(primary, fn, { timeoutMs = 60000 })` over
  `<hash(primary)>-git.sqlite`, `BEGIN EXCLUSIVE`, rollback and close in `finally`, timeout error
  `Git lock wait exceeded 60 seconds`.
- [ ] 4.2 Wrap `refresh`, worktree add/remove/prune, local branch deletion, task branch push, remote branch deletion
  and the ledger's `pull`/`acquire` (optional lock wrapper in `ClaimLedger`) in the Git lock.
- [ ] 4.3 Run the preflights' target fetch, temporary worktree add/remove and the setup worktree add under the Git
  lock, each as its own `withGitLock` call that returns before any prompt, harness session or install command, so
  the Git lock is released before `runQueue` requests the invocation lock (design decision 4 invariant).
- [ ] 4.4 Prepend `-c gc.auto=0` to runner Git commands.

## 5. Start checkout unchanged and cleanup

- [ ] 5.1 Add `setupWorktree(root, config)` (src/setup-worktree.ts): `<primary>-outcomes/setup-<operation>` on
  `outcome/setup-<operation[0..12]>` from `origin/<target>`, created under the Git lock on first accepted change and
  reused when present; never touched by task cleanup or the leftover sweep.
- [ ] 5.2 `openspecPreflight`: write `openspec/config.yaml` and the `.gitkeep` files into the setup worktree instead
  of `root`; run the global CLI install with `cwd` = operating system temporary directory; the message and details
  name the setup worktree path and branch and say to commit there, push and merge into `<target>`.
- [ ] 5.3 `testFrameworkPreflight`: run install commands with `cwd` = setup worktree, write files, check
  `refusedChange` and take snapshots there; messages and details name the setup worktree path and branch. Update
  the existing preflight tests that expected writes in `root`.
- [ ] 5.4 Add `cleanupTask` (worktree remove + prune, `branch -D`, remote `push --delete` when present), each step
  independent, under the Git lock; store failed steps in the completed entry and add `cleanupFailed` to the
  `accepted` event without changing the result.
- [ ] 5.5 Sweep leftover worktrees and local branches of this invocation's completed tasks on start, before task
  selection; failures are recorded and never stop the run.
- [ ] 5.6 Keep worktrees and branches of blocked and unfinished tasks.

## 6. README

- [ ] 6.1 Replace "Give each machine its own clone" (How it works) with running many runners on one branch in one
  clone (one invocation name per runner, shared claims ledger, Git lock), explain that the target is the branch the
  runner starts from (omit or match `project.target`/`authority.target`; any valid Git branch name such as
  `release/1.2` works; the refusal reasons `detached-head`, `target-differs-from-current-branch`,
  `target-missing-on-origin` and `unsupported-target-name` in the exit code table), and describe worktree and branch
  cleanup, leftover removal on start and kept blocked worktrees.
- [ ] 6.2 In "How it works", replace the sentence "A local SQLite lock prevents simultaneous invocations in one
  clone" (in the paragraph before the replaced one) with: a per-invocation lock refuses a second process of the
  same invocation, different invocations of one clone run concurrently, and a per-clone Git lock (held for one
  group of Git operations, waited for up to 60 seconds, released when its holder exits or crashes) serializes their
  Git operations on the shared repository. Next to this Git lock text, state that runner Git commands run with
  `-c gc.auto=0` (automatic garbage collection is turned off for them so it cannot take ref lock files while
  another runner works) and that users must run `git gc` or `git maintenance run` themselves, for example while no
  runner is active. No README text may still say that one clone allows only one invocation.
- [ ] 6.3 Document start-branch target resolution (current branch, branch name check, `git ls-remote origin` check,
  the four refusal reasons) as the first startup step, before the OpenSpec preflight: change "Before anything else"
  for the OpenSpec preflight so it runs after target resolution, and make target resolution the first listed step
  in "Harness selection" and in "Start and resume".
- [ ] 6.4 In the OpenSpec and test framework preflight sections, replace "in the working tree" with the setup
  worktree (`<primary>-outcomes/setup-<operation>` on `outcome/setup-...`): the runner never changes the start
  checkout; commit in the setup worktree, push its branch and merge it into the target, then run again.

## 7. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Tests use scripted adapters, scripted pull
request hosts and Git fixtures (bare origin plus clones); concurrency tests use child processes
(`test/support/work-queue-child.ts` style).

### Grade E

- [ ] 7.1 (E) (required) `hash(config)` differs for configurations that differ only in the resolved target
  (target is part of the frozen identity).
- [ ] 7.2 (E) (required) `validBranchName` and `validateConfig` accept `main`, `release/1.2`, `fix/v2.0` and
  `feature/x`, and reject `-x`, `a..b`, `a/`, `a.lock`, `.a`, `a b`, `a@{b` and `@`.
- [ ] 7.3 (E) (coverage-only) Lock and ownership file names: same for the same invocation, different for different
  invocations of one clone.
- [ ] 7.4 (E) (coverage-only) `receiptAt` accepts a receipt without `target` and rejects an empty `target`.

### Grade D

- [ ] 7.5 (D) (required) Omitted `project.target` and `authority.target` resolve to the current branch of a Git
  fixture.
- [ ] 7.6 (D) (required) Target different from the current branch, covered as two separate cases: (a) only
  `project.target` given and differing, (b) only `authority.target` given and differing. In each case `main` exits
  4 with reason `target-differs-from-current-branch` in the output line and diagnostics file, and no invocation
  lock, worktree or claims-ledger claim is created.
- [ ] 7.7 (D) (required) Detached HEAD refused with exit 4 and reason `detached-head`.
- [ ] 7.8 (D) (required) Branch missing on origin refused with exit 4 and reason `target-missing-on-origin`.
- [ ] 7.9 (D) (required) Starting on branch `release/1.2` (present on origin) with omitted targets resolves the
  target to `release/1.2` and passes configuration validation and the OpenSpec preflight target check (no
  `Invalid OFF configuration or authority`).
- [ ] 7.10 (D) (required) With `git check-ref-format` stubbed to reject the current branch, the run is refused with
  exit 4 and reason `unsupported-target-name`.
- [ ] 7.11 (D) (coverage-only) Explicit targets equal to the current branch are accepted unchanged.

### Grade C

- [ ] 7.12 (C) (required) Interactive OpenSpec preflight with accepted layout creation writes
  `openspec/config.yaml` and the `.gitkeep` files into the setup worktree on `outcome/setup-...`; the start
  checkout's HEAD, branch, index and porcelain status are unchanged and no file was created under it; the message
  names the setup worktree; a declined prompt creates no setup worktree.
- [ ] 7.13 (C) (required) Interactive test framework preflight with an accepted recommendation runs the install
  command with `cwd` = setup worktree (recorded by the scripted `exec`) and writes the files there; the start
  checkout is unchanged; `changedFiles` and the message refer to the setup worktree; a second preflight reuses the
  existing setup worktree.
- [ ] 7.14 (C) (required) Concurrent fetch, worktree add/remove and branch create/delete from several child
  processes through `withGitLock` all succeed without Git lock-file errors.
- [ ] 7.15 (C) (required) A Git lock holder killed with SIGKILL releases the lock; the next acquirer does not wait
  for the timeout.
- [ ] 7.16 (C) (required) Git lock wait exceeds the limit: with the limit injected short (default 60 seconds
  asserted as the default `timeoutMs`), a waiter behind a held lock fails with `Git lock wait exceeded 60 seconds`
  and `fn` is never called.
- [ ] 7.17 (C) (required) A second process of the same invocation started while the first runs is refused at once
  with exit code 4 and diagnostics reason `invocation-running`; the first process continues unaffected and
  completes its run with its expected result.
- [ ] 7.18 (C) (required) A different invocation runs while another invocation's ownership is unreleased, and
  leaves that invocation's ownership file, state, worktrees, claims-ledger entries (same claimant, tasks and
  scopes) and its local and remote task branches (same names and commits) unchanged.
- [ ] 7.19 (C) (required) Leftover worktree and local branch of an already accepted task are removed on start, and
  removed before task selection: the test asserts that the leftover worktree directory and local branch are
  already gone when the first task is selected or claimed (observed from inside the scripted adapter's first call,
  and the sweep is recorded before the first selection/claim event in the run's event log). Other invocations',
  unfinished tasks' and the setup worktree stay.
- [ ] 7.20 (C) (required) A blocked task keeps its worktree, its local branch and its pushed remote branch on
  origin, and a restart resumes it there.

### Grade B

- [ ] 7.21 (B) (required) After merge and confirmed acceptance the task worktree, local branch and remote branch are
  removed; the accepted event has no `cleanupFailed`.
- [ ] 7.22 (B) (required) A cleanup failure (for example a failing remote delete) is reported in the accepted event
  `cleanupFailed` while status, accepted, remaining and exit code are unchanged.
- [ ] 7.23 (B) (required) A run started from a feature branch opens and merges its pull requests against that
  branch (scripted host records the base) and the receipt records `target` equal to it.
- [ ] 7.24 (B) (required) The start checkout's HEAD, branch, index and porcelain status are unchanged after a run
  that accepts a task, and the task was worked in a worktree outside the checkout: the scripted adapter records
  its working directory, and the test asserts that this path is under `<primary>-outcomes/`, is not the start
  checkout itself and is not inside the start checkout (its resolved real path does not start with the
  checkout's real path).

### Grade A

- [ ] 7.25 (A) (required) Two invocations run concurrently in one clone on one branch with scripted adapters,
  complete different tasks with distinct claimants and no overlapping-scope work at the same time, and both merge
  into the start branch.

## 8. Verification after binding

- [ ] 8.1 Run `npm run typecheck`.
- [ ] 8.2 Run `npm test` with the coverage gate at 85%.
