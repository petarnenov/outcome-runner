import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionAttemptOwner } from '../src/model.ts';
import { SESSION_ATTEMPTS, SESSION_LABELS, SESSION_RETRY_DELAYS_MS, SessionAttemptsExhausted,
  isSessionTransportFailure, sameSessionAttemptOwner, sessionAttemptOwner, sessionAttemptsMessage, sessionFailureDetail,
  sessionRetryMessage } from '../src/session-retry.ts';
import { STEP_LINE_LIMIT, createStepLog } from '../src/step-log.ts';

const TRANSPORT = 'Claude transport exited (1) without a complete private result: ';
const withCode = (code: string) => Object.assign(new Error(`failure ${code}`), { code });

// 4.1 (E) (required)
test('E: transport failures are recognised and other failures are not', () => {
  assert.equal(isSessionTransportFailure(new Error(TRANSPORT)), true);
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTCONN']) {
    assert.equal(isSessionTransportFailure(withCode(code)), true, code);
  }
  assert.equal(isSessionTransportFailure(new Error('Codex RPC observation timed out')), true);
  assert.equal(isSessionTransportFailure(new Error('Could not resolve host: github.com')), true);
  for (const message of ['Scripted worker failure', 'Malformed Codex transport', 'Codex turn did not complete',
    'Selected harness interface unavailable', 'Worker plan incomplete']) {
    assert.equal(isSessionTransportFailure(new Error(message)), false, message);
  }
  assert.equal(isSessionTransportFailure(withCode('ENOENT')), false);
  assert.equal(isSessionTransportFailure(TRANSPORT), false);
  assert.equal(isSessionTransportFailure(undefined), false);
});

// 4.2 (E) (required)
test('E: the attempts, waits and messages of the session retry', () => {
  assert.equal(SESSION_ATTEMPTS, 3);
  assert.deepEqual(SESSION_RETRY_DELAYS_MS, [10000, 30000]);
  assert.equal(sessionRetryMessage('plan', 10000), 'planning: no report; retry in 10 s');
  assert.equal(sessionAttemptsMessage('plan', 3, 'x'), 'Session plan ended without a report after 3 attempts; last failure: x');
  const error = new SessionAttemptsExhausted('plan', 3, 'x');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'SessionAttemptsExhausted');
  assert.equal(error.message, 'Session plan ended without a report after 3 attempts; last failure: x');
  assert.equal(error.purpose, 'plan'); assert.equal(error.attempts, 3); assert.equal(error.lastFailure, 'x');
  assert.equal(sessionFailureDetail(new Error('a\nb\tc\u0007d')), 'a b c d');
  const long = `${'a'.repeat(100)}${'b'.repeat(2000)}`;
  assert.equal(sessionFailureDetail(new Error(long)), 'b'.repeat(2000));
  assert.equal(sessionFailureDetail('plain'), 'plain');
});

// 4.3 (E) (required)
test('E: the session retry line keeps its attempt number for every label and a 20-character id', () => {
  const lines: string[] = [];
  const log = createStepLog({ write: line => { lines.push(line); }, now: () => new Date(2026, 0, 1, 12, 0, 0).getTime() });
  const subject = 'ABCDEFGHIJKLMNOPQRST';
  assert.equal(subject.length, 20);
  log(subject, 'session retry', sessionRetryMessage('document-review', 30000), { attempt: 3 });
  const longest = lines[0].replace(/\n$/u, '');
  assert.ok(longest.length <= STEP_LINE_LIMIT, longest);
  assert.ok(!longest.endsWith('...'), longest);
  assert.ok(longest.endsWith('documentation review: no report; retry in 30 s (attempt 3)'), longest);
  for (const [purpose, label] of Object.entries(SESSION_LABELS)) {
    for (const [index, wait] of SESSION_RETRY_DELAYS_MS.entries()) {
      lines.length = 0;
      const attempt = index + 2;
      log(subject, 'session retry', sessionRetryMessage(purpose as keyof typeof SESSION_LABELS, wait), { attempt });
      const line = lines[0].replace(/\n$/u, '');
      assert.ok(line.length <= STEP_LINE_LIMIT, line);
      assert.ok(line.endsWith(`${label}: no report; retry in ${wait / 1000} s (attempt ${attempt})`), line);
    }
  }
});

// 4.4 (E) (required, scenario "The record names its session")
test('E: a session attempt owner names its purpose, stage and integration', () => {
  const integration = { target: 't1', previousBase: 'b', conflicts: [], outcome: 'clean' as const, step: 'review' as const };
  assert.deepEqual(sessionAttemptOwner({ stage: 'plan' }, 'plan'), { purpose: 'plan', stage: 'plan' });
  // An integration record outside the integrate stage is not part of the owner.
  assert.deepEqual(sessionAttemptOwner({ stage: 'work', integration }, 'review'), { purpose: 'review', stage: 'work' });
  assert.deepEqual(sessionAttemptOwner({ stage: 'integrate', integration }, 'review'),
    { purpose: 'review', stage: 'integrate', integration: { target: 't1', step: 'review' } });
  assert.deepEqual(sessionAttemptOwner({ stage: 'integrate' }, 'work'), { purpose: 'work', stage: 'integrate' });
  const owner: SessionAttemptOwner = { purpose: 'work', stage: 'integrate', integration: { target: 't1', step: 'send-back' } };
  assert.equal(sameSessionAttemptOwner(owner, { ...owner, integration: { ...owner.integration! } }), true);
  assert.equal(sameSessionAttemptOwner({ purpose: 'plan', stage: 'plan' }, { purpose: 'plan', stage: 'plan' }), true);
  assert.equal(sameSessionAttemptOwner(owner, { ...owner, purpose: 'review' }), false);
  assert.equal(sameSessionAttemptOwner(owner, { ...owner, stage: 'work' }), false);
  assert.equal(sameSessionAttemptOwner(owner, { ...owner, integration: { target: 't2', step: 'send-back' } }), false);
  assert.equal(sameSessionAttemptOwner(owner, { ...owner, integration: { target: 't1', step: 'resolve' } }), false);
  assert.equal(sameSessionAttemptOwner(owner, { purpose: 'work', stage: 'integrate' }), false);
  assert.equal(sameSessionAttemptOwner({ purpose: 'work', stage: 'integrate' }, owner), false);
  assert.equal(sameSessionAttemptOwner(undefined, owner), false);
  assert.equal(sameSessionAttemptOwner(owner, undefined), false);
});
