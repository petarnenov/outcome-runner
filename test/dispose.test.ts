import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import type { RunConfig, Work } from '../src/model.ts';
import { disposeInvocation } from '../src/dispose.ts';
import { dispose, main, run } from '../src/cli.ts';
import { invocationLockFiles, runQueue } from '../src/runner.ts';
import type { PullRequestHost, RunOptions } from '../src/runner.ts';
import { resolveRunPaths } from '../src/run-paths.ts';
import { hasBranch, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
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
const ownershipText = (f: RunnerFixture, config: RunConfig) => readFileSync(lockFiles(f, config).ownership, 'utf8');
const ownershipOf = (f: RunnerFixture, config: RunConfig) => JSON.parse(ownershipText(f, config));
const stateText = (config: RunConfig) => readFileSync(join(config.stateDirectory, 'state.json'), 'utf8');
const stateOf = (config: RunConfig) => JSON.parse(stateText(config));

const CLAIMS = 'refs/heads/work-queue-claims-main';
const ledgerHead = (f: RunnerFixture) => git(f.remote, 'for-each-ref', '--format=%(objectname)', CLAIMS);
const ledgerFiles = (f: RunnerFixture): string[] => {
  const head = ledgerHead(f);
  return head ? git(f.remote, 'ls-tree', '--name-only', head).split('\n').filter(Boolean) : [];
};
const claimText = (f: RunnerFixture, id: string) => git(f.remote, 'show', `${ledgerHead(f)}:${id}.json`);

const reasonIs = (reason: string) => (error: unknown) => (error as { reason?: string }).reason === reason;
const failing = (...ids: string[]) => scriptedWorker({ fail: prompt => ids.some(id => prompt.includes(`Task ${id};`)) });
/** A scripted host whose merge fails: the task stays blocked at merge with a pushed branch and an open pull request. */
const mergeFailing = (f: RunnerFixture): PullRequestHost => ({ ...f.hostFor(),
  merge() { throw new Error('Scripted merge failure'); } });

/** Runs `config` until its first leaf is blocked at merge and returns the blocked work. */
async function blockOnMerge(f: RunnerFixture, config: RunConfig, extra: RunOptions = {}): Promise<Work> {
  const result = await runQueue(config, f.options(config, { host: mergeFailing(f), ...extra }));
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  const work: Work = stateOf(config).blocked[config.leaves![0]].work;
  assert.equal(work.stage, 'merge');
  return work;
}

// Grade E

test('E (required): an unknown invocation is refused before any state, lock or ownership file exists', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('ghost', { leaves: ['A'] });
  await assert.rejects(disposeInvocation(config, { host: f.hostFor() }), reasonIs('unknown-invocation'));
  assert.equal(existsSync(config.stateDirectory), false);
  for (const path of Object.values(lockFiles(f, config))) assert.equal(existsSync(path), false, path);

  const cli = cliInvocation(f, 'never-run', { leaves: ['A'] });
  const { code, lines, line } = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
  assert.equal(code, 4); assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(line).sort(), ['diagnostics', 'reason', 'status']);
  assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'unknown-invocation');
  assert.equal(existsSync(cli.config.stateDirectory), false);
  for (const path of Object.values(lockFiles(f, cli.config))) assert.equal(existsSync(path), false, path);
  assert.equal(git(f.remote, 'for-each-ref', CLAIMS), '');
});

test('E (coverage-only): a state of another invocation name is unknown-invocation', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'] });
  mkdirSync(config.stateDirectory, { recursive: true });
  const state = { version: 2, identity: { invocation: 'other', root: f.root, project: { target: 'main' } } };
  writeFileSync(join(config.stateDirectory, 'state.json'), JSON.stringify(state));
  await assert.rejects(disposeInvocation(config, { host: f.hostFor() }), reasonIs('unknown-invocation'));
  for (const path of Object.values(lockFiles(f, config))) assert.equal(existsSync(path), false, path);
  assert.deepEqual(stateOf(config), state);
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

// Grade D

test('D (required): a fully accepted invocation has nothing to release and stays byte-for-byte unchanged', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'] });
  assert.equal((await f.run(config)).status, 'exhausted');
  const before = { state: stateText(config), ledger: ledgerHead(f), target: git(f.remote, 'rev-parse', 'main'),
    receipt: git(f.remote, 'show', 'main:evidence/results/A.json'), ownership: ownershipText(f, config) };
  const summary = await disposeInvocation(config, { host: f.hostFor() });
  assert.deepEqual(summary, { status: 'nothing-to-release', invocation: 'one', releasedClaims: [],
    ownership: 'already-released', work: [], openPullRequests: [] });
  assert.deepEqual({ state: stateText(config), ledger: ledgerHead(f), target: git(f.remote, 'rev-parse', 'main'),
    receipt: git(f.remote, 'show', 'main:evidence/results/A.json'), ownership: ownershipText(f, config) }, before);
  assert.equal(stateOf(config).status, 'released'); assert.equal(Object.hasOwn(stateOf(config), 'disposed'), false);
  assert.deepEqual(ledgerFiles(f), ['A.json']); assert.equal(f.records[0].state, 'MERGED');
});

