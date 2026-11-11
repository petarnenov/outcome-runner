# Design: Dispose of an invocation

## Context

- An invocation is identified by its resolved state directory
  (`$XDG_STATE_HOME/outcome-runner/<clone>/<invocation>`, `resolveRunPaths`). Its `state.json` (`RunStore`, version 2)
  holds `identity` (the configuration with `root`, `project`, `invocation`, `leaves`), `claimant`, `current`,
  `blocked`, `completed` and `status`; `lock.sqlite` beside it is held exclusively by a running process.
- `invocationLockFiles(primary, stateDirectory)` gives the per-invocation lock (`.sqlite`, held with
  `BEGIN EXCLUSIVE` for the whole run) and ownership file (`-owner.json`, `{ identity, stateDirectory, released }`),
  both in the `.work-queue-locks` directory beside the primary checkout.
- `ClaimLedger` stores one `<id>.json` claim per task on `work-queue-claims-<target>`; claims are written with a
  compare-and-swap push and are never removed today. A claim carries `claimant` (the invocation's
  `state.claimant`), `branch` and `scopes`.
- Task work (`Work`) records `path` (below `<primary>-outcomes`), `branch` (`outcome/<id>-<op>`) and, once
  published, `pr` (`PullRequest`: `number`, optional `url`, `state`, `branch`).
- `state.json` `status` is not always `released` when nothing is claimed: `finish` stores `incomplete` when the
  remaining tasks were never claimed (they waited on a foreign claim, a dependency or a blocked scope) and leaves the
  ownership file unreleased; it stores `blocked`/`incomplete` when the only blocked entry is a task already merged at
  `origin/<target>` whose acceptance recording failed; and a run that crashed after `store.update({ status:
  'running' })` and before claiming leaves `running`.

## Decisions

### 1. Command and entry points

- `src/dispose.ts` exports `disposeInvocation(config: RunConfig, options: DisposeOptions): Promise<DisposeSummary>`
  where `config` is already resolved (`root`, `stateDirectory`, `project.target`, as `resolveRunPaths` returns or as
  test fixtures build it) and `DisposeOptions` is `{ removeWork?: boolean; host?: PullRequestHost }` (the default host
  is `GitHubHost(root, project)`).
- `src/cli.ts` exports `dispose(path, output, { args, cwd, env, host })`: reads the invocation file, calls
  `resolveRunPaths(json, { cwd, env })`, accepts only `--remove-work` (at most once; any other argument is a startup
  failure), prints the summary as one JSON line and returns 0. Any thrown error is printed with the existing
  `reportFailure` (`{ status: 'unavailable', reason, diagnostics }`, its `reason` or `startup-or-run-failed`) and
  returns 4. Dispose plays no mascot and appends no statistics record (it is not a run).
- `run([command, ...rest], commands = { dispose })` gains an optional second parameter holding the dispose entry
  point (default: the exported `dispose`); `run(['dispose', file, ...flags])` calls
  `commands.dispose(file, undefined, { args: flags })`. The parameter exists only so a test can check the dispatch
  with a spy; `bin/outcome-runner.ts` keeps calling `run(argv)`.

### 2. Matching a known invocation state (refusal `unknown-invocation`)

The match is read-only and creates no file or directory: `<stateDirectory>/state.json` must exist (not a symlink),
parse as JSON with `version` 2, and have `identity.invocation === config.invocation`, `realpath(identity.root) ===
root` and `identity.project.target === config.project.target`. Otherwise dispose throws `reason: 'unknown-invocation'`
(exit 4). The frozen identity hash is not recomputed, because it includes the resolved harness selection; an
invocation whose file was edited after its run can therefore still be disposed.

### 3. Running process (refusal `invocation-running`)

