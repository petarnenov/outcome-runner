# Tasks

## 1. Runner version

- [ ] 1.1 Create `src/runner-version.ts` with a cached `runnerVersion()` reading the package `version` from
  `../package.json` or `../../package.json` (design decision 1); make `Statistics` default its `version` clock to it.
- [ ] 1.2 Add `runnerVersion` to every diagnostics file written by `reportFailure` (decision 4).
- [ ] 1.3 Add optional `runnerVersion` to `RunState` and `RunStoreOptions.version`; stamp it on every
  `RunStore.update` and on the dispose state write; keep it out of the identity so older states resume (decision 4).
- [ ] 1.4 Stamp `runnerVersion` in the per-invocation ownership file wherever `src/runner.ts` writes it and when
  `disposeInvocation` rewrites it with `released: true`; keep reading ownership files without the field (decision 4).

## 2. CLI

- [ ] 2.1 Export `USAGE` and dispatch `--version`, `--help` and `-h` first in `run`, writing to stdout and returning
  0, without touching the ledger or creating diagnostics (decision 2).
- [ ] 2.2 Extend `printTaskHashes` with `{ ids, error }`; pass the remaining `hash` arguments as ids; report a missing
  queue argument or file and unknown ids as one stderr line with exit 4 and nothing on stdout; print only the
  requested ids in queue order (decision 3).

## 3. README

- [ ] 3.1 Replace the install and npx commands with the `--allow-git=root --allow-scripts=outcome-runner` forms,
  add the update rule (update only while no invocation is unfinished or after checking that it can resume; verify
  with `--version`), and document `--version`, `--help`, `hash <queue file> [<task id>...]`, the one-line stderr
  errors and `runnerVersion` in `state.json`, the ownership file and diagnostics files (decision 5).

## 4. Tests

Graded from E (easiest) to A (most complex); listed easiest first. CLI tests call `run`, `printTaskHashes` and
`main` in-process with captured stdout/stderr where possible, and spawn `bin/outcome-runner.ts` for the
end-to-end exit code checks.

### Grade E

- [ ] 4.1 (E) (required) `--version`: `run(['--version'])` writes exactly `<package.json version>\n` to stdout and
  returns 0; the spawned binary exits 0 with the same stdout. The spawned run uses an isolated ledger home and
  temporary directory (environment pointing to fresh temporary directories) and asserts that the ledger file is
  unchanged (absent before and after, or byte-identical) and that no `work-queue-error-*` diagnostics directory is
  created.
- [ ] 4.2 (E) (required) `--help` and `-h`: stdout of `--help` contains the run command with its flags,
  `hash <queue file> [<task id>...]`, `dispose <invocation file> [--remove-work]`, `--version` and `--help`; the
  stdout of `-h` is identical to the stdout of `--help`, and both are equal to the exported `USAGE`; exit code 0 for
  both.
- [ ] 4.3 (E) (coverage-only) `runnerVersion()` returns the `version` of `package.json` and the same value on a
  second call.

### Grade D

- [ ] 4.4 (D) (required) Hash with task ids: for a queue with `A` and `B`, `printTaskHashes(queue, out, { ids: ['B'] })`
  prints exactly `{ B: hash(B) }` and returns 0; through `run(['hash', queue, 'B'])` too; without ids every task is
  printed; a repeated id is printed once.
- [ ] 4.5 (D) (required) Missing queue file: `printTaskHashes(missing, out, { error })` returns 4, writes nothing to
  stdout, writes exactly one stderr line containing the path and no `    at ` stack frame; the spawned binary
  `hash <missing>` exits 4 with that one stderr line. Update the existing `missing` case in `test/cli.test.ts`.
- [ ] 4.6 (D) (required) Unknown task id: `hash <queue> X` returns 4, stdout empty, exactly one stderr line naming
  `X` without a stack frame; with two unknown ids both are named in one line.
- [ ] 4.7 (D) (coverage-only) `run(['hash'])` without a queue argument reports `missing queue file argument` on one
  stderr line with exit 4.

### Grade C

- [ ] 4.8 (C) (required) Diagnostics file version: a refused run (`main` with an invalid flag) and a malformed queue
  through `printTaskHashes` each print an `unavailable` line whose diagnostics file contains `runnerVersion` equal to
  the package version.
- [ ] 4.9 (C) (required) State file version: a `RunStore` created with `version: () => '9.9.9'` writes `state.json`
  with `runnerVersion` `9.9.9`; reopening a state without `runnerVersion` with the same identity succeeds and stamps
  the current version.

### Grade B

- [ ] 4.10 (B) (required) Ownership file version: a run through the runner fixture writes the ownership file at
  `invocationLockFiles(primary, stateDirectory).ownership` with `runnerVersion` equal to the package version; a
  dispose of that invocation rewrites it with `released: true` and `runnerVersion`; an ownership file written
  without `runnerVersion` is still recognised by dispose (`ownership: 'released'`).
- [ ] 4.11 (B) (coverage-only) A resumed invocation through the runner fixture after a version change (state stamped
  `0.0.1`, reopened with the current version) resumes without an incompatible-state refusal and ends with the new
  `runnerVersion` in `state.json`.

### Grade A

- [ ] 4.12 (A) (coverage-only) Dispose of a blocked invocation stamps `runnerVersion` in the written `state.json`
  while leaving the rest of the dispose record unchanged.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with the coverage gate at 85%.
