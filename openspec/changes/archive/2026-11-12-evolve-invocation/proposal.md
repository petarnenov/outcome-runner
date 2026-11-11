# Keep invocation work across runner upgrades and added tasks

## Why

The frozen identity of an invocation is currently the hash of the whole resolved run configuration
(`hash({ ...config, root, leaves })` in `RunStore` and `hash(config)` in the ownership file). Any field, default or
setting that a newer runner adds to the resolved configuration changes that hash. The runner then refuses the
unfinished invocation with `Run state is incompatible`, and its claims, worktrees, reviews and accepted tasks can no
longer be resumed. The same refusal stops an owner who only wants to add tasks to `authority.tasks` of a running
invocation.

## What Changes

- The frozen invocation identity becomes an explicit, versioned projection (identity schema 2). It contains only what
  the owner authorised: the invocation name and repository root, the authority (reference, instruction, target and
  the task ids with their hashes), the project target and its queue, changes and receipts paths, the harness, model,
  effort and coverage, the checks (`checks`, `planningCheck`, `setup`), and the leaves. Runner defaults such as the
  archive command, operational settings such as `maxAccepted`, `commitScope`, `commitSuffix` and `repository`, and any
  setting a newer runner introduces are outside the identity.
- On resume, a harness, model, effort or coverage that neither the invocation file nor a flag sets keeps coming from
  the frozen identity through the existing `selectHarness` recorded-selection path (`recordedSelection`). The schema 2
  identity keeps these fields where that path reads them, so a newer runner's different default never changes them.
- State written by an older runner (identity schema 1, the hash of the whole configuration) is migrated in place when
  its recorded identity is intact and its projection matches. The migration keeps all durable state and is recorded.
- A newer runner can declare required settings. When one is missing from the invocation, the run is refused with exit
  code 4, reason `missing-setting`, the missing `setting` and an `example`, before any state, lock, claim or worktree
  is touched. Adding exactly that setting resumes the unfinished work. The addition is recorded in `state.json` and in
  every receipt written afterwards.
- The owner may add tasks to `authority.tasks` (and to `leaves`, when given) of an unfinished invocation. Existing
  work is kept and resumed first. The new tasks are then worked in queue order. The addition is recorded in
  `state.json` and in later receipts. Removing a task or changing a task hash is still refused as before.
- The ownership file no longer refuses a resumed invocation of the same state directory because its identity hash
  changed. Identity compatibility is decided only by the run store.
- README: a section on upgrading the runner during an unfinished invocation and on adding tasks to it.

## Capabilities

### New Capabilities

- `invocation-evolution`: a stable invocation identity across runner upgrades, required settings added without
  losing state, and tasks added to an unfinished invocation.

## Impact

- `src/invocation-identity.ts` (new): identity projection, comparison, required settings.
- `src/run-store.ts`: identity schema 2, legacy migration, task additions, change records, stable operation key.
- `src/runner.ts`: required settings check, ownership check, change records, receipts. The frozen selection on
  resume uses the unchanged `selectHarness` and `recordedSelection` in `src/harness-selection.ts`.
- `src/cli.ts`, `src/statistics.ts`: `missing-setting` reason with `setting` and `example` in the unavailable line.
- `src/git.ts`: optional `invocationChanges` in the `Receipt` type.
- Tests in `test/invocation-evolution.test.ts`; README section.
