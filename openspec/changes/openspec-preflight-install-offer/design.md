# Design: OpenSpec preflight with install offer

## Existing Behavior

`src/cli.ts` `main` reads the invocation JSON, applies flags and calls
`runQueue`; any thrown error becomes one stdout JSON line
`{status:'unavailable', reason:'startup-or-run-failed', diagnostics}` and exit
code 4, with `{message, stack}` in a private diagnostics file. `runQueue` first
calls `resolveHarness` (which, for Codex, spawns the app-server to read defaults
and catalog), then validates configuration, takes the SQLite lock, fetches
`origin/<target>`, claims and creates worktrees. OpenSpec is used only through
`project.planningCheck`.

## Placement

New module `src/openspec-preflight.ts` exporting
`openspecPreflight(config: RunConfig, deps?: Partial<PreflightDeps>): Promise<void>`.
`runQueue` calls it as its first statement, before `resolveHarness`, so it
precedes every harness check, any selection prompt (OR-4 will add those after
it), the lock, claims and worktrees. `RunOptions` gains
`openspec?: Partial<PreflightDeps>` passed through unchanged.

The preflight uses `config.root` (realpath), `config.project.target`,
`config.project.changes` and `config.project.receipts`. It validates these with
the existing `safePath` before use, because full `validateConfig` runs after
harness resolution.

## Injectable dependencies

```ts
interface PreflightDeps {
  interactive: boolean;                       // default: Boolean(process.stdin.isTTY && process.stderr.isTTY)
  ask: (question: string) => Promise<string>; // default: readline on stdin, question written to stderr
  say: (text: string) => void;                // default: process.stderr.write
  probe: (program: string, args: string[], cwd: string) => { status: number | null };
                                              // default: spawnSync, stdio 'ignore', no shell;
                                              // used ONLY for `openspec --version`; child output is discarded
  exec: (program: string, args: string[], cwd: string) => { status: number | null };
                                              // default: spawnSync, stdio ['ignore', stderr fd, stderr fd], no shell;
                                              // used ONLY for the npm install
  configPresent: (root: string, target: string) => boolean;
                                              // default: git fetch origin <target>, then
                                              // git ls-tree --name-only origin/<target> -- openspec/config.yaml;
                                              // returns false ONLY when ls-tree succeeds with empty output;
                                              // any git failure throws (see "Git failures")
  exists: (path: string) => boolean;          // default: existsSync
  writeFile: (path: string, content: string) => void; // default: mkdirSync(dirname, recursive) + writeFileSync with flag 'wx'
}
```

Neither `probe` nor `exec` uses a shell, and neither writes to stdout, so
stdout stays reserved for JSON lines. `probe` discards the child's stdout and
stderr entirely, so the version check prints nothing in the happy path (the
version string never reaches the terminal). `exec` forwards the npm install's
stdout and stderr to the parent stderr so the user sees install progress. A
spawn error (for example ENOENT) counts as a nonzero status for both. `ask` is
only called when `interactive` is true. Answers `y` or `yes` (trimmed,
case-insensitive) mean yes; anything else, including an empty line or closed
stdin, means no.

## Git failures

The default `configPresent` uses the existing `git(root, ...)` helper from
`src/git.ts`, which throws on any nonzero exit (and runs with
`GIT_TERMINAL_PROMPT=0`). Only a fetch that succeeds followed by an `ls-tree`
that exits 0 decides the answer: output listing `openspec/config.yaml` means
present, empty output means missing. Every other outcome, for example no
network, no `origin` remote, a nonexistent `<target>` branch, an unknown
revision or a spawn error, is thrown as a plain `Error` (message naming the
failing git step) and is not caught by the preflight. It therefore carries no
`reason`, so `src/cli.ts` reports `startup-or-run-failed` with exit code 4.
In that case nothing is asked (interactive or not), no `say` explanation about
a missing config is printed, no layout file is created and neither
`openspec-not-initialized` nor `openspec-layout-created` is reported, because
the runner cannot know whether `origin/<target>` contains the config. The
`git` helper captures its child output, so a successful config check prints
nothing either.

## Flow

1. CLI check: `probe('openspec', ['--version'], root)`; available when status
   0. Output is discarded.
