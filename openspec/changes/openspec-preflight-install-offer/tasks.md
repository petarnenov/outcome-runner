# Tasks

## 1. Preflight module

- [x] 1.1 Create `src/openspec-preflight.ts` with `PreflightError` (field
  `reason`), `PreflightDeps` and `openspecPreflight(config, deps)` with real
  defaults: TTY detection on stdin and stderr, readline prompt on stderr,
  `probe` = `spawnSync` without shell and with stdio `'ignore'` (child output
  discarded; used only for `openspec --version`), `exec` = `spawnSync` without
  shell forwarding child output to stderr (used only for the npm install), git
  fetch plus `ls-tree --name-only` for `openspec/config.yaml` at
  `origin/<target>`, `existsSync`, and exclusive file creation.
- [x] 1.2 Implement the CLI check (`probe('openspec', ['--version'])`),
  interactive install offer running exactly
  `npm install -g @fission-ai/openspec@latest` as an argument array via `exec`,
  re-check via `probe`, and `openspec-missing` refusals.
- [x] 1.3 Implement the config check, interactive layout offer creating only
  missing `openspec/config.yaml` (`schema: spec-driven`), `<changes>/.gitkeep`
  and `<receipts>/.gitkeep`, the commit-and-push message with reason
  `openspec-layout-created`, and `openspec-not-initialized` refusals.
- [x] 1.4 Non-interactive path never calls `ask`, never installs and never
  writes.
- [x] 1.5 Default `configPresent` returns false only when `git ls-tree` exits 0
  with empty output; any git failure (fetch or ls-tree nonzero, no `origin`,
  nonexistent target, spawn error) throws a plain `Error` without `reason`,
  which the preflight does not catch, so no prompt, no `say` about a missing
  config and no file creation happen.

## 2. Integration

- [x] 2.1 `src/runner.ts`: add `openspec?: Partial<PreflightDeps>` to
  `RunOptions`; call the preflight first in `runQueue`, before
  `resolveHarness`, the lock, claims and worktrees.
- [x] 2.2 `src/cli.ts`: `reportFailure` uses the error's `reason` when present
  (default `startup-or-run-failed`) in stdout and the diagnostics file.

## 3. Tests (no npm, openspec or real TTY)

- [x] 3.1 Available and initialized: `probe` called once with
  `openspec ['--version']`, `exec` never called, and `say` and `ask` record
  nothing (the version check writes nothing through `say`); no install.
- [x] 3.2 Missing CLI, yes, successful install via `exec` and successful
  re-check via `probe`.
- [x] 3.3 Missing CLI, yes, failing install -> `openspec-missing`; install ok
  but re-check failing -> `openspec-missing`.
- [x] 3.4 Missing CLI, no -> `openspec-missing`, no install.
- [x] 3.5 Missing config, yes -> only missing files created, no git commit or
  push, reason `openspec-layout-created` with commit-and-push message.
- [x] 3.6 Missing config, no -> `openspec-not-initialized`, nothing written.
- [x] 3.7 Non-interactive missing CLI and missing config refusals with nothing
  asked, installed or created.
- [x] 3.8 `main` maps a `PreflightError` to exit code 4 with its reason on
  stdout, and a plain error to `startup-or-run-failed`; prompts never reach
  the stdout writer.
- [x] 3.9 `runQueue` with a failing preflight refuses before harness resolution,
  adapter creation or lock; existing runner tests inject a passing preflight.
- [x] 3.10 Config check git failure: a scripted `configPresent` that throws, in
  both interactive and non-interactive mode, propagates an error without
  `reason` (reported as `startup-or-run-failed`), with no `ask`, no `say` about
  a missing config and no `writeFile`. The default `configPresent`, run against
  a temporary repository with a local bare `origin`, returns true when the
  config is committed, false when `ls-tree` is empty, and throws (never returns
  false) when there is no `origin` remote or the target branch does not exist.
- [x] 3.11 Default `probe` silence: a `node` helper under `test/support/` calls
  the default `probe` on `process.execPath` with a script printing to stdout
  and stderr; the test captures the helper's stdout and stderr, asserts both
  are empty and the status is 0; a nonexistent program yields a nonzero status.

## 4. Documentation

- [x] 4.1 README: describe the OpenSpec preflight, the install offer, layout
  creation (never committed or pushed), the TTY rule, stderr prompts, the
  silent happy path, the non-interactive refusals, the diagnostics reasons, and
  that git failures while reading `origin/<target>` are reported as
  `startup-or-run-failed`.

## 5. Verification

- [x] 5.1 `npm run typecheck` passes.
- [x] 5.2 `npm test` passes, including the coverage gate.
