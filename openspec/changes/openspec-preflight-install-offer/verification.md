# Verification: OpenSpec preflight with install offer

## Implementation

- `src/openspec-preflight.ts`: `PreflightError` (field `reason`), injectable
  `PreflightDeps` (`interactive`, `ask`, `say`, `probe`, `exec`, `configPresent`,
  `exists`, `writeFile`), real defaults and `openspecPreflight`.
- `src/runner.ts`: `RunOptions.openspec`; `runQueue` awaits the preflight as its
  first statement, before `resolveHarness`, the lock, claims and worktrees.
- `src/cli.ts`: `reportFailure` reports a nonempty `error.reason` (default
  `startup-or-run-failed`) on stdout and in the diagnostics file.
- `README.md`: new "OpenSpec preflight" section plus pointers from Quick start,
  the exit-code table and "Start and resume".

## Tests

`test/openspec-preflight.test.ts` covers: available and initialized (silent,
exactly one `openspec --version` probe); missing CLI with yes and a successful
install (exact `npm` argument array, re-check); yes with a failing install; install
succeeding while the re-check fails; no and empty answers; missing config with
yes (only missing files, existing file untouched, `openspec-layout-created`, a
real working-tree run proving no commit or push) and with no
(`openspec-not-initialized`); non-interactive refusals; git failures in the
config check (no reason, prompt, explanation or file); the default config check
against a local bare origin (present, empty listing, missing branch, no origin);
the TTY rule; the default prompt, silent probe and stderr-forwarding installer
via `node` helpers only; runner ordering before harness, adapter and lock; and
`main` reason mapping with prompts kept off stdout.

Existing `runQueue` callers in `test/runner.test.ts`,
`test/harness-catalog.test.ts` and `test/support/work-queue-child.ts` inject a
scripted passing preflight. `test/zz-debug-capture.test.ts` checks that the README
documents the preflight. Its name is left over from a diagnostic step and could
not be renamed through the available file operations.

No test runs npm, the openspec binary for the preflight, or a real TTY.
