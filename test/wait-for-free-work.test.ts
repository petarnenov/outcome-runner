import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { hash, resolvePollSeconds } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { invocationLockFiles, runQueue } from '../src/runner.ts';
import type { RunResult } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import { disposeInvocation } from '../src/dispose.ts';
import type { DisposeSummary } from '../src/dispose.ts';
import { ClaimLedger } from '../src/claims.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const CLAIMS = 'work-queue-claims-main';
/** The local ref the claims ledger of the fixture checkout pulls into. */
const LEDGER_TRACKING = `refs/work-queue/claims/${CLAIMS}`;

const failing = (...ids: string[]) => scriptedWorker({ fail: prompt => ids.some(id => prompt.includes(`Task ${id};`)) });
const noWorker = () => { throw new Error('No worker expected'); };
const claimOf = (f: RunnerFixture, id: string) => JSON.parse(git(f.remote, 'show', `refs/heads/${CLAIMS}:${id}.json`));
const stateOf = (config: RunConfig) => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
const ownershipOf = (f: RunnerFixture, config: RunConfig) =>
  JSON.parse(readFileSync(invocationLockFiles(f.root, config.stateDirectory).ownership, 'utf8'));
const waitLines = (lines: string[]) => lines.filter(line => / run wait: /u.test(line));

/** Invocation `name` claims task `id` and blocks on it through the `fail` hook, so its claim stays in the ledger. */
async function holdBy(f: RunnerFixture, name: string, id: string): Promise<RunConfig> {
  const config = f.config(name, { leaves: [id] });
  const result = await f.run(config, { createAdapter: failing(id) });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(claimOf(f, id).claimant, stateOf(config).claimant);
  return config;
}

/**
 * A fake sleep that records the milliseconds of every call and runs `actions[n]` on call n + 1. A call without an
 * action throws `fake sleep: poll limit reached`, so a run that polls more often than scripted fails instead of hanging.
 */
function scriptedSleep(actions: (() => void | Promise<void>)[]) {
  const calls: number[] = [];
  const sleep = async (milliseconds: number) => {
    calls.push(milliseconds);
    const action = actions[calls.length - 1];
    if (!action) throw new Error('fake sleep: poll limit reached');
    await action();
  };
  return { sleep, calls };
}

// Grade E

test('E (required): resolvePollSeconds defaults to 60, accepts 5 and 3600 and refuses every other value', () => {
  assert.equal(resolvePollSeconds(undefined), 60);
  assert.equal(resolvePollSeconds(5), 5);
  assert.equal(resolvePollSeconds(3600), 3600);
  for (const value of [4, 3601, 7.5, '60', NaN]) {
    assert.throws(() => resolvePollSeconds(value), (error: Error & { reason?: string; details?: { setting?: string } }) =>
      error.reason === 'invalid-poll-seconds' && error.details?.setting === 'pollSeconds' &&
      error.message === 'Invalid pollSeconds: expected an integer from 5 through 3600', String(value));
  }
});

// Grade D

