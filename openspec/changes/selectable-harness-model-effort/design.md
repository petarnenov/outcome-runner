# Design: selectable model and effort per harness

## Context

- `src/harness.ts` `resolveHarness` defaults Claude to `claude-opus-5-5`/`medium`
  and throws `Claude requires Opus 5.5 medium` for anything else; for Codex it
  reads `config/read` via `codexDefaults` and checks effort against a hard-coded
  list `['minimal','low','medium','high','xhigh']`.
- `src/claude-adapter.ts` constructor throws `Unsupported Claude model or effort`
  unless model/effort are the Opus 5.5 medium pair. `arguments()` already passes
  `--model this.model --effort this.effort`; `observeMessage` already verifies the
  init `model`, assistant `message.model` and result `modelUsage[].canonicalModel`
  against `this.model`.
- `src/codex-adapter.ts` has `connect()` and `rpc()`; it does no model or effort
  check of its own.
- `src/cli.ts` `main` accepts at most one `--harness=` argument.
- `runQueue` calls `resolveHarness` first, before the lock, claim or worktree, and
  any thrown error becomes exit code 4 with a private diagnostics file holding the
  message. `hash(config)` of the resolved config is the ownership identity and
  `RunStore` refuses an incompatible identity.

## Goals / Non-Goals

Goals: one source of truth for models/efforts per harness; selectable model and
effort for both harnesses; refusal before allocation naming the bad value;
unchanged defaults and identity freezing.

Non-goals: changing the Claude message verification rules, the Codex restriction
set, run store format, or adding a command that lists catalogs.

## Decisions

### Catalog module `src/harness-catalog.ts`

```ts
export type Catalog = Map<string, string[]>; // model id -> supported efforts
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export const claudeCatalog: Catalog; // opus-5-5, sonnet-5-5, haiku-5-5, fable-5-2
export async function codexCatalog(rpc: <R>(method: string, params: object) => Promise<R>): Promise<Catalog>;
export async function harnessCatalog(harness: Harness, codex?: () => Promise<Catalog>): Promise<Catalog>;
export function assertSelection(harness: Harness, catalog: Catalog, model: string, effort: string): void;
```

- `codexCatalog` calls `model/list` with `{ cursor, includeHidden: false }`,
  starting with no cursor and repeating with the returned `nextCursor` until it is
  null/absent. Entries with `hidden: true` are skipped even if returned. The model
  identifier is the entry's `model` field (the value Codex accepts as its `model`
  configuration), falling back to `id` when `model` is absent. Efforts are
  `supportedReasoningEfforts.map(e => e.reasoningEffort)`. A malformed page
  (missing `data` array) throws. A repeated cursor throws to avoid an endless
  loop.
- `assertSelection` throws `Model "<model>" is not offered by harness <harness>`
  when the model is absent, and `Effort "<effort>" is not supported by model
  "<model>" of harness <harness>` when the effort is absent from the model's list.
  These messages land in the existing diagnostics file (exit code 4).
- Rationale: a `Map` keeps lookup trivial; passing an `rpc` function keeps the
  module free of process spawning and makes it scriptable in tests.

### `src/harness.ts`

- `codexDefaults` becomes `codexSelection(cwd, create)` returning
  `{ model?, effort?, catalog }`. It creates exactly one CodexAdapter, calls
  `connect()` on it exactly once, then sends `config/read` (defaults) and calls
  `adapter.models()` (catalog) over that same connection, and closes the adapter
  in a `finally`. Exactly one app-server process is spawned per call.
- `resolveHarness(config, readCodex = codexSelection)`:
  1. harness = `config.harness ?? 'claude'`; unknown harness throws `Unknown
     outcome harness`.
  2. Claude: `model ??= 'claude-opus-5-5'`, `effort ??= 'medium'`, catalog =
     `claudeCatalog`. No Codex process is started.
  3. Codex: always calls `readCodex(config.root)` (catalog is needed even when
     both values are explicit); fills omitted model/effort from its defaults.
  4. Missing model or effort after resolution throws `Resolved model and effort
     are required`.
  5. `assertSelection(harness, catalog, model, effort)`.
  The hard-coded effort list and the Opus-only check are removed.
