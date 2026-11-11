import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { digest, hash, validBranchName, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { invocationLockFiles } from '../src/runner.ts';
import { resolveRunPaths } from '../src/run-paths.ts';
import { openspecPreflight } from '../src/openspec-preflight.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const configFor = (target: string): RunConfig => ({ root: '/repository', stateDirectory: '/state/one', invocation: 'one',
  authority: { reference: 'owner', instruction: 'OFF', target, tasks: {} },
  project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target,
    checks: [{ command: 'node', args: ['--test-coverage-lines={coverage}'] }], planningCheck: { command: 'openspec', args: ['validate'] } } });

// Grade E

test('E (required): the resolved target is part of the frozen invocation identity', () => {
  assert.notEqual(hash(configFor('main')), hash(configFor('feature/x')));
  assert.equal(hash(configFor('main')), hash(configFor('main')));
});

test('E (required): every valid Git branch name is a target and invalid names are refused', () => {
  for (const name of ['main', 'release/1.2', 'fix/v2.0', 'feature/x']) {
    assert.equal(validBranchName(name), true, name);
    assert.equal(validateConfig(configFor(name)).project.target, name);
  }
  for (const name of ['-x', 'a..b', 'a/', 'a.lock', '.a', 'a b', 'a@{b', '@']) {
    assert.equal(validBranchName(name), false, name);
    assert.throws(() => validateConfig(configFor(name)), /Invalid OFF configuration or authority/u, name);
  }
  for (const name of ['', '/a', 'a//b', 'a.', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a/.b', 'a\u0007', undefined, 3]) {
    assert.equal(validBranchName(name), false, String(name));
  }
});

test('E (coverage-only): lock and ownership files are per invocation of one clone', () => {
  const one = invocationLockFiles('/clone', '/state/one');
  assert.deepEqual(invocationLockFiles('/clone', '/state/one'), one);
  const other = invocationLockFiles('/clone', '/state/other');
  assert.notEqual(other.lock, one.lock); assert.notEqual(other.ownership, one.ownership);
  assert.equal(one.lock, join('/', '.work-queue-locks', `${hash('/clone')}-${hash('/state/one')}.sqlite`));
  assert.equal(one.ownership, join('/', '.work-queue-locks', `${hash('/clone')}-${hash('/state/one')}-owner.json`));
});

function receiptRepository(t: TestContext, target: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'many-runners-receipt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const spec = 'openspec/changes/a/specs/a/spec.md';
  mkdirSync(join(root, 'openspec/changes/a/specs/a'), { recursive: true }); writeFileSync(join(root, spec), '# A\n');
  const receipt = { version: 1, id: 'A', taskHash: 'task', authority: 'owner', ...(target === undefined ? {} : { target }),
    specification: { [spec]: digest('# A\n') }, review: { reviewer: 'claude:review', outcome: 'accepted', accepted: true },
    checks: [{ command: 'node', args: [], outcome: 'passed' }], manifest: [{ path: spec, hash: digest('# A\n') }],
    head: 'head', base: 'base' };
  mkdirSync(join(root, 'evidence/results'), { recursive: true });
  writeFileSync(join(root, 'evidence/results/A.json'), JSON.stringify(receipt));
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'test: receipt');
  return root;
}

test('E (coverage-only): receipts without a target stay valid and an empty target is refused', t => {
  assert.equal(receiptAt(receiptRepository(t, undefined), 'HEAD', 'evidence/results/A.json', 'task', null)!.target, undefined);
  assert.equal(receiptAt(receiptRepository(t, 'feature/x'), 'HEAD', 'evidence/results/A.json', 'task', null)!.target, 'feature/x');
  for (const target of ['', 7]) {
    assert.throws(() => receiptAt(receiptRepository(t, target), 'HEAD', 'evidence/results/A.json', 'task', null),
      /Invalid accepted outcome receipt/u);
  }
});

// Grade D

/** The fixture configuration as an invocation file would hold it: without root and state directory. */
function invocationOf(f: RunnerFixture): RunConfig {
  const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
  return invocation as RunConfig;
}
/** Writes an invocation file of the fixture configuration, transformed by `patch`. */
function invocationFile(f: RunnerFixture, patch: (config: RunConfig) => object = config => config) {
  const path = join(f.base, 'invocation.json'); writeFileSync(path, JSON.stringify(patch(invocationOf(f))));
  return path;
}
const withoutTargets = (config: RunConfig) => {
  const { target: _project, ...project } = config.project; const { target: _authority, ...authority } = config.authority;
  return { ...config, project, authority };
};