// Grade C

test('C (required): dispose releases the claims in one commit and frees the ownership for a new invocation', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const one = f.config('one', { leaves: ['A'] });
  const work = await blockOnMerge(f, one);
  assert.deepEqual(ledgerFiles(f), ['A.json']);
  assert.ok(existsSync(work.path)); assert.ok(hasBranch(f.root, work.branch)); assert.ok(hasBranch(f.remote, work.branch));
  const head = ledgerHead(f);
  const summary = await disposeInvocation(one, { host: f.hostFor() });
  assert.equal(summary.status, 'disposed'); assert.deepEqual(summary.releasedClaims, ['A']);
  assert.equal(summary.ownership, 'released');
  assert.deepEqual(ledgerFiles(f), []);
  assert.equal(git(f.remote, 'rev-list', '--count', `${head}..${ledgerHead(f)}`), '1');
  assert.equal(git(f.remote, 'log', '-1', '--format=%s', ledgerHead(f)), 'chore(fixture): release claims of invocation one');
  assert.equal(ownershipOf(f, one).released, true);
  const state = stateOf(one);
  assert.equal(state.status, 'released'); assert.deepEqual(Object.keys(state.disposed.tasks), ['A']);
  assert.equal(state.disposed.tasks.A.branch, work.branch); assert.deepEqual(state.blocked, {});
  const result = await f.run(f.config('two', { leaves: ['A'] }));
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.deepEqual(result.accepted, ['A']);
});

test('C (required): dispose keeps and lists the worktree and branches of unaccepted work by default', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const one = f.config('one', { leaves: ['A'] });
  const work = await blockOnMerge(f, one);
  const summary = await disposeInvocation(one, { host: f.hostFor() });
  assert.deepEqual(summary.work, [{ id: 'A', worktree: { path: work.path, state: 'kept' },
    localBranch: { name: work.branch, state: 'kept' }, remoteBranch: { name: work.branch, state: 'kept' } }]);
  assert.ok(existsSync(work.path)); assert.ok(hasBranch(f.root, work.branch)); assert.ok(hasBranch(f.remote, work.branch));
});

test('C (required): dispose with removeWork removes the worktree and branches of unaccepted work', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const one = f.config('one', { leaves: ['A'] });
  const work = await blockOnMerge(f, one);
  const summary = await disposeInvocation(one, { host: f.hostFor(), removeWork: true });
  assert.deepEqual(summary.work, [{ id: 'A', worktree: { path: work.path, state: 'removed' },
    localBranch: { name: work.branch, state: 'removed' }, remoteBranch: { name: work.branch, state: 'removed' } }]);
  assert.equal(existsSync(work.path), false);
  assert.equal(hasBranch(f.root, work.branch), false); assert.equal(hasBranch(f.remote, work.branch), false);
  assert.ok(!git(f.root, 'worktree', 'list').includes(work.path));
  assert.deepEqual(summary.releasedClaims, ['A']);
});

test('C (required): a repeated dispose exits 0 with nothing-to-release and changes nothing', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const cli = cliInvocation(f, 'one', { leaves: ['A'] });
  await blockOnMerge(f, cli.config);
  const first = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
  assert.equal(first.code, 0); assert.equal(first.line.status, 'disposed');
  const before = { state: stateText(cli.config), ledger: ledgerHead(f), ownership: ownershipText(f, cli.config) };
  const second = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
  assert.equal(second.code, 0); assert.equal(second.line.status, 'nothing-to-release');
  assert.deepEqual(second.line.releasedClaims, []); assert.equal(second.line.ownership, 'already-released');
  assert.deepEqual(second.line.work, first.line.work);
  assert.deepEqual({ state: stateText(cli.config), ledger: ledgerHead(f), ownership: ownershipText(f, cli.config) }, before);
});

