# Design: Interactive harness, model, effort and coverage selection

## Context

- `runQueue` (`src/runner.ts`) calls `openspecPreflight` then
  `resolveHarness(requested)` then hashes the resolved config into the
  ownership identity and `RunStore` identity (`state.json` in
  `stateDirectory`, field `identity`).
- `src/cli.ts` currently resolves coverage to 85 before calling the runner, so
  the runner cannot tell "not given" from "given 85".
- `ClaudeAdapter.probe()` and `CodexAdapter.probe()` run
  `<executable> --version` with `execFileSync` and compare against
  `2.1.321` / `0.167.0`; a missing executable throws `ENOENT`.
- `src/harness-catalog.ts` provides the Claude catalog and `codexCatalog(rpc)`
  (Codex `model/list`), typed `Catalog = ReadonlyMap<string, readonly
  string[]>` and consumed by `assertSelection`, `harnessCatalog`,
  `CodexAdapter.models()` and existing tests.
- `codexSelection(cwd)` in `src/harness.ts` reads the Codex `config/read`
  defaults and the catalog in one app-server session.
  `resolveHarness(config, readCodex = codexSelection)` calls `readCodex`
  whenever the harness is `codex`, even when model and effort are given.
- `src/openspec-preflight.ts` exports `isInteractive` and `promptOn` (stderr
  prompts, `''` on closed stdin).

## Goals / Non-Goals

Goals: availability check for both harnesses, interactive selection in the
fixed order, non-interactive defaults, restart reuse, injectable effects, at
most one Codex app-server session for selection and resolution together.

Non-goals: changing catalog contents or validation, minimum versions, adapter
transports, or the flag syntax; installing harnesses.

## Decisions

### 1. New module `src/harness-selection.ts`

```ts
export type Availability =
  { harness: Harness; available: true; version: string } |
  { harness: Harness; available: false; reason: string; version?: string };

export interface SelectionDeps {
  interactive: boolean;                       // isInteractive(stdin, stderr)
  ask: (question: string) => Promise<string>; // promptOn(process.stdin, process.stderr)
  say: (text: string) => void;                // process.stderr.write
  probe: (harness: Harness) => Availability;  // wraps the adapter probes
  readCodex: (cwd: string) => Promise<CodexSelection>; // default codexSelection
  recorded: (stateDirectory: string) => Partial<Selection> | null; // reads state.json identity
}
export interface SelectionResult {
  config: RunConfig;        // harness/model/effort/coverage filled as far as decided
  codex?: CodexSelection;   // set exactly when config.harness === 'codex'
}
export async function selectHarness(config: RunConfig,
  overrides?: Partial<SelectionDeps>): Promise<SelectionResult>;
export class HarnessUnavailableError extends Error { reason = 'harness-unavailable' }
```

`selectHarness` returns a copy of the config with `harness`, `model`, `effort`
and `coverage` filled in, plus the Codex selection it read. `resolveHarness`
then validates as today (catalog, coverage range) and remains the single
validation point.

### 2. Probe wrapper

The default `probe(harness)` constructs the adapter with a no-op tool catalog
(as `codexSelection` does) and calls its existing `probe()`. Mapping:

- `interface-ready` -> available with `version`.
- `unavailable` -> unavailable with the adapter's reason
  (`uncertified-claude-version` / `uncertified-codex-version`) and version.
- thrown error with `code === 'ENOENT'` -> unavailable, reason `not-installed`.
- any other thrown error (timeout, nonzero exit) -> unavailable, reason
  `probe-failed`. The run is never failed by a probe.

Both harnesses are always probed, in order `claude`, `codex`, interactive or
not, and only after the OpenSpec preflight has passed.

### 3. Order of `runQueue` and the single Codex read

`openspecPreflight` -> `selectHarness` -> `resolveHarness` -> `validateConfig`
-> lock / identity hash / `RunStore` -> claims and worktrees. `RunOptions`
gains `selection?: Partial<SelectionDeps>`.

Codex is read exactly once per start, by `selectHarness`, through
`deps.readCodex` (injected `options.selection.readCodex` or the default
`codexSelection`). Whenever the decided harness is `codex` (chosen
interactively, given by flag/JSON, recorded on restart, or non-interactive),
`selectHarness` calls `readCodex(config.root)` once — after the availability
check has passed, and before the model prompt when interactive — and returns
it as `SelectionResult.codex`. The runner then calls:

```ts
const { config: selected, codex } = await selectHarness(requested, options.selection);
const config = await resolveHarness(selected, codex ? async () => codex : codexSelection);
```

so `resolveHarness` reuses the already-read `CodexSelection` and never opens
a second app-server session. When the harness is `claude`, `readCodex` is not
called at all. Consequently runner tests that end on Codex (choosing Codex,
restart with a recorded Codex selection, identity freezing) inject
`selection.readCodex` and never spawn `codex`. `resolveHarness`'s signature
is unchanged.

Because the selected values are written into the config before
`hash(config)`, they are frozen exactly like flag values.

### 4. Restart reuse

`recorded(stateDirectory)` reads `<stateDirectory>/state.json` when it exists
(no lock, read-only) and returns `identity.harness`, `identity.model`,
`identity.effort` and `identity.coverage` when all four are present; otherwise
`null`. When recorded, every field not given by flag/JSON takes the recorded
value and no selection prompt is asked (`ask` is never called; harness
statuses may still be written to stderr when interactive). A given value that
differs is kept as given, so the identity hash differs and `RunStore` refuses
with the existing "Run state is incompatible" error (refused as today). The
recorded harness is still subject to the availability rule, and a recorded
`codex` harness triggers the single `readCodex` call of §3.

