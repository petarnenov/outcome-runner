import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEASE_SECONDS, resolveLeaseSeconds, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { claimStale } from '../src/claims.ts';

/** A fixed fake time used by the unit tests. */
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const ago = (seconds: number) => iso(NOW - seconds * 1000);

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
