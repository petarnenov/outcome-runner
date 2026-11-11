import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import type { PullRequest, RunConfig } from '../src/model.ts';
import { ClaimLedger } from '../src/claims.ts';
import { acceptedThisRun, explainUnfinished, invocationLockFiles, missingDependencies } from '../src/runner.ts';
import type { RunOptions, UnfinishedInput } from '../src/runner.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const STATE = '/state/state.json';
/** One remaining task R without dependencies, nothing done, blocked or claimed; `patch` adds the situation. */
const input = (patch: Partial<UnfinishedInput> = {}): UnfinishedInput => ({ remaining: ['R'], ids: ['R'],
  tasks: [{ id: 'R', dependencies: [], scopes: ['src/r'] }], completed: {}, blocked: {}, done: [], baselineDone: [],
  foreignClaims: [], statePath: STATE, ...patch });
/** The limit of one is reached by task A of the invocation, accepted during this run. */
const limitReached: Partial<UnfinishedInput> = { ids: ['R', 'A'], completed: { A: {} }, done: ['A'], maxAccepted: 1 };

/** Runs `config` through the CLI and returns the exit code, the printed line and the diagnostics file content. */
async function cli(f: RunnerFixture, config: RunConfig, extra: RunOptions = {}) {
  const { root: _root, stateDirectory: _state, ...invocation } = config;
  const path = join(f.base, `invocation-${config.invocation}.json`); writeFileSync(path, JSON.stringify(invocation));
  const lines: string[] = [];
  const code = await main(path, async () => f.run(config, extra), line => lines.push(line),
    { cwd: f.root, env: { XDG_STATE_HOME: join(f.base, 'xdg'), OUTCOME_RUNNER_MASCOT: '0' } });
  const line = JSON.parse(lines.at(-1)!);
  const diagnostics = line.diagnostics ? JSON.parse(readFileSync(line.diagnostics, 'utf8')) : null;
  if (line.diagnostics) rmSync(join(line.diagnostics, '..'), { recursive: true, force: true });
  return { code, line, diagnostics };
}

const stateOf = (config: RunConfig) => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
const released = (f: RunnerFixture, config: RunConfig): boolean =>
  JSON.parse(readFileSync(invocationLockFiles(f.root, config.stateDirectory).ownership, 'utf8')).released;
const failing = (...ids: string[]) => scriptedWorker({ fail: prompt => ids.some(id => prompt.includes(`Task ${id};`)) });

/**
 * Runs `config` until task `id` is merged and interrupts it there, then removes the recorded claim time, so the next
 * run cannot record the acceptance unless the ledger still holds the claim time.
 */
async function mergeWithoutClaimTime(f: RunnerFixture, config: RunConfig, id: string): Promise<void> {
  await assert.rejects(f.run(config, { afterEffect: async (kind, subject) => {
    if (kind === 'merge' && (subject as PullRequest).branch?.startsWith(`outcome/${id}-`)) {
      throw Object.assign(new Error('Interrupted after merge'), { interrupted: true });
    }
  } }), /Interrupted after merge/u);
  const state = stateOf(config); assert.equal(state.current.id, id); delete state.current.claimedAt;
  writeFileSync(join(config.stateDirectory, 'state.json'), JSON.stringify(state));
}

/** Runs `fn` while the claims ledger hides the claim time of task `id`, so recording its acceptance fails. */
async function withoutLedgerClaimTime<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const pull = ClaimLedger.prototype.pull;
  ClaimLedger.prototype.pull = function () {
    const snapshot = pull.call(this); const claim = snapshot.claims.get(id);
    if (claim) delete claim.claimedAt;
    return snapshot;
  };
  try { return await fn(); } finally { ClaimLedger.prototype.pull = pull; }
}

// Grade E

test('E (coverage-only): missingDependencies allows invocation and accepted dependencies and names the others', () => {
  const tasks = [{ id: 'A', dependencies: [] }, { id: 'B', dependencies: ['A'] }, { id: 'C', dependencies: ['B', 'D'] },
    { id: 'D', dependencies: [] }, { id: 'E', dependencies: ['Z'] }];
  assert.deepEqual(missingDependencies(['B', 'C'], tasks, id => id === 'A' || id === 'D'), {});
  assert.deepEqual(missingDependencies(['A', 'B'], tasks, () => false), {});
  assert.deepEqual(missingDependencies(['C', 'B'], tasks, () => false), { C: ['D'], B: ['A'] });
  assert.deepEqual(missingDependencies(['E'], tasks, () => true), { E: ['Z'] });
  assert.deepEqual(acceptedThisRun({ ids: ['A', 'B', 'C', 'D'], completed: { A: {}, C: {} }, blocked: { B: {} },
    done: ['A', 'B', 'C'], baselineDone: ['C'] }), ['A', 'B']);
});