test('C (required): a disposed invocation is refused with invocation-disposed and claims nothing', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const cli = cliInvocation(f, 'one', { leaves: ['A'] });
  const blocked = await runQueue(cli.config, f.options(cli.config, { createAdapter: failing('A') }));
  assert.equal(blocked.status, 'incomplete');
  assert.equal((await disposeCli(f, cli.file, cli.env, { host: f.hostFor() })).code, 0);
  const head = ledgerHead(f);
  const lines: string[] = [];
  const code = await main(cli.file, (config, options) => runQueue(config, f.options(config, options)),
    line => lines.push(line), { cwd: f.root, env: cli.env, mascot: async () => {} });
  const line = JSON.parse(lines.at(-1)!);
  rmSync(dirname(line.diagnostics), { recursive: true, force: true });
  assert.equal(code, 4); assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'invocation-disposed');
  assert.equal(ledgerHead(f), head); assert.deepEqual(ledgerFiles(f), []);
  assert.equal(ownershipOf(f, cli.config).released, true);
});

test('C (required): an incomplete invocation without claims is disposed, released and never resumed', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const two = f.config('two', { leaves: ['B'] });
  assert.equal((await f.run(two, { createAdapter: failing('B') })).status, 'incomplete');
  const one = f.config('one', { leaves: ['B'] });
  // `one` waits for the claim of `two`; the fixture's first poll cancels it, which leaves it incomplete.
  const waiting = await f.run(one, { createAdapter: () => { throw new Error('No worker expected'); } });
  assert.equal(waiting.status, 'cancelled'); assert.equal(waiting.blockers!.B.kind, 'waiting-for-claim');
  assert.equal(stateOf(one).status, 'incomplete'); assert.equal(ownershipOf(f, one).released, false);
  assert.deepEqual(ledgerFiles(f), ['B.json']);
  assert.equal(JSON.parse(claimText(f, 'B')).claimant, stateOf(two).claimant);
  const before = { ledger: ledgerHead(f), claim: claimText(f, 'B'), two: stateText(two) };
  const summary = await disposeInvocation(one, { host: f.hostFor() });
  assert.deepEqual(summary, { status: 'disposed', invocation: 'one', releasedClaims: [], ownership: 'released',
    work: [], openPullRequests: [] });
  assert.equal(ownershipOf(f, one).released, true);
  assert.equal(stateOf(one).status, 'released'); assert.deepEqual(stateOf(one).disposed.tasks, {});
  assert.deepEqual({ ledger: ledgerHead(f), claim: claimText(f, 'B'), two: stateText(two) }, before);
  await assert.rejects(f.run(one), reasonIs('invocation-disposed'));
  const state = stateText(one);
  assert.equal((await disposeInvocation(one, { host: f.hostFor() })).status, 'nothing-to-release');
  assert.equal(stateText(one), state);
});

// Grade B

test('B (required): accepted work of the invocation is untouched and only the unaccepted claim is released', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const one = f.config('one', { leaves: ['A', 'B'] });
  const result = await f.run(one, { createAdapter: failing('B') });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.accepted, ['A']);
  const accepted = () => ({ receipt: git(f.remote, 'show', 'main:evidence/results/A.json'),
    target: git(f.remote, 'rev-parse', 'main'), claim: claimText(f, 'A'), completed: stateOf(one).completed.A,
    pr: { ...f.records[0] } });
  const before = accepted();
  assert.equal(before.pr.state, 'MERGED');
  const summary = await disposeInvocation(one, { host: f.hostFor() });
  assert.deepEqual(summary.releasedClaims, ['B']); assert.deepEqual(summary.work.map(item => item.id), ['B']);
  assert.deepEqual(summary.openPullRequests, []);
  assert.deepEqual(ledgerFiles(f), ['A.json']);
  assert.deepEqual(accepted(), before);
  assert.deepEqual(Object.keys(stateOf(one).disposed.tasks), ['B']);
});

