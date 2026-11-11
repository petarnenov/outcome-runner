import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import type { RunConfig } from '../src/model.ts';
import { disposeInvocation } from '../src/dispose.ts';
import { dispose, run } from '../src/cli.ts';
import { invocationLockFiles } from '../src/runner.ts';
import type { PullRequestHost } from '../src/runner.ts';
import { resolveRunPaths } from '../src/run-paths.ts';
import { runnerFixture } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

/**
 * The CLI view of invocation `name` (design decision 9): a temporary XDG state home, the invocation file without
 * `root` and `stateDirectory`, and the run configuration the CLI resolves from it.
 */
function cliInvocation(f: RunnerFixture, name: string, patch: Partial<RunConfig> = {}) {
  const env = { XDG_STATE_HOME: join(f.base, 'xdg') };
  const { root: _root, stateDirectory: _state, ...invocation } = f.config(name, patch);
  const file = join(f.base, `invocation-${name}.json`); writeFileSync(file, JSON.stringify(invocation));
  return { env, file, config: resolveRunPaths(invocation, { cwd: f.root, env }) };
}

/** Runs the dispose command and returns its exit code, its printed lines and the parsed last line. */
async function disposeCli(f: RunnerFixture, file: string, env: NodeJS.ProcessEnv,
  { host, args }: { host?: PullRequestHost; args?: string[] } = {}) {
  const lines: string[] = [];
  const code = await dispose(file, line => lines.push(line), { cwd: f.root, env, host, args });
  const line = JSON.parse(lines.at(-1)!);
  if (line.diagnostics) rmSync(dirname(line.diagnostics), { recursive: true, force: true });
  return { code, lines, line };
}

/** The invocation lock and ownership files of `config` beside the fixture's primary checkout. */
const lockFiles = (f: RunnerFixture, config: RunConfig) => invocationLockFiles(f.root, config.stateDirectory);

const unknownInvocation = (error: unknown) => (error as { reason?: string }).reason === 'unknown-invocation';

// Grade E

test('E (required): an unknown invocation is refused before any state, lock or ownership file exists', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('ghost', { leaves: ['A'] });
  await assert.rejects(disposeInvocation(config, { host: f.hostFor() }), unknownInvocation);
  assert.equal(existsSync(config.stateDirectory), false);
  for (const path of Object.values(lockFiles(f, config))) assert.equal(existsSync(path), false, path);

  const cli = cliInvocation(f, 'never-run', { leaves: ['A'] });
  const { code, lines, line } = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
  assert.equal(code, 4); assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(line).sort(), ['diagnostics', 'reason', 'status']);
  assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'unknown-invocation');
  assert.equal(existsSync(cli.config.stateDirectory), false);
  for (const path of Object.values(lockFiles(f, cli.config))) assert.equal(existsSync(path), false, path);
  assert.equal(git(f.remote, 'for-each-ref', 'refs/heads/work-queue-claims-main'), '');
});

test('E (coverage-only): a state of another invocation name is unknown-invocation', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'] });
  mkdirSync(config.stateDirectory, { recursive: true });
  const state = { version: 2, identity: { invocation: 'other', root: f.root, project: { target: 'main' } } };
  writeFileSync(join(config.stateDirectory, 'state.json'), JSON.stringify(state));
  await assert.rejects(disposeInvocation(config, { host: f.hostFor() }), unknownInvocation);
  for (const path of Object.values(lockFiles(f, config))) assert.equal(existsSync(path), false, path);
  assert.deepEqual(JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8')), state);
});

test('E (coverage-only): dispose rejects an unknown argument and a repeated --remove-work with exit 4', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const cli = cliInvocation(f, 'one', { leaves: ['A'] });
  for (const args of [['--bogus'], ['--remove-work', '--remove-work'], ['--remove-work=yes']]) {
    const { code, line } = await disposeCli(f, cli.file, cli.env, { args });
    assert.equal(code, 4, JSON.stringify(args)); assert.equal(line.status, 'unavailable');
    assert.equal(line.reason, 'startup-or-run-failed');
  }
});

test('E (required): run dispatches dispose with the file and its flags and returns its exit code', async () => {
  const calls: Parameters<typeof dispose>[] = [];
  const spy: typeof dispose = async (...args) => { calls.push(args); return 7; };
  assert.equal(await run(['dispose', 'invocation.json', '--remove-work'], { dispose: spy }), 7);
  assert.equal(calls.length, 1);
  const [path, output, options] = calls[0];
  assert.equal(path, 'invocation.json'); assert.equal(output, undefined);
  assert.deepEqual(options, { args: ['--remove-work'] });
});