test('E (coverage-only): explainUnfinished applies the rules in order', () => {
  const blockedR = { R: { work: { stage: 'work' as const, scopes: ['src/r'] } } };
  assert.deepEqual(explainUnfinished(input({ ...limitReached, blocked: blockedR })),
    { R: { kind: 'blocked', stage: 'work', reason: 'operation-incomplete', diagnostics: STATE } });
  const dependent = [{ id: 'R', dependencies: ['Q'], scopes: ['src/r'] }];
  assert.deepEqual(explainUnfinished(input({ ...limitReached, tasks: dependent })),
    { R: { kind: 'max-accepted', reason: 'max-accepted', limit: 1 } });
  assert.deepEqual(explainUnfinished(input({ tasks: dependent,
    foreignClaims: [{ id: 'R', host: 'elsewhere', scopes: ['src/r'] }] })),
    { R: { kind: 'waiting-for-dependency', reason: 'waiting-for-dependency', dependencies: ['Q'] } });
  const blockedB = { B: { work: { stage: 'plan' as const, scopes: ['src/r/shared'] } } };
  assert.deepEqual(explainUnfinished(input({ ids: ['R', 'B'], remaining: ['R', 'B'], blocked: blockedB,
    foreignClaims: [{ id: 'H', host: 'two', scopes: ['src/r/x'] }, { id: 'G', host: 'one', scopes: ['src'] }] })), {
    B: { kind: 'blocked', stage: 'plan', reason: 'operation-incomplete', diagnostics: STATE },
    R: { kind: 'waiting-for-claim', reason: 'waiting-for-claim', claim: { id: 'G', host: 'one' } } });
  assert.deepEqual(explainUnfinished(input({ ids: ['R', 'B'], remaining: ['R', 'B'], blocked: blockedB })).R,
    { kind: 'waiting-for-blocked-scope', reason: 'waiting-for-blocked-scope', task: 'B' });
});

test('E (coverage-only): explainUnfinished refuses to leave a task unexplained', () => {
  assert.throws(() => explainUnfinished(input()), /Unexplained unfinished task/u);
  assert.deepEqual(explainUnfinished(input({ remaining: [] })), {});
});

test('E (required): a task accepted by another runner does not count against maxAccepted', () => {
  const situation = input({ maxAccepted: 1, tasks: [{ id: 'R', dependencies: [], scopes: ['src/r'] },
    { id: 'F', dependencies: [], scopes: ['src/f'] }, { id: 'G', dependencies: [], scopes: ['src/r/g'] }],
  done: ['F'], baselineDone: [], foreignClaims: [{ id: 'G', host: 'other', scopes: ['src/r/g'] }] });
  assert.deepEqual(explainUnfinished(situation),
    { R: { kind: 'waiting-for-claim', reason: 'waiting-for-claim', claim: { id: 'G', host: 'other' } } });
  const { ids, completed, blocked, done, baselineDone } = situation;
  assert.deepEqual(acceptedThisRun({ ids, completed, blocked, done, baselineDone }), []);
});

// Grade D

test('D (required): leaves missing dependencies are refused with exit 4 before any state, claim or worktree', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B', 'C', 'X'], dependencies: { B: ['A'], C: ['A', 'X'] } });
  const config = f.config('one', { leaves: ['B', 'C'] });
  const { code, line, diagnostics } = await cli(f, config);
  assert.equal(code, 4); assert.equal(line.status, 'unavailable');
  assert.equal(line.reason, 'dependencies-outside-invocation');
  assert.equal(diagnostics.reason, 'dependencies-outside-invocation');
  assert.deepEqual(diagnostics.details, { missing: { B: ['A'], C: ['A', 'X'] } });
  assert.match(diagnostics.message, /B needs A; C needs A, X/u);
  assert.equal(existsSync(join(config.stateDirectory, 'state.json')), false);
  assert.equal(git(f.remote, 'for-each-ref', 'refs/heads/work-queue-claims-main'), '');
  assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(f.records.length, 0);
});

