import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { USAGE, printTaskHashes, run } from '../src/cli.ts';
import { runnerVersion } from '../src/runner-version.ts';
import { ledgerPath } from '../src/statistics.ts';
import { hash } from '../src/model.ts';
import { git } from '../src/git.ts';
import { RunStore } from '../src/run-store.ts';
import type { InvocationIdentity } from '../src/invocation-identity.ts';
import { disposeInvocation } from '../src/dispose.ts';
import { invocationLockFiles } from '../src/runner.ts';
import { main } from './support/isolated-cli.ts';
import { publishToOrigin } from './support/git-origin.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';

const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string;
const binary = resolve('bin/outcome-runner.ts');
const taskA = { id: 'A', title: 'One', change: 'one', priority: 1, criteria: ['Works.'], scopes: ['src/a'], dependencies: [] };
const taskB = { id: 'B', title: 'Two', change: 'two', priority: 2, criteria: ['Works.'], scopes: ['src/b'], dependencies: [] };

function directory(t: TestContext, prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** A queue file with tasks A and B. */
function queueFile(t: TestContext): string {
  const path = join(directory(t, 'cli-usage-queue-'), 'queue.json');
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [taskA, taskB] }));
  return path;
}

/** Captures what `run` writes to stdout and stderr. */
async function captured(args: string[]) {
  let stdout = ''; let stderr = '';
  const code = await run(args, undefined, { output: line => { stdout += line; }, error: line => { stderr += line; } });
  return { code, stdout, stderr };
}

/** Spawns the binary with a fresh ledger home and temporary directory. */
function spawnIsolated(t: TestContext, args: string[]) {
  const state = directory(t, 'cli-usage-state-'); const temporary = directory(t, 'cli-usage-tmp-');
  const home = directory(t, 'cli-usage-home-');
  const env = { ...process.env, XDG_STATE_HOME: state, TMPDIR: temporary, HOME: home };
  const result = spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8', env });
  return { result, ledger: ledgerPath(env, home), temporary };
}

/** Asserts that `text` is exactly one line without a stack frame and returns it without the newline. */
function oneLine(text: string): string {
  assert.match(text, /^[^\n]+\n$/u);
  assert.ok(!text.includes('    at '), text);
  return text.slice(0, -1);
}

/** Reads the diagnostics file named by an `unavailable` line and removes its directory. */
function diagnosticsOf(line: string): Record<string, unknown> {
  const parsed = JSON.parse(line);
  assert.equal(parsed.status, 'unavailable');
  const content = JSON.parse(readFileSync(parsed.diagnostics, 'utf8'));
  rmSync(dirname(parsed.diagnostics), { recursive: true, force: true });
  return content;
}

// Grade E

test('E (required): --version prints the package version and exits 0 without a ledger record or diagnostics', async t => {
  assert.deepEqual(await captured(['--version']), { code: 0, stdout: `${packageVersion}\n`, stderr: '' });
  const { result, ledger, temporary } = spawnIsolated(t, ['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${packageVersion}\n`);
  assert.equal(existsSync(ledger), false);
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith('work-queue-error-')), []);
});

test('E (required): --help and -h print the same usage with every command and exit 0', async t => {
  const help = await captured(['--help']);
  const short = await captured(['-h']);
  assert.equal(help.code, 0); assert.equal(short.code, 0);
  assert.equal(help.stdout, USAGE); assert.equal(short.stdout, help.stdout);
  for (const text of ['<invocation file>', '--harness=', '--model=', '--effort=', '--coverage=', '--no-mascot',
    '--retry <task id>', 'hash <queue file> [<task id>...]', 'dispose <invocation file> [--remove-work]',
    'outcome-runner --version', 'outcome-runner --help']) {
    assert.ok(help.stdout.includes(text), text);
  }
  for (const flag of ['--help', '-h']) {
    const { result } = spawnIsolated(t, [flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, USAGE);
  }
});

test('E (coverage-only): runnerVersion returns the package version on every call', () => {
  assert.equal(runnerVersion(), packageVersion);
  assert.equal(runnerVersion(), packageVersion);
});

// Grade D

test('D (required): hash prints only the requested task ids', async t => {
  const queue = queueFile(t); const lines: string[] = [];
  assert.equal(printTaskHashes(queue, line => lines.push(line), { ids: ['B'] }), 0);
  assert.deepEqual(lines, [`${JSON.stringify({ B: hash(taskB) })}\n`]);
  assert.deepEqual(await captured(['hash', queue, 'B']),
    { code: 0, stdout: `${JSON.stringify({ B: hash(taskB) })}\n`, stderr: '' });
  assert.deepEqual(await captured(['hash', queue]),
    { code: 0, stdout: `${JSON.stringify({ A: hash(taskA), B: hash(taskB) })}\n`, stderr: '' });
  assert.deepEqual(await captured(['hash', queue, 'B', 'A', 'B']),
    { code: 0, stdout: `${JSON.stringify({ A: hash(taskA), B: hash(taskB) })}\n`, stderr: '' });
});

test('D (required): a missing queue file is one stderr line naming it with exit 4', async t => {
  const missing = join(directory(t, 'cli-usage-missing-'), 'missing.json');
  const lines: string[] = []; let stderr = '';
  assert.equal(printTaskHashes(missing, line => lines.push(line), { error: line => { stderr += line; } }), 4);
  assert.deepEqual(lines, []);
  assert.ok(oneLine(stderr).includes(missing));
  const { result, temporary } = spawnIsolated(t, ['hash', missing]);
  assert.equal(result.status, 4);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith('work-queue-error-')), []);
  // A directory is not a queue file either.
  const folder = await captured(['hash', dirname(missing)]);
  assert.equal(folder.code, 4); assert.equal(folder.stdout, '');
  assert.ok(oneLine(folder.stderr).includes(dirname(missing)));
});

