import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import type { MainOptions, MascotPlayer } from '../src/cli.ts';
import type { RunOptions } from '../src/runner.ts';
import type { RunConfig } from '../src/model.ts';
import { git } from '../src/git.ts';
import { ledgerPath } from '../src/statistics.ts';
import type { RunStatistics } from '../src/statistics.ts';
import { playMascot } from '../mascot/mascot.ts';
import { recordingPlayer as recorder } from './support/mascot-player.ts';
import type { PlayerCall } from './support/mascot-player.ts';
import { publishToOrigin } from './support/git-origin.ts';

type Runner = (config: RunConfig, options: RunOptions) => Promise<{ status: string }>;
type Write = (chunk: string, ...rest: unknown[]) => boolean;

const SHOW = '\x1b[?25h';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-mascot-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repository'); mkdirSync(root); git(root, 'init', '-b', 'main'); publishToOrigin(root);
  const path = join(base, 'invocation.json'); writeFileSync(path, JSON.stringify({ invocation: 'mascot' }));
  const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: join(base, 'state') };
  const records = (): RunStatistics[] => readFileSync(ledgerPath(env), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  return { base, root, path, env, records };
}

async function execute(t: TestContext, runner: Runner, options: MainOptions & { output?: (line: string) => void } = {}) {
  const f = fixture(t); const lines: string[] = [];
  const { output = (line: string) => { lines.push(line); }, ...rest } = options;
  const code = await main(f.path, runner, output, { cwd: f.root, ...rest, env: { ...f.env, ...rest.env } });
  for (const line of lines) {
    const diagnostics = (JSON.parse(line) as { diagnostics?: string }).diagnostics;
    if (diagnostics) rmSync(join(diagnostics, '..'), { recursive: true, force: true });
  }
  return { code, lines, records: f.records };
}

const eventsRun = (result: object): Runner => async (_config, options) => {
  options.report!({ status: 'accepted', id: 'OR-1', summary: 'Done.', durationSeconds: 3, grade: 'C' });
  options.report!({ status: 'blocked', id: 'OR-2' }, { reason: 'Worker plan incomplete' });
  return { status: 'exhausted', ...result };
};

test('B: task events and every final status play their mood and caption', async t => {
  const cases: [object, number, string, string][] = [
    [{ status: 'exhausted', accepted: ['OR-1'], remaining: [], completions: {} }, 0, 'celebrating', 'exhausted: 1 accepted, 0 remaining'],
    [{ status: 'limit-reached', accepted: ['OR-1'], remaining: ['OR-2'], completions: {} }, 0, 'content', 'limit-reached: 1 accepted, 1 remaining'],
    [{ status: 'incomplete', accepted: ['OR-1'], remaining: ['OR-3'], completions: {}, claimedElsewhere: { 'OR-3': {} } }, 3, 'sleepy',
      'incomplete: 1 accepted, 1 remaining'],
    [{ status: 'incomplete', accepted: ['OR-1'], remaining: ['OR-2'], completions: {},
      blockers: { 'OR-2': { reason: 'operation-incomplete', diagnostics: '/d' } } }, 3, 'sad', 'incomplete: 1 accepted, 1 remaining'],
  ];
  for (const [result, expectedCode, mood, caption] of cases) {
    const { calls, player } = recorder();
    const { code } = await execute(t, eventsRun(result), { mascot: player });
    assert.equal(code, expectedCode);
    assert.deepEqual(calls.map(call => [call.mood, call.caption]), [
      ['happy', 'OR-1 merged'], ['angry', 'OR-2 blocked: Worker plan incomplete'], [mood, caption]]);
    assert.ok(calls.every(call => call.signal instanceof AbortSignal));
  }
});

test('B: SIGTERM cancellation plays startled and exit code 4 plays dizzy', async t => {
  const cancelled = recorder();
  const result = await execute(t, async () => { process.emit('SIGTERM'); throw new Error('stopped'); }, { mascot: cancelled.player });
  assert.equal(result.code, 3);
  assert.deepEqual(cancelled.calls.map(call => [call.mood, call.caption]), [['startled', 'cancelled: 0 accepted, 0 remaining']]);
  const failed = recorder();
  const unavailable = await execute(t, async () => { throw new Error('Invalid invocation'); }, { mascot: failed.player });
  assert.equal(unavailable.code, 4);
  assert.equal(JSON.parse(unavailable.lines[0]).status, 'unavailable');
  assert.deepEqual(failed.calls.map(call => [call.mood, call.caption]), [['dizzy', 'unavailable: 0 accepted, 0 remaining']]);
});

test('B: a refused --no-mascot exits 4 without calling the player', async t => {
  for (const args of [['--no-mascot=1'], ['--no-mascot', '--no-mascot']]) {
    const { calls, player } = recorder(); let ran = false;
    const { code, lines } = await execute(t, async () => { ran = true; return { status: 'exhausted' }; }, { args, mascot: player });
    assert.equal(code, 4); assert.equal(ran, false); assert.equal(calls.length, 0);
    assert.equal(JSON.parse(lines[0]).status, 'unavailable');
  }
});

