# Design: Harness-analysed test framework preflight

## Existing Behavior

`runQueue` in `src/runner.ts` runs `openspecPreflight`, then `selectHarness`,
`resolveHarness` and `validateConfig` (which freeze harness, model, effort and
coverage), then takes the SQLite lock, fetches `origin/<target>`, claims a task
and creates its worktree. Worker sessions use `createAdapter` (default
`createHarness(options, config)`), the `CodexFiles` broker and the private
`outcome_report` tool. `PreflightError` (from `src/openspec-preflight.ts`)
carries a `reason` that `src/cli.ts` `reportFailure` prints with exit code 4;
`reportFailure` writes the message only to the private diagnostics file and
prints `{status, reason, diagnostics}` to stdout, which is why the OpenSpec
preflight calls `deps.say(message)` on stderr before throwing. `safeFailure` in
`src/statistics.ts` whitelists reasons for the ledger.

## Placement

New module `src/test-framework-preflight.ts` exporting

```ts
testFrameworkPreflight(config: RunConfig, deps?: Partial<TestFrameworkDeps>): Promise<void>
```

`runQueue` calls it immediately after `validateConfig(config)` and
`statistics?.resolved(...)`, before the lock, the queue refresh, claims and
worktrees, wrapped in `cancellable(..., signal)`. The adapter factory
(`options.createAdapter ?? createHarness(…, config)`) is computed before the
call so the analysis uses exactly the selected harness, model and effort.
`RunOptions` gains `testFramework?: Partial<TestFrameworkDeps>`; the runner
passes `{ createAdapter, signal, ...options.testFramework }`. A thrown error
propagates out of `runQueue` before any lock or claim exists.

## Injectable dependencies

```ts
interface TestFrameworkDeps {
  signal?: AbortSignal;
  interactive: boolean;                 // default: isInteractive(isatty(0), isatty(2)) (same rule as OpenSpec preflight)
  ask: (question: string) => Promise<string>; // default: promptOn(process.stdin, process.stderr, signal)
  say: (text: string) => void;          // default: process.stderr.write
  createAdapter: (options: HarnessOptions) => HarnessAdapter;
  worktree: {
    add(root: string, target: string): string;   // default: see "Temporary worktree"; returns the worktree path
    remove(root: string, path: string): void;
  };
  analyse?: (config: RunConfig, root: string) => Promise<unknown>;
                                        // optional override of the whole session (used by existing runner tests);
                                        // default: the session described below
  exec: (program: string, args: string[], cwd: string) => { status: number | null };
                                        // default: spawnSync, shell: false, stdio ['ignore', 2, 2]
  writeFile: (path: string, content: string) => void; // default: mkdirSync(dirname, recursive) + writeFileSync
  snapshot: (root: string) => Map<string, string>;
                                        // default: for every path in `git status --porcelain -z --untracked-files=all`,
                                        // path -> `<XY status>:<sha256 of file content | 'missing'>`
}
```

No test starts a real harness, runs a package manager or uses a real TTY: tests
supply scripted adapters, worktree recorders, answers, a recording `exec`, an
in-memory `writeFile` and a scripted `snapshot`.

## Temporary worktree

Default `add(root, target)`: `git fetch origin <target>`, `sha = git rev-parse
origin/<target>`, `dir = mkdtempSync(join(tmpdir(), 'outcome-test-framework-'))`
(realpath; refused when inside the primary checkout), then `git worktree add
--detach <dir>/tree <sha>`; returns `<dir>/tree`. Default `remove(root, path)`:
`git worktree remove --force <path>`, then `rmSync(dirname(path), {recursive,
force})` and `git worktree prune`; removal errors are collected and rethrown
only when the analysis itself succeeded. `testFrameworkPreflight` calls
`remove` in a `finally` around the session, so the worktree is removed when the
session succeeds, fails, returns an invalid report or is cancelled; it is
removed before any prompt, install or file write. A failing `add` is reported
as `test-framework-analysis-failed` (with `remove` called for any partially
created path).

## Analysis session

- Files: `git ls-files -z` in the temporary worktree.
- Broker: `new CodexFiles({ root: tree, scopes: files.map(path => ({ path,
  mode: 'read' })), store: refusingStore, identity: { purpose: 'test-framework-analysis' },
  revalidate: async () => true })`. There are no write scopes; `refusingStore`
  throws on use, so `write_file` can never succeed.
- `handleTool`: `backlog_tool` with `read_file` goes to the broker;
  `context` with section `paths` returns the tracked files paged by 200; every
  other operation (including `write_file` and `run_checks`) and every other
  section throws `Analysis session is read-only`. `test_framework_report`
  validates its input (see below); an invalid report throws to the harness with
  the validation message, a valid one is recorded and answers
  `{ status: 'recorded' }`.
- Tools offered: `brokerTool` and `testFrameworkReportTool` only (no
  `outcome_report`, no shell; adapters already run without shell or approval
  tools).
- Adapter: `createAdapter({ cwd: tree, tools, handleTool })`; `probe()` must be
  `interface-ready`. The prompt states OFF mode, read-only broker use, the
  target, the resolved coverage threshold `config.coverage` and the required
  report parts.
- The session fails when the probe is not ready, `startAction` throws, or it
  ends without a recorded valid report. Then
  `PreflightError('test-framework-analysis-failed', …)` is thrown and no claim is
  made. The last validation message is included in the diagnostics details.

## Report schema and validation

