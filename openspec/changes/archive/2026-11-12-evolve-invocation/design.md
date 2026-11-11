# Design: evolve-invocation

## Context

`runSteps` opens `new RunStore(config.stateDirectory, { ...config, root, leaves: ids })`. `RunStore` compares
`state.identityHash` with `hash(identity)` and `state.frozen` with `identity.leaves`, and refuses any difference with
`Run state is incompatible; reconcile it without discarding history`. The ownership file stores `hash(config)` and
refuses an unreleased file whose hash differs. `config` is the resolved configuration: it includes harness, model and
effort defaults that `selectHarness` and `resolveHarness` fill in, and any field a future runner adds. `RunStore.intend`
derives operation ids from `state.identityHash`. `disposeInvocation` matches state by `version === 2`,
`identity.invocation`, `identity.root` and `identity.project.target`.

`selectHarness` in `src/harness-selection.ts` already reuses the frozen selection on restart. It calls
`deps.recorded(config.stateDirectory)`; the default is `recordedSelection`, which reads `state.json` read-only and
returns `state.identity.harness`, `model`, `effort` and `coverage` (only when all four are recorded) together with
`state.statisticsSources`. `selectHarness` fills each unset key with `??=`, so a value from the invocation file or a
flag still wins. It turns off prompting (`prompting = interactive && !recorded`) and restores the recorded statistics
sources, so the filled keys keep their original provenance. Tests control this behaviour by injecting
`selection.recorded`.

## Decisions

### 1. Identity schema 2: an explicit projection

A new module `src/invocation-identity.ts` exports:

```ts
export const IDENTITY_SCHEMA = 2;
export interface InvocationIdentity {
  schema: 2;
  invocation: string;
  root: string;
  authority: { reference: string; instruction: string; target: string; tasks: Record<string, string> };
  project: { target: string; queue: string; changes: string; receipts: string;
    checks: CommandSpec[]; planningCheck: CommandSpec; setup: CommandSpec[] };
  harness: Harness; model: string; effort: string; coverage: number;
  leaves: string[];
}
export function invocationIdentity(config: RunConfig & { leaves: string[] }): InvocationIdentity;
```

The projection copies only the listed fields (`setup` normalised to `[]` when absent). Nothing else of the resolved
configuration enters the identity: not `project.archive` (it has a runner default), not `maxAccepted`, `mode`,
`commitScope`, `commitSuffix`, `repository`, not `stateDirectory` (it is derived from `root` and `invocation`), and
not any key that a newer runner adds. The identity keeps `invocation`, `root` and `project.target` at the same paths
as before, so `disposeInvocation` keeps matching migrated and new state without change. It also keeps `harness`,
`model`, `effort` and `coverage` at the top level of `identity`, as the legacy identity does, so `recordedSelection`
reads both legacy and schema 2 state without change (decision 4). `state.version` stays `2`; the new field
`state.identitySchema` is `2`, and its absence means legacy schema 1.

A future runner that needs a new identity field must bump `IDENTITY_SCHEMA` and add a migration like decision 3. The
projection of one schema never changes.

### 2. Comparing identities

`compareIdentity(stored, next)` returns one of:

- `{ kind: 'same' }`: `hash(stored) === hash(next)`.
- `{ kind: 'tasks-added', tasks }`: everything except `authority.tasks` and `leaves` is equal. Every stored task id is
  in `next.authority.tasks` with the same hash. Every stored leaf is in `next.leaves`. At least one task id or leaf is
  new. `tasks` lists the sorted ids that are new in `authority.tasks` or in `leaves`.
- `{ kind: 'incompatible' }`: anything else, including a removed task, a changed task hash, a removed leaf, or a
  changed harness, model, effort, coverage, check or authority field.

### 3. RunStore opening, migration and additions

`RunStore` gains an options field `settings?: Record<string, string>` (decision 5) and takes an `InvocationIdentity`
instead of the whole configuration. The existing checks for the leaf set, the repository root and symlinks are
unchanged. Under the store lock, when `state.json` exists:

1. The basic validity checks stay (`version 2`, operations, accepted, sequence, cancelled). Failing them refuses with
   the existing message.
2. Legacy state (`identitySchema` absent): the store requires `state.identityHash === hash(state.identity)` and
   `hash(state.frozen) === hash(state.identity.leaves)`. This proves the recorded configuration is intact. The stored
   identity is then `invocationIdentity(state.identity)`. A legacy identity lacks no projected field, because the old
   identity was the resolved configuration with `root` and `leaves`. When a field is missing anyway, the state is
   incompatible.
3. Schema 2 state: the stored identity is `state.identity`, and `state.identityHash` must equal its hash.
4. `compareIdentity(stored, next)`. `incompatible` throws `Run state is incompatible; reconcile it without discarding
   history`, as before, without writing. `same` and `tasks-added` continue.
5. When anything changed, one `update` writes `identitySchema: 2`, `identity: next`, `identityHash: hash(next)`,
   `frozen: next.leaves` and the appended change records. A legacy migration appends
   `{ kind: 'identity-upgraded', from: 1, to: 2, at }`. A task addition appends `{ kind: 'tasks-added', tasks, at }`.
   `operations`, `accepted`, `current`, `blocked`, `completed`, `claimant`, `baselineDone`, `statisticsSources` and
   `disposed` are kept unchanged.

A new state is created with `identitySchema: 2`, `identity: next`, `identityHash: hash(next)` and
`operationKey: hash(next)`.

**Stable operation ids.** `intend` derives ids from `state.operationKey ?? state.identityHash`. A migration or a task
addition sets `operationKey` to the previous `identityHash` when it is absent, so every recorded intent keeps its id
and no broker effect is repeated.