After a successful match (decision 6 step 1), dispose opens the invocation lock file and
`<stateDirectory>/lock.sqlite` with `node:sqlite` and runs `PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;` on both (the
same locks a run holds). Only a lock that is already held (`SQLITE_BUSY` / `database is locked` from `BEGIN
EXCLUSIVE`) maps to `reason: 'invocation-running'` (exit 4); any other error while opening (for example a missing
directory) is rethrown unchanged and reported as `startup-or-run-failed`. Both locks are held until dispose finishes
and are closed in a `finally`, so a run started during dispose is refused by the existing `invocation-running` check.
A state left `running` by a crashed process holds no lock (the OS released it) and is disposed normally.

### 4. What is released

With `done` = task ids whose receipt is accepted at `origin/<target>` (the runner's `receiptAt` check with the
queue read at the fetched target; a claim whose task is not in the queue is unaccepted):

- Claims: ledger claims with `claimant === state.claimant` and id not in `done`. Claims of other claimants and
  claims of accepted tasks stay. Without a `claimant` there is nothing to release in the ledger.
- Unaccepted work: `state.current` and every `state.blocked[*].work` whose id is not in `done`, plus the branch
  of each released claim (its worktree path, when no state entry exists, is unknown and not listed). Entries
  already recorded in `state.disposed` are included again so a repeated dispose lists them.
- `state.completed`, receipts, accepted claims and merged pull requests are never read for changes or touched.

### 5. Claim release commit

`ClaimLedger.release(snapshot, ids, message): boolean` builds the ledger tree without `<id>.json` for `ids`
(`ls-tree`, `mktree`, `commit-tree` with the snapshot head as parent) and pushes it with the same compare-and-swap as
`acquire`; it returns false when the remote head moved. Dispose pulls, recomputes the claim set and retries up to 5
times, then throws. When `ids` is empty no commit is made. The single commit message is
`chore(<commitScope ?? 'work-queue'>): release claims of invocation <invocation><commitSuffix ?? ''>`. An emptied
ledger keeps an empty tree commit (the branch is not deleted).

### 6. Order of effects (idempotent)

1. Match, then lock, then match again, in exactly this order:
   a. Read-only match (decision 2). An unknown invocation is refused here, before any lock file is opened, so no
      state directory, `lock.sqlite`, invocation lock file or ownership file is created.
   b. Take both locks (decision 3). Only a lock that is already held yields `invocation-running`.
   c. Re-read and re-match `state.json` under the locks (a run may have finished or rewritten it in between); a
      mismatch now is `unknown-invocation`. The re-read state is the one used below.
2. Fetch the target and compute `done`, the owned claims to release and the unaccepted work (decision 4).
3. State record. `state.json` is written when either holds:
   - there is something to dispose: at least one owned unaccepted claim, or an unaccepted `current`/`blocked`
     entry not yet in `state.disposed`; or
   - `state.status` is not `released` (for example `incomplete` with tasks that were never claimed, `blocked` or
     `incomplete` whose only blocked entry is a task already merged at `origin/<target>`, or `running` left by a
     crash before claiming; see Context).

   The write is one atomic write (temp file + rename, like `RunStore.update`, incrementing `sequence`) that always
   sets `status: 'released'` and a `disposed: { at, tasks: { [id]: Work } }` record merged with an earlier record
   (`tasks` holds the newly disposed unaccepted work and may be empty, for example when no task was ever claimed).
   It also sets `current: null` when `current` is unaccepted and removes the disposed ids from `blocked`; entries
   whose id is in `done` stay as they are. Writing this before the claim release means a crash later still leaves a
   state the runner refuses (decision 8) and a repeated dispose that finishes the rest.
   When there is nothing to dispose and `status` is already `released` (a fully accepted invocation, or a repeated
   dispose), `state.json` is not written at all: it stays byte-for-byte unchanged and, for a fully accepted
   invocation, gets no `disposed` record. Every state dispose leaves behind therefore has `status` `released`, which
   is what the criterion "marks its state released" requires.
