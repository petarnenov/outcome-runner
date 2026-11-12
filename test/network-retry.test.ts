import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from '../src/git.ts';
import { isConnectionFailure, NETWORK_RETRY_DELAYS_MS, useNetworkRetry, withNetworkRetry } from '../src/network-retry.ts';
import { runnerFixture } from './support/runner-fixture.ts';

const UNREACHABLE = 'https://unreachable-origin.invalid/origin.git';

const failure = (message: string, stderr = '') => Object.assign(new Error(message), { stderr });
const lookupFailure = () => failure('Command failed: git fetch origin main',
  "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n");

/** A retry policy that records its waits instead of sleeping; `onSleep` runs at each wait. */
function recordedWaits(t: { after: (fn: () => void) => void }, onSleep: () => void = () => {}, delaysMs = [1, 2, 3]) {
  const waits: number[] = [];
  t.after(useNetworkRetry({ delaysMs, sleep: milliseconds => { waits.push(milliseconds); onSleep(); }, onWait: () => {} }));
  return waits;
}

// Grade C

test('C (required): connection failures of Git and gh are recognized and other failures are not', () => {
  assert.equal(isConnectionFailure(lookupFailure()), true);
  assert.equal(isConnectionFailure(failure('ssh: Could not resolve hostname github.com: nodename nor servname provided')), true);
  assert.equal(isConnectionFailure(failure('Command failed: gh pr view 3',
    'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n')), true);
  assert.equal(isConnectionFailure(failure("fatal: unable to access 'x': Failed to connect to github.com port 443")), true);
  assert.equal(isConnectionFailure(failure('Command failed: git push', '! [rejected] main -> main (non-fast-forward)\n')), false);
  assert.equal(isConnectionFailure(failure('Command failed: git rev-parse', "fatal: ambiguous argument 'x'\n")), false);
  assert.equal(isConnectionFailure('Could not resolve host'), false);
});

test('C (required): a connection failure is retried after each wait until the command succeeds', t => {
  const waits = recordedWaits(t); let calls = 0;
  const result = withNetworkRetry(() => { calls += 1; if (calls < 3) throw lookupFailure(); return 'fetched'; }, () => 'git fetch');
  assert.equal(result, 'fetched'); assert.equal(calls, 3); assert.deepEqual(waits, [1, 2]);
});

test('C (required): any other failure is thrown at once without waiting', t => {
  const waits = recordedWaits(t); let calls = 0;
  const rejected = failure('Command failed: git push', '! [rejected]\n');
  assert.throws(() => withNetworkRetry(() => { calls += 1; throw rejected; }, () => 'git push'), error => error === rejected);
  assert.equal(calls, 1); assert.deepEqual(waits, []);
});

test('C (required): after the last wait the connection failure is thrown unchanged', t => {
  const waits = recordedWaits(t); let calls = 0; let last: Error | undefined;
  assert.throws(() => withNetworkRetry(() => { calls += 1; last = lookupFailure(); throw last; }, () => 'git fetch'),
    error => error === last);
  assert.equal(calls, 4); assert.deepEqual(waits, [1, 2, 3]);
});

test('C (required): each wait is announced with the retry number, the wait and the failed command', t => {
  const announced: [number, number, string][] = []; let calls = 0;
  t.after(useNetworkRetry({ delaysMs: [7, 8], sleep: () => {}, onWait: (...args) => { announced.push(args); } }));
  withNetworkRetry(() => { calls += 1; if (calls < 3) throw lookupFailure(); }, () => 'git fetch origin');
  assert.deepEqual(announced, [[1, 7, 'git fetch origin'], [2, 8, 'git fetch origin']]);
});

test('C (required): the default policy waits about 15 minutes in total before giving up', () => {
  const total = NETWORK_RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0);
  assert.ok(total >= 14 * 60000 && total <= 16 * 60000, `${total} ms`);
  assert.ok(NETWORK_RETRY_DELAYS_MS.every(wait => wait > 0 && wait <= 60000));
});

// Grade B

test('B (required): a real git fetch from an unreachable origin succeeds once the connection is back', t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const origin = git(f.root, 'remote', 'get-url', 'origin');
  git(f.root, 'remote', 'set-url', 'origin', UNREACHABLE);
  // The connection comes back during the second wait.
  let waited = 0;
  const waits = recordedWaits(t, () => { waited += 1; if (waited === 2) git(f.root, 'remote', 'set-url', 'origin', origin); });
  git(f.root, 'fetch', '-q', 'origin', 'main');
  assert.deepEqual(waits, [1, 2]);
  assert.equal(git(f.root, 'rev-parse', 'origin/main'), git(f.remote, 'rev-parse', 'refs/heads/main'));
});

// Grade A

test('A (required): a run that loses its connection after claiming a task waits, then merges the task', { timeout: 300000 }, async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const origin = git(f.root, 'remote', 'get-url', 'origin');
  let lost = false; let waits = 0;
  t.after(useNetworkRetry({ delaysMs: [1, 1, 1, 1, 1], sleep: () => {
    waits += 1;
    if (waits === 3) git(f.root, 'remote', 'set-url', 'origin', origin);
  } }));
  const lines: string[] = [];
  const result = await f.run(f.config('one'), { steps: line => { lines.push(line); }, afterEffect: async kind => {
    if (kind !== 'claim' || lost) return;
    lost = true; git(f.root, 'remote', 'set-url', 'origin', UNREACHABLE);
  } });
  assert.ok(lost, 'the connection was lost during the run');
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A', 'B']);
  assert.equal(waits, 3);
  const network = lines.filter(line => / run network: connection lost at git /u.test(line));
  assert.equal(network.length, 3, lines.join(''));
  assert.match(network[1], /retrying in 0\.001 s \(attempt 3\)/u);
  assert.equal(f.records.filter(pr => pr.state === 'MERGED').length, 2);
});

test('A (required): a connection that never comes back ends the run as before, and a later run resumes the task', { timeout: 300000 }, async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const origin = git(f.root, 'remote', 'get-url', 'origin');
  const restore = useNetworkRetry({ delaysMs: [1, 1], sleep: () => {} }); t.after(restore);
  let lost = false;
  // As before this change, the run ends with the connection failure, which the CLI reports as unavailable.
  await assert.rejects(f.run(f.config('one'), { afterEffect: async kind => {
    if (kind !== 'claim' || lost) return;
    lost = true; git(f.root, 'remote', 'set-url', 'origin', UNREACHABLE);
  } }), /Could not resolve host: unreachable-origin\.invalid/u);
  assert.ok(lost);
  git(f.root, 'remote', 'set-url', 'origin', origin);
  const second = await f.run(f.config('one'));
  assert.equal(second.status, 'exhausted', JSON.stringify(second));
  assert.deepEqual(second.accepted, ['A']);
  assert.equal(f.records.filter(pr => pr.state === 'MERGED').length, 1);
});