```ts
interface AnalysisReport {
  technologies: {
    name: string;                        // unique, nonempty
    kind: 'language' | 'runtime' | 'framework' | 'build-tool';
    evidence: string[];                  // >= 1 tracked paths at origin/<target>
    frameworks: {
      name: string; evidence: string[];  // tracked paths
      thresholds: { lines: number | null; branches: number | null; functions: number | null };
    }[];
    recommendations: {
      framework: string;
      rationale: string;                 // one sentence: nonempty, single line
      install: { command: string; args: string[] }[];
      changes: { path: string; content: string }[];  // >= 1; full new file content
      thresholds: { lines: number; branches: number; functions: number };
    }[];
  }[];
}
```

The report is refused (invalid) when any part is missing or malformed: an empty
`technologies` list; a missing, duplicate or empty name; an unknown kind;
evidence that is empty or names a path that is not tracked in the temporary
worktree; a framework without a `thresholds` object holding `lines`,
`branches` and `functions` each `null` or a number from 0 to 100; or, for an
unprepared technology, fewer than one or more than three recommendations, a
rationale that is empty or contains a line break, `install` not an array of
`{command: nonempty string, args: string[]}`, empty `changes` or a change
without a nonempty `path` string and string `content`, or recommendation
thresholds not all equal to `config.coverage`. Recommendations of prepared
technologies are ignored.

A technology is **prepared** when one of its frameworks has `lines`,
`branches` and `functions` all numbers `>= config.coverage`.

## Startup decision

1. All technologies prepared: return; nothing is asked or written (in
   interactive mode the technology summary is still printed to stderr).
2. Non-interactive with an unprepared technology: throw
   `PreflightError('test-framework-missing', …)` naming the unprepared
   technologies, with `details: { report }`; nothing is asked, executed or
   written.
3. Interactive: `say` each technology with its kind, evidence paths and
   existing frameworks (with thresholds). Take `before = snapshot(root)` before
   any install or write. For each unprepared technology in report order: `say`
   the numbered recommendations with rationale and `ask`
   `Choose 1-n or s to skip [1]`. An empty answer or `1` selects the first;
   another valid number selects that recommendation; anything else skips.
4. For a chosen recommendation, validate every change path: `safePath`, inside
   the repository root after resolving existing ancestors (no symlink escape),
   no `.git` path component, and not within `project.queue`,
   `project.receipts` or `project.changes`. Any violation refuses the
   recommendation (said on stderr) and leaves the technology unprepared;
   nothing is asked, executed or written for it.
5. Otherwise `say` the exact install commands (JSON command and argument
   arrays) and file changes (path and content) and `ask` `Run these commands and
   apply these changes? [y/N]`; only `y`/`yes` is yes. On no the technology
   stays unprepared. On yes run each install with `exec(command, args, root)`
   in order (never through a shell); a nonzero or null status stops that
   technology, leaves it unprepared and skips its file changes. When all
   installs succeed, write each change with `writeFile(join(root, path),
   content)` and record the relative path as written.
6. After all unprepared technologies, compute the changed files: take
   `after = snapshot(root)`; a path is changed when it is in `after` and is
   absent from `before` or has a different value, or when it was written in
   step 5. Paths that were already dirty or untracked before the preflight and
   are unchanged (same status and content) are not listed. The list is sorted
   and deduplicated.
   - When any technology remains unprepared, the message names them (and lists
     the changed files, if any); the runner calls `say(message)` on stderr and
     then throws `PreflightError('test-framework-missing', message)`.
   - Otherwise the message is `Changed <files>; commit and push them to
     origin/<target>, then run again`; the runner calls `say(message)` on
     stderr and then throws `PreflightError('test-framework-prepared', message)`
     with `details: { changedFiles }`.
   The runner never runs git add, commit or push. Both exit with code 4.
   Saying the message first matters because `reportFailure` prints only the
   reason and the diagnostics path on stdout.

## Exit code, reason and diagnostics

`PreflightError` gains an optional `details` field. `reportFailure` writes
`{ reason, message, stack, details }` into the private diagnostics file.
`safeFailure` adds `test-framework-missing`, `test-framework-analysis-failed`
and `test-framework-prepared`.

## Tests

`test/test-framework-preflight.test.ts` calls `testFrameworkPreflight` with
scripted deps: a scripted adapter that issues broker calls and
`test_framework_report` calls, a recording worktree, scripted answers, a
recording `exec`, in-memory `writeFile`, a recording `say` and a scripted
`snapshot`. It covers every listed criterion case, the read-only tool refusals,
asserts `worktree.remove` after every `add`, asserts that the changed files
appear in the said stderr output, and asserts that a file already dirty before
the preflight and unchanged by it is not listed. The default worktree and
snapshot functions are exercised against a temporary git repository with a
bare `origin` (git only), asserting the detached worktree is outside the
repository and gone (directory and `git worktree list`) afterwards. A runner
test asserts the analysis runs after selection with the resolved model and
effort and before the lock and claims; existing runner tests pass a scripted
`testFramework.analyse` returning a prepared report.

## Tradeoffs

Running the analysis on `origin/<target>` rather than the working tree matches
the OpenSpec preflight and the claim base. Empty answers preselect the first
recommendation but the confirmation defaults to no, so a stray Enter never
installs anything. Exiting 4 after a successful setup is deliberate: the
runner reads only `origin/<target>` and never commits on the user's behalf.
Comparing status and content snapshots, rather than listing every dirty path,
keeps unrelated pre-existing changes out of the commit advice, and still
catches an already modified file that an install changes again.