test('B: --no-mascot with other flags and OUTCOME_RUNNER_MASCOT=0 never call the player', async t => {
  const flagged = recorder(); let received!: RunConfig;
  const run: Runner = async (config, options) => { received = config; return eventsRun({ accepted: [], remaining: [] })(config, options); };
  const first = await execute(t, run, { args: ['--model=claude-sonnet-5-5', '--no-mascot', '--effort=high'], mascot: flagged.player });
  assert.equal(first.code, 0); assert.equal(flagged.calls.length, 0);
  assert.equal(received.model, 'claude-sonnet-5-5'); assert.equal(received.effort, 'high');
  const environment = recorder();
  const second = await execute(t, run, { env: { OUTCOME_RUNNER_MASCOT: '0' }, mascot: environment.player });
  assert.equal(second.code, 0); assert.equal(environment.calls.length, 0);
});

test('B: stdout is byte-for-byte identical with and without the mascot and never holds the reason', async t => {
  const result = { accepted: ['OR-1'], remaining: [], completions: {} };
  const on = await execute(t, eventsRun(result), { mascot: recorder().player });
  const off = await execute(t, eventsRun(result), { args: ['--no-mascot'], mascot: recorder().player });
  assert.deepEqual(on.lines, off.lines);
  assert.equal(on.lines.join(''), off.lines.join(''));
  assert.equal(on.lines[1], '{"status":"blocked","id":"OR-2"}\n');
  assert.ok(!on.lines.join('').includes('Worker plan incomplete'));
});

test('B: the default player writes to stderr only', async t => {
  const stderr = process.stderr as unknown as { write: Write; isTTY?: boolean };
  const stdout = process.stdout as unknown as { write: Write };
  const originalErr = stderr.write; const originalOut = stdout.write; const tty = stderr.isTTY;
  let errors = ''; let outputs = '';
  stderr.write = chunk => { errors += String(chunk); return true; };
  stdout.write = (chunk, ...rest) => { outputs += String(chunk); return originalOut.call(process.stdout, chunk, ...rest); };
  stderr.isTTY = true;
  try {
    const { code } = await execute(t, async () => ({ status: 'exhausted', accepted: [], remaining: [] }), { env: { TERM: 'dumb' } });
    assert.equal(code, 0);
  } finally { stderr.write = originalErr; stdout.write = originalOut; stderr.isTTY = tty; }
  assert.ok(errors.includes('exhausted: 0 accepted, 0 remaining'));
  assert.ok(!outputs.includes('exhausted: 0 accepted, 0 remaining'));
});

test('A: a throwing or rejecting player leaves stdout, exit code and statistics unchanged', async t => {
  const result = { status: 'incomplete', accepted: ['OR-1'], remaining: ['OR-2'], completions: {}, blockers: { 'OR-2': { reason: 'x' } } };
  const off = await execute(t, eventsRun(result), { args: ['--no-mascot'] });
  const players: MascotPlayer[] = [() => { throw new Error('sync failure'); }, async () => { throw new Error('async failure'); }];
  for (const player of players) {
    const failing = await execute(t, eventsRun(result), { mascot: player });
    assert.deepEqual(failing.lines, off.lines); assert.equal(failing.code, off.code); assert.equal(failing.code, 3);
    const [record] = failing.records(); const [reference] = off.records();
    assert.equal(record.status, reference.status); assert.equal(record.exitCode, reference.exitCode);
  }
});

test('A: SIGINT during a task animation aborts it and shows the cursor before the cancelled line', async t => {
  const log: [string, string][] = []; const calls: PlayerCall[] = [];
  const stream = { isTTY: true, write: (chunk: string) => { log.push(['stderr', chunk]); return true; } };
  let hang = true; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  const wait = (_ms: number, signal?: AbortSignal) => hang ? new Promise<void>((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); started();
  }) : Promise.resolve();
  const player: MascotPlayer = (mood, caption, { signal }) => {
    calls.push({ mood, caption, signal });
    return playMascot(mood, caption, { stream, isTTY: () => true, env: {}, wait, signal });
  };
  const { code } = await execute(t, async (_config, options) => {
    options.report!({ status: 'accepted', id: 'OR-1' });
    await waiting;
    process.emit('SIGINT'); hang = false;
    throw new Error('Run cancelled');
  }, { mascot: player, output: line => { log.push(['stdout', line]); } });
  assert.equal(code, 3);
  assert.equal(calls[0].mood, 'happy'); assert.equal(calls[0].signal.aborted, true);
  const shown = log.findIndex(([target, chunk]) => target === 'stderr' && chunk === SHOW);
  const cancelled = log.findIndex(([target, chunk]) => target === 'stdout' && JSON.parse(chunk).status === 'cancelled');
  assert.ok(shown >= 0 && cancelled > shown, 'cursor shown before the cancelled line');
  assert.ok(!log.slice(0, cancelled).some(([, chunk]) => chunk.includes('OR-1 merged')));
  assert.deepEqual(calls.slice(1).map(call => [call.mood, call.caption]), [['startled', 'cancelled: 0 accepted, 0 remaining']]);
});

test('A: a signal after the exhausted terminal line plays startled with the cancelled caption', async t => {
  const { calls, player } = recorder(); const lines: string[] = [];
  const terminal = { status: 'exhausted', accepted: ['OR-1'], remaining: [], completions: {} };
  const { code, records } = await execute(t, async () => terminal, { mascot: player, output: line => {
    lines.push(line);
    if (JSON.parse(line).status === 'exhausted') process.emit('SIGTERM');
  } });
  assert.deepEqual(lines, [JSON.stringify(terminal) + '\n']);
  assert.equal(code, 3);
  assert.equal(records()[0].status, 'cancelled'); assert.equal(records()[0].exitCode, 3);
  assert.deepEqual(calls.map(call => [call.mood, call.caption]), [['startled', 'cancelled: 1 accepted, 0 remaining']]);
});
