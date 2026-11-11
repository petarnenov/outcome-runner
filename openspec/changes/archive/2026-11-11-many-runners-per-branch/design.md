# Design: many runners per branch

## Context

`runQueue` (src/runner.ts) opens `<dirname(primary)>/.work-queue-locks/<hash(primary)>.sqlite`, runs
`BEGIN EXCLUSIVE` with `busy_timeout=0` and keeps it for the whole run. It also writes
`<hash(primary)>-owner.json`; while that file is not `released`, any invocation with another identity or state
directory is refused. `resolveRunPaths` (src/run-paths.ts) derives `root` and `stateDirectory` but takes
`project.target` from the invocation file, and `validateConfig` (src/model.ts) requires
`authority.target === project.target` and accepts only targets matching `/^[A-Za-z0-9][A-Za-z0-9/_-]*$/` without
`..` or a trailing `/`; `openspecPreflight` (src/openspec-preflight.ts) repeats that rule.
Task worktrees live under `<primary>-outcomes/<operation>` on branch `outcome/<id>-<operation[0..12]>`, where
`operation` hashes the invocation name, so different invocations never share a worktree or task branch. The claims
ledger (`src/claims.ts`) already serializes task ownership across runners through a compare-and-swap push of
`work-queue-claims-<target>`, with a claimant UUID stored per invocation state.

In interactive mode two startup preflights currently write into the start checkout `root`:
`openspecPreflight` writes `openspec/config.yaml` and the `.gitkeep` files of the changes and receipts directories,
and `testFrameworkPreflight` (src/test-framework-preflight.ts) runs the recommended install commands with
`cwd = root` and writes the recommended files to `join(root, change.path)`. Both then exit with a refusal asking the
user to commit and push.

## Goals / Non-Goals

Goals: several invocations in one clone on one branch at the same time; target = start branch; no Git lock-file
failures between runners; tidy worktrees and branches after acceptance; the start checkout is never changed,
including by the interactive setup preflights.

Non-goals: changing the claims ledger format, taking over foreign claims, cleaning up tasks of other invocations,
removing remote branches of unfinished or blocked tasks, committing or pushing interactive setup changes for the user.

## Decisions

### 1. Target resolution in `resolveRunPaths`

A new helper `resolveRunTarget(root, config)` runs from `resolveRunPaths` (the production entry point used by
`main`) after `root` is known and before the configuration is returned, so the result enters `hash(config)` and
therefore the frozen invocation identity (state compatibility, ownership identity, statistics).

1. `git symbolic-ref --quiet --short HEAD` in the start directory. A failure (detached HEAD) throws an error with
   `reason: 'detached-head'`.
2. If `project.target` or `authority.target` is given and differs from the current branch, throw with
   `reason: 'target-differs-from-current-branch'`. Omitted fields are set to the current branch.
3. `git ls-remote --exit-code origin refs/heads/<branch>`; no matching row throws with
   `reason: 'target-missing-on-origin'`.

The errors carry `reason`, so the existing `reportFailure` in src/cli.ts prints
`{"status":"unavailable","reason":...,"diagnostics":...}` and returns exit code 4. Resolution is the first startup
step and precedes the OpenSpec preflight (which already fetches `origin <target>`). `runQueue` itself keeps trusting
the resolved configuration so direct test callers with fixture roots keep working; the invariant is established by
the entry point.

The receipt gains `target: project.target`. `receiptAt` accepts receipts without `target` (earlier receipts) and
requires a nonempty string when present; it does not compare the value with the current target, because a feature
branch with receipts may later be merged into another branch.

Pull requests already use `--base project.target`, so a run started from a feature branch opens and merges its pull
requests against that branch, and the claims branch becomes `work-queue-claims-<feature>`.

### 2. Target names: every valid Git branch name is accepted

Because the target is now whatever branch is checked out, the old target rule
(`/^[A-Za-z0-9][A-Za-z0-9/_-]*$/`) would reject ordinary branches such as `release/1.2` or `fix/v2.0` with the
unrelated message `Invalid OFF configuration or authority`. The rule is widened instead of adding a refusal:

