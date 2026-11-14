import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { hash, resolveCheckTimeoutMinutes } from '../src/model.ts';
import { CHECK_KILL_GRACE_MS, CheckTimedOut, failureDetail, limitText, runQueue } from '../src/runner.ts';
import { runLimitedCheck } from '../src/check-process.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import type { HarnessOptions, ToolInput } from '../src/harness-adapter.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';
import { FAST_CHECKS, HANG_MARKER, HANG_SCRIPT, IGNORE_TERM_SCRIPT, alive, hangCheck } from './support/check-scripts.ts';

const LIMIT_LINE = 'Check timed out after 300 ms';
const CLAIMS = 'work-queue-claims-main';

/** A temporary directory removed after the test. */
function temporary(t: TestContext, prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The pids recorded in `file`, separated by spaces or newlines. */
const pidsIn = (file: string): number[] => existsSync(file) ?
  readFileSync(file, 'utf8').split(/\s+/u).filter(Boolean).map(Number) : [];

/**
 * A fixture with task A whose product checks are the hang check (first) and two fast checks, so a limit of 300 ms
 * only stops the hang. The pid file is in the fixture base directory, outside the worktree.
 */
function hangFixture(t: TestContext): { f: RunnerFixture; pidFile: string } {
  const f = runnerFixture(t, { ids: ['A'] });
  const pidFile = join(f.base, 'hang-pids.txt');
  f.project.checks.splice(0, f.project.checks.length, hangCheck(pidFile), ...structuredClone(FAST_CHECKS));
  return { f, pidFile };
}

/** One broker call of a scripted session. */
const tool = (options: HarnessOptions, operation: string, input: object): Promise<any> =>
  options.handleTool('backlog_tool', { operation, input } as ToolInput, { threadId: 'fixture' }) as Promise<any>;

async function writeMarker(options: HarnessOptions): Promise<void> {
  const before = await tool(options, 'read_file', { path: HANG_MARKER });
  await tool(options, 'write_file', { path: HANG_MARKER, content: 'hang\n', expectedHash: before.hash });
}

async function deleteMarker(options: HarnessOptions): Promise<void> {
  const before = await tool(options, 'read_file', { path: HANG_MARKER });
  await tool(options, 'delete_file', { path: HANG_MARKER, expectedHash: before.hash });
}

const isImplementation = (prompt: string) => prompt.includes('Implement all approved');
const receiptOf = (f: RunnerFixture) => JSON.parse(git(f.remote, 'show', 'refs/heads/main:evidence/results/A.json'));
const allPassed = (checks: { outcome: string }[]) => checks.every(check => check.outcome === 'passed');

// Grade E

test('E (required): resolveCheckTimeoutMinutes defaults to 30, accepts 1 and 240 and refuses every other value', () => {
  assert.equal(resolveCheckTimeoutMinutes(), 30);
  assert.equal(resolveCheckTimeoutMinutes(undefined), 30);
  assert.equal(resolveCheckTimeoutMinutes(1), 1);
  assert.equal(resolveCheckTimeoutMinutes(240), 240);
  for (const value of [0, 241, 7.5, '30', null]) {
    assert.throws(() => resolveCheckTimeoutMinutes(value),
      (error: Error & { reason?: string; details?: { setting?: string; value?: unknown } }) =>
        error.reason === 'invalid-check-timeout' && error.details?.setting === 'checkTimeoutMinutes' &&
        error.details.value === value &&
        error.message === 'Invalid checkTimeoutMinutes: expected an integer from 1 through 240', String(value));
  }
});

test('E (required): limitText names whole minutes or milliseconds, and the kill grace is 10 seconds', () => {
  assert.equal(limitText(1800000), '30 minutes');
  assert.equal(limitText(60000), '1 minute');
  assert.equal(limitText(300), '300 ms');
  assert.equal(CHECK_KILL_GRACE_MS, 10000);
});

test('E (required): checkTimeoutMinutes is not part of the invocation identity', t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = { ...f.config('one'), coverage: 85, leaves: ['A'] };
  const limited = invocationIdentity({ ...config, checkTimeoutMinutes: 5 });
  const plain = invocationIdentity(config);
  assert.deepEqual(limited, plain);
  assert.equal(hash(limited), hash(plain));
});

// Grade D

