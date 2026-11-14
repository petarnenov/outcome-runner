import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { DEFAULT_LEASE_SECONDS, hash, resolveLeaseSeconds, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { claimStale } from '../src/claims.ts';
import type { Claim } from '../src/claims.ts';
import { explainUnfinished, foreignClaimsOf, invocationLockFiles, runQueue } from '../src/runner.ts';
import { invocationIdentity } from '../src/invocation-identity.ts';
import { main } from './support/isolated-cli.ts';
import { runnerFixture } from './support/runner-fixture.ts';

/** A fixed fake time used by the unit tests. */
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const ago = (seconds: number) => iso(NOW - seconds * 1000);
const CLAIMS = 'work-queue-claims-main';

type Refusal = Error & { reason?: string; details?: { setting?: string; value?: unknown } };
const refusedLease = (value: unknown) => (error: Refusal) => error.reason === 'invalid-lease-seconds' &&
  error.details?.setting === 'leaseSeconds' && Object.is(error.details.value, value) && /leaseSeconds/u.test(error.message);

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
  const claim = JSON.parse(git(f.remote, 'show', `refs/heads/${CLAIMS}:B.json`));
  assert.equal(claim.claimant, stateOf().claimant); assert.equal(claim.leaseSeconds, 3600);
});
