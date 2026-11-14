# Design: Time limit for product checks

## Context

`checks(work, definitions, kind?, attempt?)` in `src/runner.ts` runs each command synchronously through `command`
(`execFileSync` wrapped in `withNetworkRetry`, `src/git.ts`). It is used for:

- product checks (`project.checks`): through `runProductChecks` for the broker `run_checks` operation, the
  `final-checks` stage and the integration `checks` step; directly for the work-stage checks and the publish gate
  (`finalGate`, which saves `finalChecks` after every row);
- setup commands (`project.setup`) and the planning check (`project.planningCheck`).

A failure throws the `execFileSync` error. `failureDetail` turns it into the last 16000 characters of stdout and
stderr. The work stage passes that detail to `countCheck('work', ...)`, which uses one check attempt. The broker
turns it into a tool error the worker reads.

## Decisions

### 1. Setting and validation

- `RunConfig.checkTimeoutMinutes?: number` in `src/model.ts`, with `DEFAULT_CHECK_TIMEOUT_MINUTES = 30`.
- `resolveCheckTimeoutMinutes(value = 30)` returns the value when it is a safe integer from 1 through 240.
  Otherwise it throws `Invalid checkTimeoutMinutes: expected an integer from 1 through 240`, with
  `reason: 'invalid-check-timeout'` and `details: { setting: 'checkTimeoutMinutes', value }`. This has the same
  shape as `resolvePollSeconds`.
- `runSteps` calls it right after `resolvePollSeconds`: before any preflight, lock, state, ownership file, claim or
  worktree. `validateConfig` calls it too. Through the CLI, the existing failure path prints
  `{ status: 'unavailable', reason: 'invalid-check-timeout', diagnostics }` with exit code 4. The diagnostics file
  holds the message and the details naming `checkTimeoutMinutes`.
- `invocationIdentity` does not change. It projects only named fields, so `checkTimeoutMinutes` stays outside the
  identity, and changing it never makes a stored invocation incompatible.

### 2. Test hook

`RunOptions.checkLimits?: { timeoutMs?: number; killGraceMs?: number }` is documented as a test hook. Without it,
the limit is `checkTimeoutMinutes * 60000` and the kill grace is `CHECK_KILL_GRACE_MS = 10000`. Tests use it to set
a limit of a few hundred milliseconds, and a shorter grace for the SIGTERM-ignoring case. Like `retry` and `sleep`,
it never enters the identity or the state.

### 3. Limited check process (`src/check-process.ts`)

`runLimitedCheck(cwd, program, args, { limitMs, graceMs, env })` returns
`Promise<{ status: 'passed'; output: string } | { status: 'timed-out'; output: string }>`. A failing exit rejects
with an error that has the same shape as the `execFileSync` error: `message`, `status`, `stdout` and `stderr`. So
`failureDetail` and `isConnectionFailure` work on it unchanged.

- `spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`. `detached` makes the
  check the leader of a new process group (`setsid`), so its descendants share the group id `child.pid`. The child
  is not `unref`ed. `env` is the environment of `command` (exported from `src/git.ts` as `commandEnvironment()`):
  `CI=true`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, and no `NODE_TEST_CONTEXT` or `NODE_TEST_WORKER_ID`.
- stdout and stderr are collected as UTF-8, each capped at 32 MiB like the `maxBuffer` of `command`. Past the cap,
  only the newest bytes are kept. A passing check returns the trimmed stdout, as `command` does.
- Within the limit, the result is decided on the child's `close` event: exit code 0 passes, anything else rejects.
- When the limit timer fires first:
  1. `process.kill(-pid, 'SIGTERM')` (ignoring `ESRCH`).
  2. Wait for the leader's `exit`, then poll `process.kill(-pid, 0)` every 25 ms until it throws `ESRCH`, for at
     most `graceMs` from the SIGTERM. The leader is waited for first because an unreaped leader can still count as
     a group member.
  3. If the group still exists after the grace period, `process.kill(-pid, 'SIGKILL')`, then poll until `ESRCH`.
     The poll ends because SIGKILL cannot be ignored and every orphan is reaped by init.
  4. Wait for both pipes to close. A killed group can no longer hold them open.
  5. Resolve `{ status: 'timed-out', output }`. `output` is the trimmed stdout and stderr joined by a newline, the
     same way `failureDetail` joins them.