test('B (required): open pull requests are listed, never merged, and an unreachable host is not fatal', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const one = f.config('one', { leaves: ['A'] });
  const work = await blockOnMerge(f, one);
  const unreachable: PullRequestHost = { find() { throw new Error('Host unavailable'); },
    create() { throw new Error('No create expected'); }, merge() { throw new Error('No merge expected'); } };
  const first = await disposeInvocation(one, { host: unreachable });
  assert.equal(first.status, 'disposed'); assert.deepEqual(first.releasedClaims, ['A']);
  assert.deepEqual(first.openPullRequests, [{ id: 'A', number: 1, branch: work.branch, state: 'unknown' }]);
  const scripted = f.hostFor(); let merges = 0; let creates = 0;
  const spy: PullRequestHost = { find: branch => scripted.find(branch),
    create() { creates += 1; return null; }, merge() { merges += 1; } };
  const second = await disposeInvocation(one, { host: spy });
  assert.deepEqual(second.openPullRequests, [{ id: 'A', number: 1, branch: work.branch, state: 'OPEN' }]);
  assert.equal(merges, 0); assert.equal(creates, 0); assert.equal(f.records[0].state, 'OPEN');
});

test('B (required): the dispose command prints exactly one JSON summary line and exits 0', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const cli = cliInvocation(f, 'one', { leaves: ['A'] });
  const work = await blockOnMerge(f, cli.config);
  const { code, lines, line } = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
  assert.equal(code, 0); assert.equal(lines.length, 1); assert.ok(lines[0].endsWith('}\n'));
  assert.deepEqual(line, { status: 'disposed', invocation: 'one', releasedClaims: ['A'], ownership: 'released',
    work: [{ id: 'A', worktree: { path: work.path, state: 'kept' }, localBranch: { name: work.branch, state: 'kept' },
      remoteBranch: { name: work.branch, state: 'kept' } }],
    openPullRequests: [{ id: 'A', number: 1, branch: work.branch, state: 'OPEN' }] });
});

// Grade A

test('A (required): dispose is refused while a process of the invocation is running', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const cli = cliInvocation(f, 'one', { leaves: ['A'] });
  const snapshot = () => ({ ledger: ledgerHead(f), ownership: ownershipText(f, cli.config), state: stateText(cli.config) });
  const observed: { value?: { code: number; reason: string; before: unknown; after: unknown } } = {};
  const createAdapter = scriptedWorker({ onSession: async () => {
    if (observed.value) return;
    const before = snapshot();
    const { code, line } = await disposeCli(f, cli.file, cli.env, { host: f.hostFor() });
    observed.value = { code, reason: line.reason, before, after: snapshot() };
  } });
  const result = await runQueue(cli.config, f.options(cli.config, { createAdapter }));
  assert.ok(observed.value);
  assert.equal(observed.value.code, 4); assert.equal(observed.value.reason, 'invocation-running');
  assert.deepEqual(observed.value.after, observed.value.before);
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.deepEqual(result.accepted, ['A']);
});

test('A (required): disposing one invocation leaves other invocations and repositories untouched', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const one = f.config('one', { leaves: ['A'] }); const two = f.config('two', { leaves: ['B'] });
  assert.equal((await f.run(one, { createAdapter: failing('A') })).status, 'incomplete');
  assert.equal((await f.run(two, { createAdapter: failing('B') })).status, 'incomplete');
  const g = runnerFixture(t, { ids: ['A'] });
  const other = g.config('one', { leaves: ['A'] });
  assert.equal((await g.run(other, { createAdapter: failing('A') })).status, 'incomplete');
  const snapshot = () => ({ claim: claimText(f, 'B'), two: { ownership: ownershipText(f, two), state: stateText(two) },
    other: { ledger: ledgerHead(g), files: ledgerFiles(g), ownership: ownershipText(g, other), state: stateText(other) } });
  const before = snapshot();
  const summary = await disposeInvocation(one, { host: f.hostFor() });
  assert.deepEqual(summary.releasedClaims, ['A']); assert.deepEqual(ledgerFiles(f), ['B.json']);
  assert.deepEqual(snapshot(), before);
  assert.equal(ownershipOf(f, two).released, false); assert.equal(ownershipOf(g, other).released, false);
  const resumed = await f.run(two);
  assert.equal(resumed.status, 'exhausted', JSON.stringify(resumed)); assert.deepEqual(resumed.accepted, ['B']);
});