test('D (required): a check within the limit passes with its output, and a failing check rejects as before', async t => {
  const cwd = temporary(t, 'check-within-');
  assert.deepEqual(await runLimitedCheck(cwd, 'node', ['-e', "console.log('ok')"], { limitMs: 5000 }),
    { status: 'passed', output: 'ok' });
  const error = await runLimitedCheck(cwd, 'node', ['-e',
    "console.log('to stdout'); console.error('to stderr'); process.exitCode = 1"], { limitMs: 5000 })
    .then(() => assert.fail('the check should fail'), (failure: unknown) => failure);
  assert.equal((error as { status?: number }).status, 1);
  const detail = failureDetail(error);
  assert.match(detail, /to stdout/u);
  assert.match(detail, /to stderr/u);
});

test('D (required): a hanging check is stopped after its limit and recorded as timed-out with its output', async t => {
  const cwd = temporary(t, 'check-hang-');
  mkdirSync(join(cwd, dirname(HANG_MARKER)), { recursive: true });
  writeFileSync(join(cwd, HANG_MARKER), 'hang\n');
  const pidFile = join(temporary(t, 'check-pids-'), 'pids.txt');
  const started = Date.now();
  const result = await runLimitedCheck(cwd, 'sh', ['-c', HANG_SCRIPT, 'sh', pidFile], { limitMs: 300 });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(result.status, 'timed-out');
  assert.match(result.output, /check started/u);
  const pids = pidsIn(pidFile);
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false);
});

test('D (required): a timed-out detail keeps the last 16000 characters and ends with the limit line', () => {
  const output = Array.from({ length: 20000 }, (_, index) => String(index % 10)).join('');
  const timedOut = new CheckTimedOut(output, 300, { command: 'node', args: ['hang.js'] });
  assert.equal(timedOut.detail, `${output.slice(-16000)}\n${LIMIT_LINE}`);
  assert.equal(failureDetail(timedOut), timedOut.detail);
  assert.deepEqual(timedOut.row, { command: 'node', args: ['hang.js'], outcome: 'timed-out', timeLimitMs: 300,
    output: timedOut.detail });
});

// Grade C

test('C (required): a check and its child that ignore SIGTERM are killed after the grace, leaving no process', async t => {
  const cwd = temporary(t, 'check-term-');
  const pidFile = join(temporary(t, 'check-term-pids-'), 'pids.txt');
  const started = Date.now();
  const result = await runLimitedCheck(cwd, 'sh', ['-c', IGNORE_TERM_SCRIPT, 'sh', pidFile],
    { limitMs: 300, graceMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'timed-out');
  assert.match(result.output, /started/u);
  assert.ok(elapsed >= 300 + 200 - 20, `took ${elapsed} ms`);
  const pids = pidsIn(pidFile);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH', String(pid));
  }
});

