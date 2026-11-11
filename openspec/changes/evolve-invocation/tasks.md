# Tasks

## 1. Identity module

- [ ] 1.1 `src/invocation-identity.ts`: `IDENTITY_SCHEMA`, `InvocationIdentity`, `invocationIdentity(config)`
  (decision 1) and `compareIdentity(stored, next)` (decision 2). `harness`, `model`, `effort` and `coverage` stay at
  the top level of the identity so the existing `recordedSelection` keeps reading them (decision 4).
- [ ] 1.2 `RequiredSetting`, `REQUIRED_SETTINGS` (empty), `missingSetting(config, required)` and
  `MissingSettingError` with `reason`, `setting` and `example` (decision 5).

## 2. Run store

- [ ] 2.1 `src/run-store.ts`: take an `InvocationIdentity`; `RunState` gains `identitySchema`, `operationKey`,
  `settings` and `changes`; export `InvocationChange`; injectable `now`.
- [ ] 2.2 Open existing state as in decision 3: legacy integrity check and migration (`identity-upgraded`), schema 2
  check, `compareIdentity`, `tasks-added` update of `identity`, `identityHash` and `frozen`, unchanged refusal message
  for `incompatible` without any write.
- [ ] 2.3 `intend` uses `operationKey ?? identityHash`; the first migration or addition preserves the previous
  `identityHash` as `operationKey`.

## 3. Runner and CLI

- [ ] 3.1 `RunOptions.requiredSettings`; `runSteps` checks `missingSetting(requested, …)` before the OpenSpec
  preflight and throws `MissingSettingError` before any effect.
- [ ] 3.2 Frozen harness, model, effort and coverage on resume: no new reader and no write into `requested`. Keep the
  existing `selectHarness` → `deps.recorded` (`recordedSelection`) path unchanged, and keep the four fields at the top
  level of the schema 2 identity (decision 4). `src/harness-selection.ts` needs no change.
- [ ] 3.3 Open the store with `invocationIdentity({ ...config, root, leaves: ids })`; record required settings in
  `settings` and append `setting-added` changes on resume (decision 5).
- [ ] 3.4 Ownership: refuse an unreleased file only for a different `stateDirectory`; record the schema 2 identity hash
  (decision 7).
- [ ] 3.5 Receipt: add `invocationChanges` when `state.changes` is non-empty; optional field in `Receipt` of
  `src/git.ts` (decision 8).
- [ ] 3.6 `src/cli.ts` `reportFailure` adds `setting` and `example` when present; `missing-setting` joins
  `SAFE_FAILURE_REASONS` in `src/statistics.ts`.
- [ ] 3.7 Update existing tests that construct `RunStore` with a whole configuration or assert the ownership identity
  refusal to the new behaviour.

## 4. README

- [ ] 4.1 Add the section "Upgrading the runner or adding tasks during an invocation" (decision 9).

## 5. Tests

Graded from E (easiest) to A (most complex); listed easiest first. Tests live in
`test/invocation-evolution.test.ts`. Unit tests call the exported functions and `RunStore` directly on temporary
directories. Runner tests use the existing runner Git fixture (a bare origin, the project queue, scripted adapters and
the scripted pull request host) used by the target-scope recovery tests. An invocation is interrupted with an
`AbortController` from `afterEffect` (for example `implementation`) and run again with `runQueue` and the same state
directory. "Legacy state" is produced by rewriting that `state.json` the way the previous runner wrote it: `identity`
is the whole resolved configuration with `root` and `leaves`, `identityHash` is its `hash`, and `identitySchema`,
`operationKey`, `settings` and `changes` are absent. "Unchanged" state means `state.json` is byte-identical before
and after the refused run.

### Grade E

- [ ] 5.1 (E) (required) `invocationIdentity` keeps exactly the fields of decision 1. Configurations differing only
  in `project.archive`, `maxAccepted`, `commitScope`, `commitSuffix`, `repository` or an unknown top-level or project
  key give equal identities. A changed task hash, harness, model, effort, coverage, `checks`, `planningCheck` or
  `setup` gives a different identity. An absent `setup` equals `setup: []`.
- [ ] 5.2 (E) (required) `compareIdentity`: equal identities give `same`; an added task in `authority.tasks` (and in
  `leaves`) gives `tasks-added` with the sorted new ids; a removed task, a changed task hash, a removed leaf and a
  changed model each give `incompatible`; an added task together with a changed model gives `incompatible`.
- [ ] 5.3 (E) (required) `missingSetting` returns the first missing `RequiredSetting` by dot path, and `undefined`
  when every path has a value (including `false` and `0`). `MissingSettingError` carries `reason`
  `missing-setting`, `setting` and `example`, and its message names the path and the example.
- [ ] 5.4 (E) (coverage-only) Regression guard for decision 1's layout: `recordedSelection` on a schema 2
  `state.json` written by `RunStore` returns the identity's harness, model, effort and coverage and its
  `statisticsSources`. It exercises no new code; it fails only if a later change moves those fields.

