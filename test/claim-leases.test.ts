import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { DEFAULT_LEASE_SECONDS, hash, resolveLeaseSeconds, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { ClaimLedger, claimStale } from '../src/claims.ts';
import type { Claim } from '../src/claims.ts';
import { ELIGIBLE } from '../src/merge-eligibility.ts';
import { explainUnfinished, foreignClaimsOf, invocationLockFiles, runQueue } from '../src/runner.ts';
import type { LeaseTimer, PullRequestHost } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

/** A fixed fake time used by the unit tests. */
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const ago = (seconds: number) => iso(NOW - seconds * 1000);
const CLAIMS = 'work-queue-claims-main';

type Refusal = Error & { reason?: string; details?: { setting?: string; value?: unknown } };
const refusedLease = (value: unknown) => (error: Refusal) => error.reason === 'invalid-lease-seconds' &&
  error.details?.setting === 'leaseSeconds' && Object.is(error.details.value, value) && /leaseSeconds/u.test(error.message);

/** The claim of `id` on the claims ledger branch of the fixture origin. */
const claimOf = (f: RunnerFixture, id: string): Claim => JSON.parse(git(f.remote, 'show', `refs/heads/${CLAIMS}:${id}.json`));
/** The head commit of the claims ledger branch of the fixture origin. */
const ledgerHead = (f: RunnerFixture): string => git(f.remote, 'rev-parse', `refs/heads/${CLAIMS}`);
const stateOf = (config: RunConfig) => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
const waitLines = (lines: string[]) => lines.filter(line => / run wait: /u.test(line));
const noWorker = () => { throw new Error('No worker expected'); };

/**
 * A fake lease timer: it records every interval it was started with and the stop calls, and exposes the renewal
 * callback of the last start, which the test invokes after advancing the fake clock.
 */
function fakeTimer() {
  const timer = { intervals: [] as number[], stops: 0, renew: (): void => { throw new Error('No timer started'); } };
  const leaseTimer: LeaseTimer = (renew, intervalMs) => {
    timer.intervals.push(intervalMs); timer.renew = renew;
    return () => { timer.stops += 1; };
  };
  return { timer, leaseTimer };
}

/** Writes a claim of `id` by invocation `zero` (host `zero-host`) directly on the ledger of the fixture origin. */
function claimByZero(f: RunnerFixture, id: string, fields: Partial<Claim>): Claim {
  const ledger = new ClaimLedger(f.integrator, 'main');
  const claim: Claim = { version: 1, id, claimant: 'zero-claimant', scopes: [`src/${id.toLowerCase()}`],
    taskHash: hash(f.queue.tasks.find(task => task.id === id)), host: 'zero-host', branch: `outcome/${id}-zero`,
    ...fields };
  assert.equal(ledger.acquire(ledger.pull(), claim, `chore(fixture): claim ${id}`), true);
  return claim;
}

/** Replaces the claim of `B` on the ledger of the fixture origin with a fresh claim of another claimant, `taker`. */
function takeOverByTaker(f: RunnerFixture, at: number): Claim {
  const ledger = new ClaimLedger(f.integrator, 'main');
  const claim: Claim = { version: 1, id: 'B', claimant: 'taker', scopes: ['src/b'], host: 'taker-host',
    branch: 'outcome/B-taker', claimedAt: iso(at), renewedAt: iso(at), leaseSeconds: 1800 };
  assert.equal(ledger.acquire(ledger.pull(), claim, 'chore(fixture): take over B'), true);
  return claim;
}

// Grade E

test('E (required): resolveLeaseSeconds defaults to 1800 and accepts the bounds 300 and 86400', () => {
  assert.equal(DEFAULT_LEASE_SECONDS, 1800);
  assert.equal(resolveLeaseSeconds(), 1800);
  assert.equal(resolveLeaseSeconds(undefined), 1800);
  assert.equal(resolveLeaseSeconds(300), 300);
  assert.equal(resolveLeaseSeconds(86400), 86400);
});

test('E (required): resolveLeaseSeconds and validateConfig refuse every invalid leaseSeconds', () => {
  for (const value of [299, 86401, 600.5, '1800', null]) {
    assert.throws(() => resolveLeaseSeconds(value), refusedLease(value), JSON.stringify(value));
    assert.throws(() => validateConfig({ leaseSeconds: value } as unknown as RunConfig), refusedLease(value),
      JSON.stringify(value));
  }
});

test('E (required): claimStale uses the holder lease, renewedAt or claimedAt, never expires blocked claims', () => {
  const claim = { claimedAt: ago(4000) };
  // Renewed 1801 seconds ago with lease 1800: stale; exactly 1800 seconds: not stale.
  assert.equal(claimStale({ ...claim, renewedAt: ago(1801), leaseSeconds: 1800 }, NOW), true);
  assert.equal(claimStale({ ...claim, renewedAt: ago(1800), leaseSeconds: 1800 }, NOW), false);
  // A blocked claim renewed ten leases ago never expires.
  assert.equal(claimStale({ ...claim, renewedAt: ago(18000), leaseSeconds: 1800, blocked: { at: ago(18000) } }, NOW),
    false);
  // The holder's lease decides.
  assert.equal(claimStale({ ...claim, renewedAt: ago(301), leaseSeconds: 300 }, NOW), true);
  assert.equal(claimStale({ ...claim, renewedAt: ago(300), leaseSeconds: 300 }, NOW), false);
  // A legacy claim without renewedAt and leaseSeconds is renewed at claimedAt with the default lease.
  assert.equal(claimStale({ claimedAt: ago(1801) }, NOW), true);
  assert.equal(claimStale({ claimedAt: ago(1800) }, NOW), false);
  assert.equal(claimStale({ claimedAt: ago(1000) }, NOW), false);
  // A claim without a parseable renewal time is never stale.
  assert.equal(claimStale({}, NOW), false);
  assert.equal(claimStale({ claimedAt: 'not a time' }, NOW), false);
  assert.equal(claimStale({ renewedAt: 'not a time', claimedAt: ago(100000) }, NOW), false);
});

// Grade E (coverage-only) 4.4: not needed, coverage reached.

// Grade D

test('D (required): foreignClaimsOf with a time omits stale foreign claims and is unchanged without one', () => {
  const claim = (id: string, claimant: string, fields: Partial<Claim> = {}): Claim =>
    ({ version: 1, id, claimant, scopes: [`src/${id.toLowerCase()}`], host: claimant, ...fields });
  const claims = [
    claim('A', 'other', { renewedAt: ago(10), leaseSeconds: 1800 }),
    claim('B', 'other', { renewedAt: ago(1801), leaseSeconds: 1800 }),
    claim('C', 'other', { renewedAt: ago(18000), leaseSeconds: 1800, blocked: { at: ago(18000) } }),
    claim('D', 'other', { claimedAt: ago(1801) }),
    claim('E', 'mine', { renewedAt: ago(10) }),
    claim('F', 'other', { renewedAt: ago(10) }),
    claim('G', 'other'),
  ];
  const snapshot = { claims: new Map(claims.map((item): [string, Claim] => [item.id, item])) };
  const ids = (list: Claim[]) => list.map(item => item.id);
  // Fresh, blocked and timeless foreign claims stay; stale ones (B, legacy D) go; own and done claims are excluded.
  assert.deepEqual(ids(foreignClaimsOf(snapshot, ['F'], 'mine', NOW)), ['A', 'C', 'G']);
  assert.deepEqual(ids(foreignClaimsOf(snapshot, ['F'], 'mine')), ['A', 'B', 'C', 'D', 'G']);
});

test('D (required): explainUnfinished explains a claim-lost task as blocked with reason claim-lost', () => {
  const blockers = explainUnfinished({ ids: ['B'], remaining: ['B'], tasks: [{ id: 'B', dependencies: [], scopes: ['src/b'] }],
    completed: {}, done: [], baselineDone: [], foreignClaims: [{ id: 'B', host: 'taker', scopes: ['src/b'] }],
    statePath: '/state/state.json', blocked: { B: { reason: 'claim-lost', work: { stage: 'merge', scopes: ['src/b'] } } } });
  assert.deepEqual(blockers, { B: { kind: 'blocked', stage: 'merge', reason: 'claim-lost',
    diagnostics: '/state/state.json' } });
});

for (const value of [299, 86401, 600.5, '1800']) {
  test(`D (required): leaseSeconds ${JSON.stringify(value)} is refused through the CLI before any state, claim or worktree`, async t => {
    const f = runnerFixture(t, { ids: ['A'] });
    const { root: _root, stateDirectory: _state, ...invocation } = f.config('one', { leaves: ['A'] });
    const file = join(f.base, 'invocation.json');
    writeFileSync(file, JSON.stringify({ ...invocation, leaseSeconds: value }));
    const xdg = join(f.base, 'xdg'); const lines: string[] = [];
    let started = 0;
    const code = await main(file, (config, options) => runQueue(config, f.options(config, { ...options,
      createAdapter: () => { started += 1; throw new Error('No session expected'); } })),
    line => lines.push(line), { cwd: f.root, env: { XDG_STATE_HOME: xdg, OUTCOME_RUNNER_MASCOT: '0' },
      mascot: async () => {} });
    assert.equal(code, 4);
    const line = JSON.parse(lines.at(-1)!);
    assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'invalid-lease-seconds');
    const diagnostics = JSON.parse(readFileSync(line.diagnostics, 'utf8'));
    rmSync(dirname(line.diagnostics), { recursive: true, force: true });
    assert.equal(diagnostics.reason, 'invalid-lease-seconds');
    assert.deepEqual(diagnostics.details, { setting: 'leaseSeconds', value });
    assert.match(diagnostics.message, /leaseSeconds/u);
    // No state.json (the state lives below the XDG state home), lock, ownership file, claim, worktree or session.
    assert.equal(existsSync(join(xdg, 'outcome-runner')), false);
    assert.equal(existsSync(join(f.base, '.work-queue-locks')), false);
    assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${CLAIMS}`), '');
    assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(started, 0);
  });
}

test('D (required): leaseSeconds is outside the identity, so a resumed invocation with another lease continues', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const one = f.config('one', { leaves: ['A', 'B'] });
  const identity = (leaseSeconds: number) => invocationIdentity({ ...one, leaseSeconds, coverage: 85, leaves: ['A', 'B'] });
  assert.deepEqual(identity(300), identity(3600)); assert.equal(hash(identity(300)), hash(identity(3600)));
  const first = await f.run({ ...one, maxAccepted: 1, leaseSeconds: 300 });
  assert.equal(first.status, 'limit-reached', JSON.stringify(first)); assert.deepEqual(first.accepted, ['A']);
  const identityHash = stateOf(one).identityHash;
  const owned = JSON.parse(readFileSync(invocationLockFiles(f.root, one.stateDirectory).ownership, 'utf8')).identity;
  const second = await f.run({ ...one, leaseSeconds: 3600 });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.ok(second.accepted.includes('B')); assert.deepEqual(second.remaining, []);
  assert.equal(stateOf(one).identityHash, identityHash);
  assert.equal(JSON.parse(readFileSync(invocationLockFiles(f.root, one.stateDirectory).ownership, 'utf8')).identity, owned);
  // The claim of B was written by the resumed run with its own lease.
  const claim = claimOf(f, 'B');
  assert.equal(claim.claimant, stateOf(one).claimant); assert.equal(claim.leaseSeconds, 3600);
});

// Grade C

test('C (required): ledger operations replace, renew, mark blocked, detect loss and defer under contention', t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const ledger = new ClaimLedger(f.integrator, 'main');
  const held: Claim = { version: 1, id: 'B', claimant: 'one', scopes: ['src/b'], host: 'one-host',
    branch: 'outcome/B-one', claimedAt: ago(100), renewedAt: ago(100), leaseSeconds: 1800 };
  assert.equal(ledger.acquire(ledger.pull(), held, 'chore(fixture): claim B'), true);
  // commitClaim replaces the entry of the same id: one file per id.
  assert.equal(ledger.acquire(ledger.pull(), { ...held, host: 'one-host-again' }, 'chore(fixture): rewrite B'), true);
  assert.equal(git(f.remote, 'ls-tree', '--name-only', `refs/heads/${CLAIMS}`), 'B.json');
  assert.equal(claimOf(f, 'B').host, 'one-host-again');
  // markBlocked writes blocked.at and keeps renewedAt.
  assert.equal(ledger.markBlocked('B', 'one', 'outcome/B-one', ago(50), 'chore(fixture): mark the claim of B blocked'),
    'blocked');
  assert.deepEqual(claimOf(f, 'B').blocked, { at: ago(50) });
  assert.equal(claimOf(f, 'B').renewedAt, ago(100));
  // renew writes renewedAt and leaseSeconds and drops blocked.
  assert.equal(ledger.renew('B', 'one', 'outcome/B-one', ago(10), 900, 'chore(fixture): renew the claim of B'), 'renewed');
  const renewed = claimOf(f, 'B');
  assert.equal(renewed.renewedAt, ago(10)); assert.equal(renewed.leaseSeconds, 900);
  assert.equal(Object.hasOwn(renewed, 'blocked'), false);
  assert.equal(renewed.claimedAt, ago(100)); assert.equal(renewed.claimant, 'one');
  // Another claimant's or another branch's claim, or no claim at all, is lost; nothing is written.
  const head = ledgerHead(f);
  assert.equal(ledger.renew('B', 'two', 'outcome/B-one', ago(5), 1800, 'renew'), 'lost');
  assert.equal(ledger.renew('B', 'one', 'outcome/B-other', ago(5), 1800, 'renew'), 'lost');
  assert.equal(ledger.markBlocked('B', 'two', 'outcome/B-one', ago(5), 'mark'), 'lost');
  assert.equal(ledger.renew('Z', 'one', 'outcome/B-one', ago(5), 1800, 'renew'), 'lost');
  assert.equal(ledgerHead(f), head);
  // A lock wrapper that pushes an unrelated ledger commit before every ledger operation makes every
  // compare-and-swap fail, so both operations are deferred and the claim stays unchanged.
  const noise = new ClaimLedger(f.root, 'main'); let pushed = 0;
  const racing = new ClaimLedger(f.integrator, 'main', fn => {
    pushed += 1;
    assert.equal(noise.acquire(noise.pull(), { version: 1, id: `Z${pushed}`, claimant: 'noise', scopes: ['src/z'] },
      'chore(fixture): unrelated claim'), true);
    return fn();
  });
  const before = claimOf(f, 'B');
  assert.equal(racing.renew('B', 'one', 'outcome/B-one', ago(1), 1800, 'renew'), 'deferred');
  assert.equal(racing.markBlocked('B', 'one', 'outcome/B-one', ago(1), 'mark'), 'deferred');
  assert.deepEqual(claimOf(f, 'B'), before);
  assert.ok(pushed >= 20, String(pushed));
});

test('C (required): a takeover with a snapshot whose claim differs from the observed stale claim makes no commit', t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const ledger = new ClaimLedger(f.integrator, 'main');
  const stale: Claim = { version: 1, id: 'B', claimant: 'zero', scopes: ['src/b'], host: 'zero-host',
    branch: 'outcome/B-zero', claimedAt: ago(4000), renewedAt: ago(4000), leaseSeconds: 1800 };
  const taker: Claim = { version: 1, id: 'B', claimant: 'one', scopes: ['src/b'], host: 'one-host',
    branch: 'outcome/B-one', claimedAt: ago(0), renewedAt: ago(0), leaseSeconds: 1800 };
  // Without any claim of B in the snapshot nothing is taken over.
  assert.equal(ledger.takeOver(ledger.pull(), stale, taker, 'chore(fixture): take over B'), false);
  assert.equal(git(f.remote, 'for-each-ref', `refs/heads/${CLAIMS}`), '');
  assert.equal(ledger.acquire(ledger.pull(), stale, 'chore(fixture): claim B'), true);
  const head = ledgerHead(f);
  // The snapshot holds the stale claim, but the observed claim differs (it was renewed meanwhile).
  const snapshot = ledger.pull();
  assert.equal(ledger.takeOver(snapshot, { ...stale, renewedAt: ago(10) }, taker, 'chore(fixture): take over B'), false);
  assert.equal(ledgerHead(f), head); assert.equal(claimOf(f, 'B').claimant, 'zero');
  // With the observed claim equal to the snapshot's, the takeover is pushed.
  assert.equal(ledger.takeOver(snapshot, structuredClone(stale), taker, 'chore(fixture): take over B'), true);
  assert.equal(claimOf(f, 'B').claimant, 'one');
  // The same old snapshot cannot win a second takeover: its head is no longer the ledger head.
  assert.equal(ledger.takeOver(snapshot, stale, { ...taker, claimant: 'two' }, 'chore(fixture): take over B'), false);
  assert.equal(claimOf(f, 'B').claimant, 'one');
});

test('C (required): leaseSeconds 300 starts the renewal timer with 100000 ms and the claim records the lease', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const { timer, leaseTimer } = fakeTimer();
  const config = f.config('one', { leaves: ['B'], leaseSeconds: 300 });
  const result = await f.run(config, { now: () => NOW, leaseTimer });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(timer.intervals, [100000]);
  assert.equal(timer.stops, 1);
  const claim = claimOf(f, 'B');
  assert.equal(claim.claimant, stateOf(config).claimant);
  assert.equal(claim.leaseSeconds, 300);
  assert.equal(claim.claimedAt, iso(NOW)); assert.equal(claim.renewedAt, claim.claimedAt);
  assert.equal(Object.hasOwn(claim, 'blocked'), false);
});

// Grade B

test('B (required): the claim is renewed during an implementation session that outlasts the default lease', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const { timer, leaseTimer } = fakeTimer();
  let clock = NOW;
  const ticks: { at: number; claim: Claim }[] = [];
  const createAdapter = scriptedWorker({ onSession: (_options, prompt) => {
    if (!prompt.includes('Implement all approved')) return;
    // The session lasts 2400 seconds: four ticks, each after the fake clock advanced by 600 seconds.
    for (let tick = 0; tick < 4; tick += 1) {
      clock += 600000;
      timer.renew();
      ticks.push({ at: clock, claim: claimOf(f, 'B') });
    }
  } });
  const config = f.config('one', { leaves: ['B'] });
  const result = await f.run(config, { now: () => clock, leaseTimer, createAdapter });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['B']);
  assert.deepEqual(timer.intervals, [600000]);
  assert.equal(ticks.length, 4);
  for (const { at, claim } of ticks) {
    assert.equal(claim.renewedAt, iso(at)); assert.equal(claim.leaseSeconds, 1800);
    assert.equal(claim.claimant, stateOf(config).claimant); assert.equal(claim.claimedAt, iso(NOW));
    // Another runner never sees the claim stale during the session.
    assert.equal(claimStale(claim, at), false);
  }
  const last = ticks.at(-1)!;
  assert.equal(last.at - NOW, 2400000);
  // Control: without the renewals the claim would have been stale at the last tick.
  assert.equal(claimStale({ ...last.claim, renewedAt: last.claim.claimedAt }, last.at), true);
  assert.ok(timer.stops >= 1);
});

/** Runs invocation `one` with leaf `B` against a foreign claim of `B` by `zero`, at the fake time `NOW`. */
async function againstZero(t: TestContext, fields: Partial<Claim>) {
  const f = runnerFixture(t, { ids: ['B'] });
  claimByZero(f, 'B', fields);
  const prompts: string[] = []; const lines: string[] = [];
  const config = f.config('one', { leaves: ['B'] });
  const result = await f.run(config, { now: () => NOW, steps: line => { lines.push(line); },
    createAdapter: scriptedWorker({ onSession: (_options, prompt) => { prompts.push(prompt); } }) });
  return { f, config, result, prompts, waits: waitLines(lines) };
}

/** `B` was not started: it waits for `zero`'s claim, which still names `zero`. */
function assertWaitingForZero({ f, result, prompts, waits }: Awaited<ReturnType<typeof againstZero>>) {
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.blockers, { B: { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'B', host: 'zero-host' } } });
  assert.deepEqual(result.claimedElsewhere, { B: { host: 'zero-host' } });
  assert.equal(waits.length, 1); assert.ok(waits[0].endsWith(' run wait: waiting 60s for B on zero-host\n'), waits[0]);
  assert.equal(prompts.length, 0);
  assert.equal(claimOf(f, 'B').claimant, 'zero-claimant');
}

/** `B` was taken over from `zero` and accepted, never waited for, and the new claim is `one`'s. */
function assertTakenOver({ f, config, result, prompts, waits }: Awaited<ReturnType<typeof againstZero>>) {
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['B']);
  assert.equal(result.blockers, undefined); assert.equal(result.claimedElsewhere, undefined);
  assert.deepEqual(waits, []);
  assert.ok(prompts.some(prompt => prompt.includes('Task B;')));
  const claim = claimOf(f, 'B');
  assert.equal(claim.claimant, stateOf(config).claimant);
  assert.equal(claim.claimedAt, iso(NOW)); assert.equal(claim.renewedAt, iso(NOW)); assert.equal(claim.leaseSeconds, 1800);
}

test('B (required): a claim renewed exactly one lease ago is waited for', async t => {
  assertWaitingForZero(await againstZero(t, { claimedAt: ago(5000), renewedAt: ago(1800), leaseSeconds: 1800 }));
});

test('B (required): a claim renewed longer than its lease ago is taken over as free work', async t => {
  assertTakenOver(await againstZero(t, { claimedAt: ago(5000), renewedAt: ago(1801), leaseSeconds: 1800 }));
});

test('B (required): a legacy claim without renewal data within the default lease is waited for', async t => {
  assertWaitingForZero(await againstZero(t, { claimedAt: ago(1000) }));
});

test('B (required): a legacy claim without renewal data older than the default lease is taken over', async t => {
  assertTakenOver(await againstZero(t, { claimedAt: ago(1801) }));
});

/** Invocation `one` blocks `B` with a failing session at `NOW`; its claim is marked blocked in the ledger. */
async function blockedByOne(f: RunnerFixture): Promise<RunConfig> {
  const one = f.config('one', { leaves: ['B'] });
  const result = await f.run(one, { now: () => NOW,
    createAdapter: scriptedWorker({ fail: prompt => prompt.includes('Task B;') }) });
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.B.kind, 'blocked');
  const claim = claimOf(f, 'B');
  assert.equal(claim.claimant, stateOf(one).claimant);
  assert.deepEqual(claim.blocked, { at: iso(NOW) });
  assert.equal(claim.renewedAt, iso(NOW));
  return one;
}

test('B (required): a blocked claim ten leases old is not taken over by another runner', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const one = await blockedByOne(f);
  const before = claimOf(f, 'B');
  const later = NOW + 10 * 1800 * 1000;
  const result = await f.run(f.config('two', { leaves: ['B'] }), { now: () => later, createAdapter: noWorker });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.blockers!.B, { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'B', host: before.host } });
  assert.deepEqual(claimOf(f, 'B'), before);
  assert.equal(claimOf(f, 'B').claimant, stateOf(one).claimant);
});

test('B (required): the own invocation resumes its blocked claim, clearing the mark before any session', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const one = await blockedByOne(f);
  const restart = NOW + 10 * 1800 * 1000;
  const seen: Claim[] = [];
  const result = await f.run(one, { now: () => restart, createAdapter: scriptedWorker({ onSession: () => {
    if (!seen.length) seen.push(claimOf(f, 'B'));
  } }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(seen.length, 1);
  const [first] = seen;
  assert.equal(Object.hasOwn(first, 'blocked'), false);
  assert.equal(first.renewedAt, iso(restart)); assert.equal(first.leaseSeconds, 1800);
  assert.equal(first.claimant, stateOf(one).claimant); assert.equal(first.claimedAt, iso(NOW));
});

// Grade A

test('A (required): exactly one of two runners that read the same stale claim takes it over', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  claimByZero(f, 'B', { claimedAt: ago(5000), renewedAt: ago(5000), leaseSeconds: 1800 });
  const one = f.config('one', { leaves: ['B'] }); const two = f.config('two', { leaves: ['B'] });
  // Invocation two first runs while zero's claim is still fresh, so it only records its claimant and waits.
  const early = await f.run(two, { now: () => NOW - 4000 * 1000, createAdapter: noWorker });
  assert.equal(early.status, 'cancelled', JSON.stringify(early));
  assert.equal(early.blockers!.B.kind, 'waiting-for-claim');
  const twoClaimant = stateOf(two).claimant as string;
  const twoBranch = `outcome/B-${hash({ invocation: 'two', id: 'B', authority: two.authority.reference }).slice(0, 12)}`;
  // Invocation one pulls the ledger with the stale claim; right after its pull (at its claim step line) two takes
  // the claim over from the very same ledger state, before one pushes its own takeover.
  const pulled = ledgerHead(f);
  let raced = false; const onePrompts: string[] = []; const lines: string[] = [];
  const steps = (line: string) => {
    lines.push(line);
    if (raced || !/ B claim: claiming the task/u.test(line)) return;
    raced = true;
    const ledger = new ClaimLedger(f.integrator, 'main');
    const snapshot = ledger.pull();
    assert.equal(snapshot.head, pulled);
    assert.equal(ledger.takeOver(snapshot, snapshot.claims.get('B')!, { version: 1, id: 'B', claimant: twoClaimant,
      scopes: ['src/b'], taskHash: hash(f.queue.tasks[0]), host: 'two-host', branch: twoBranch, claimedAt: iso(NOW),
      renewedAt: iso(NOW), leaseSeconds: 1800 }, 'chore(fixture): take over B'), true);
  };
  const lost = await f.run(one, { now: () => NOW, steps,
    createAdapter: scriptedWorker({ onSession: (_options, prompt) => { onePrompts.push(prompt); } }) });
  assert.ok(raced);
  // Only one takeover was pushed: two's. One lost the compare-and-swap, pulled again and waits for two's claim.
  assert.equal(git(f.remote, 'rev-list', '--count', '--grep=take over B', `refs/heads/${CLAIMS}`), '1');
  assert.equal(claimOf(f, 'B').claimant, twoClaimant);
  assert.equal(lost.status, 'cancelled', JSON.stringify(lost));
  assert.deepEqual(lost.blockers, { B: { kind: 'waiting-for-claim', reason: 'waiting-for-claim',
    claim: { id: 'B', host: 'two-host' } } });
  assert.ok(!onePrompts.some(prompt => prompt.includes('Task B;')));
  assert.ok(waitLines(lines).every(line => line.endsWith(' run wait: waiting 60s for B on two-host\n')));
  // The winner works its claim and merges B exactly once.
  const won = await f.run(two, { now: () => NOW + 1000 });
  assert.equal(won.status, 'exhausted', JSON.stringify(won)); assert.deepEqual(won.accepted, ['B']);
  assert.equal(claimOf(f, 'B').claimant, twoClaimant);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'MERGED');
  assert.equal(f.records[0].branch, twoBranch);
  assert.equal(git(f.remote, 'rev-list', '--count', '--grep=accept 1', 'refs/heads/main'), '1');
  assert.equal(stateOf(one).completed, undefined);
});

test('A (required): a claim taken over before the merge stops the previous holder without a merge', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const base = f.hostFor();
  let merges = 0; let taken: Claim | undefined;
  const host: PullRequestHost = { ...base,
    // The merge stage reads the eligibility right before it would merge; another runner takes over B meanwhile.
    eligibility: () => { taken ??= takeOverByTaker(f, NOW); return ELIGIBLE; },
    merge: (pr, head, guard) => { merges += 1; return base.merge(pr, head, guard); } };
  const one = f.config('one', { leaves: ['B'] });
  const result = await f.run(one, { now: () => NOW, host });
  assert.ok(taken);
  assert.equal(merges, 0);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].state, 'OPEN');
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.B.kind, 'blocked'); assert.equal(result.blockers!.B.reason, 'claim-lost');
  assert.equal(result.blockers!.B.stage, 'merge');
  const state = stateOf(one);
  assert.equal(state.blocked.B.reason, 'claim-lost');
  assert.equal(state.blocked.B.work.claimLostAt, iso(NOW));
  // The claim stays the taker's: one never marks or renews it.
  assert.deepEqual(claimOf(f, 'B'), taken);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), git(f.root, 'rev-parse', 'HEAD'));
});

test('A (required): a renewal that finds the claim taken over stops the timer and the task before the push', async t => {
  const f = runnerFixture(t, { ids: ['B'] });
  const { timer, leaseTimer } = fakeTimer();
  const base = f.hostFor();
  let creates = 0; let clock = NOW; let taken: Claim | undefined; let stopsAfterTick = -1;
  const host: PullRequestHost = { ...base, create: (work, body) => { creates += 1; return base.create(work, body); } };
  const createAdapter = scriptedWorker({ onSession: (_options, prompt) => {
    if (taken || !prompt.includes('Implement all approved')) return;
    taken = takeOverByTaker(f, clock);
    clock += 600000;
    timer.renew();
    stopsAfterTick = timer.stops;
  } });
  const one = f.config('one', { leaves: ['B'] });
  const result = await f.run(one, { now: () => clock, host, leaseTimer, createAdapter });
  assert.ok(taken);
  // The renewal found the claim held by the taker and stopped the timer at once.
  assert.equal(stopsAfterTick, 1);
  assert.equal(timer.stops, 1);
  // A later tick of the stopped timer does nothing.
  timer.renew();
  assert.deepEqual(claimOf(f, 'B'), taken);
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(result.blockers!.B.reason, 'claim-lost');
  const state = stateOf(one);
  assert.equal(state.blocked.B.reason, 'claim-lost');
  assert.equal(state.blocked.B.work.branch.startsWith('outcome/B-'), true);
  // No task branch was pushed and no pull request was created.
  assert.equal(git(f.remote, 'for-each-ref', 'refs/heads/outcome'), '');
  assert.equal(creates, 0); assert.equal(f.records.length, 0);
});

// Grade A (coverage-only) 4.19: not needed, coverage reached.