test('D (required): unknown task ids are named in one stderr line with exit 4', async t => {
  const queue = queueFile(t);
  const one = await captured(['hash', queue, 'X']);
  assert.equal(one.code, 4); assert.equal(one.stdout, '');
  assert.equal(oneLine(one.stderr), 'outcome-runner hash: unknown task id: X');
  const two = await captured(['hash', queue, 'A', 'X', 'Y']);
  assert.equal(two.code, 4); assert.equal(two.stdout, '');
  assert.equal(oneLine(two.stderr), 'outcome-runner hash: unknown task ids: X, Y');
  const control = await captured(['hash', queue, 'X\nY']);
  assert.equal(oneLine(control.stderr), 'outcome-runner hash: unknown task id: "X\\nY"');
});

// Grade C

test('C (required): diagnostics files of a refused run and a malformed queue name the runner version', async t => {
  const base = directory(t, 'cli-usage-run-');
  const root = join(base, 'project'); mkdirSync(root);
  git(root, 'init', '-b', 'main'); publishToOrigin(root);
  const invocation = join(base, 'invocation.json'); writeFileSync(invocation, JSON.stringify({ invocation: 'nightly' }));
  let output = '';
  assert.equal(await main(invocation, async () => { throw new Error('Must not run'); }, line => { output += line; },
    { cwd: root, args: ['--bogus'], mascot: async () => {} }), 4);
  assert.equal(diagnosticsOf(oneLine(output)).runnerVersion, packageVersion);
  const queue = join(base, 'queue.json'); writeFileSync(queue, '{');
  const lines: string[] = [];
  assert.equal(printTaskHashes(queue, line => lines.push(line), { error: () => assert.fail('No usage error') }), 4);
  assert.equal(lines.length, 1);
  assert.equal(diagnosticsOf(lines[0]).runnerVersion, packageVersion);
});

test('C (required): state.json names the runner version and a state without it still opens', t => {
  const identity = { leaves: ['A'], invocation: 'one' } as unknown as InvocationIdentity;
  const path = join(directory(t, 'cli-usage-store-'), 'state');
  const store = new RunStore(path, identity, { version: () => '9.9.9' });
  store.close();
  const file = join(path, 'state.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.runnerVersion, '9.9.9');
  const { runnerVersion: _dropped, ...older } = written;
  writeFileSync(file, JSON.stringify(older));
  const reopened = new RunStore(path, identity);
  reopened.close();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runnerVersion, packageVersion);
  assert.equal(reopened.state.identityHash, written.identityHash);
});

// Grade B

test('B (required): the ownership file names the runner version, also after dispose and for older files', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const failing = scriptedWorker({ fail: prompt => prompt.includes('Task A;') || prompt.includes('Task B;') });
  const one = f.config('one', { leaves: ['A'] });
  assert.equal((await f.run(one, { createAdapter: failing })).status, 'incomplete');
  const files = invocationLockFiles(f.root, one.stateDirectory);
  const written = JSON.parse(readFileSync(files.ownership, 'utf8'));
  assert.equal(written.released, false); assert.equal(written.runnerVersion, packageVersion);
  assert.equal((await disposeInvocation(one, { host: f.hostFor() })).ownership, 'released');
  const released = JSON.parse(readFileSync(files.ownership, 'utf8'));
  assert.deepEqual(released, { ...written, released: true, runnerVersion: packageVersion });
  assert.equal(JSON.parse(readFileSync(join(one.stateDirectory, 'state.json'), 'utf8')).runnerVersion, packageVersion);

  const two = f.config('two', { leaves: ['B'] });
  assert.equal((await f.run(two, { createAdapter: failing })).status, 'incomplete');
  const older = invocationLockFiles(f.root, two.stateDirectory).ownership;
  const { runnerVersion: _dropped, ...fields } = JSON.parse(readFileSync(older, 'utf8'));
  writeFileSync(older, JSON.stringify(fields));
  assert.equal((await disposeInvocation(two, { host: f.hostFor() })).ownership, 'released');
  assert.deepEqual(JSON.parse(readFileSync(older, 'utf8')), { ...fields, released: true, runnerVersion: packageVersion });
});
