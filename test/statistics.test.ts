import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Statistics, ledgerPath, cleanOrigin, tokenUsage } from '../src/statistics.ts';
import type { RunConfig, Work } from '../src/model.ts';

function collector() {
  let utc = '2026-01-01T00:00:00.000Z'; let elapsed = 1000;
  const statistics = new Statistics({ utc: () => utc, elapsed: () => elapsed,
    uuid: () => 'test-run-id', version: () => '1.2.3', host: () => 'fixture-host' });
  return { statistics, end: () => { utc = '2026-01-01T00:00:02.000Z'; elapsed = 3000; } };
}
const config = { invocation: 'nightly', project: { target: 'main' },
  authority: { reference: 'owner-reference', instruction: 'SECRET_AUTHORITY' } } as RunConfig;

test('E: XDG paths and all fallback cases use the isolated home', t => {
  const home = mkdtempSync(join(tmpdir(), 'ledger-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(ledgerPath({ XDG_STATE_HOME: join(home, 'state') }, home), join(home, 'state/outcome-runner/runs.jsonl'));
  for (const value of [undefined, '', 'relative']) {
    assert.equal(ledgerPath({ XDG_STATE_HOME: value }, home), join(home, '.local/state/outcome-runner/runs.jsonl'));
  }
});

test('E: unresolved schema is complete, nullable and contains no undiscovered tasks', () => {
  const { statistics } = collector(); const record = statistics.finish('unavailable', 4, 'SECRET_ERROR');
  assert.deepEqual(Object.keys(record).sort(), ['schemaVersion', 'runId', 'runnerVersion', 'hostname',
    'repositoryTopLevel', 'originUrl', 'targetBranch', 'invocation', 'authorityReference', 'startedAt', 'endedAt',
    'durationSeconds', 'exitCode', 'status', 'failureReason', 'settings', 'tasks', 'tokenUsage'].sort());
  assert.equal(record.schemaVersion, 1); assert.equal(record.failureReason, 'startup-or-run-failed');
  for (const key of ['repositoryTopLevel', 'originUrl', 'targetBranch', 'invocation', 'authorityReference', 'tokenUsage'] as const) {
    assert.equal(record[key], null);
  }
  assert.deepEqual(Object.keys(record.settings).sort(),
    ['harness', 'harnessCliVersion', 'model', 'effort', 'coverage', 'maxAccepted', 'leaves'].sort());
  for (const pair of Object.values(record.settings)) assert.deepEqual(pair, { value: null, source: null });
  assert.deepEqual(record.tasks, []);
});

test('E: UTC boundaries, monotonic duration and explicit identity metadata', () => {
  const { statistics, end } = collector();
  statistics.metadata(config, '/canonical/repository', 'https://username:password@example.org/org/repo.git?secret=yes#private');
  end(); const record = statistics.finish('exhausted', 0);
  assert.equal(record.runId, 'test-run-id'); assert.equal(record.runnerVersion, '1.2.3');
  assert.equal(record.hostname, 'fixture-host'); assert.equal(record.repositoryTopLevel, '/canonical/repository');
  assert.equal(record.originUrl, 'https://example.org/org/repo.git');
  assert.equal(record.invocation, 'nightly'); assert.equal(record.authorityReference, 'owner-reference');
  assert.equal(record.targetBranch, 'main'); assert.equal(record.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(record.endedAt, '2026-01-01T00:00:02.000Z'); assert.equal(record.durationSeconds, 2);
  assert.equal(record.failureReason, null);
  assert.equal(cleanOrigin('git@example.org:org/repo.git'), 'example.org:org/repo.git');
  assert.equal(cleanOrigin('invalid@secret'), null);
  assert.equal(cleanOrigin('/local/origin.git'), '/local/origin.git');
});

test('E: task schema and completion nulls for every terminal decision', () => {
  for (const outcome of ['accepted', 'blocked', 'claimed-elsewhere', 'not-started'] as const) {
    const { statistics } = collector();
    const work = { id: 'A', change: 'a', stage: 'work', completion: { summary: 'Approved summary.',
      grade: 'B', durationSeconds: 12 }, finalChecks: [], pr: { number: 7, url: 'https://example.org/pull/7' } } as unknown as Work;
    statistics.decision(work, outcome, work);
    const row = statistics.finish('incomplete', 3).tasks[0];
    assert.deepEqual(Object.keys(row).sort(), ['id', 'change', 'outcome', 'lastStage', 'blockingReason',
      'durationSeconds', 'complexityGrade', 'completionSummary', 'workerSessions', 'planningReviewRounds',
      'implementationReviewRounds', 'planningFindingsPerRound', 'implementationFindingsPerRound', 'finalChecks', 'pr', 'tokenUsage'].sort());
    assert.equal(row.id, 'A'); assert.equal(row.change, 'a'); assert.equal(row.outcome, outcome);
    assert.equal(row.lastStage, 'work'); assert.equal(row.blockingReason, outcome === 'blocked' ? 'operation-incomplete' : null);
    assert.equal(row.durationSeconds, outcome === 'accepted' ? 12 : null);
    assert.equal(row.complexityGrade, outcome === 'accepted' ? 'B' : null);
    assert.equal(row.completionSummary, outcome === 'accepted' ? 'Approved summary.' : null);
    assert.deepEqual(row.workerSessions, { investigate: 0, plan: 0, work: 0, review: 0 });
    assert.equal(row.planningReviewRounds, 0); assert.equal(row.implementationReviewRounds, 0);
    assert.deepEqual(row.planningFindingsPerRound, []); assert.deepEqual(row.implementationFindingsPerRound, []);
    assert.deepEqual(row.pr, { number: 7, url: 'https://example.org/pull/7' }); assert.equal(row.tokenUsage, null);
  }
  assert.deepEqual(tokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
});
