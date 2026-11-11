# Tasks

## 1. Selection module

- [x] 1.1 Create `src/harness-selection.ts` with `Availability`,
  `SelectionDeps`, `SelectionResult { config; codex? }`,
  `HarnessUnavailableError` (reason `harness-unavailable`) and
  `selectHarness(config, overrides): Promise<SelectionResult>`; defaults reuse
  `isInteractive` and `promptOn` from `src/openspec-preflight.ts` (stderr
  prompts) and `codexSelection` from `src/harness.ts`.
- [x] 1.2 Default `probe(harness)` wraps `ClaudeAdapter.probe()` /
  `CodexAdapter.probe()`: `interface-ready` -> available with version;
  `unavailable` -> adapter reason and version; `ENOENT` -> `not-installed`;
  any other error -> `probe-failed`. Never throws.
- [x] 1.3 Default `recorded(stateDirectory)` reads
  `<stateDirectory>/state.json` read-only when present and returns the
  identity's harness, model, effort and coverage only when all four exist.
- [x] 1.4 Single Codex read: whenever the decided harness is `codex`
  (interactive, flag/JSON, recorded or non-interactive) and it is available,
  call `deps.readCodex(config.root)` exactly once and return it as
  `SelectionResult.codex`; never call it when the harness is `claude` or the
  run is refused.
- [x] 1.5 Interactive flow: show every harness status on stderr, then ask
  harness (available only; `claude` preselected when available, else the
  single/first available), model (catalog; `claude-opus-5-5` for Claude; for
  Codex `codex.model` from `config/read` when in the catalog, else
  `codex.defaultModel` from `model/list` `isDefault` when in the catalog,
  else the first catalog model), effort (only the model's efforts; `medium`
  when supported, else `codex.defaultEfforts.get(model)` when supported, else
  `codex.effort` when supported, else the first listed), coverage (85;
  integer 1..100; re-ask on invalid). Empty answer accepts the preselected
  value; a 1-based index or exact value selects; anything else re-asks. Given
  flag/JSON values skip their prompt.
- [x] 1.6 Non-interactive flow: no `ask`/`say`; fill Claude defaults
  (`claude`, `claude-opus-5-5`, `medium`, 85) where not given; leave Codex
  model/effort to `resolveHarness` (fed by the single Codex read).
- [x] 1.7 Refuse with `HarnessUnavailableError` when no harness is available
  or the given/recorded/default harness is unavailable; the message lists each
  harness with its reason.
- [x] 1.8 Restart: when recorded, fill only fields not given from the record
  and ask nothing; differing given values pass through so `RunStore` refuses
  as today.

## 2. Codex default model and default efforts

- [x] 2.1 `src/harness-catalog.ts`: add `CodexModels { catalog: Catalog;
  defaultModel?: string; defaultEfforts: ReadonlyMap<string, string> }` and
  `codexModels(rpc)`; parse `isDefault` (first visible entry with `true`) and
  `defaultReasoningEffort` (kept only when it is a supported effort of that
  model; first entry per id wins); ignore malformed values. Keep `Catalog`,
  `assertSelection`, `harnessCatalog` unchanged and keep
  `codexCatalog(rpc): Promise<Catalog>` returning `(await
  codexModels(rpc)).catalog`, so existing `codexCatalog` callers and tests
  are unchanged.
- [x] 2.2 `src/codex-adapter.ts`: add `modelList(): Promise<CodexModels>`;
  `models()` keeps its signature and returns `(await this.modelList()).catalog`.
- [x] 2.3 `src/harness.ts`: `CodexSelection` gains optional `defaultModel?:
  string` and `defaultEfforts?: ReadonlyMap<string, string>`; `codexSelection`
  fills them from `adapter.modelList()`; `resolveHarness` ignores them and
  keeps its signature.
- [x] 2.4 Tests in `test/harness-catalog.test.ts`: `codexModels` records
  `defaultModel` and per-model `defaultEfforts`, ignores hidden/malformed
  defaults and unsupported default efforts; existing `codexCatalog` tests
  pass unchanged.

## 3. Integration

- [x] 3.1 `src/runner.ts`: add `selection?: Partial<SelectionDeps>` to
  `RunOptions`; call `selectHarness(requested, options.selection)` after
  `openspecPreflight` and before `resolveHarness`, the lock, the identity
  hash, claims and worktrees; then call
  `resolveHarness(selected, codex ? async () => codex : codexSelection)` so
  the `CodexSelection` read once by `selectHarness` (or the injected
  `readCodex`) is reused and no second app-server session is opened.
- [x] 3.2 `src/cli.ts`: validate `--coverage` with `resolveCoverage` but set
  `config.coverage` only when the flag is given.

## 4. Tests (no real harness, no real TTY)

Every test below injects `probe`, `ask`/`interactive` and, whenever the run
may end on Codex, `selection.readCodex`; runner tests also inject
`createAdapter`. Codex tests assert `readCodex` was called exactly once.

- [x] 4.1 Both available, default answers -> `claude`, `claude-opus-5-5`,
  `medium`, 85; statuses on stderr; nothing on stdout but JSON; `readCodex`
  not called.
- [x] 4.2 Choosing Codex (through `selectHarness` and through `runQueue` with
  injected `selection.readCodex`), one of its models and efforts with a
  scripted catalog; effort list restricted to the model; `medium`-unsupported
  preselects the model's `defaultEfforts` entry; `readCodex` called once and
  `resolveHarness` reuses it.
- [x] 4.3 Codex model preselection: `config/read` model when in the catalog;
  with no `config/read` model (or one missing from the catalog) the
  `defaultModel` from `model/list` is preselected; with neither, the first
  catalog model.
- [x] 4.4 Only one harness available -> shown and preselected; unavailable
  harness answer re-asks.
- [x] 4.5 None available -> exit 4, `harness-unavailable`, message lists both
  harnesses and reasons; flag harness unavailable -> same refusal;
  `readCodex` not called; missing executable maps to `not-installed` in the
  default probe wrapper (using a nonexistent executable path, not a real
  harness).
- [x] 4.6 Flag-supplied (and JSON-supplied) values skip their prompts.
- [x] 4.7 Invalid coverage answer followed by a valid one.
- [x] 4.8 Non-interactive defaults; nothing asked.
- [x] 4.9 Restart reusing the recorded `codex`/`gpt-a`/`high`/90 selection
  without prompts, with injected `selection.readCodex` called once; differing
  flag refused as incompatible.
- [x] 4.10 Chosen values frozen in the identity like flags (including a Codex
  case with injected `selection.readCodex`); probes not called when the
  OpenSpec preflight refuses.
- [x] 4.11 Existing runner and CLI tests inject passing probes and remain
  green.

## 5. Documentation

- [x] 5.1 README: interactive startup order (OpenSpec, harness availability,
  harness, model, effort, coverage), preselected answers (including the Codex
  default model order), Enter behaviour, non-interactive defaults, restart
  reuse and `harness-unavailable` reasons.

## 6. Verification

- [x] 6.1 `npm run typecheck` passes.
- [x] 6.2 `npm test` passes, including the coverage gate.
