# Design: Clear CLI usage, version and install guidance

## Context

`run(argv)` in `src/cli.ts` dispatches `dispose` and `hash` and treats any other first argument as an invocation
file for `main`. `printTaskHashes(queuePath, output)` validates the queue and prints `{id: hash}` for every task;
every failure goes through `reportFailure`, which writes `{status:'unavailable', reason, diagnostics}` to stdout and a
private `error.json` with `reason`, `message`, `stack` and optional `details`. `Statistics` already reads the
package version (`../package.json` from `src/`, `../../package.json` from `dist/src/`) into the ledger's
`runnerVersion`. `RunStore.update` writes `state.json` on every change. The runner also writes a per-invocation
ownership file `<hash(primary)>-<hash(stateDirectory)>-owner.json` (`invocationLockFiles` in `src/runner.ts`), and
`disposeInvocation` in `src/dispose.ts` rewrites it with `released: true`.

## Decisions

### 1. One runner version helper

New `src/runner-version.ts` exports `runnerVersion(): string`, moving the existing lookup out of `Statistics`:
read `package.json` next to the package root (`../package.json` relative to the module, or `../../package.json`
when built into `dist/src`) and return its `version`. The result is cached after the first read. `Statistics` keeps
its injectable `version` clock but defaults it to `runnerVersion`. This is the version of the executing
installation, never a hardcoded literal.

### 2. `--version` and `--help`

`run` checks the first argument before any other dispatch:

- `--version` writes `<version>\n` (the bare version, for example `0.20.1`) to stdout and returns 0.
- `--help` or `-h` writes the usage text to stdout and returns 0.

Neither reads a file, resolves a repository, plays the mascot, appends a ledger record or creates a diagnostics
file. Further arguments after them are ignored. The usage text is a constant `USAGE` exported from `src/cli.ts`;
`--help` and `-h` write exactly `USAGE`. It lists, one per line:

```text
Usage:
  outcome-runner <invocation file> [--harness=<claude|codex>] [--model=<id>] [--effort=<level>] [--coverage=<n>] [--no-mascot] [--retry <task id>]...
  outcome-runner hash <queue file> [<task id>...]
  outcome-runner dispose <invocation file> [--remove-work]
  outcome-runner --version
  outcome-runner --help
```

followed by one short line per command and the README link. `outcome-runner` with no arguments keeps its current
behaviour (an `unavailable` refusal) to avoid changing run semantics in this task.

### 3. `hash` with task ids and one-line errors

`printTaskHashes(queuePath, output = stdout, { ids = [], error = stderr } = {})`. `run(['hash', queue, ...ids])`
passes the remaining arguments as `ids`.

1. A missing `queuePath` argument, or a file that does not exist (`ENOENT`) or is not a regular file, writes
   `outcome-runner hash: queue file not found: <queuePath>\n` to `error` (for a missing argument:
   `outcome-runner hash: missing queue file argument`) and returns 4.
2. The queue is validated as today. Invalid or malformed queues keep the existing `reportFailure` path (stdout
   `unavailable` line with diagnostics), because the README already documents it.
3. With `ids`, every id must name a task in the queue. When any id is unknown, one line is written to `error`:
   `outcome-runner hash: unknown task id: <id>\n` for one unknown id, or
   `outcome-runner hash: unknown task ids: <id>, <id>\n` naming every unknown id in argument order; the command
   returns 4 and writes nothing to `output`. Repeated ids are printed once.
4. Otherwise it writes one JSON line mapping only the requested ids (all tasks when `ids` is empty) to their
   hashes, in queue order, and returns 0.

The argument in the error line is printed with `JSON.stringify` when it contains a control character or a newline,
so the message stays one line. No stack and no diagnostics file is produced for these two errors.

### 4. Runner version in run and diagnostics files

The run files of criterion 3 are every file the runner writes for an invocation outside the repository history:
`state.json`, the per-invocation ownership file, the diagnostics file `error.json` and the statistics ledger record.

- `reportFailure` writes `runnerVersion` into every `error.json` (also used by `dispose` and the `hash` validation
  failures).
- `RunState` gets an optional `runnerVersion?: string`. `RunStore.update` sets it to `runnerVersion()` on every
  write, so `state.json` always names the version of the runner that last wrote it. A state written by an older
  runner without the field still opens; it is not part of the identity, so a version change never makes a resume
  incompatible. `RunStore` takes the version through an optional `RunStoreOptions.version` (default
  `runnerVersion`) so tests can inject it. `writeStateFile` callers outside `RunStore` (dispose) spread the
  existing state and also stamp the field.
- The ownership file `<hash(primary)>-<hash(stateDirectory)>-owner.json` gets `runnerVersion` wherever the runner
  writes it in `src/runner.ts`, and `disposeInvocation` stamps the current `runnerVersion()` when it rewrites the file
  with `released: true`. Readers of the ownership file only compare `stateDirectory` and the owner fields and ignore
  unknown fields, so an ownership file without the field (older runner) is still read as before and the field never
  decides ownership.
- The ledger already carries `runnerVersion`; it now uses the shared helper.

The lock file `<key>.sqlite` holds no record (it exists only for its SQLite lock) and is not changed. Receipts
committed to the repository are not changed: they are acceptance evidence whose format is validated across runner
versions, not run files.

### 5. README

- Replace every global install command with
  `npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner` and the npx form with
  the same two flags. Explain that `--allow-scripts=outcome-runner` lets npm run the package's build during the Git
  install.
- Add an "Updating the runner" note: the same command updates the global runner; check the result with
  `outcome-runner --version`; update only while no invocation is unfinished, or after checking that the unfinished
  invocation can resume with the new runner (see the upgrading section), and never while a run is in progress.
- Document `--version`, `--help`, `hash <queue file> [<task id>...]`, the one-line stderr errors with exit code 4,
  and `runnerVersion` in `state.json`, the ownership file and the diagnostics file.

## Risks

- Changing the missing-queue output from stdout `unavailable` to a stderr line changes an existing test
  expectation (`test/cli.test.ts`); the README's "On `unavailable`" sentence is adjusted for the missing case.
- Stamping `runnerVersion` adds one field to `state.json` and the ownership file; tests comparing whole state or
  ownership objects must tolerate it.