- `createHarness` is unchanged.

### `src/claude-adapter.ts`

The constructor keeps the defaults `claude-opus-5-5`/`medium` and replaces the
hard-coded check with `assertSelection('claude', claudeCatalog, model, effort)`.
Verification in `observeMessage` is unchanged and compares against the selected
`this.model`, so a Sonnet run must report Sonnet in init, assistant and result.

### `src/codex-adapter.ts`

Add `models(): Promise<Catalog>` returning `codexCatalog((m, p) => this.rpc(m, p))`.
`models()` requires an already-connected adapter: it does not call `connect()`
and never spawns a process. Called before `connect()` (no live child), it throws
`Codex adapter is not connected`. The caller (`codexSelection`) owns the single
`connect()`/close lifecycle, so the one-session decision holds and no child
process is left without an owner. No hard-coded model or effort values exist or
are added.

### `src/cli.ts`

Parse each argument against `/^--(harness|model|effort)=(.+)$/u`; harness value
must be `claude` or `codex`. A non-matching argument, an empty value or a repeated
flag throws `Expected --harness=<claude|codex>, --model=<id> and --effort=<level>,
each at most once`. Matching values are assigned to `config.harness`,
`config.model`, `config.effort`, overriding the JSON fields. Validation of model
and effort values is left to `resolveHarness` (inside `runQueue`), so unknown
values still fail before allocation with exit code 4.

### Identity

No change: `resolveHarness` returns the resolved triple in the config hashed for
ownership and stored by `RunStore`; CLI overrides are applied before resolution so
they take part in identity. A restart resolving a different value is refused.

### README

- `Start and resume`: describe the catalog per harness, the three flags, CLI over
  JSON precedence, refusal with exit code 4, and unchanged defaults; replace the
  statement that Claude is pinned to Opus 5.5 medium ("exact model
  `claude-opus-5-5`, effort `medium`. No fallback is permitted.").
  - Add a sentence stating that the Claude catalog is a static list of exact
    model IDs, updated with the runner when Claude Code accepts new IDs.
  - Remove the sentence "The CLI flag overrides the JSON harness only; explicit
    model/effort values remain." and replace it with the new rule: `--harness=`,
    `--model=` and `--effort=` each override the JSON `harness`, `model` and
    `effort` respectively.
  - Replace the sentence "Leave those optional fields unset for a shared
    template, or use values consistent with the selected harness." so it states
    that a model not offered by the selected harness's catalog, or an effort the
    selected model does not support, is refused before allocation with exit code
    4 and a diagnostics message naming the rejected value (omitted fields still
    fall back to the defaults).
  - Replace the text saying Claude is selected only through the harness flag or
    JSON with: Claude is used when both CLI and JSON harness are omitted, or when
    `--harness=claude` / JSON `"harness": "claude"` is given; model and effort
    are then selectable independently through flags or JSON.
- `Quick start`: replace "Add `--harness=codex` to use Codex." with text showing
  `--harness=`, `--model=`, `--effort=`; listing Claude models `claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2` and efforts `low`,
  `medium`, `high`, `xhigh`, `max`; stating that Codex models/efforts come from
  `model/list`; and that defaults remain `claude` / `claude-opus-5-5` / `medium`
  (omitted Codex values from local Codex configuration).

## Risks / Trade-offs

- Codex runs now always spawn a short app-server session for `model/list`, even
  with explicit model/effort. Acceptable: it is read-only, it is the same single
  session already used for defaults, and it is closed before allocation.
- A Codex default effort from local config that the model does not list is now
  refused instead of passed through. This is the requested behavior.
- The Claude catalog is static and must be updated when Claude Code accepts new
  IDs; the README states this (required by the README section above and task
  5.1).

## Migration

Existing invocations with omitted values resolve identically, so their identity
hash is unchanged and they resume normally.
