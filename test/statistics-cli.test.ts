import test, { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, printTaskHashes } from '../src/cli.ts';
import { git } from '../src/git.ts';
import { resolveHarness } from '../src/harness.ts';
import { runQueue } from '../src/runner.ts';
import { ledgerEffects, ledgerPath } from '../src/statistics.ts';
import type { RunStatistics } from '../src/statistics.ts';
import type { RunConfig } from '../src/model.ts';

afterEach(t => {
  const error = (t as unknown as { error?: Error }).error;
  if (error) process.stderr.write(error.stack + '\n');
});
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repository'); mkdirSync(root); git(root, 'init', '-b', 'main');
  const path = join(base, 'invocation.json'); const env = { XDG_STATE_HOME: join(base, 'state'), PRIVATE_ENV: 'SECRET_ENV' };
  const config = { invocation: 'statistics', authority: { reference: 'owner-ref', instruction: 'SECRET_AUTHORITY',
    target: 'main', tasks: {} }, project: { target: 'main', changes: 'openspec/changes', receipts: 'evidence/results',
      queue: 'planning/outcomes.json', repository: 'fixture/repo',
      planningCheck: { command: 'node', args: ['-e', ''] },
      checks: [{ command: 'node', args: ['--test-coverage-lines={coverage}'] }] } };
  writeFileSync(path, JSON.stringify(config));
  const records = (): RunStatistics[] => readFileSync(ledgerPath(env), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  return { base, root, path, env, config, records };
}

for (const [status, code] of [['exhausted', 0], ['limit-reached', 0], ['incomplete', 3]] as const) {
  test('C: one record and unchanged result for ' + status, async t => {
    const f = fixture(t); const output: unknown[] = [];
    const expected = { status, accepted: [], remaining: ['A'], completions: {} };
    assert.equal(await main(f.path, async (_config, options) => {
      options.report!({ status: 'blocked', id: 'A' }); return expected;
    }, line => output.push(JSON.parse(line)), { cwd: f.root, env: f.env }), code);
    assert.deepEqual(output, [{ status: 'blocked', id: 'A' }, expected]);
    assert.equal(f.records().length, 1); const record = f.records()[0];
    assert.equal(record.status, status); assert.equal(record.exitCode, code); assert.equal(record.failureReason, null);
    assert.equal(record.repositoryTopLevel, f.root); assert.equal(record.invocation, 'statistics');
    assert.equal(record.authorityReference, 'owner-ref'); assert.ok(record.durationSeconds >= 0);
    assert.match(record.runId, /^[0-9a-f-]{36}$/u);
    assert.equal(record.runnerVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
}

test('C: flags override JSON with their actual provenance at the main boundary', async t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ ...f.config, harness: 'codex', model: 'claude-sonnet-5-5', coverage: 90 }));
  assert.equal(await main(f.path, async (config, options) => {
    options.statistics!.resolved(await resolveHarness(config), options.statistics!.sources, 'scripted-version');
    options.statistics!.setting('leaves', ['A', 'D'], 'default');
    return { status: 'exhausted' };
  }, () => {}, { cwd: f.root, env: f.env, args: ['--harness=claude', '--coverage=93'] }), 0);
  const settings = f.records()[0].settings;
  assert.deepEqual(settings.harness, { value: 'claude', source: 'cli-flag' });
  assert.deepEqual(settings.harnessCliVersion, { value: 'scripted-version', source: 'cli-flag' });
  assert.deepEqual(settings.coverage, { value: 93, source: 'cli-flag' });
  assert.deepEqual(settings.model, { value: 'claude-sonnet-5-5', source: 'invocation-json' });
  assert.deepEqual(settings.effort, { value: 'medium', source: 'default' });
});

