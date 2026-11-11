# Tasks

## 1. Claims ledger

- [x] 1.1 Add `ClaimLedger.release(snapshot, ids, message): boolean` (src/claims.ts, design decision 5): a commit
  of the ledger tree without `<id>.json` for `ids`, pushed with the compare-and-swap of `acquire`; false when the
  remote head moved; no commit for empty `ids`.

## 2. Dispose

- [x] 2.1 Create `src/dispose.ts` with `disposeInvocation(config, { removeWork, host })` and the `DisposeSummary`
  type (design decisions 1 and 7).
- [x] 2.2 Read-only match of the state (decision 2) as the very first step (decision 6 step 1a), throwing
  `reason: 'unknown-invocation'` before any lock is opened and before any file or directory is created.
- [x] 2.3 Then take the invocation lock and the state `lock.sqlite` (decision 3); only an already held lock throws
  `reason: 'invocation-running'`, other open errors are rethrown; close both in `finally`. Re-read and re-match
  `state.json` under the locks (decision 6 step 1c).
- [x] 2.4 Compute `done`, owned unaccepted claims and unaccepted work (decision 4) and apply the effects in the order
  of decision 6: one atomic `state.json` write with `status: 'released'` and a `disposed` record (possibly with
  empty `tasks`) whenever there is something to dispose or `status` is not already `released`, and no write
  otherwise; claim release with up to 5 retries; optional work removal under the Git lock; ownership. Count the
  state write in the `disposed` / `nothing-to-release` rule (decision 7).
- [x] 2.5 List open pull requests with `host.find(branch)` only, with `state` `OPEN`, or `unknown` from the recorded
  `work.pr` when `find` throws (decision 7); never call `merge` or `create`.

## 3. CLI and runner

- [x] 3.1 Add `dispose(path, output, { args, cwd, env, host })` to src/cli.ts (only `--remove-work`, at most once);
  failures go through `reportFailure` with exit 4. Give `run` an optional second parameter `commands = { dispose }`
  and dispatch `run(['dispose', file, ...flags])` to `commands.dispose(file, undefined, { args: flags })`
  (decision 1).
- [x] 3.2 In `runSteps` refuse a state with a `disposed` record with `reason: 'invocation-disposed'` before the
  ownership file is written (decision 8).

## 4. README

- [x] 4.1 Document when to dispose of an invocation, the command and `--remove-work`, the summary fields, the exit
  codes and reasons (`invocation-running`, `unknown-invocation`, `invocation-disposed` for a later run), that
  accepted work and other invocations are untouched, that open pull requests are listed and never merged (and that
  removing a remote branch may close its pull request), that a disposed invocation file cannot be run again (use a
  new invocation name), and that this replaces manual edits of ownership files or the claims branch (remove any such
  manual instructions).

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Tests use Git fixtures
(`test/support/runner-fixture.ts`) with scripted adapters and the scripted pull request host; a task is left
unaccepted by a failing scripted session (`fail` hook), and an open pull request by a scripted host whose `merge`
throws. CLI-path tests (5.1, 5.11, 5.15, 5.16) align state directories as in design decision 9: a temporary
`XDG_STATE_HOME`, the run config built with `resolveRunPaths(invocationJson, { cwd: fixture.root, env })`, the same
`invocationJson` written to the invocation file, and the exported `dispose(file, output, { cwd: fixture.root, env,
host })` called with that env and the fixture's scripted host.

### Grade E

- [x] 5.1 (E) (required) Unknown invocation: (a) `disposeInvocation` with a config whose state directory has no
  `state.json` throws `reason` `unknown-invocation` and the state directory is not created; (b) through the CLI,
  `dispose(file, output, { cwd: fixture.root, env })` for a never-run invocation name returns 4 and prints one line
  `{ status: 'unavailable', reason: 'unknown-invocation', diagnostics }`; (c) in both cases no invocation lock file
  (`.sqlite`) and no ownership file (`-owner.json`) exists for that invocation under the `.work-queue-locks`
  directory beside the primary checkout (`invocationLockFiles(root, stateDirectory)` paths do not exist), and the
  resolved state directory does not exist.
- [x] 5.2 (E) (coverage-only) A `state.json` whose `identity.invocation` differs from the config is
  `unknown-invocation`.
- [x] 5.3 (E) (coverage-only) CLI `dispose` rejects an unknown argument and a repeated `--remove-work` with exit 4.
- [x] 5.4 (E) (required) Dispatch: `run(['dispose', file, '--remove-work'], { dispose: spy })` calls the spy once with
  `file` and `args: ['--remove-work']` and returns its exit code.