for (const value of [0, 241, 7.5, '30']) {
  test(`C (required): checkTimeoutMinutes ${JSON.stringify(value)} is refused through the CLI before any state, claim or worktree`, async t => {
    const f = runnerFixture(t, { ids: ['A'] });
    const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
    const file = join(f.base, 'invocation.json');
    writeFileSync(file, JSON.stringify({ ...invocation, checkTimeoutMinutes: value }));
    const xdg = join(f.base, 'xdg'); const lines: string[] = [];
    const code = await main(file, (config, options) => runQueue(config, f.options(config, options)),
      line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: xdg, OUTCOME_RUNNER_MASCOT: '0' },
        mascot: async () => {} });
    assert.equal(code, 4);
    const line = JSON.parse(lines.at(-1)!);
    assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'invalid-check-timeout');
    const diagnostics = JSON.parse(readFileSync(line.diagnostics, 'utf8'));
    rmSync(dirname(line.diagnostics), { recursive: true, force: true });
    assert.equal(diagnostics.reason, 'invalid-check-timeout');
    assert.deepEqual(diagnostics.details, { setting: 'checkTimeoutMinutes', value });
    assert.match(diagnostics.message, /checkTimeoutMinutes/u);
    assert.equal(existsSync(join(xdg, 'outcome-runner')), false);
    assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
    assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${CLAIMS}`), '');
    assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  });
}

test('C (required): checks within the default limit are unchanged and write no check timeout line', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const lines: string[] = [];
  const result = await f.run(f.config('one', { leaves: ['A'] }), { steps: line => { lines.push(line); } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(lines.filter(line => / check timeout: /u.test(line)).length, 0);
  const receipt = receiptOf(f);
  assert.equal(receipt.checks.length, 2);
  assert.ok(allPassed(receipt.checks), JSON.stringify(receipt.checks));
});

test('C (required): a blocked run resumed with another valid checkTimeoutMinutes is not refused as incompatible', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const one = f.config('one', { leaves: ['A'] });
  const first = await f.run(one, { createAdapter: scriptedWorker({ fail: prompt => prompt.includes('Task A;') }) });
  assert.equal(first.status, 'incomplete', JSON.stringify(first));
  assert.equal(first.blockers!.A.kind, 'blocked');
  const identityHash = f.state('one').identityHash;
  const second = await f.run({ ...one, checkTimeoutMinutes: 10 });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.deepEqual(second.accepted, ['A']);
  assert.equal(f.state('one').identityHash, identityHash);
});

// Grade B

test('B (required): a hanging work-stage check is recorded, logged and uses one check attempt each time', async t => {
  const { f, pidFile } = hangFixture(t);
  const prompts: string[] = []; const lines: string[] = [];
  const worker = scriptedWorker({ onSession: async (options, prompt) => {
    if (!isImplementation(prompt)) return;
    prompts.push(prompt);
    if (prompts.length === 1) await writeMarker(options);
  } });
  const result = await f.run(f.config('one', { leaves: ['A'] }), { createAdapter: worker,
    checkLimits: { timeoutMs: 300 }, steps: line => { lines.push(line); } });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.A.reason, 'check-budget-exhausted');
  const timeouts = lines.filter(line => / A check timeout: /u.test(line));
  assert.equal(timeouts.length, 4);
  assert.match(timeouts[0], / A check timeout: sh 1\/3 timed out after 300 ms\n$/u);
  const implementations = lines.map((line, index) => / A implementation: /u.test(line) ? index : -1)
    .filter(index => index >= 0);
  assert.ok(lines.indexOf(timeouts[0]) < implementations[1]);
  const state = f.state('one');
  const work = state.blocked.A.work;
  assert.equal(state.blocked.A.budget.exhausted, 'checks');
  assert.equal(work.budget.work.checks, 4);
  assert.equal(work.budget.work.reviews, 0);
  assert.deepEqual(work.reviews ?? [], []);
  const record = work.checks.find((check: { outcome: string }) => check.outcome === 'timed-out');
  assert.ok(record, JSON.stringify(work.checks));
  assert.equal(record.timeLimitMs, 300);
  assert.match(record.output, /check started/u);
  assert.ok(record.output.endsWith(LIMIT_LINE), record.output);
  assert.ok(prompts[1].includes(LIMIT_LINE));
  const pids = pidsIn(pidFile);
  assert.equal(pids.length, 4);
  for (const pid of pids) assert.equal(alive(pid), false, String(pid));
});

test('B (required): a worker run_checks call that times out rejects with the limit line and uses no check attempt', async t => {
  const { f, pidFile } = hangFixture(t);
  let message = ''; let before: number | undefined; let after: number | undefined; let sessions = 0;
  const worker = scriptedWorker({ onSession: async (options, prompt) => {
    if (!isImplementation(prompt) || sessions++ > 0) return;
    await writeMarker(options);
    before = f.state('one').current.budget.work.checks;
    try { await tool(options, 'run_checks', {}); }
    catch (error) { message = (error as Error).message; }
    after = f.state('one').current.budget.work.checks;
    await deleteMarker(options);
  } });
  const result = await f.run(f.config('one', { leaves: ['A'] }), { createAdapter: worker,
    checkLimits: { timeoutMs: 300 } });
  assert.ok(message.endsWith(LIMIT_LINE), message);
  assert.match(message, /check started/u);
  assert.equal(before, 0);
  assert.equal(after, before);
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const pids = pidsIn(pidFile);
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false);
});

// Grade A

test('A (required): a worker that fixes the hang after the timed-out result gets the task accepted', async t => {
  const { f, pidFile } = hangFixture(t);
  const prompts: string[] = [];
  const worker = scriptedWorker({ onSession: async (options, prompt) => {
    if (!isImplementation(prompt)) return;
    prompts.push(prompt);
    if (prompts.length === 1) await writeMarker(options);
    else if (prompts.length === 2 && prompt.includes(LIMIT_LINE)) await deleteMarker(options);
  } });
  const result = await f.run(f.config('one', { leaves: ['A'] }), { createAdapter: worker,
    checkLimits: { timeoutMs: 300 } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.equal(prompts.length, 2);
  assert.equal(f.state('one').completed.A.budget.work.checks, 1);
  const receipt = receiptOf(f);
  assert.equal(receipt.checks.length, 3);
  assert.ok(allPassed(receipt.checks), JSON.stringify(receipt.checks));
  const pids = pidsIn(pidFile);
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false);
});