### Grade D

- [ ] 5.5 (D) (required) CLI refusal: `main` with a runner that throws `MissingSettingError` for `project.example`
  returns 4. The printed line has `status` `unavailable`, `reason` `missing-setting`, `setting` `project.example`, the
  `example` and `diagnostics`. The statistics record has `failureReason` `missing-setting`.
- [ ] 5.6 (D) (required) `RunStore` migration: legacy state with operations, `current`, `claimant`, `completed` and
  `accepted` opened with the projected identity keeps all of them. It writes `identitySchema` 2, the projected
  identity and its hash, `operationKey` equal to the legacy `identityHash`, and one `identity-upgraded` change.
  `intend` for an action recorded before returns the same operation id. Legacy state whose `identity` was edited
  (hash mismatch) is refused with `Run state is incompatible`, and the file is unchanged.
- [ ] 5.7 (D) (required) `RunStore` additions: a schema 2 state opened with one added task records `tasks-added` with
  that id and updates `identity`, `identityHash` and `frozen`, keeping `operationKey`. A removed task and a changed
  task hash are refused with `Run state is incompatible`, and the file is unchanged.
- [ ] 5.8 (D) (coverage-only) An unreleased ownership file of the same state directory with a different `identity`
  hash does not refuse the run; one with a different `stateDirectory` still refuses.

### Grade C

- [ ] 5.9 (C) (required) Resumed by a newer runner with unchanged settings: the invocation of task A is interrupted
  from `afterEffect('implementation')` and its state is rewritten to legacy state. It is run again with the same
  invocation file, and the resolved configuration additionally carries an unknown key and an explicit default
  `project.archive`, simulating a newer runner's added settings. The run is not refused. A resumes without a second
  claim commit, worktree or investigation session (session counts by purpose from `state.json`), on the same branch
  and worktree path, and is accepted. `state.json` `changes` holds `identity-upgraded`, and A's receipt on
  `origin/main` lists it in `invocationChanges`.
- [ ] 5.10 (C) (required) Frozen model reused: an invocation started with model `model-a` set by a flag is
  interrupted. It is run again without the model flag or a model in the invocation file, with a selection whose
  default model differs. The run resumes with `model-a` (the adapter options and the statistics `model` setting), is
  not refused, and the stored identity is unchanged. Note: this already passes on the current code. It is a
  regression guard for the existing `selectHarness` → `recordedSelection` path (decision 4) under schema 2 state,
  required by the spec scenario "Newer default does not replace the frozen model", and is not evidence for new code.

### Grade B

- [ ] 5.11 (B) (required) Missing required setting reported, then accepted: the invocation of task A is interrupted
  from `afterEffect('implementation')`. It is run again with `requiredSettings` `[{ path: 'project.example', example:
  'value' }]` and an invocation file without it. `runQueue` throws `MissingSettingError` naming `project.example` with
  the example, before the OpenSpec preflight runs (its injected probe is not called). `state.json` is unchanged, and
  the worktree, local branch and claim still exist. With `project.example` added to the invocation file and nothing
  else changed, the next run resumes A at its recorded stage without a second claim and accepts it. `state.json`
  `changes` holds one `setting-added` record for `project.example`, `settings` holds that path, and A's receipt
  lists the record in `invocationChanges`.
- [ ] 5.12 (B) (required) Changed or removed task still refused: with the invocation of A interrupted, (a) A's hash in
  `authority.tasks` is changed while the queue is unchanged, and the run is refused with `Task source differs from
  frozen authority`; (b) the queue and `authority.tasks` are changed together to a new definition of A, and the run is
  refused with `Run state is incompatible`; (c) a second task B that was in `authority.tasks` is removed, and the run
  is refused with `Run state is incompatible`. In every case `state.json` is unchanged and A's worktree and claim
  remain.

### Grade A

- [ ] 5.13 (A) (required) Added tasks worked while existing work resumes: the invocation of task A (priority 2) is
  interrupted from `afterEffect('implementation')`. The owner adds task B (priority 1, scope disjoint from A) to the
  queue on `origin/main` and to `authority.tasks`, and runs it again. A resumes at its recorded stage without a second
  claim or investigation and is accepted. B is claimed only after A's acceptance: in the step log, B's `claim` line
  follows A's acceptance line, despite B's lower priority number. B is then accepted. `state.json` `changes` holds
  `tasks-added` `['B']`, `frozen` contains A and B, and the operation ids recorded before the addition are kept. B's
  receipt lists the `tasks-added` record in `invocationChanges`.
- [ ] 5.14 (A) (coverage-only) Added task while an existing task is blocked: A is blocked (its implementation review
  keeps reporting `changes-required`) and the run ends incomplete. The owner adds task C with a disjoint scope. The
  next run recovers A from `blocked` first (its work and sessions kept) and then works C, which is accepted.

## 6. Verification after binding

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run `npm test` with the coverage gate at 85%.