- The promise therefore settles only after no process of the group remains. This is the guarantee "no process of
  the check remains after the check is recorded".
- A cancelled run (abort signal or SIGINT/SIGTERM to the runner) does not interrupt a running check. This matches
  today's synchronous behaviour.

`src/network-retry.ts` gets `withNetworkRetryAsync(run, describe)`. It uses the same policy and connection-failure
test as `withNetworkRetry`, awaiting each attempt. Each attempt has its own limit. A timed-out result is a result,
not an error, so it is never retried.

### 4. Runner integration

- `checks` becomes `async` and is awaited at every call site. `integrateTarget` becomes `async` (it awaits the setup
  checks), and the publish stage awaits it. All callers are already in async code: the stage loop, the broker
  `handleTool` and the integration steps.
- Only rows of `project.checks` go through `runLimitedCheck`. Setup commands and the planning check still use the
  synchronous `command`, so their behaviour does not change.
- `limitText(ms)` (exported) gives `N minutes` (or `1 minute`) when `ms` is a whole number of minutes, and `N ms`
  otherwise. The limit line is `Check timed out after <limitText>`; with the default it reads
  `Check timed out after 30 minutes`.
- `detail` is the last 16000 characters of the output, a newline, and the limit line.
- On `timed-out`, `checks`:
  1. writes the step line with step `check timeout` and the message
     `<basename of the command> <index>/<count> timed out after <limitText>` (for example
     `node 1/3 timed out after 30 minutes`) with the current attempt. This happens before any save, session or
     other effect;
  2. pushes the row `{ command, args, outcome: 'timed-out', timeLimitMs, output: detail }`;
  3. saves `finalChecks: rows` in the publish gate as now, and otherwise saves `checks: rows`, so the record is in
     the work state and the worker can read it through the `checks` context section;
  4. throws `CheckTimedOut` (exported) with `detail`, `timeLimitMs` and the row.
- `failureDetail(error)` returns `error.detail` unchanged for a `CheckTimedOut`. The general `.slice(-16000)` would
  cut the head of the output to make room for the limit line, but the full 16000 characters plus the line are
  needed.
- Because `CheckTimedOut` is thrown like any other check failure, the existing paths apply unchanged:
  - work stage: `countCheck('work', [detail])` uses one check attempt and stores `detail` as the finding for the
    next implementation session; four timed-out or failed runs exhaust the budget with `check-budget-exhausted`;
  - broker `run_checks`: `runProductChecks` rethrows `new Error(detail)`, and the worker receives the tool error as
    for any other failed check. Worker checks never count against the budget;
  - `final-checks`: the task blocks as for a failed check;
  - integration `checks` step: a send-back with the detail as the finding;
  - publish gate: an integration, or a thrown error, as for a failed check.
- `CheckRecord` gains `timeLimitMs?: number`, and its `outcome` documents `passed`, `failed` and `timed-out`.
  `checkRecords` (the public projection in the pull request body and broker results) keeps `command`, `args` and
  `outcome`, so a public record shows `timed-out` without the output.

### 5. README

Add a "Check time limit" section. It covers: the 30-minute default; `checkTimeoutMinutes` (1 to 240, operational,
not part of the identity); which checks have a limit; process-group stopping (SIGTERM, then SIGKILL after 10
seconds); the `timed-out` outcome with the limit and output; one check attempt; and the step line. Add
`invalid-check-timeout` to the exit code 4 reasons, and the field to the invocation settings table.

## Risks and trade-offs

- Process groups are a POSIX mechanism. The runner already targets POSIX (macOS and Linux). A check that calls
  `setsid` itself leaves the group and is not stopped. This is documented as a limitation.
- Asynchronous checks let the event loop run during a check. This is safe because each run handles one task at a
  time and every state write still goes through `save`.
- If the runner itself is killed during a check, the detached group is not stopped. That is out of scope.
