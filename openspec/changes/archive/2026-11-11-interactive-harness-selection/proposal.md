# Proposal: Interactive harness, model, effort and coverage selection

## Why

Today the runner silently falls back to `claude`, `claude-opus-5-5`, `medium`
and coverage 85 when they are not given by flag or invocation JSON. A user
starting the runner in a terminal cannot see which harnesses are installed and
certified, nor pick a model or effort without knowing the exact identifiers.
A missing `claude` or `codex` executable surfaces only later, as a thrown
`execFileSync` error from a worker session, after lock, claim and worktree.

## What Changes

- After the OpenSpec preflight (OR-3) and before harness resolution, lock,
  claims and worktrees, the runner probes both harnesses with their existing
  version probes (Claude Code >= 2.1.321, Codex CLI >= 0.167.0). A missing
  executable is reported as unavailable with reason `not-installed` instead of
  failing the run.
- Interactive startup (stdin and stderr are TTYs, prompts on stderr, exactly as
  the OpenSpec preflight) shows each harness with its status and version or
  reason and then asks, in order: harness (available ones only, `claude`
  preselected when available), model (from the OR-1 catalog,
  `claude-opus-5-5` for Claude; for Codex its configured model, else the
  `model/list` default model, else the first catalog model), effort (only
  those the chosen model supports, `medium` preselected when supported,
  otherwise the model's default effort from `model/list`) and coverage
  threshold (85 preselected, integer 1..100, re-asked on invalid input). Enter
  accepts the preselected answer. Values given by CLI flag or invocation JSON
  are not asked.
- No available harness, or a flag/JSON harness that is unavailable, exits with
  code 4 and diagnostics reason `harness-unavailable` listing every harness and
  its reason.
- Non-interactive startup asks nothing and applies flags, JSON and defaults
  (`claude`, `claude-opus-5-5`, `medium`, 85); the selected harness must be
  available.
- On restart of an invocation whose state already records harness, model,
  effort and coverage, no prompt is shown and the recorded selection is reused;
  differing flag or JSON values are refused as today (incompatible state).
- The chosen values enter the run configuration before its identity is hashed,
  so they are frozen exactly like flag values.
- Codex configuration and catalog are read once per start (by the selection)
  and reused by harness resolution, so no second app-server session opens.
- Prompt input, harness probes and the Codex reader are injectable; tests
  never start a real harness.
- README documents the startup order: OpenSpec, harness availability, harness,
  model, effort, coverage.

## Capabilities

### New Capabilities

- `interactive-harness-selection`: harness availability check and interactive
  selection of harness, model, effort and coverage at startup.

## Impact

- `src/`: new `src/harness-selection.ts`; `src/runner.ts` (call order,
  `RunOptions.selection`, reuse of the selection's Codex read in
  `resolveHarness`); `src/cli.ts` (coverage stays unset when not given);
  `src/claude-adapter.ts` / `src/codex-adapter.ts` probes reused through a
  wrapper that maps a missing executable to `not-installed`;
  `src/harness-catalog.ts` adds `CodexModels` / `codexModels` (default model
  and per-model default efforts) while `Catalog` and `codexCatalog` stay
  unchanged; `src/codex-adapter.ts` adds `modelList()`; `src/harness.ts`
  `CodexSelection` gains optional `defaultModel` and `defaultEfforts`.
- `test/`: new `test/harness-selection.test.ts`; catalog tests for
  `codexModels`; existing runner and CLI tests inject passing harness probes.
- `README.md`: startup order and selection documentation.
- Depends on OR-1 (catalog), OR-2 (coverage threshold), OR-3 (OpenSpec
  preflight).
