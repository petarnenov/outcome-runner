# OpenSpec preflight with install offer

## Why

OR-3 requires the runner to confirm that OpenSpec is usable before it does any
work. Today a missing `openspec` CLI only surfaces when the planning check
(`openspec validate ...`) fails deep inside a claimed task, and a repository
without `openspec/config.yaml` on `origin/<target>` is only discovered by
workers. Both waste a claim, a worktree and harness sessions.

## What Changes

- Add an OpenSpec preflight that runs first in `runQueue`, before harness
  resolution (probes, Codex app-server, any later selection prompt), the lock,
  claims and worktrees. It checks that `openspec --version` exits 0 (its output
  discarded, so the happy path is silent) and that `openspec/config.yaml`
  exists at `origin/<target>`.
- Startup is interactive only when both `process.stdin` and `process.stderr` are
  TTYs. Prompts, explanations and npm install output go to stderr; stdout keeps
  only the existing JSON lines.
- Interactive missing CLI: offer `npm install -g @fission-ai/openspec@latest`,
  run it as an argument array on yes, then re-check. Otherwise exit code 4 with
  diagnostics reason `openspec-missing`.
- Interactive missing config: offer to create the missing files of the project
  layout (`openspec/config.yaml` with `schema: spec-driven`,
  `<changes>/.gitkeep`, `<receipts>/.gitkeep`) in the working tree, never
  committing or pushing, then exit code 4 telling the user to commit and push.
  On no, exit code 4 with reason `openspec-not-initialized`.
- Non-interactive: never ask, install or create; refuse with exit code 4 and the
  matching reason.
- The CLI's startup failure output carries a specific `reason` when the error
  provides one, instead of always `startup-or-run-failed`.
- Prompt input, process execution (a silent `probe` for the version check and a
  forwarding `exec` for the install), file creation and the TTY decision are
  injectable; tests never run npm, openspec or a real TTY.
- README documents the preflight, the install offer and non-interactive
  behaviour.

## Impact and Scope

Depends on accepted OR-2. Implementation is limited to `src`, `test` and
`README.md`. New module `src/openspec-preflight.ts`; small changes to
`src/runner.ts` (call the preflight first, injectable through `RunOptions`) and
`src/cli.ts` (reason propagation). Existing runner tests gain a scripted
passing preflight so no test executes the real `openspec` binary.

This planning session writes only the proposal, design, tasks and capability
specification.

## Acceptance

The `openspec-preflight` delta specifies every OR-3 criterion as scenarios.
Implementation acceptance requires `npm run typecheck` and `npm test` to pass,
including the coverage gate.