test('D (required): without leaves, authority tasks depending on each other are worked in dependency order', async t => {
  const f = runnerFixture(t, { ids: ['C', 'B', 'A'], dependencies: { C: ['B'], B: ['A'] } });
  const result = await f.run(f.config());
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A', 'B', 'C']);
  assert.deepEqual(f.records.map(pr => pr.branch!.split('-')[0]), ['outcome/A', 'outcome/B', 'outcome/C']);
});

// Grade C

test('C (required): a dependency accepted earlier lets a later run work its dependent leaf', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'], dependencies: { B: ['A'] } });
  assert.equal((await f.run(f.config('one', { leaves: ['A'] }))).status, 'exhausted');
  const result = await f.run(f.config('two', { leaves: ['B'] }));
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.deepEqual(result.accepted, ['B']);
});

test('C (required): a failing session is explained as blocked and leaves state.json blocked', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'] });
  const { code, line } = await cli(f, config, { createAdapter: failing('A') });
  assert.equal(code, 3); assert.equal(line.status, 'incomplete'); assert.deepEqual(line.remaining, ['A']);
  assert.deepEqual(line.blockers, { A: { kind: 'blocked', stage: 'investigate', reason: 'operation-incomplete',
    diagnostics: join(config.stateDirectory, 'state.json') } });
  assert.equal(stateOf(config).status, 'blocked');
});

test('C (required): a leaf waiting for a blocked dependency names it and every remaining task is explained', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'], dependencies: { B: ['A'] } });
  const result = await f.run(f.config('one', { leaves: ['A', 'B'] }), { createAdapter: failing('A') });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.remaining, ['A', 'B']);
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.deepEqual(result.blockers!.B, { kind: 'waiting-for-dependency', reason: 'waiting-for-dependency', dependencies: ['A'] });
  assert.ok(result.remaining.every(id => result.blockers![id]));
});

test('C (required): a foreign claim with overlapping scopes is named and leaves state.json incomplete', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const ledger = new ClaimLedger(f.root, 'main');
  assert.equal(ledger.acquire(ledger.pull(), { version: 1, id: 'A', scopes: ['src/a'], claimant: 'foreign',
    host: 'elsewhere' }, 'chore: claim A'), true);
  const config = f.config('one', { leaves: ['A'] });
  const { code, line } = await cli(f, config, { createAdapter: () => { throw new Error('No worker expected'); } });
  assert.equal(code, 3); assert.equal(line.status, 'incomplete'); assert.deepEqual(line.remaining, ['A']);
  assert.deepEqual(line.blockers, { A: { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'A', host: 'elsewhere' } } });
  assert.deepEqual(line.claimedElsewhere, { A: { host: 'elsewhere' } });
  assert.equal(stateOf(config).status, 'incomplete');
});

test('C (required): a task overlapping the scopes of a blocked task names the blocked task', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'], scopes: { B: ['src/b', 'src/a/shared'] } });
  const result = await f.run(f.config('one', { leaves: ['A', 'B'] }), { createAdapter: failing('A') });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.remaining, ['A', 'B']);
  assert.equal(result.blockers!.A.kind, 'blocked');
  assert.deepEqual(result.blockers!.B, { kind: 'waiting-for-blocked-scope', reason: 'waiting-for-blocked-scope', task: 'A' });
});

test('C (required): state.json status is running inside the first session', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config('one', { leaves: ['A'] });
  const observed: string[] = [];
  const result = await f.run(config, { createAdapter: scriptedWorker({ onSession: () => { observed.push(stateOf(config).status); } }) });
  assert.equal(result.status, 'exhausted'); assert.equal(observed[0], 'running');
  assert.equal(stateOf(config).status, 'released');
});

// Grade B

test('B (required): a run accepting every leaf exits 0 and leaves state.json released', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config('one', { leaves: ['A', 'B'] });
  const { code, line } = await cli(f, config);
  assert.equal(code, 0); assert.equal(line.status, 'exhausted'); assert.deepEqual(line.accepted, ['A', 'B']);
  assert.equal(stateOf(config).status, 'released'); assert.equal(released(f, config), true);
});

test('B (required): a reached limit without blocked or in-progress work releases with unstarted max-accepted tasks', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config('one', { leaves: ['A', 'B'], maxAccepted: 1 });
  const { code, line } = await cli(f, config);
  assert.equal(code, 0); assert.equal(line.status, 'limit-reached');
  assert.deepEqual(line.accepted, ['A']); assert.deepEqual(line.remaining, ['B']);
  assert.deepEqual(line.blockers, { B: { kind: 'max-accepted', reason: 'max-accepted', limit: 1 } });
  assert.equal(released(f, config), true); assert.equal(stateOf(config).status, 'released');
});