2. If unavailable:
   - non-interactive: throw `PreflightError('openspec-missing', ...)`;
   - interactive: `say` an explanation that the OpenSpec CLI is missing, then
     `ask` whether to run `npm install -g @fission-ai/openspec@latest`. On yes
     `exec('npm', ['install', '-g', '@fission-ai/openspec@latest'], root)`; if
     it exits 0, repeat step 1 (again via `probe`). On no, nonzero install, or
     a still failing re-check, throw `openspec-missing`.
3. Config check: `configPresent(root, target)`. The real implementation fetches
   `origin <target>` and lists `openspec/config.yaml` at `origin/<target>`; the
   working tree is not consulted. It returns false only for a successful
   `ls-tree` with empty output; if it throws (see "Git failures"), the error
   propagates unchanged and steps 4 and 5 are skipped.
4. If absent:
   - non-interactive: throw `openspec-not-initialized`;
   - interactive: `say` that `openspec/config.yaml` is missing at
     `origin/<target>` and list the layout files; `ask` whether to create them.
     On no throw `openspec-not-initialized`. On yes, for each of
     `openspec/config.yaml` (content `schema: spec-driven\n`),
     `<changes>/.gitkeep` and `<receipts>/.gitkeep` (empty) under `root`: if
     `exists` is false, `writeFile`; existing files are never overwritten. No git
     add, commit or push. Then `say` and throw
     `PreflightError('openspec-layout-created', 'Created <files>; commit and push them to origin/<target>, then run again')`.
     Even when every file already existed locally, the run stops, because the
     config is still absent on `origin/<target>`.
5. Both present: return silently; nothing is printed or asked.

## Exit code and reason

`PreflightError extends Error` with a `reason` field. `reportFailure` in
`src/cli.ts` uses `error.reason` when it is a nonempty string, otherwise
`startup-or-run-failed`, and also stores `reason` in the diagnostics file. All
three preflight errors therefore yield exit code 4 with stdout
`{status:'unavailable', reason:<reason>, diagnostics}`. Git failures in the
config check are plain errors and yield `startup-or-run-failed`.

## Tests

`test/openspec-preflight.test.ts` calls `openspecPreflight` with fully scripted
deps (recording `probe` and `exec` calls, scripted `ask` answers, recording
`say`, in-memory `exists` and `writeFile`). Cases: available and initialized
(asserts `probe` was called once with `openspec ['--version']`, `exec` was
never called, and `say` and `ask` recorded nothing, i.e. the version check
writes nothing through `say`); missing CLI + yes + successful install (exact
`npm` argument array via `exec`, re-check performed via `probe`, `openspec`
never run through `exec`); yes + failing install; yes + install ok but re-check
still failing; no; missing config + yes (only missing files written, existing
one untouched, reason `openspec-layout-created`, no git exec); missing config +
no; non-interactive missing CLI and missing config (no `ask`, no install, no
write); `configPresent` throwing, both interactive and non-interactive (error
propagates without a `reason`, no `ask`, no `say`, no `writeFile`).

The default `probe` is exercised by spawning a small `node` helper script under
`test/support/` (via `process.execPath`) that calls the default `probe` on
`process.execPath` with a script printing to both stdout and stderr; the test
captures the helper's stdout and stderr and asserts both are empty and the
reported status is 0. A nonexistent program yields a nonzero status. This uses
only `node`, never npm or openspec.

The default `configPresent` is exercised against a temporary local git
repository with a bare `origin`: present, missing (empty `ls-tree`), and
failing cases (no `origin` remote, nonexistent target branch) that must throw
rather than return false; this uses only `git`, never npm or openspec.
A test through `main` with a scripted runner throwing `PreflightError` asserts
exit code 4 and the reason in stdout, and one throwing a plain error asserts
`startup-or-run-failed`. A runner test asserts a failing preflight happens
before the adapter factory or lock are used. Existing `runQueue` tests pass a
scripted passing `openspec` option so no test runs the real binary.

## Tradeoffs

The default for an empty answer is no, so a stray Enter never installs global
packages or writes files. Splitting `probe` (silent) from `exec` (forwarded)
keeps the happy path free of stderr output while still showing npm progress
when the user opts into an install. Creating files but still exiting 4 is
deliberate: the runner reads only `origin/<target>`, and committing or pushing
on the user's behalf is out of scope. Treating git failures as startup errors
rather than "missing" avoids misreporting `openspec-not-initialized` and avoids
offering to create layout files that may already exist on `origin/<target>`.
