import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { DEFAULT_LEASE_SECONDS, hash, resolveLeaseSeconds, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { ClaimLedger, claimStale } from '../src/claims.ts';
import type { Claim } from '../src/claims.ts';
import { explainUnfinished, foreignClaimsOf, invocationLockFiles, runQueue } from '../src/runner.ts';
import type { LeaseTimer } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture } from './support/runner-fixture.ts';
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
  const stateOf = () => JSON.parse(readFileSync(join(one.stateDirectory, 'state.json'), 'utf8'));
  const first = await f.run({ ...one, maxAccepted: 1, leaseSeconds: 300 });
  assert.equal(first.status, 'limit-reached', JSON.stringify(first)); assert.deepEqual(first.accepted, ['A']);
  const identityHash = stateOf().identityHash;
  const owned = JSON.parse(readFileSync(invocationLockFiles(f.root, one.stateDirectory).ownership, 'utf8')).identity;
  const second = await f.run({ ...one, leaseSeconds: 3600 });
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.ok(second.accepted.includes('B')); assert.deepEqual(second.remaining, []);
  assert.equal(stateOf().identityHash, identityHash);
  assert.equal(JSON.parse(readFileSync(invocationLockFiles(f.root, one.stateDirectory).ownership, 'utf8')).identity, owned);
  // The claim of B was written by the resumed run with its own lease.
  const claim = claimOf(f, 'B');
  assert.equal(claim.claimant, stateOf().claimant); assert.equal(claim.leaseSeconds, 3600);
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
  const state = JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(claim.claimant, state.claimant);
  assert.equal(claim.leaseSeconds, 300);
  assert.equal(claim.claimedAt, iso(NOW)); assert.equal(claim.renewedAt, claim.claimedAt);
  assert.equal(Object.hasOwn(claim, 'blocked'), false);
});
