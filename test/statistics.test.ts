import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Statistics, ledgerPath, cleanOrigin, tokenUsage, appendStatistics, ledgerEffects, sumUsage } from '../src/statistics.ts';
import { selectHarness } from '../src/harness-selection.ts';
import { resolveHarness } from '../src/harness.ts';
import type { Sources } from '../src/statistics.ts';
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

test('D: append creates private storage, secures existing files and preserves bytes in one write', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-append-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: join(directory, 'nested/state') };
  const record = collector().statistics.finish('exhausted', 0); let writes = 0;
  const effects = { ...ledgerEffects, append: (fd: number, bytes: Buffer) => {
    writes++; assert.equal(bytes.toString(), JSON.stringify(record) + '\n'); return ledgerEffects.append(fd, bytes);
  } };
  appendStatistics(record, { env, effects });
  const path = ledgerPath(env); const first = readFileSync(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o666);
  appendStatistics(record, { env, effects });
  assert.equal(writes, 2); assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(path), Buffer.concat([first, first]));
});

test('D: settings carry effective precedence, every provenance class, Enter defaults and one observed probe', async () => {
  const statistics = collector().statistics; let probes = 0; let answers = ['high', ''];
  const result = await selectHarness({ ...config, root: '/unused', stateDirectory: '/unused',
    harness: 'claude', model: 'claude-sonnet-5-5' }, {
    interactive: true, ask: async () => answers.shift()!, say: () => {}, recorded: () => null,
    probe: harness => { probes++; return { harness, available: true, version: 'fixture-version' }; },
    sources: { harness: 'cli-flag', model: 'invocation-json' },
    onResolved: (selected, sources, version) => statistics.resolved(selected, sources, version),
  });
  statistics.resolved(await resolveHarness(result.config), statistics.sources, 'fixture-version');
  statistics.setting('leaves', ['expanded-A', 'expanded-B'], 'default');
  const settings = statistics.finish('exhausted', 0).settings;
  assert.equal(probes, 2);
  assert.deepEqual(settings.harness, { value: 'claude', source: 'cli-flag' });
  assert.deepEqual(settings.harnessCliVersion, { value: 'fixture-version', source: 'cli-flag' });
  assert.deepEqual(settings.model, { value: 'claude-sonnet-5-5', source: 'invocation-json' });
  assert.deepEqual(settings.effort, { value: 'high', source: 'interactive-answer' });
  assert.deepEqual(settings.coverage, { value: 85, source: 'default' });
  assert.deepEqual(settings.maxAccepted, { value: null, source: 'default' });
  assert.deepEqual(settings.leaves, { value: ['expanded-A', 'expanded-B'], source: 'default' });
  answers = ['', '', '', ''];
  let sources: Sources = {};
  await selectHarness({ root: '/unused', stateDirectory: '/unused' } as RunConfig, {
    interactive: true, ask: async () => answers.shift()!, say: () => {}, recorded: () => null,
    probe: harness => ({ harness, available: true, version: 'fixture' }),
    onResolved: (_config, chosen) => { sources = chosen; },
  });
  for (const key of ['harness', 'model', 'effort', 'coverage'] as const) assert.equal(sources[key], 'default');
});

test('D: complete, partial, absent and invalid usage; cumulative reports replace rather than add', () => {
  assert.equal(tokenUsage({ inputTokens: -1, outputTokens: 1.5, totalTokens: NaN }), null);
  assert.equal(sumUsage([]), null); assert.equal(sumUsage([null, null]), null);
  const statistics = collector().statistics; const task = { id: 'A', change: 'a' };
  statistics.decision(task);
  const first = statistics.session('A'); first(tokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }));
  first(tokenUsage({ inputTokens: 4, outputTokens: 5, totalTokens: 9 }));
  first(tokenUsage({ inputTokens: 4, outputTokens: 5, totalTokens: 9 }));
  const second = statistics.session('A'); second(tokenUsage({ inputTokens: 6, outputTokens: 7, totalTokens: 13 }));
  const result = statistics.finish('incomplete', 3);
  assert.deepEqual(result.tasks[0].tokenUsage, { inputTokens: 10, outputTokens: 12, totalTokens: 22 });
  assert.deepEqual(result.tokenUsage, result.tasks[0].tokenUsage);
  assert.deepEqual(sumUsage([tokenUsage({ inputTokens: 2 }), tokenUsage({ inputTokens: 3, outputTokens: 1 })]),
    { inputTokens: 5, outputTokens: null, totalTokens: null });
  assert.deepEqual(sumUsage([tokenUsage({ inputTokens: 2 }), null]),
    { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal(collector().statistics.finish('unavailable', 4).tokenUsage, null);
});