for (const value of [4, 3601, 7.5, '60']) {
  test(`D (required): pollSeconds ${JSON.stringify(value)} is refused through the CLI before any state, claim or worktree`, async t => {
    const f = runnerFixture(t, { ids: ['A'] });
    const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
    const file = join(f.base, 'invocation.json');
    writeFileSync(file, JSON.stringify({ ...invocation, pollSeconds: value }));
    const xdg = join(f.base, 'xdg'); const lines: string[] = [];
    const code = await main(file, (config, options) => runQueue(config, f.options(config, options)),
      line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: xdg, OUTCOME_RUNNER_MASCOT: '0' },
        mascot: async () => {} });
    assert.equal(code, 4);
    const line = JSON.parse(lines.at(-1)!);
    assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'invalid-poll-seconds');
    const diagnostics = JSON.parse(readFileSync(line.diagnostics, 'utf8'));
    rmSync(dirname(line.diagnostics), { recursive: true, force: true });
    assert.equal(diagnostics.reason, 'invalid-poll-seconds');
    assert.deepEqual(diagnostics.details, { setting: 'pollSeconds', value });
    assert.match(diagnostics.message, /pollSeconds/u);
    assert.equal(existsSync(join(xdg, 'outcome-runner')), false);
    assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
    assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${CLAIMS}`), '');
    assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  });
}

test('D (required): a task blocked in this invocation ends the run incomplete without waiting', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'], dependencies: { B: ['A'] } });
  const { sleep, calls } = scriptedSleep([]);
  const result = await f.run(f.config('one', { leaves: ['A', 'B'] }), { createAdapter: failing('A'), sleep });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.deepEqual(result.blockers!.B, { kind: 'waiting-for-dependency', reason: 'waiting-for-dependency',
    dependencies: ['A'] });
  assert.deepEqual(calls, []);
});

test('D (required): a reached limit ends limit-reached without waiting for a task claimed elsewhere', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  await holdBy(f, 'two', 'B');
  const { sleep, calls } = scriptedSleep([]);
  const result = await f.run(f.config('one', { leaves: ['A', 'B'], maxAccepted: 1 }), { sleep });
  assert.equal(result.status, 'limit-reached', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']); assert.deepEqual(result.remaining, ['B']);
  assert.deepEqual(calls, []);
});

// Grade C

test('C (required): a run whose only task waits for a foreign claim is cancelled during the wait and stays incomplete', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  await holdBy(f, 'two', 'B');
  const one = f.config('one', { leaves: ['B'] });
  const result = await f.run(one, { createAdapter: noWorker });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.remaining, ['B']); assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.blockers, { B: { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'B', host: claimOf(f, 'B').host } } });
  assert.deepEqual(f.sleeps, [60000]);
  assert.equal(stateOf(one).status, 'incomplete');
});

test('C (required): a foreign claim beside a task blocked in this invocation ends incomplete without waiting', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  await holdBy(f, 'two', 'B');
  const { sleep, calls } = scriptedSleep([]);
  const result = await f.run(f.config('one', { leaves: ['A', 'B'] }), { createAdapter: failing('A'), sleep });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.equal(result.blockers!.B.kind, 'waiting-for-claim');
  assert.deepEqual(calls, []);
});

test('C (required): pollSeconds is outside the identity, so a resumed invocation with another interval continues', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const one = f.config('one', { leaves: ['A', 'B'] });
  const identity = (pollSeconds: number) => invocationIdentity({ ...one, pollSeconds, coverage: 85, leaves: ['A', 'B'] });
  assert.deepEqual(identity(5), identity(120)); assert.equal(hash(identity(5)), hash(identity(120)));
  const first = await f.run({ ...one, maxAccepted: 1, pollSeconds: 5 });
  assert.equal(first.status, 'limit-reached', JSON.stringify(first)); assert.deepEqual(first.accepted, ['A']);
  const identityHash = stateOf(one).identityHash; const owned = ownershipOf(f, one).identity;
  // maxAccepted is operational too, and the kept baseline would end a second run with it at once.
  const second = await f.run({ ...one, pollSeconds: 120 });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.ok(second.accepted.includes('B')); assert.deepEqual(second.remaining, []);
  assert.ok(stateOf(one).completed.A); assert.ok(stateOf(one).completed.B);
  assert.equal(stateOf(one).identityHash, identityHash); assert.equal(ownershipOf(f, one).identity, owned);
  assert.equal(claimOf(f, 'B').claimant, stateOf(one).claimant);
});

test('C (required): the wait writes one step line per poll naming the task and the host of its claim', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  await holdBy(f, 'two', 'B');
  const host = claimOf(f, 'B').host as string;
  assert.ok(host);
  const abort = new AbortController(); const lines: string[] = []; const order: string[] = [];
  const { sleep, calls } = scriptedSleep([() => { order.push('sleep'); }, () => { order.push('sleep'); abort.abort(); }]);
  const steps = (line: string) => { lines.push(line); if (/ run wait: /u.test(line)) order.push('wait'); };
  const result = await f.run(f.config('one', { leaves: ['B'], pollSeconds: 5 }),
    { createAdapter: noWorker, signal: abort.signal, sleep, steps });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(calls, [5000, 5000]);
  const waits = waitLines(lines);
  assert.equal(waits.length, 2);
  for (const line of waits) assert.ok(line.endsWith(` run wait: waiting 5s for B on ${host}\n`), line);
  assert.deepEqual(order, ['wait', 'sleep', 'wait', 'sleep']);
  // Without pollSeconds the interval is 60 seconds; the fixture's default sleep cancels the run at its first poll.
  const again = await f.run(f.config('one', { leaves: ['B'] }), { createAdapter: noWorker });
  assert.equal(again.status, 'cancelled', JSON.stringify(again));
  assert.deepEqual(f.sleeps, [60000]);
});

test('C (required): a task accepted by another runner outside the invocation does not end the wait as limit-reached', async t => {
  const f = runnerFixture(t, { ids: ['B', 'X'] });
  assert.equal((await f.run(f.config('three', { leaves: ['X'] }))).status, 'exhausted');
  await holdBy(f, 'two', 'B');
  const result = await f.run(f.config('one', { leaves: ['B'], maxAccepted: 1 }), { createAdapter: noWorker });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(f.sleeps, [60000]);
  assert.equal(result.blockers!.B.kind, 'waiting-for-claim');
});

// Grade B

test('B (required): a cancel during the wait ends the run without a fetch, ledger pull, claim, worktree or session', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const two = await holdBy(f, 'two', 'B');
  const one = f.config('one', { leaves: ['B'] });
  const local = () => ({ target: git(f.root, 'rev-parse', 'refs/remotes/origin/main'),
    ledger: git(f.root, 'rev-parse', LEDGER_TRACKING) });
  const worktrees = () => git(f.root, 'worktree', 'list');
  const abort = new AbortController();
  let before: ReturnType<typeof local> | undefined; let worktreesBefore = ''; let sessions = 0;
  const { sleep, calls } = scriptedSleep([() => {
    before = local(); worktreesBefore = worktrees();
    const remote = { target: git(f.remote, 'rev-parse', 'refs/heads/main'),
      ledger: git(f.remote, 'rev-parse', `refs/heads/${CLAIMS}`) };
    // Origin moves during the wait, so any fetch or ledger pull after the abort would move the local refs.
    git(f.integrator, 'fetch', '-q', 'origin'); git(f.integrator, 'checkout', '-q', '-B', 'main', 'origin/main');
    writeFileSync(join(f.integrator, 'advanced.txt'), 'advanced during the wait\n');
    git(f.integrator, 'add', 'advanced.txt'); git(f.integrator, 'commit', '-q', '-m', 'test(fixture): advance the target');
    git(f.integrator, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const ledger = new ClaimLedger(f.integrator, 'main');
    assert.equal(ledger.acquire(ledger.pull(), { version: 1, id: 'Z', claimant: 'elsewhere', scopes: ['src/z'],
      host: 'elsewhere' }, 'chore(fixture): claim Z'), true);
    assert.notEqual(git(f.remote, 'rev-parse', 'refs/heads/main'), remote.target);
    assert.notEqual(git(f.remote, 'rev-parse', `refs/heads/${CLAIMS}`), remote.ledger);
    abort.abort();
  }]);
  const result = await f.run(one, { signal: abort.signal, sleep,
    createAdapter: () => { sessions += 1; throw new Error('No session expected'); } });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(calls, [60000]);
  assert.deepEqual(result.blockers, { B: { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'B', host: claimOf(f, 'B').host } } });
  assert.ok(before);
  assert.deepEqual(local(), before);
  assert.equal(worktrees(), worktreesBefore);
  assert.equal(claimOf(f, 'B').claimant, stateOf(two).claimant);
  assert.equal(sessions, 0);
  const state = stateOf(one);
  assert.equal(state.status, 'incomplete'); assert.equal(state.current ?? null, null);
  assert.equal(ownershipOf(f, one).released, false);
});

test('B (required): a claim released by dispose during the wait lets the run claim and accept the task', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const two = await holdBy(f, 'two', 'B');
  const one = f.config('one', { leaves: ['B'] });
  let summary: DisposeSummary | undefined;
  const { sleep, calls } = scriptedSleep([async () => { summary = await disposeInvocation(two, { host: f.hostFor() }); }]);
  const result = await f.run(one, { sleep });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['B']); assert.deepEqual(calls, [60000]);
  assert.deepEqual(summary!.releasedClaims, ['B']);
  assert.equal(claimOf(f, 'B').claimant, stateOf(one).claimant);
  assert.ok(stateOf(one).completed.B);
});

test('B (required): a claimed task merged by another runner during the wait frees an overlapping task', async t => {
  const f = runnerFixture(t, { ids: ['A', 'C'], scopes: { C: ['src/c', 'src/a/shared'] } });
  const two = await holdBy(f, 'two', 'A');
  const one = f.config('one', { leaves: ['A', 'C'] });
  let retried: RunResult | undefined;
  const { sleep, calls } = scriptedSleep([async () => { retried = await f.run(two, { retry: ['A'] }); }]);
  const result = await f.run(one, { sleep });
  assert.equal(retried!.status, 'exhausted', JSON.stringify(retried)); assert.deepEqual(retried!.accepted, ['A']);
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['C']); assert.deepEqual(result.remaining, []); assert.deepEqual(calls, [60000]);
  assert.ok(stateOf(one).completed.C); assert.equal(stateOf(one).completed.A, undefined);
});

// Grade A

test('A (required): a dependency merged by another runner during the wait lets the run accept its dependent', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'], dependencies: { B: ['A'] } });
  const two = await holdBy(f, 'two', 'A');
  const host = claimOf(f, 'A').host as string;
  const one = f.config('one', { leaves: ['A', 'B'] });
  const lines: string[] = []; let retried: RunResult | undefined;
  const { sleep, calls } = scriptedSleep([async () => { retried = await f.run(two, { retry: ['A'] }); }]);
  const result = await f.run(one, { sleep, steps: line => { lines.push(line); } });
  // A waits for the claim of two and B for its dependency A, so A is the only task named.
  const waits = waitLines(lines);
  assert.equal(waits.length, 1); assert.ok(waits[0].endsWith(` run wait: waiting 60s for A on ${host}\n`), waits[0]);
  assert.deepEqual(calls, [60000]);
  assert.equal(retried!.status, 'exhausted', JSON.stringify(retried));
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['B']); assert.deepEqual(result.remaining, []);
  assert.ok(stateOf(one).completed.B); assert.equal(stateOf(one).completed.A, undefined);
  // A's receipt on the target is the one carried by the pull request two merged.
  const merged = stateOf(two).completed.A;
  const pr = f.records.find(record => record.branch === merged.branch)!;
  assert.equal(pr.state, 'MERGED');
  assert.equal(git(f.remote, 'show', 'refs/heads/main:evidence/results/A.json'),
    git(f.remote, 'show', `${pr.headRefOid}:evidence/results/A.json`));
  assert.ok(lines.findIndex(line => / B claim: /u.test(line)) > lines.indexOf(waits[0]));
});
