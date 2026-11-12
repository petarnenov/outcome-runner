# Clear CLI usage, version and install guidance

## Why

`outcome-runner` has no `--version` or `--help`: an unknown first argument is treated as an invocation file and
ends in an `unavailable` line. `outcome-runner hash` always prints every task and reports a missing queue file only
through a private diagnostics file. Nothing written by a run except the statistics ledger names the runner version,
so an outdated global install is hard to notice. The README install command lacks
`--allow-scripts=outcome-runner`, which npm needs to run the package's build script during a global Git install, and
does not say when updating the global runner is safe.

## What Changes

- `outcome-runner --version` prints the installed package version; `outcome-runner --help` (and `-h`) prints the
  commands and their arguments. Both write to stdout and exit 0, and neither reads a queue, invocation or state.
- `outcome-runner hash <queue file> [<task id>...]` prints the hashes of only the given task ids (all tasks when
  none are given). A missing queue file or an unknown task id is reported as one line on stderr naming the argument,
  with exit code 4 and no stack trace; nothing is printed on stdout.
- The run state file (`state.json`), the per-invocation ownership file, every diagnostics file (`error.json`) and
  the run statistics ledger record carry `runnerVersion`, read from one shared helper.
- README: the exact global install and update command
  `npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner`, the `--version` and
  `--help` commands, `hash` with task ids, and the rule to update the global runner only while no invocation is
  unfinished or after checking that the unfinished invocation can resume.

## Capabilities

### New Capabilities

- `cli-usage-and-install`: version and help output, selective task hashing with one-line argument errors, the
  runner version in run and diagnostics files, and the documented install and update command.

## Impact

- `src/cli.ts` (dispatch, help text, `printTaskHashes`, `reportFailure`), a new `src/runner-version.ts`,
  `src/statistics.ts` (uses the helper), `src/run-store.ts` (stamps `runnerVersion`), `src/runner.ts` and
  `src/dispose.ts` (stamp `runnerVersion` in the ownership file).
- `test/cli.test.ts` (the missing-queue expectation changes) and a new `test/cli-usage.test.ts`.
- `README.md`. `package.json` is in scope but needs no change; the version stays owned by the release workflow.