### Grade D

- [ ] 5.5 (D) (coverage-only) `ClaimLedger.release` removes only the named claim files in one commit with the given
  message, makes no commit for empty ids, and returns false when the remote head moved.
  `not needed: coverage reached`
- [x] 5.6 (D) (required) Dispose a fully accepted invocation: nothing is released, the summary `status` is
  `nothing-to-release`, receipts and the ledger head are unchanged, and `state.json` is byte-for-byte unchanged (no
  `disposed` record; `status` stays `released`).

### Grade C

- [x] 5.7 (C) (required) Claims released and ownership freed: invocation `one` blocks on task `A` (claim, worktree,
  branches exist); after dispose the ledger lacks `A.json`, exactly one new ledger commit names `one`, the ownership
  file has `released: true`, `state.json` `status` is `released` with a `disposed` record for `A`, and a new
  invocation `two` with leaf `A` accepts `A`.
- [x] 5.8 (C) (required) Work kept by default: after 5.7's dispose the worktree, local branch and remote branch of
  `A` still exist and the summary lists them as `kept`.
- [x] 5.9 (C) (required) Work removed with `--remove-work`: they no longer exist and are listed as `removed`.
- [x] 5.10 (C) (required) Repeated dispose: a second dispose exits 0 with `nothing-to-release`, empty
  `releasedClaims`, an unchanged ledger head and a byte-for-byte unchanged `state.json`.
- [x] 5.11 (C) (required) Disposed state not resumed: running invocation `one` again through
  `main(file, (config, options) => runQueue(config, fixture.options(config, options)), output,
  { cwd: fixture.root, env })` (decision 9) is refused with reason `invocation-disposed` and exit 4, and claims
  nothing.
- [x] 5.12 (C) (required) Unclaimed incomplete invocation (design decisions 6 step 3, 7 and 8): invocation `two`
  blocks on leaf `B` (holding its claim); invocation `one` with leaf `B` then runs, waits on `two`'s claim and ends
  with `state.json` `status` `incomplete`, its ownership file `released: false` and no claim of its own. After
  `disposeInvocation` of `one`: its ownership file has `released: true`, its `state.json` `status` is `released`
  with a `disposed` record (empty `tasks`), the summary `status` is `disposed` with empty `releasedClaims`, the ledger
  head and `two`'s claim of `B` are unchanged, and running `one` again with `runQueue` is refused with reason
  `invocation-disposed`. A second dispose of `one` reports `nothing-to-release` and leaves `state.json`
  byte-for-byte unchanged.

### Grade B

- [x] 5.13 (B) (required) Accepted work untouched: invocation with leaves `A` and `B`, `A` accepted and `B` blocked;
  dispose releases only `B`'s claim; `A`'s receipt, claim, `completed` entry and merged pull request are unchanged.
- [x] 5.14 (B) (required) Open pull request listed: a task whose merge fails keeps an open pull request; the summary
  lists it in `openPullRequests` with `state` `OPEN` and the host's `merge` is not called during dispose. With a host
  whose `find` throws, the recorded `work.pr` is listed with `state` `unknown` and dispose still succeeds.
- [x] 5.15 (B) (required) CLI summary: the exported `dispose(file, output, { cwd: fixture.root, env, host })` with the
  fixture's scripted host (decision 9) on a blocked invocation prints exactly one JSON line with `status`,
  `invocation`, `releasedClaims`, `ownership`, `work` and `openPullRequests` and returns 0.

### Grade A

- [x] 5.16 (A) (required) Running invocation refused: from inside a scripted session of invocation `one`
  (`onSession` hook), the exported `dispose(file, output, { cwd: fixture.root, env, host })` (decision 9) returns 4
  with reason `invocation-running`; the ledger head, ownership file and `state.json` are unchanged and the run then
  finishes normally.
- [x] 5.17 (A) (required) Another invocation untouched: invocations `one` and `two` of one repository each block on
  their own task, and a second repository fixture holds its own invocation; disposing `one` leaves `two`'s claim,
  ownership file and `state.json`, and the other repository's ledger, ownership and state byte-for-byte unchanged,
  and `two` can still be resumed.
- [ ] 5.18 (A) (coverage-only) Claim release race: the ledger head moves between pull and push (another claim
  committed); dispose retries and releases the claim in one commit without removing the other claim.
  `not needed: coverage reached`

## 6. Verification after binding

- [x] 6.1 Run `npm run typecheck`.
- [x] 6.2 Run `npm test` with the coverage gate at 85%.