test('D: privacy allowlists exclude every private source and preserve only approved completion', () => {
  const statistics = collector().statistics;
  statistics.metadata(config, '/repository', 'https://user:SECRET_CREDENTIAL@example.org/repository');
  const work = { id: 'A', change: 'a', stage: 'merge', findings: ['SECRET_FINDING'],
    investigation: { summary: 'SECRET_INVESTIGATION' }, lastToolError: { input: 'SECRET_PROMPT' },
    sessions: [{ purpose: 'work', privateText: 'SECRET_OUTPUT', events: [{ type: 'private', body: 'SECRET_FILE' }] }],
    finalChecks: [{ command: 'npm', args: ['test'], outcome: 'failed', output: 'SECRET_CHECK' }],
    reviews: [{ findings: ['SECRET_REVIEW'], summary: 'SECRET_REPORT' }],
    planningReviews: [{ findings: [] }], completion: { summary: 'Approved completion.', grade: 'C', durationSeconds: 10 },
  } as unknown as Work;
  statistics.decision(work, 'blocked', work, 'SECRET_ERROR');
  statistics.decision({ ...work, id: 'B' }, 'accepted', { ...work, id: 'B' });
  const usage = statistics.session('A');
  usage(tokenUsage({ inputTokens: 5, ...{ arbitrary: 'SECRET_EVENT', environment: 'SECRET_ENV' } }));
  const result = statistics.finish('unavailable', 4, 'SECRET_FAILURE');
  const bytes = JSON.stringify(result);
  assert.ok(!bytes.includes('SECRET_')); assert.ok(bytes.includes('Approved completion.'));
  assert.deepEqual(result.tasks[0].finalChecks, [{ command: 'npm', args: ['test'], outcome: 'failed' }]);
  assert.deepEqual(result.tasks[0].implementationFindingsPerRound, [1]);
  assert.equal(result.tasks[0].completionSummary, null);
});

test('D: every persistence failure and short writes are safely reported without retries or exceptions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-effects-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: directory };
  for (const key of ['serialize', 'mkdir', 'open', 'secure', 'append', 'close', 'short'] as const) {
    for (const status of ['exhausted', 'incomplete', 'unavailable', 'cancelled'] as const) {
      const record = collector().statistics.finish(status, status === 'exhausted' ? 0 : status === 'unavailable' ? 4 : 3);
      const before = JSON.stringify(record); let warnings = ''; let writes = 0;
      const fail = () => { throw Object.assign(new Error('SECRET_EACCES'), { code: 'EACCES' }); };
      const effects = { ...ledgerEffects, append: (fd: number, bytes: Buffer) => {
        writes++; if (key === 'short') return bytes.length - 1;
        if (key === 'append') return fail(); return ledgerEffects.append(fd, bytes);
      } };
      if (key === 'close') effects.close = fd => { ledgerEffects.close(fd); fail(); };
      else if (key !== 'append' && key !== 'short') Object.assign(effects, { [key]: fail });
      assert.doesNotThrow(() => appendStatistics(record, { env, effects, stderr: text => { warnings += text; } }));
      assert.match(warnings, /statistics ledger/u); assert.ok(!warnings.includes('SECRET'));
      assert.equal(JSON.stringify(record), before); assert.ok(writes <= 1);
      if (key === 'short') assert.equal(writes, 1);
    }
  }
});

test('C: decisions deduplicate by ID, final acceptance wins, and legacy session history is counted once', () => {
  const statistics = collector().statistics; const work = { id: 'A', change: 'a', stage: 'merge',
    sessions: [{ purpose: 'work' }, { purpose: 'review' }], completion: { summary: 'Approved.', grade: 'E', durationSeconds: 5 },
    planningReviews: [{ findings: [] }, { findings: ['private'] }], reviews: [{ findings: ['one', 'two'] }, { findings: [] }],
  } as unknown as Work;
  statistics.decision(work, 'blocked', work);
  statistics.decision(work, 'claimed-elsewhere');
  statistics.decision(work, 'accepted', work);
  statistics.decision(work, 'blocked', work);
  const record = statistics.finish('exhausted', 0);
  assert.equal(record.tasks.length, 1); assert.equal(record.tasks[0].outcome, 'accepted');
  assert.deepEqual(record.tasks[0].workerSessions, { investigate: 0, plan: 0, work: 1, review: 1 });
  assert.deepEqual(record.tasks[0].planningFindingsPerRound, [0, 1]);
  assert.deepEqual(record.tasks[0].implementationFindingsPerRound, [2, 0]);
});