- A new pure function `validBranchName(name)` in src/model.ts implements the rules of
  `git check-ref-format --branch` for a plain branch name: nonempty; no component beginning with `.` or ending with
  `.lock`; no `..`, `@{`, `//`; no ASCII control character, space, `~`, `^`, `:`, `?`, `*`, `[` or `\`; no leading
  `-` or `/`; no trailing `/` or `.`; not `@`. `validateConfig` and `openspecPreflight` use it in place of the
  regular expression (both stay synchronous and Git-free).
- `resolveRunTarget` additionally runs `git check-ref-format --branch <current branch>`. If Git rejects the name,
  or Git accepts it but `validBranchName` does not (a rule gap), it throws with `reason: 'unsupported-target-name'`
  (exit code 4). For a branch that Git itself checked out this is only a defensive guard; it is documented with the
  other refusal reasons.
- Every place that builds a ref or path from the target is checked to stay valid for such names: `origin/<target>`,
  `refs/heads/<target>`, `work-queue-claims-<target>` (a valid ref for any valid branch name) and any file name
  that embeds the target uses `digest(target)` or the existing safe encoding rather than the raw name.

### 3. Per-invocation lock and ownership

The invocation key is `hash(resolve(config.stateDirectory))` (the state directory already contains the clone and
invocation name). The run lock becomes `<lockRoot>/<hash(primary)>-<key>.sqlite` (still `busy_timeout=0`,
`BEGIN EXCLUSIVE` for the whole run), so a second process of the same invocation fails immediately with an error
carrying `reason: 'invocation-running'`. The ownership file becomes `<lockRoot>/<hash(primary)>-<key>-owner.json`
with the same `identity`/`stateDirectory`/`released` content; a mismatching unreleased identity is refused as
before. Ownership files of other invocations are never read or written, so one invocation cannot inherit or
override another's unfinished work. The old per-clone files are ignored (not deleted).

### 4. Per-clone Git lock

New helper `withGitLock<T>(primary, fn: () => T, { timeoutMs = 60000 } = {}): T` in `src/git-lock.ts`. It opens
`<lockRoot>/<hash(primary)>-git.sqlite`, sets `busy_timeout=<timeoutMs>`, runs `BEGIN EXCLUSIVE`, calls `fn`, then
`ROLLBACK` and closes in `finally`. SQLite file locks are released by the operating system when the holder exits or
crashes, so a killed runner never leaves the lock held. A wait longer than the timeout throws
`Git lock wait exceeded 60 seconds`; during a task this blocks the task (state kept, resumable), at startup it is a
startup failure. The wait is synchronous; it is bounded by 60 seconds and lock holders keep the lock only for one
group of Git commands, never during harness sessions, checks, prompts or install commands.

Groups run under the lock:
- `refresh` (fetch of the target and `rev-parse origin/<target>`);
- `ClaimLedger.pull` and `ClaimLedger.acquire` (ls-remote, fetch into the tracking ref, hash-object, mktree,
  commit-tree, push) — the ledger receives an optional `withLock` wrapper;
- worktree add with `-b`, worktree remove, worktree prune, local branch deletion;
- task branch push (`git push origin HEAD:refs/heads/<branch>`) and remote branch deletion;
- the target fetch and temporary worktree add/remove in the OpenSpec and test framework preflights, and the setup
  worktree add (decision 8).

Deadlock freedom rests on one invariant: **the Git lock is never held while waiting for the invocation lock** (nor
while waiting for anything else but the Git commands of its own group). Every `withGitLock` call returns, releasing
the Git lock, before the caller does anything else; in particular the preflights run before `runQueue` requests the
invocation lock, and their Git groups have already released the Git lock by then. A process may hold the invocation
lock while it waits for the Git lock, but the Git lock holder never waits for any invocation lock, so no wait cycle
can form. (The invocation lock itself is never waited for: it uses `busy_timeout=0`.)

Runner Git commands run with `-c gc.auto=0` (prepended in the shared `git` helper) so that an automatic
`gc`/`pack-refs` started by one runner cannot take `packed-refs.lock` while another runner fetches. Commits and
merges inside a task worktree touch only that worktree's index and its own branch ref and stay outside the lock.

### 5. Claims

Unchanged ledger and selection: each invocation state stores its own `claimant` UUID; foreign claims and scope
overlaps are skipped. Under the Git lock the ledger's compare-and-swap push still decides races between runners of
the same clone and of other machines.

### 6. Cleanup after acceptance

In the branch that records an accepted `current` task, after the completion is stored, the runner runs
`cleanupTask(work)` under the Git lock:
1. `git worktree remove --force <path>` when the path exists (then `worktree prune`);
2. `git branch -D <branch>` when `refs/heads/<branch>` exists;
3. `git push origin --delete <branch>` when `ls-remote` shows the remote branch (a branch already deleted by the
   host is not an error).
Each step is attempted independently; failed step names (`worktree`, `local-branch`, `remote-branch`) are stored
in the completed entry as `cleanup: { failed: [...] }` and the `accepted` event carries `cleanupFailed: [...]`
(omitted when everything succeeded). The result status, accepted list, exit code and receipt are unaffected.
Blocked and unfinished tasks are never cleaned up, so they resume in their worktree.

### 7. Leftover sweep on start

After the store is opened and before the main loop, for every entry in `store.state.completed` whose worktree
path or local branch still exists, the runner runs the worktree and local branch steps of `cleanupTask` under the
Git lock. Failures are recorded in the entry and never stop the run. Only tasks of this invocation's own state are
considered.

### 8. The start checkout is never modified, including by interactive setup

The runner only fetches into remote-tracking refs, writes objects, creates worktrees outside the checkout and
updates refs of task, setup and claims branches. It never runs checkout, reset, merge, add or commit in `root`, never
writes files below `root` and never runs install commands with `cwd = root`.

The interactive setup paths of the two preflights are moved out of the start checkout:

- A shared helper `setupWorktree(root, config)` (src/setup-worktree.ts) returns the path of a setup worktree
  `<primary>-outcomes/setup-<operation>` on local branch `outcome/setup-<operation[0..12]>`, where `operation` is
  derived from the invocation name exactly as for task worktrees. It is created from `origin/<target>` under the Git
  lock on first use and reused when it already exists. It is created only after the user has accepted a change, so
  declined or non-interactive runs create nothing.
- `openspecPreflight` writes `openspec/config.yaml` and the `.gitkeep` files into the setup worktree (existing files
  are still never overwritten). The global OpenSpec CLI install (`npm install -g ...`) does not write a project file
  and runs with `cwd` set to the operating system temporary directory instead of `root`.
- `testFrameworkPreflight` runs the chosen install commands with `cwd` = setup worktree, writes the chosen files
  there, checks `refusedChange` against the setup worktree and takes the before/after `snapshot` there.
- Both still exit with their existing refusal reasons (`openspec-layout-created`, `test-framework-prepared`,
  `test-framework-missing`); the message and `details` now name the setup worktree path and branch and tell the user
  to commit there, push the branch and merge it into `<target>`, then run again. The setup worktree and branch are
  kept (they hold the user's changes) and are not touched by task cleanup or the leftover sweep.

Tests assert that HEAD, the current branch, the index and `git status --porcelain` of the start checkout are
unchanged after a run that accepts a task and after each accepted interactive setup.

## Risks / Trade-offs

- A synchronous 60-second wait blocks signal handling during the wait; acceptable because holders release within one
  Git group.
- `gc.auto=0` defers repository maintenance to the user; the README states this next to the Git lock text and tells
  users to run `git gc` or `git maintenance run` themselves (task 6.2).
- Older receipts lack `target`; tolerated by design.
- Interactive setup changes no longer appear in the user's checkout; the user must commit them from the setup
  worktree. The messages name its path and branch, and the README describes it.
- `validBranchName` duplicates Git's rules; `resolveRunTarget` cross-checks it with `git check-ref-format` so a gap
  is reported as `unsupported-target-name` rather than failing later.

## Migration

Existing per-clone ownership files are ignored. A resumed invocation keeps its state when its resolved target equals
the previously given `project.target`; starting it from another branch changes the identity and is refused as an
incompatible state, as for any other configuration change.