test('B (required): a reached limit keeping a blocked task leaves state.json blocked', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B', 'C'] });
  const config = f.config('one', { leaves: ['A', 'B', 'C'], maxAccepted: 1 });
  const { code, line } = await cli(f, config, { createAdapter: failing('A') });
  assert.equal(code, 0); assert.equal(line.status, 'limit-reached');
  assert.deepEqual(line.accepted, ['B']); assert.deepEqual(line.remaining, ['A', 'C']);
  assert.equal(line.blockers.A.kind, 'blocked');
  assert.deepEqual(line.blockers.C, { kind: 'max-accepted', reason: 'max-accepted', limit: 1 });
  assert.equal(released(f, config), false); assert.equal(stateOf(config).status, 'blocked');
});

// Grade A

test('A (required): a failed acceptance recording reaching maxAccepted ends incomplete with max-accepted tasks', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B', 'C'] });
  const config = f.config('one', { leaves: ['A', 'B', 'C'], maxAccepted: 2 });
  await mergeWithoutClaimTime(f, config, 'B');
  const { code, line } = await withoutLedgerClaimTime('B', () => cli(f, config));
  assert.equal(code, 3); assert.equal(line.status, 'incomplete');
  assert.deepEqual(line.accepted, ['A']); assert.deepEqual(line.remaining, ['C']);
  assert.equal(line.blockers.B.kind, 'blocked'); assert.equal(line.blockers.B.stage, 'merge');
  assert.deepEqual(line.blockers.C, { kind: 'max-accepted', reason: 'max-accepted', limit: 2 });
  assert.equal(stateOf(config).status, 'blocked'); assert.equal(released(f, config), false);
  assert.match(stateOf(config).blocked.B.reason, /Cannot recover original claim timestamp/u);
});

test('A (required): a failed acceptance recording without a limit keeps working other tasks and ends with exit 3', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config('one', { leaves: ['A', 'B'] });
  await mergeWithoutClaimTime(f, config, 'A');
  const { code, line } = await withoutLedgerClaimTime('A', () => cli(f, config));
  assert.equal(code, 3); assert.equal(line.status, 'incomplete');
  assert.deepEqual(line.accepted, ['B']); assert.deepEqual(line.remaining, []);
  assert.deepEqual(Object.keys(line.blockers), ['A']); assert.equal(line.blockers.A.kind, 'blocked');
  assert.equal(released(f, config), false); assert.equal(stateOf(config).status, 'blocked');
});

test('A (required): a failed acceptance recording and a failing session are both explained', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config('one', { leaves: ['A', 'B'] });
  await mergeWithoutClaimTime(f, config, 'A');
  const { code, line } = await withoutLedgerClaimTime('A', () => cli(f, config, { createAdapter: failing('B') }));
  assert.equal(code, 3); assert.equal(line.status, 'incomplete');
  assert.deepEqual(line.remaining, ['B']);
  assert.equal(line.blockers.A.kind, 'blocked'); assert.equal(line.blockers.B.kind, 'blocked');
  assert.ok(!JSON.stringify(line).includes('Unexplained'));
  assert.equal(stateOf(config).status, 'blocked');
});

test('A (required): a reached limit keeping recovered in-progress work leaves state.json completed', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config('one', { leaves: ['A', 'B'], maxAccepted: 1 });
  // The first run blocks A and is interrupted after claiming B.
  await assert.rejects(f.run(config, { createAdapter: failing('A'), afterEffect: async (kind, subject) => {
    if (kind === 'claim' && (subject as { id: string }).id === 'B') {
      throw Object.assign(new Error('Interrupted after claim'), { interrupted: true });
    }
  } }), /Interrupted after claim/u);
  assert.equal(stateOf(config).status, 'running');
  const { code, line } = await cli(f, config);
  assert.equal(code, 0); assert.equal(line.status, 'limit-reached');
  assert.deepEqual(line.accepted, ['B']); assert.deepEqual(line.remaining, ['A']);
  assert.deepEqual(line.blockers, { A: { kind: 'max-accepted', reason: 'max-accepted', limit: 1 } });
  assert.equal(released(f, config), false); assert.equal(stateOf(config).status, 'completed');
  assert.deepEqual(stateOf(config).blocked, {});
});
