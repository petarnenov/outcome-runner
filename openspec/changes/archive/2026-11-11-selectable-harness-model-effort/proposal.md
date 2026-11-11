# Selectable model and effort per harness

## Why

The runner pins Claude to `claude-opus-5-5` with effort `medium` and rejects every
other combination in two places (`src/harness.ts` and the `ClaudeAdapter`
constructor). Codex model and effort are taken from local configuration and only
checked against a hard-coded effort list. Operators cannot choose a cheaper or
stronger model, or a different reasoning effort, per invocation, and the knowledge
of what each harness offers is scattered across modules.

## What Changes

- Add one catalog module `src/harness-catalog.ts` that answers which models each
  harness offers and which efforts each model supports.
  - Claude: static catalog of `claude-opus-5-5`, `claude-sonnet-5-5`,
    `claude-haiku-5-5` and `claude-fable-5-2`, each with efforts `low`, `medium`,
    `high`, `xhigh` and `max`.
  - Codex: models returned by the app-server RPC `model/list` (all pages,
    following `nextCursor`, hidden models excluded) with efforts from
    `supportedReasoningEfforts[].reasoningEffort`, read over the same single
    app-server session that already reads Codex defaults.
- `src/harness.ts`, `src/claude-adapter.ts` and `src/codex-adapter.ts` use the
  catalog instead of their own hard-coded model and effort checks.
- **BREAKING (relaxation)**: remove the restriction "Claude requires Opus 5.5
  medium" and the ClaudeAdapter check "Unsupported Claude model or effort". Any
  catalog combination is accepted and passed to
  `claude --model <id> --effort <level>`; the existing pinned-model verification
  of init, assistant and result messages applies to the selected model.
- A model or effort that the selected harness does not offer, or an effort the
  selected model does not support, is refused before allocation (exit code 4)
  with a diagnostics message naming the rejected value.
- Defaults are unchanged: omitted harness, model and effort resolve to `claude`,
  `claude-opus-5-5`, `medium`; omitted Codex model and effort are resolved from
  the local Codex configuration.
- CLI accepts `--model=<id>` and `--effort=<level>` besides
  `--harness=<claude|codex>`, in any order, each at most once; anything else is
  refused with exit code 4. CLI values override invocation JSON `model`/`effort`.
- Resolved harness, model and effort remain part of the frozen invocation
  identity.
- Tests are updated. README `Start and resume` and `Quick start` both document
  the three flags, the Claude models and efforts listed above, that Codex models
  and efforts come from `model/list`, and the unchanged defaults
  (`claude` / `claude-opus-5-5` / `medium`, Codex from local configuration); the
  Opus 5.5 medium pinning statement and the Quick start line "Add
  `--harness=codex` to use Codex." are replaced.

## Capabilities

### New Capabilities

- `harness-model-selection`: catalog of models and efforts per harness,
  resolution and validation of the selected harness/model/effort, and the CLI
  flags that select them.

### Modified Capabilities

None recorded as specs yet; the behavior changed here (Claude pinning, CLI
harness flag) is captured in full by the new capability.

## Impact

- Code: new `src/harness-catalog.ts`; changes in `src/harness.ts`,
  `src/claude-adapter.ts`, `src/codex-adapter.ts`, `src/cli.ts`.
- Tests: `test/runner-harness.test.ts`, `test/runner-claude.test.ts`,
  `test/cli.test.ts` (or a new `test/harness-catalog.test.ts`). No test starts a
  real harness.
- Docs: `README.md` sections `Start and resume` and `Quick start`.
- No change to queue, receipts, run store format or invocation identity hashing.
