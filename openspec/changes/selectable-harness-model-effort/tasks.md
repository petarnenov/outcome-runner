# Tasks

## 1. Catalog module

- [ ] 1.1 Create `src/harness-catalog.ts` with the static Claude catalog
  (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`;
  efforts `low`, `medium`, `high`, `xhigh`, `max`).
- [ ] 1.2 Implement `codexCatalog(rpc)` over `model/list`: follow `nextCursor`
  across all pages, exclude `hidden` models, read efforts from
  `supportedReasoningEfforts[].reasoningEffort`, refuse malformed pages and
  repeated cursors.
- [ ] 1.3 Implement `assertSelection(harness, catalog, model, effort)` with messages
  naming the rejected model or effort.

## 2. Use the catalog

- [ ] 2.1 `src/harness.ts`: replace the Opus-only check and the hard-coded effort
  list; read Codex defaults and catalog in one adapter session
  (`codexSelection`: create one adapter, call `connect()` once, then
  `config/read` and `adapter.models()` on that same connection, then close);
  keep defaults `claude`/`claude-opus-5-5`/`medium`.
- [ ] 2.2 `src/claude-adapter.ts`: remove `Unsupported Claude model or effort`;
  validate via the catalog; keep init/assistant/result verification against the
  selected model.
- [ ] 2.3 `src/codex-adapter.ts`: add `models()` delegating to `codexCatalog`
  over the existing connection. `models()` requires an already-connected adapter,
  does not call `connect()` and does not spawn a process; called on an
  unconnected adapter it throws.

## 3. CLI

- [ ] 3.1 `src/cli.ts`: accept `--harness=`, `--model=`, `--effort=` in any order,
  each at most once, nonempty; refuse anything else (exit code 4); CLI values
  override JSON `harness`, `model`, `effort`.

## 4. Tests (no real harness)

- [ ] 4.1 Claude catalog lookup and Codex catalog via a scripted `model/list`
  with pagination and a hidden model.
- [ ] 4.2 Default resolution (all omitted; Codex defaults from configuration;
  partial Codex selection).
- [ ] 4.3 Refusal of unknown model and unsupported effort, with the value in the
  error message; refusal through `main` yields exit code 4.
- [ ] 4.4 CLI flag parsing in any order, precedence over JSON, repeated/empty/
  unknown arguments refused.
- [ ] 4.5 ClaudeAdapter with `claude-sonnet-5-5` (non-Opus): arguments carry the
  selected model/effort; a scripted run succeeds; mismatching model is rejected.
- [ ] 4.6 Update existing tests asserting the removed Opus-only messages;
  identity test still refuses a changed model/effort.
- [ ] 4.7 `codexSelection` with a scripted spawn: assert exactly one process is
  spawned and both `config/read` and `model/list` are sent over that one
  process, which is closed afterwards. `CodexAdapter.models()` on an unconnected
  adapter throws without spawning.

## 5. Documentation

- [ ] 5.1 README `Start and resume`: document catalogs, flags, precedence and
  unchanged defaults, and:
  - replace the Opus 5.5 medium pinning statement ("exact model
    `claude-opus-5-5`, effort `medium`. No fallback is permitted.");
  - add a sentence stating that the Claude catalog is a static list of exact
    model IDs, updated with the runner when Claude Code accepts new IDs;
  - remove the sentence "The CLI flag overrides the JSON harness only; explicit
    model/effort values remain." and replace it with the new rule: `--harness=`,
    `--model=` and `--effort=` each override the JSON `harness`, `model` and
    `effort` respectively;
  - replace "Leave those optional fields unset for a shared template, or use
    values consistent with the selected harness." with a statement that a model
    not offered by the selected harness's catalog, or an effort the selected
    model does not support, is refused before allocation with exit code 4 and a
    diagnostics message naming the rejected value;
  - reword the Claude selection sentences so they no longer imply Claude is
    chosen only through the harness flag or JSON with a fixed model: Claude is
    used when both harness values are omitted or `claude` is given, and model
    and effort are selectable through flags or JSON.
- [ ] 5.2 README `Quick start`: replace the line "Add `--harness=codex` to use
  Codex." with text that shows `--harness=`, `--model=` and `--effort=`; lists
  the Claude models `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`,
  `claude-fable-5-2` and efforts `low`, `medium`, `high`, `xhigh`, `max`; states
  that Codex models and efforts come from the app-server `model/list`; and states
  that defaults stay `claude` / `claude-opus-5-5` / `medium`, with omitted Codex
  model and effort taken from the local Codex configuration.
- [ ] 5.3 After editing, confirm no README sentence still says the CLI overrides
  only the harness, or that Claude is pinned to Opus 5.5 medium, and that the
  static-Claude-catalog sentence from 5.1 is present.

## 6. Verification

- [ ] 6.1 `npm run typecheck` passes.
- [ ] 6.2 `npm test` passes, including the 85% coverage gate.