### 5. Prompt flow (interactive only)

1. `say` one line per harness: `claude: available (2.1.330 (Claude Code))` or
   `codex: unavailable (not-installed)`.
2. Harness: if given, use it (must be available). Else if none available,
   refuse. Else list the available harnesses numbered; preselected is
   `claude` when available, otherwise the only/first available one. A single
   available harness is still shown and preselected.
3. Model: if given, use it. Else list the harness catalog models (Claude:
   `claudeCatalog`; Codex: `codex.catalog` from the single `readCodex` call of
   §3). Preselected: `claude-opus-5-5` for Claude. For Codex, the Codex
   default model, determined in this order:
   1. `codex.model` (the `config/read` model) when it is in the catalog;
   2. else `codex.defaultModel` (the `model/list` entry marked
      `isDefault: true`, see §9) when it is in the catalog;
   3. else the first catalog model.
4. Effort: if given, use it. Else list only the chosen model's efforts
   (`catalog.get(model)`). Preselected, first match wins:
   1. `medium` when supported;
   2. the model's default effort: Codex `codex.defaultEfforts.get(model)`
      (`defaultReasoningEffort` from `model/list`, §9) when supported;
   3. the `config/read` effort `codex.effort` when supported;
   4. the first listed effort.
   (Every Claude model supports `medium`, so steps 2–4 apply to Codex only.)
5. Coverage: if given, use it. Else ask with `85` preselected; accept only a
   string matching `^\d+$` whose value is 1..100; otherwise `say` an error and
   ask again.

Answer parsing for list prompts: trimmed empty -> preselected; a 1-based index
or an exact listed value -> that value; anything else -> re-ask. Prompts show
the preselected value, e.g. `Harness [claude]: `. Closed stdin yields `''`,
so it accepts the preselected answer and never loops.

### 6. Non-interactive

No `ask`/`say` calls. Defaults `claude`, `claude-opus-5-5`, `medium`, `85`
apply for Claude fields not given; Codex model/effort defaults keep coming from
`config/read` inside `resolveHarness` (unchanged OR-1 behaviour), now fed by
the `CodexSelection` read once in `selectHarness` (§3). The selected harness
must be available, else `HarnessUnavailableError`.

### 7. Refusal

`HarnessUnavailableError` (reason `harness-unavailable`) message lists every
harness: `No available harness: claude: not-installed; codex:
uncertified-codex-version (codex-cli 0.100.0)` or `Harness codex is
unavailable: ...`. `cli.ts` already maps `reason` to exit code 4 diagnostics.
The refusal happens before `readCodex` is called.

### 8. CLI coverage

`main` validates a `--coverage` flag with `resolveCoverage` but assigns
`config.coverage` only when the flag is given, leaving JSON-given or absent
coverage untouched for the runner. `resolveHarness` still applies the 85
default when nothing set it.

### 9. Codex default model and per-model default effort

The `Catalog` type, `assertSelection`, `harnessCatalog` and
`codexCatalog(rpc): Promise<Catalog>` keep their exact signatures and
behaviour. The extra `model/list` data lives in a separate structure:

```ts
// src/harness-catalog.ts
export interface CodexModels {
  catalog: Catalog;                              // same content codexCatalog returns today
  defaultModel?: string;                         // first visible entry with isDefault === true
  defaultEfforts: ReadonlyMap<string, string>;   // model -> defaultReasoningEffort
}
export async function codexModels(rpc: CatalogRpc): Promise<CodexModels>;
export async function codexCatalog(rpc: CatalogRpc): Promise<Catalog> {
  return (await codexModels(rpc)).catalog;
}
```

- `CodexModelEntry` gains `isDefault?: unknown` and
  `defaultReasoningEffort?: unknown`.
- `defaultModel` is set from the first visible (non-hidden) entry whose
  `isDefault === true`; hidden entries are ignored as today.
- `defaultEfforts.set(id, effort)` only when `defaultReasoningEffort` is a
  non-empty string contained in that model's supported efforts, and only for
  the first entry of a given id (later duplicates merge efforts as today but
  do not overwrite the default).
- Malformed or absent `isDefault` / `defaultReasoningEffort` are ignored, never
  errors, so existing `codexCatalog` fixtures and tests stay valid unchanged.

`CodexAdapter` gains `modelList(): Promise<CodexModels>` (same connection
check, calls `codexModels`); `models(): Promise<Catalog>` stays and returns
`(await this.modelList()).catalog`.

`CodexSelection` in `src/harness.ts` becomes

```ts
export interface CodexSelection {
  model?: string; effort?: string; catalog: Catalog;
  defaultModel?: string;                          // new, optional
  defaultEfforts?: ReadonlyMap<string, string>;   // new, optional
}
```

`codexSelection` fills both new fields from `adapter.modelList()`. Both fields
are optional, so existing tests and injected readers that return only
`{ model, effort, catalog }` keep compiling and behave as before
(preselection then falls back per §5). `resolveHarness` ignores the new
fields.

## Risks / Trade-offs

- Probing Codex on every start adds one `codex --version` call; acceptable and
  required by the criteria.
- Reading `state.json` before the lock may race with another owner; the read
  is advisory only, and the lock/identity checks still decide.
- Existing runner tests must inject passing probes (and, when they end on
  Codex, `selection.readCodex`) so no real harness starts.