4. Release the claims (decision 5).
5. With `--remove-work`, remove each unaccepted work's worktree (only when within `<primary>-outcomes`; `git worktree
   remove --force`, then `worktree prune`), local branch (`branch -D`) and remote branch (`push origin --delete`),
   each step independently under the Git lock (`withGitLock`), recording failed steps; without it, only inspect which
   exist.
6. Ownership: when the ownership file exists, its `stateDirectory` equals `resolve(config.stateDirectory)` and it is
   not released, rewrite it with `released: true` (keeping other fields). Another stateDirectory's file is never
   written (it cannot be at this path, but the check guards it).

### 7. Summary

```json
{ "status": "disposed" | "nothing-to-release", "invocation": "<name>",
  "releasedClaims": ["<id>"], "ownership": "released" | "already-released" | "absent",
  "work": [{ "id": "<id>", "worktree": { "path": "...", "state": "kept" | "removed" | "absent" | "failed" },
    "localBranch": { "name": "...", "state": "..." }, "remoteBranch": { "name": "...", "state": "..." } }],
  "openPullRequests": [{ "id": "<id>", "number": 1, "url": "...", "branch": "...", "state": "OPEN" | "unknown" }] }
```

- `status` is `nothing-to-release` exactly when no claim was released, the ownership file was not changed and
  `state.json` was not written (decision 6 step 3, including a write made only to set `status: 'released'`);
  otherwise `disposed`. So an invocation that was `incomplete` with no claim and an unreleased ownership file is
  reported `disposed` with empty `releasedClaims`.
- `work` and `openPullRequests` are sorted by id. `url` is present only when known.
- Open pull requests: for each unaccepted work branch dispose calls `host.find(branch)`; a result with `state`
  `OPEN` is listed with `"state": "OPEN"`, any other result or `null` is not listed. When `find` throws for a
  branch, the work's recorded `work.pr` (if any) is listed with its `number`, `url` and branch and
  `"state": "unknown"`, whatever state was recorded, because dispose cannot tell whether it is still open; work
  without a recorded `pr` is not listed. A host failure is never fatal. Dispose never calls `merge` or `create`.

### 8. Disposed state is not resumed

In `runSteps`, right after the `RunStore` is opened and before the ownership file is written, a state with a
`disposed` record is refused with `reason: 'invocation-disposed'` (exit 4) and the store is closed.

Deliberate choice: every `state.json` that dispose writes carries a `disposed` record (decision 6 step 3), including
a write made only to set `status: 'released'` with an empty `tasks` map. A state with `status` `released` and no
`disposed` record therefore only exists when dispose did not write it at all, which happens only when it was already
`released` with nothing to dispose: a fully accepted invocation. Such a state may be run again exactly as before this
change (it has no unaccepted work to pick up), so the fully accepted case stays byte-for-byte unchanged. Any state
dispose changed, including an `incomplete`, `blocked` or crashed `running` state without claims, is never resumed;
the same invocation file is refused and a new invocation name starts fresh work.

### 9. Test harness for the CLI path

CLI tests (tasks 5.1, 5.11, 5.15 and 5.16) need the fixture run's `stateDirectory` to equal what the CLI resolves.
They create a temporary `XDG_STATE_HOME`, build the run config with
`resolveRunPaths(invocationJson, { cwd: fixture.root, env: { XDG_STATE_HOME } })` (where `invocationJson` is
`fixture.config(name)` without `root` and `stateDirectory`, also written to the invocation file), run it with
`runQueue(config, fixture.options(config, ...))`, and call the exported `dispose(file, output, { cwd: fixture.root,
env: { XDG_STATE_HOME }, host })` with the same env and the fixture's scripted host. Task 5.11 runs the file again
through `main(file, (config, options) => runQueue(config, fixture.options(config, options)), output,
{ cwd: fixture.root, env: { XDG_STATE_HOME } })`, so preflights stay scripted and statistics go to the temporary
state home. No test changes `runnerFixture` itself.

## Risks

- Removing the remote branch with `--remove-work` lets the forge close an open pull request; README says so.
- A process killed without releasing its SQLite locks does not exist (the OS releases them), so the lock test is
  reliable for a crashed run.
- Disposing a state whose only blocked entry was merged but not recorded stops the runner from recording that
  acceptance on resume; the merge itself stays at `origin/<target>` and is untouched.