/** Runs the CLI in the fixture checkout and returns the exit code, the printed line and the diagnostics file content. */
async function cli(f: RunnerFixture, path: string, runner: Parameters<typeof main>[1] = async () => { throw new Error('Must not run'); }) {
  const lines: string[] = [];
  const code = await main(path, runner, line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg') } });
  const line = JSON.parse(lines.at(-1)!);
  const diagnostics = line.diagnostics ? JSON.parse(readFileSync(line.diagnostics, 'utf8')) : null;
  if (line.diagnostics) rmSync(join(line.diagnostics, '..'), { recursive: true, force: true });
  return { code, line, diagnostics };
}

/** No invocation lock, worktree or claims-ledger claim was created. */
function nothingAllocated(f: RunnerFixture, branch = 'main') {
  assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(f.remote, 'for-each-ref', `refs/heads/work-queue-claims-${branch.replaceAll('/', '-')}`), '');
  assert.equal(existsSync(join(f.base, 'xdg', 'outcome-runner')), false);
}

test('D (required): omitted project.target and authority.target resolve to the current branch', t => {
  const f = runnerFixture(t);
  const config = resolveRunPaths(withoutTargets(invocationOf(f)) as unknown as Partial<RunConfig>,
    { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg') } });
  assert.equal(config.root, f.root);
  assert.equal(config.project.target, 'main'); assert.equal(config.authority.target, 'main');
  assert.equal(config.project.queue, 'planning/outcomes.json'); assert.equal(config.authority.reference, 'fixture-owner');
});

for (const field of ['project', 'authority'] as const) {
  test(`D (required): only ${field}.target given and different from the current branch is refused`, async t => {
    const f = runnerFixture(t);
    git(f.root, 'checkout', '-q', '-b', 'feature/x'); git(f.root, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
    const path = invocationFile(f, config => {
      const stripped = withoutTargets(config);
      return { ...stripped, [field]: { ...stripped[field], target: 'main' } };
    });
    const { code, line, diagnostics } = await cli(f, path);
    assert.equal(code, 4);
    assert.equal(line.reason, 'target-differs-from-current-branch'); assert.equal(diagnostics.reason, 'target-differs-from-current-branch');
    assert.match(diagnostics.message, new RegExp(`${field}\\.target "main" differs from the current branch "feature/x"`, 'u'));
    nothingAllocated(f, 'feature/x'); nothingAllocated(f, 'main');
  });
}

test('D (required): a detached HEAD is refused with reason detached-head', async t => {
  const f = runnerFixture(t);
  git(f.root, 'checkout', '-q', '--detach');
  const { code, line, diagnostics } = await cli(f, invocationFile(f, withoutTargets));
  assert.equal(code, 4); assert.equal(line.reason, 'detached-head'); assert.equal(diagnostics.reason, 'detached-head');
  nothingAllocated(f);
});

test('D (required): a branch missing on origin is refused with reason target-missing-on-origin', async t => {
  const f = runnerFixture(t);
  git(f.root, 'checkout', '-q', '-b', 'local-only');
  const { code, line, diagnostics } = await cli(f, invocationFile(f, withoutTargets));
  assert.equal(code, 4); assert.equal(line.reason, 'target-missing-on-origin');
  assert.equal(diagnostics.reason, 'target-missing-on-origin'); assert.equal(diagnostics.details.branch, 'local-only');
  nothingAllocated(f, 'local-only');
});

test('D (required): a start on release/1.2 resolves the target and passes validation and the OpenSpec target check', async t => {
  const f = runnerFixture(t);
  git(f.root, 'checkout', '-q', '-b', 'release/1.2'); git(f.root, 'push', '-q', 'origin', 'HEAD:refs/heads/release/1.2');
  let checked: string[] = [];
  const { code, line } = await cli(f, invocationFile(f, withoutTargets), async config => {
    validateConfig(config);
    await openspecPreflight(config, { interactive: false, probe: () => ({ status: 0 }) });
    checked = [config.project.target, config.authority.target];
    return { status: 'exhausted' };
  });
  assert.equal(code, 0, JSON.stringify(line)); assert.equal(line.status, 'exhausted');
  assert.deepEqual(checked, ['release/1.2', 'release/1.2']);
});

test('D (required): a branch name rejected by git check-ref-format is refused with reason unsupported-target-name', async t => {
  const f = runnerFixture(t);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const stub = join(f.base, 'stub-bin'); mkdirSync(stub);
  writeFileSync(join(stub, 'git'), `#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = check-ref-format ]; then exit 1; fi\ndone\n` +
    `exec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  const path = invocationFile(f, withoutTargets); const previous = process.env.PATH;
  process.env.PATH = `${stub}:${previous}`;
  let result: Awaited<ReturnType<typeof cli>>;
  try { result = await cli(f, path); } finally { process.env.PATH = previous; }
  assert.equal(result.code, 4); assert.equal(result.line.reason, 'unsupported-target-name');
  assert.equal(result.diagnostics.reason, 'unsupported-target-name');
  nothingAllocated(f);
});