The change records are typed in `src/run-store.ts`:

```ts
export type InvocationChange =
  | { kind: 'identity-upgraded'; from: 1; to: 2; at: string }
  | { kind: 'setting-added'; setting: string; at: string }
  | { kind: 'tasks-added'; tasks: string[]; at: string };
// RunState gains: identitySchema?: 2; operationKey?: string; settings?: Record<string, string>;
// changes?: InvocationChange[]
```

The store takes an injectable `now` (default `Date.now`) for `at`.

### 4. Frozen harness, model, effort and coverage on resume: the existing `recorded` hook

No new reader is added. On resume, harness, model, effort and coverage that neither the invocation file nor a flag
sets come from the existing `selectHarness` path described in the Context: `deps.recorded(config.stateDirectory)`
(default `recordedSelection`) returns the four frozen values, `selectHarness` fills the unset keys with `??=`, does
not prompt, and restores `state.statisticsSources`. A newer runner's different default therefore never replaces a
frozen value, and the identity stays the same. A value the owner sets explicitly is used as given; when it differs
from the frozen value, the store refuses as before (decision 3).

This works for legacy and schema 2 state without changing `recordedSelection`, because decision 1 keeps the four
fields at the top level of `identity`. Keeping that layout is the only obligation this change places on decision 4;
it is why decision 1 fixes those paths. Writing frozen values into `requested` before `selectHarness` is rejected: it
would turn the source of each filled key into `invocation-json` (`sources[key] ??= config[key] !== undefined ?
'invocation-json' : 'default'`), and tests injecting `selection.recorded` would no longer control the behaviour.

No real gap needs an extension of the hook. Disposed state is refused by the existing `invocation-disposed` check
before any work, so reusing its selection only skips a prompt for a run that is then refused. A state without all four
fields, or one that does not parse, yields `null` as today, and the run store then decides compatibility.

### 5. Required settings

```ts
export interface RequiredSetting { path: string; example: unknown }
export const REQUIRED_SETTINGS: readonly RequiredSetting[] = [];
export function missingSetting(config: unknown, required: readonly RequiredSetting[]): RequiredSetting | undefined;
export class MissingSettingError extends Error { reason: 'missing-setting'; setting: string; example: unknown }
```

`path` is a dot-separated path in the invocation file, for example `project.example`. A setting is missing when the
value at that path is `undefined`. `RunOptions.requiredSettings` (default `REQUIRED_SETTINGS`) lets tests and future
releases declare requirements. The runner of this change declares none.

`runSteps` checks `missingSetting(requested, required)` first, before the OpenSpec preflight. It throws
`MissingSettingError` with the message `The invocation lacks the setting <path> that this runner requires; add it,
for example <JSON of { <path>: example } nested>`. Nothing is written. No lock, state, ownership file, claim or
worktree is created or changed.

`reportFailure` in `src/cli.ts` adds `setting` and `example` to the unavailable line when the error carries them:
`{ status: 'unavailable', reason: 'missing-setting', setting, example, diagnostics }`. The exit code is 4.
`missing-setting` joins `SAFE_FAILURE_REASONS`, so the statistics ledger records it.

Recording: after the store opens, `runSteps` computes `present = { path: hash(value) }` for every required setting.
On a new state, `settings` is set to `present` without a change record. On resume, every required path that is absent
from `state.settings` appends `{ kind: 'setting-added', setting: path, at }`, and `settings` is updated. Only the
path and a hash are stored, never the value. Required settings never enter the identity, so adding one keeps the
identity and all durable state.

### 6. Added tasks are worked after existing work

`ids = config.leaves ?? Object.keys(config.authority.tasks)` already includes the added tasks. The authority and
dependency checks at startup apply to them unchanged. Recovery is unchanged: `current` resumes at its recorded stage,
and blocked entries are recovered into `current` one by one before any new claim. Only then does the selection pick
the remaining tasks, existing and added, by `priority` then id. Existing claims, worktrees, reviews and accepted tasks
are therefore kept, and the new tasks follow in queue order. `baselineDone` is not recomputed.

### 7. Ownership file

An unreleased ownership file is refused only when its `stateDirectory` differs from this invocation's. Identity
compatibility is the store's decision (decision 3). The file now records `identity: hash(identity)` of the schema 2
identity.

### 8. Receipts

When `state.changes` is non-empty, the receipt gains `invocationChanges`: the recorded changes at the time the
receipt is written, each with `kind`, `at` and either `from`/`to`, `setting` or `tasks`. Receipts of invocations
without changes are unchanged. `Receipt` in `src/git.ts` gets the optional field; `receiptAt` ignores it.

### 9. README

A section "Upgrading the runner or adding tasks during an invocation" covers:

- what the identity contains, and that a newer runner resumes unfinished work with unchanged settings;
- the `missing-setting` refusal with `setting` and `example`, and that adding exactly that setting resumes;
- adding tasks to `authority.tasks` (and `leaves`): existing work first, then queue order;
- removing a task or changing a task hash is still refused;
- the records in `state.json` `changes` and in receipts' `invocationChanges`.

## Risks

- An owner who changes a non-identity setting such as `maxAccepted` or `commitSuffix` mid-invocation is no longer
  refused. These are per-run operational settings, and the startup checks still validate them.
- A legacy state whose stored configuration was edited by hand fails the integrity check and is refused as before.
- A later identity schema that moves harness, model, effort or coverage away from the top level of `identity` must
  update `recordedSelection` in the same change.
