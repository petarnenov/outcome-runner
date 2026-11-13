import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import type { RunConfig, SessionAttempt, SessionAttemptOwner, Work } from '../src/model.ts';
import type { RunOptions } from '../src/runner.ts';
import { RunStore } from '../src/run-store.ts';
import type { HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { SESSION_ATTEMPTS, SESSION_LABELS, SESSION_RETRY_DELAYS_MS, SessionAttemptsExhausted,
  isSessionTransportFailure, sameSessionAttemptOwner, sessionAttemptOwner, sessionAttemptsMessage, sessionFailureDetail,
  sessionRetryMessage } from '../src/session-retry.ts';
import { STEP_LINE_LIMIT, createStepLog } from '../src/step-log.ts';
import { RESULT_TEST, runnerFixture, scriptedWorker } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

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

// Runner tests: runnerFixture (Git fixtures) with a scripted adapter wrapping scriptedWorker. A chosen session fails
// for chosen attempts with a Claude transport failure before reporting anything; the message names the session kind
// and its number. A fake clock passed as `sessionRetrySleep` records each wait. Session counts come from the prompts.

type Kind = 'investigate' | 'plan' | 'planReview' | 'work' | 'review' | 'document' | 'documentReview' | 'postReview' |
  'postDocumentReview' | 'sendBack' | 'resolve';
const kindOf = (prompt: string): Kind | undefined =>
  prompt.includes('Address the rejection of the merged result') ? 'sendBack' :
  prompt.includes('Resolve the merge conflicts') ? 'resolve' :
  prompt.includes('review the merged result') && prompt.includes('Review actual implementation') ? 'postReview' :
  prompt.includes('review the merged result') && prompt.includes('Review the documentation') ? 'postDocumentReview' :
  prompt.includes('Inspect current files') ? 'investigate' : prompt.includes('Create proposal.md') ? 'plan' :
  prompt.includes('Review planning artifacts') ? 'planReview' : prompt.includes('Implement all approved') ? 'work' :
  prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation changes independently') ? 'documentReview' :
  prompt.includes('Review actual implementation') ? 'review' : undefined;

type When = Partial<Record<Kind, (n: number) => boolean>>;
interface Script {
  /** Sessions (by kind and number) that fail with a transport failure before any report. */
  transport?: When;
  /** Sessions that report `blocked`. */
  blocked?: When;
  /** Review sessions that report changes-required with a finding. */
  reject?: When;
}

const FINDING = 'The merged result needs another look.';
/** The task's own src/a/result.mjs, written again by the conflict resolution session. */
const TASK_RESULT = 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n';
/** The failure message of attempt `n` of `kind`. */
const failureOf = (kind: Kind, n: number) => `${TRANSPORT}${kind} ${n}`;

function scripted(script: Script = {}) {
  const prompts: { kind: Kind | undefined; prompt: string }[] = [];
  const count = (kind: Kind) => prompts.filter(entry => entry.kind === kind).length;
  const createAdapter = (options: HarnessOptions): HarnessAdapter => {
    let kind: Kind | undefined; let n = 0;
    const handleTool: HarnessOptions['handleTool'] = async (name, input, context) => {
      let next: ToolInput = input;
      if (name === 'outcome_report' && kind) {
        if (script.blocked?.[kind]?.(n)) next = { ...input, outcome: 'blocked' };
        else if (script.reject?.[kind]?.(n)) next = { outcome: 'changes-required', summary: 'Rejected', findings: [FINDING] };
      }
      return options.handleTool(name, next, context);
    };
    const inner = scriptedWorker()({ ...options, handleTool });
    const call = (name: string, input: ToolInput) => handleTool(name, input, { threadId: 'fixture' }) as Promise<any>;
    const reply = { threadId: 'fixture', events: [], text: '' } as unknown as WorkerReply;
    return { ...inner, async startAction(prompt: string) {
      kind = kindOf(prompt); prompts.push({ kind, prompt });
      n = kind ? count(kind) : 0;
      if (kind && script.transport?.[kind]?.(n)) throw new Error(failureOf(kind, n));
      if (kind === 'sendBack' || kind === 'resolve') {
        if (kind === 'resolve') {
          const before = await call('backlog_tool', { operation: 'read_file', input: { path: 'src/a/result.mjs' } } as ToolInput);
          await call('backlog_tool', { operation: 'write_file',
            input: { path: 'src/a/result.mjs', content: TASK_RESULT, expectedHash: before.hash } } as ToolInput);
        }
        await call('outcome_report', { outcome: 'ready', summary: 'Done', findings: [] } as ToolInput);
        return reply;
      }
      return inner.startAction(prompt);
    } };
  };
  return { prompts, count, createAdapter };
}
type Scripted = ReturnType<typeof scripted>;

/** A fake clock: it records every wait in milliseconds and then resolves, or runs `then` (which may throw). */
function fakeClock(then?: (milliseconds: number) => void) {
  const waits: number[] = [];
  const sleep = async (milliseconds: number) => { waits.push(milliseconds); then?.(milliseconds); };
  return { waits, sleep };
}
const stoppingClock = () => fakeClock(() => { throw new Error('runner stopped'); });

interface Scenario { f: RunnerFixture; config: RunConfig; s: Scripted }
function scenario(t: TestContext, script: Script): Scenario {
  const f = runnerFixture(t, { ids: ['A'] });
  return { f, config: f.config(), s: scripted(script) };
}
/** One run of the scenario: its result, the step lines it wrote and the waits of its fake clock. */
async function runOnce(sc: Scenario, clock = fakeClock(), extra: RunOptions = {}) {
  const lines: string[] = [];
  const result = await sc.f.run(sc.config, { createAdapter: sc.s.createAdapter, sessionRetrySleep: clock.sleep,
    ...extra, steps: line => { lines.push(line); extra.steps?.(line); } });
  return { result, lines, waits: clock.waits };
}
const retryLines = (lines: string[]) => lines.filter(line => line.includes(' A session retry: '));

// 4.5 (D) (coverage-only): not needed: coverage reached

// 4.6 (D) (required, scenario "A cancelled run is not retried")
test('D: a run cancelled during the wait starts no further attempt and keeps no record', async t => {
  const sc = scenario(t, { transport: { plan: n => n === 1 } });
  const controller = new AbortController();
  const clock = fakeClock(() => controller.abort());
  const { result, waits } = await runOnce(sc, clock, { signal: controller.signal });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.deepEqual(waits, [10000]);
  assert.equal(sc.s.count('plan'), 1);
  const current = sc.f.state().current as Work;
  assert.equal(current.stage, 'plan');
  assert.equal(current.sessionAttempt, undefined);
});

// 4.7 (C) (required, scenario "A session fails once and then succeeds")
test('C: a planning session that fails once is started again after 10 seconds and the task is accepted', async t => {
  const sc = scenario(t, { transport: { plan: n => n === 1 } });
  const { result, lines, waits } = await runOnce(sc);
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  assert.deepEqual(waits, [10000]);
  assert.equal(sc.s.count('plan'), 2);
  const retries = retryLines(lines);
  assert.equal(retries.length, 1, lines.join(''));
  assert.ok(retries[0].trimEnd().endsWith('planning: no report; retry in 10 s (attempt 2)'), retries[0]);
  const completed = sc.f.state().completed.A as Work;
  assert.equal(completed.sessionAttempt, undefined);
});

// 4.8 (C) (required, scenario "A reported refusal is not retried")
test('C: a planning session that reports blocked is not retried', async t => {
  const sc = scenario(t, { blocked: { plan: () => true } });
  const { result, lines, waits } = await runOnce(sc);
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(sc.s.count('plan'), 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(retryLines(lines), []);
  const blocked = sc.f.state().blocked.A;
  assert.equal(blocked.reason, 'Worker plan incomplete');
  assert.equal(blocked.work.sessionAttempt, undefined);
});

// 4.9 (C) (required, scenarios "Three failures block the task" and "Waits before the second and third attempt")
test('C: three failed investigation attempts block the task with the attempt count and the last failure', async t => {
  const sc = scenario(t, { transport: { investigate: () => true } });
  const { result, lines, waits } = await runOnce(sc);
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.deepEqual(waits, [10000, 30000]);
  assert.equal(sc.s.count('investigate'), 3);
  const retries = retryLines(lines).map(line => line.trimEnd());
  assert.equal(retries.length, 2);
  assert.ok(retries[0].endsWith('investigation: no report; retry in 10 s (attempt 2)'), retries[0]);
  assert.ok(retries[1].endsWith('investigation: no report; retry in 30 s (attempt 3)'), retries[1]);
  const blocked = sc.f.state().blocked.A;
  assert.equal(blocked.reason,
    `Session investigate ended without a report after 3 attempts; last failure: ${failureOf('investigate', 3)}`);
  assert.equal(blocked.work.stage, 'investigate');
  assert.equal(blocked.work.sessionAttempt, undefined);
  assert.equal(result.blockers!.A.reason, 'operation-incomplete');
});

// 4.10 (B) (required, scenario "A retried review session uses one review round")
test('B: a retried implementation review uses one review round and no check attempt', async t => {
  const sc = scenario(t, { transport: { review: n => n === 1 } });
  const { result, waits } = await runOnce(sc);
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(waits, [10000]);
  assert.equal(sc.s.count('review'), 2);
  assert.equal(sc.s.count('work'), 1);
  const completed = sc.f.state().completed.A as Work;
  assert.deepEqual(completed.budget!.work, { reviews: 1, checks: 0 });
  assert.equal(completed.sessionAttempt, undefined);
});

// 4.11 (B) (required, scenario "A restart continues the attempt count")
test('B: a restart after a failed planning attempt continues with attempt 2', async t => {
  const sc = scenario(t, { transport: { plan: n => n === 1 } });
  const first = await runOnce(sc, stoppingClock());
  assert.equal(first.result.status, 'incomplete', JSON.stringify(first.result));
  assert.deepEqual(first.waits, [10000]);
  const blocked = sc.f.state().blocked.A;
  assert.equal(blocked.work.stage, 'plan');
  assert.deepEqual(blocked.work.sessionAttempt, { purpose: 'plan', stage: 'plan', attempt: 1, failure: failureOf('plan', 1) });
  assert.equal(sc.s.count('plan'), 1);
  const second = await runOnce(sc);
  assert.equal(second.result.status, 'exhausted', JSON.stringify(second.result));
  assert.deepEqual(second.waits, [10000]);
  const retries = retryLines(second.lines);
  assert.equal(retries.length, 1, second.lines.join(''));
  assert.ok(retries[0].trimEnd().endsWith('planning: no report; retry in 10 s (attempt 2)'), retries[0]);
  assert.equal(sc.s.count('plan'), 2);
  assert.equal((sc.f.state().completed.A as Work).sessionAttempt, undefined);
});

/** Replaces the work of the blocked or current entry of A in the state of `sc` through RunStore. */
function setRecord(sc: Scenario, record: SessionAttempt) {
  const store = new RunStore(sc.config.stateDirectory, sc.f.state().identity);
  try {
    const entry = store.state.blocked?.A;
    if (entry) store.update({ blocked: { ...store.state.blocked, A: { ...entry, work: { ...entry.work, sessionAttempt: record } } } });
    else store.update({ current: { ...store.state.current!, sessionAttempt: record } });
  } finally { store.close(); }
}

// 4.12 (B) (required, scenario "A stale record of another session is ignored")
test('B: a stale record of another session is ignored and the planning session starts as attempt 1', async t => {
  const sc = scenario(t, { blocked: { plan: n => n === 1 } });
  const first = await runOnce(sc);
  assert.equal(first.result.status, 'incomplete', JSON.stringify(first.result));
  assert.equal(sc.f.state().blocked.A.work.stage, 'plan');
  setRecord(sc, { purpose: 'investigate', stage: 'investigate', attempt: 3, failure: 'f' });
  assert.equal(sc.f.state().blocked.A.work.sessionAttempt.attempt, 3);
  const second = await runOnce(sc);
  assert.equal(second.result.status, 'exhausted', JSON.stringify(second.result));
  assert.deepEqual(retryLines(second.lines), []);
  assert.deepEqual(second.waits, []);
  assert.equal(sc.s.count('plan'), 2);
  assert.equal((sc.f.state().completed.A as Work).sessionAttempt, undefined);
});

// 4.13 (B) (required, scenario "A documentation review continued after a restart uses one review round")
test('B: a documentation review continued after a restart uses one review round', async t => {
  const sc = scenario(t, { transport: { documentReview: n => n === 1 } });
  const first = await runOnce(sc, stoppingClock());
  assert.equal(first.result.status, 'incomplete', JSON.stringify(first.result));
  const blocked = sc.f.state().blocked.A.work as Work;
  assert.equal(blocked.stage, 'document-review');
  assert.deepEqual(blocked.sessionAttempt, { purpose: 'document-review', stage: 'document-review', attempt: 1,
    failure: failureOf('documentReview', 1) });
  assert.equal(blocked.budget!.document.reviews, 1);
  const documents = sc.s.count('document'); const reviews = sc.s.count('documentReview');
  const second = await runOnce(sc);
  assert.equal(second.result.status, 'exhausted', JSON.stringify(second.result));
  assert.equal(sc.s.count('document'), documents);
  assert.equal(sc.s.count('documentReview'), reviews + 1);
  const start = second.lines.findIndex(line => line.includes(' A documentation review: '));
  assert.ok(start >= 0, second.lines.join(''));
  assert.ok(!second.lines[start].includes('(attempt'), second.lines[start]);
  assert.ok(second.lines[start + 1].includes(' A session retry: '), second.lines.join(''));
  assert.ok(second.lines[start + 1].trimEnd().endsWith('documentation review: no report; retry in 10 s (attempt 2)'));
  assert.deepEqual(second.waits, [10000]);
  const completed = sc.f.state().completed.A as Work;
  assert.equal(completed.budget!.document.reviews, 1);
  assert.equal(completed.documentationReviews!.length, 1);
  assert.equal(completed.sessionAttempt, undefined);
});

// Integration tests: as in the existing target integration tests, origin/main advances inside the task scope right
// after the archive, so the task enters the integrate stage with a clean merge.

/** Commits `content` at `path` on origin/main through the integrator clone and returns the new target. */
function advance(f: RunnerFixture, path: string, content: string): string {
  const clone = f.integrator;
  git(clone, 'fetch', '-q', 'origin'); git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');
  mkdirSync(dirname(join(clone, path)), { recursive: true }); writeFileSync(join(clone, path), content);
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', `test(fixture): advance ${path}`);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return git(clone, 'rev-parse', 'HEAD');
}

/** A run whose target advances after the archive; `targets` receives the advanced target. */
const integrated = (sc: Scenario, targets: string[], clock = fakeClock(), extra: RunOptions = {}) =>
  runOnce(sc, clock, { ...extra, afterEffect: async kind => {
    if (kind === 'archive') targets.push(advance(sc.f, 'src/a/result.test.mjs', RESULT_TEST));
  } });

// 4.14 (A) (coverage-only): not needed: coverage reached

// 4.15 (A) (required, scenario "An exhausted integration session names the attempts")
test('A: an exhausted review of the merged result blocks with the attempts, not an integration code', async t => {
  const sc = scenario(t, { transport: { postReview: () => true } });
  const targets: string[] = [];
  const { result, waits } = await integrated(sc, targets);
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(sc.s.count('postReview'), 3);
  assert.deepEqual(waits, [10000, 30000]);
  const blocked = sc.f.state().blocked.A;
  assert.equal(blocked.reason, `Session review ended without a report after 3 attempts; last failure: ${failureOf('postReview', 3)}`);
  assert.notEqual(blocked.reason, 'target-integration-rejected');
  assert.equal(result.blockers!.A.reason, 'operation-incomplete');
  const work = blocked.work as Work;
  assert.equal(work.stage, 'integrate');
  assert.equal(work.integration!.step, 'review');
  assert.equal(work.integration!.target, targets[0]);
  assert.equal(work.sessionAttempt, undefined);
});

// 4.16 (A) (required, scenario "An exhausted send-back session names the attempts")
test('A: an exhausted send-back session blocks with the attempts and is not recorded as rejected', async t => {
  const sc = scenario(t, { reject: { postReview: n => n === 1 }, transport: { sendBack: () => true } });
  const { result, waits } = await integrated(sc, []);
  assert.equal(result.status, 'incomplete', JSON.stringify(result));
  assert.equal(sc.s.count('sendBack'), 3);
  assert.deepEqual(waits, [10000, 30000]);
  const blocked = sc.f.state().blocked.A;
  assert.equal(blocked.reason, `Session work ended without a report after 3 attempts; last failure: ${failureOf('sendBack', 3)}`);
  assert.equal(result.blockers!.A.reason, 'operation-incomplete');
  const sendBack = (blocked.work as Work).integration!.sendBack!;
  assert.equal(sendBack.session, 'started');
  assert.notEqual(sendBack.outcome, 'rejected');
  assert.equal(sendBack.rejection, undefined);
});

// 4.17 (A) (coverage-only): not needed: coverage reached

/**
 * The first run of 4.18: the review of the merged result rejects once, so a send-back starts; its first attempt
 * fails and the fake clock throws, leaving the record of that attempt in the blocked work.
 */
async function abandonedSendBack(t: TestContext) {
  const sc = scenario(t, { reject: { postReview: n => n === 1 }, transport: { sendBack: n => n === 1 } });
  const targets: string[] = [];
  const first = await integrated(sc, targets, stoppingClock());
  assert.equal(first.result.status, 'incomplete', JSON.stringify(first.result));
  const work = sc.f.state().blocked.A.work as Work;
  assert.equal(work.integration!.step, 'send-back');
  assert.equal(work.integration!.sendBack!.session, 'started');
  assert.deepEqual(work.sessionAttempt, { purpose: 'work', stage: 'integrate',
    integration: { target: targets[0], step: 'send-back' }, attempt: 1, failure: failureOf('sendBack', 1) });
  assert.equal(sc.s.count('sendBack'), 1);
  return { sc, target: targets[0] };
}

/** A later advance that conflicts with the task's src/a/result.mjs, so its integration needs a resolution session. */
const conflictingAdvance = (f: RunnerFixture) => advance(f, 'src/a/result.mjs', 'export function next(n) { return 1 + n; }\n');

/** The later integration started a conflict resolution session as attempt 1 and the task was accepted. */
function assertLaterIntegration(sc: Scenario, run: { result: { status: string }; lines: string[]; waits: number[] },
  later: string) {
  assert.equal(run.result.status, 'exhausted', JSON.stringify(run.result));
  assert.equal(sc.s.count('resolve'), 1);
  assert.deepEqual(retryLines(run.lines), []);
  assert.deepEqual(run.waits, []);
  const state = sc.f.state();
  assert.deepEqual(state.blocked ?? {}, {});
  const completed = state.completed.A as Work;
  assert.equal(completed.sessionAttempt, undefined);
  assert.equal(completed.integrations!.length, 2);
  assert.equal(completed.integrations![1].target, later);
  assert.equal(completed.integrations![1].outcome, 'conflict');
  assert.deepEqual(completed.integrations![1].conflicts, ['src/a/result.mjs']);
}

// 4.18 (A) (required, scenario "An abandoned send-back attempt is not inherited")
test('A: an abandoned send-back attempt is cleared before the commit and not inherited by a later session', async t => {
  const { sc } = await abandonedSendBack(t);
  let observed: Work | undefined; let sendBacksAtCommit: number | undefined; let later = '';
  const second = await runOnce(sc, fakeClock(), { steps: line => {
    if (observed || !line.includes(' A commit: ') || !line.includes('committing the send-back result')) return;
    observed = sc.f.state().current as Work;
    sendBacksAtCommit = sc.s.count('sendBack');
    // The target advances again into the guarded paths with a conflict.
    later = conflictingAdvance(sc.f);
  } });
  assert.ok(observed, second.lines.join(''));
  assert.equal(observed!.sessionAttempt, undefined);
  assert.equal(observed!.integration!.step, 'send-back');
  assert.equal(observed!.integration!.sendBack!.session, 'started');
  assert.equal(sendBacksAtCommit, 1);
  assert.equal(sc.s.count('sendBack'), 1);
  assert.ok(!sc.f.state().completed.A.sessionAttempt);
  assertLaterIntegration(sc, second, later);
  const blockedReason = second.lines.some(line => line.includes('Session work ended without a report'));
  assert.equal(blockedReason, false);
});

test('A: a stale record of an old integration is ignored by a later conflict resolution session', async t => {
  const { sc, target } = await abandonedSendBack(t);
  // The restarted run commits the send-back result and is cancelled before the review of the merged result.
  const controller = new AbortController();
  const second = await runOnce(sc, fakeClock(), { signal: controller.signal, steps: line => {
    if (line.includes(' A commit: ') && line.includes('committing the send-back result')) controller.abort();
  } });
  assert.equal(second.result.status, 'cancelled', JSON.stringify(second.result));
  assert.equal(sc.s.count('sendBack'), 1);
  const current = sc.f.state().current as Work;
  assert.equal(current.integration!.sendBack!.session, 'finished');
  assert.equal(current.sessionAttempt, undefined);
  setRecord(sc, { purpose: 'work', stage: 'integrate', integration: { target, step: 'send-back' }, attempt: 3, failure: 'f' });
  assert.equal(sc.f.state().current.sessionAttempt.attempt, 3);
  const later = conflictingAdvance(sc.f);
  const third = await runOnce(sc);
  assertLaterIntegration(sc, third, later);
});
