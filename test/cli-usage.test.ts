import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { USAGE, run } from '../src/cli.ts';
import { runnerVersion } from '../src/runner-version.ts';
import { ledgerPath } from '../src/statistics.ts';

const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string;
const binary = resolve('bin/outcome-runner.ts');

function directory(t: TestContext, prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
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

// Grade E

test('--version prints the package version and exits 0 without a ledger record or diagnostics', async t => {
  assert.deepEqual(await captured(['--version']), { code: 0, stdout: `${packageVersion}\n`, stderr: '' });
  const { result, ledger, temporary } = spawnIsolated(t, ['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${packageVersion}\n`);
  assert.equal(existsSync(ledger), false);
  assert.deepEqual(readdirSync(temporary).filter(name => name.startsWith('work-queue-error-')), []);
});

test('--help and -h print the same usage with every command and exit 0', async t => {
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

test('runnerVersion returns the package version on every call', () => {
  assert.equal(runnerVersion(), packageVersion);
  assert.equal(runnerVersion(), packageVersion);
});