for (const scenario of ['json', 'flags', 'coverage', 'configuration', 'preflight', 'harness', 'model'] as const) {
  test('C: unavailable ' + scenario + ' appends one safe partial record', async t => {
    const f = fixture(t); let output = '';
    if (scenario === 'json') writeFileSync(f.path, '{SECRET_JSON');
    if (scenario === 'configuration') writeFileSync(f.path, JSON.stringify({ ...f.config, mode: 'invalid' }));
    if (scenario === 'model') writeFileSync(f.path, JSON.stringify({ ...f.config, model: 'SECRET_MODEL' }));
    const args = scenario === 'flags' ? ['--SECRET_FLAG=value'] : scenario === 'coverage' ? ['--coverage=0'] : [];
    const code = await main(f.path, (config, options) => runQueue(config, { ...options,
      openspec: { interactive: false, probe: () => ({ status: scenario === 'preflight' ? 1 : 0 }),
        configPresent: () => true },
      selection: { interactive: false, recorded: () => null, probe: harness => scenario === 'harness' ?
        { harness, available: false, reason: 'not-installed' } : { harness, available: true, version: 'fake-version' } },
      createAdapter: () => { throw new Error('Must never reach a worker'); },
    }), line => { output += line; }, { cwd: f.root, env: f.env, args });
    assert.equal(code, 4); const record = f.records()[0]; assert.equal(f.records().length, 1);
    assert.equal(record.status, 'unavailable'); assert.equal(record.exitCode, 4);
    assert.equal(record.failureReason, scenario === 'preflight' ? 'openspec-missing' :
      scenario === 'harness' ? 'harness-unavailable' : 'startup-or-run-failed');
    assert.deepEqual(record.tasks, []); assert.ok(!JSON.stringify(record).includes('SECRET_'));
    if (scenario === 'json') {
      assert.equal(record.repositoryTopLevel, null); assert.equal(record.invocation, null);
      for (const pair of Object.values(record.settings)) assert.deepEqual(pair, { value: null, source: null });
    }
    const diagnostics = JSON.parse(output).diagnostics;
    if (diagnostics) t.after(() => rmSync(join(diagnostics, '..'), { recursive: true, force: true }));
  });
}

test('C: hash success and failure leave the isolated ledger directory absent', t => {
  const f = fixture(t); const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = f.env.XDG_STATE_HOME;
  try {
    const queue = join(f.base, 'queue.json');
    writeFileSync(queue, JSON.stringify({ version: 1, tasks: [{ id: 'A', change: 'a', title: 'A',
      priority: 1, scopes: ['src'], dependencies: [], criteria: ['Works'] }] }));
    assert.equal(printTaskHashes(queue, () => {}), 0);
    writeFileSync(queue, '{');
    let failure = '';
    assert.equal(printTaskHashes(queue, line => { failure += line; }), 4);
    rmSync(join(JSON.parse(failure).diagnostics, '..'), { recursive: true, force: true });
    assert.equal(existsSync(join(f.env.XDG_STATE_HOME, 'outcome-runner')), false);
  } finally {
    if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old;
  }
});

test('C: two executions append two distinct parseable records and preserve the first bytes', async t => {
  const f = fixture(t);
  const execute = () => main(f.path, async () => ({ status: 'exhausted' }), () => {}, { cwd: f.root, env: f.env });
  assert.equal(await execute(), 0); const first = readFileSync(ledgerPath(f.env));
  assert.equal(await execute(), 0);
  const records = f.records(); assert.equal(records.length, 2); assert.notEqual(records[0].runId, records[1].runId);
  assert.deepEqual(readFileSync(ledgerPath(f.env)).subarray(0, first.length), first);
});

for (const failure of ['EACCES', 'invalid-parent'] as const) {
  for (const status of ['exhausted', 'incomplete', 'unavailable', 'cancelled'] as const) {
    test('C: ' + failure + ' preserves ' + status + ' stdout and exit', async t => {
      const f = fixture(t); let stderr = ''; const output: { status: string; diagnostics?: string }[] = [];
      if (failure === 'invalid-parent') writeFileSync(f.env.XDG_STATE_HOME, 'not a directory');
      const effects = failure === 'EACCES' ? { ...ledgerEffects, open: () => {
        throw Object.assign(new Error('SECRET_EACCES'), { code: 'EACCES' });
      } } : ledgerEffects;
      const code = await main(f.path, async () => {
        if (status === 'cancelled') { process.emit('SIGINT'); throw new Error('SECRET_CANCEL'); }
        if (status === 'unavailable') throw new Error('SECRET_ERROR');
        return { status };
      }, line => output.push(JSON.parse(line)), { cwd: f.root, env: f.env,
        ledger: { effects, stderr: line => { stderr += line; } } });
      assert.equal(code, status === 'exhausted' ? 0 : status === 'unavailable' ? 4 : 3);
      assert.equal(output.length, 1); assert.equal(output[0].status, status);
      assert.match(stderr, /statistics ledger/u); assert.ok(!stderr.includes('SECRET'));
      if (output[0].diagnostics) rmSync(join(output[0].diagnostics!, '..'), { recursive: true, force: true });
    });
  }
}
