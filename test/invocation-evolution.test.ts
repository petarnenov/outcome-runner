import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { Queue, RunConfig, Work } from '../src/model.ts';
import { compareIdentity, invocationIdentity, missingSetting, MissingSettingError, REQUIRED_SETTINGS }
  from '../src/invocation-identity.ts';
import type { InvocationIdentity } from '../src/invocation-identity.ts';
import { RunStore } from '../src/run-store.ts';
import type { RunOptions } from '../src/runner.ts';
import { main } from '../src/cli.ts';
import { Statistics, ledgerPath } from '../src/statistics.ts';
import type { RunStatistics } from '../src/statistics.ts';
import { hasBranch, runnerFixture } from './support/runner-fixture.ts';
import type { RunnerFixture } from './support/runner-fixture.ts';

const TASKS = { A: 'hash-a', B: 'hash-b' };
const AT = Date.parse('2026-11-12T10:00:00Z');

/** A resolved configuration with its root and leaves, as the runner projects it. */
const resolved = (patch: Record<string, unknown> = {}, project: Record<string, unknown> = {}):
  RunConfig & { leaves: string[] } => ({
  root: '/repository', stateDirectory: '/state/one', invocation: 'one', harness: 'claude', model: 'claude-opus-5-5',
  effort: 'medium', coverage: 85, leaves: ['A', 'B'],
  authority: { reference: 'owner', instruction: 'OFF implement', target: 'main', tasks: { ...TASKS } },
  project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target: 'main',
    checks: [{ command: 'npm', args: ['test', '--coverage={coverage}'] }], planningCheck: { command: 'node', args: ['-e', ''] },
    ...project },
  ...patch,
} as RunConfig & { leaves: string[] });

const identityHash = (config: RunConfig & { leaves: string[] }) => hash(invocationIdentity(config));

function temporary(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'invocation-evolution-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// 5.1 (E) (required)
test('E: invocationIdentity keeps only what the owner authorised', () => {
  const base = resolved();
  const identity = invocationIdentity(base);
  assert.deepEqual(Object.keys(identity).sort(), ['authority', 'coverage', 'effort', 'harness', 'invocation', 'leaves',
    'model', 'project', 'root', 'schema']);
  assert.deepEqual(Object.keys(identity.project).sort(), ['changes', 'checks', 'planningCheck', 'queue', 'receipts',
    'setup', 'target']);
  assert.deepEqual(Object.keys(identity.authority).sort(), ['instruction', 'reference', 'target', 'tasks']);
  assert.equal(identity.schema, 2);
  assert.equal(identity.harness, 'claude'); assert.equal(identity.model, 'claude-opus-5-5');
  assert.equal(identity.effort, 'medium'); assert.equal(identity.coverage, 85);
  const same = [
    resolved({}, { archive: { command: 'openspec', args: ['archive', '{change}', '--yes'] } }),
    resolved({ maxAccepted: 2 }),
    resolved({}, { commitScope: 'other' }),
    resolved({}, { commitSuffix: ' [skip]' }),
    resolved({}, { repository: 'owner/repository' }),
    resolved({ newerRunnerSetting: { enabled: true } }),
    resolved({}, { newerProjectSetting: 'value' }),
    resolved({ mode: 'OFF', stateDirectory: '/elsewhere' }),
    resolved({}, { setup: [] }),
  ];
  for (const config of same) assert.equal(identityHash(config), hash(identity), JSON.stringify(config));
  const different = [
    resolved({ authority: { ...base.authority, tasks: { ...TASKS, A: 'changed' } } }),
    resolved({ harness: 'codex' }),
    resolved({ model: 'claude-sonnet-5-5' }),
    resolved({ effort: 'high' }),
    resolved({ coverage: 90 }),
    resolved({}, { checks: [{ command: 'npm', args: ['run', 'check', '{coverage}'] }] }),
    resolved({}, { planningCheck: { command: 'openspec', args: ['validate'] } }),
    resolved({}, { setup: [{ command: 'npm', args: ['ci'] }] }),
  ];
  for (const config of different) assert.notEqual(identityHash(config), hash(identity), JSON.stringify(config));
});

// 5.2 (E) (required)
test('E: compareIdentity accepts only added tasks besides equal identities', () => {
  const stored = invocationIdentity(resolved());
  const withTasks = (tasks: Record<string, string>, leaves: string[], patch: Record<string, unknown> = {}) =>
    invocationIdentity(resolved({ authority: { ...stored.authority, tasks }, leaves, ...patch }));
  assert.deepEqual(compareIdentity(stored, invocationIdentity(resolved())), { kind: 'same' });
  assert.deepEqual(compareIdentity(stored, withTasks({ ...TASKS, D: 'hash-d', C: 'hash-c' }, ['A', 'B', 'D', 'C'])),
    { kind: 'tasks-added', tasks: ['C', 'D'] });
  assert.deepEqual(compareIdentity(stored, withTasks({ ...TASKS, C: 'hash-c' }, ['A', 'B'])),
    { kind: 'tasks-added', tasks: ['C'] });
  const incompatible: InvocationIdentity[] = [
    withTasks({ A: 'hash-a' }, ['A']),
    withTasks({ A: 'hash-a', B: 'changed' }, ['A', 'B']),
    withTasks({ ...TASKS }, ['A']),
    withTasks({ ...TASKS }, ['B', 'A']),
    invocationIdentity(resolved({ model: 'claude-sonnet-5-5' })),
    withTasks({ ...TASKS, C: 'hash-c' }, ['A', 'B', 'C'], { model: 'claude-sonnet-5-5' }),
  ];
  for (const next of incompatible) assert.deepEqual(compareIdentity(stored, next), { kind: 'incompatible' });
});

// 5.3 (E) (required)
test('E: missingSetting finds the first missing path and MissingSettingError names it with an example', () => {
  assert.deepEqual(REQUIRED_SETTINGS, []);
  const required = [{ path: 'project.example', example: 'value' }, { path: 'retries', example: 3 }];
  assert.deepEqual(missingSetting({ project: {} }, required), required[0]);
  assert.deepEqual(missingSetting({ project: { example: 'x' } }, required), required[1]);
  assert.deepEqual(missingSetting({ project: 'not an object' }, required), required[0]);
  assert.deepEqual(missingSetting(undefined, required), required[0]);
  assert.equal(missingSetting({ project: { example: false }, retries: 0 }, required), undefined);
  assert.equal(missingSetting({ project: { example: null }, retries: '' }, required), undefined);
  assert.equal(missingSetting({}, []), undefined);
  const error = new MissingSettingError(required[0]);
  assert.ok(error instanceof Error);
  assert.equal(error.reason, 'missing-setting');
  assert.equal(error.setting, 'project.example');
  assert.equal(error.example, 'value');
  assert.match(error.message, /project\.example/u);
  assert.ok(error.message.includes(JSON.stringify({ project: { example: 'value' } })), error.message);
});

// 5.4 (E) (coverage-only): not needed, coverage reached.

// 5.5 (D) (required)
test('D: the CLI refuses a missing setting with exit code 4, the setting and an example', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const { root: _root, stateDirectory: _state, ...invocation } = f.config();
  const path = join(f.base, 'invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const env = { XDG_STATE_HOME: join(f.base, 'xdg') };
  const lines: string[] = [];
  const code = await main(path, async () => { throw new MissingSettingError({ path: 'project.example', example: 'value' }); },
    line => lines.push(line), { cwd: f.root, env, mascot: () => {} });
  assert.equal(code, 4);
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  t.after(() => rmSync(join(line.diagnostics, '..'), { recursive: true, force: true }));
  assert.deepEqual(Object.keys(line), ['status', 'reason', 'setting', 'example', 'diagnostics']);
  assert.equal(line.status, 'unavailable'); assert.equal(line.reason, 'missing-setting');
  assert.equal(line.setting, 'project.example'); assert.equal(line.example, 'value');
  assert.match(JSON.parse(readFileSync(line.diagnostics, 'utf8')).message, /project\.example/u);
  const record = JSON.parse(readFileSync(ledgerPath(env), 'utf8').trim()) as RunStatistics;
  assert.equal(record.failureReason, 'missing-setting'); assert.equal(record.exitCode, 4);
});

/** Writes state as the previous runner did: the whole configuration with root and leaves is the identity. */
function legacyState(directory: string, config: RunConfig & { leaves: string[] }) {
  const legacyHash = hash(config);
  const action = { leaf: 'A', action: 'write' }; const fingerprint = 'fingerprint';
  const id = `run-${hash({ identity: legacyHash, action, fingerprint })}`;
  const current = { id: 'A', stage: 'work', branch: 'outcome/A-1', path: '/outcomes/a' };
  const state = { version: 2, identityHash: legacyHash, identity: config, frozen: [...config.leaves],
    operations: { [id]: { id, action, fingerprint, status: 'resolved', result: { status: 'accepted', acceptanceId: 'r' } } },
    accepted: { r: id }, status: 'running', cancelled: false, sequence: 7, claimant: 'claimant-1', current,
    completed: { B: { id: 'B', stage: 'merge' } }, baselineDone: [] };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  return { legacyHash, action, fingerprint, id, state };
}

// 5.6 (D) (required)
test('D: legacy state is migrated in place, keeping its work and operation ids, and tampered state is refused', t => {
  const directory = join(temporary(t), 'state');
  const config = resolved({ newerRunnerDefault: 'kept out' }, { archive: { command: 'openspec', args: ['archive'] } });
  const legacy = legacyState(directory, config);
  const next = invocationIdentity(config);
  const store = new RunStore(directory, next, { now: () => AT });
  try {
    const { state } = store;
    assert.equal(state.identitySchema, 2);
    assert.deepEqual(state.identity, next); assert.equal(state.identityHash, hash(next));
    assert.deepEqual(state.frozen, ['A', 'B']);
    assert.equal(state.operationKey, legacy.legacyHash);
    assert.deepEqual(state.changes, [{ kind: 'identity-upgraded', from: 1, to: 2, at: new Date(AT).toISOString() }]);
    assert.deepEqual(state.operations, legacy.state.operations); assert.deepEqual(state.accepted, legacy.state.accepted);
    assert.deepEqual(state.current, legacy.state.current); assert.equal(state.claimant, 'claimant-1');
    assert.deepEqual(state.completed, legacy.state.completed);
    assert.equal(store.intend(legacy.action, legacy.fingerprint).id, legacy.id);
    assert.equal(Object.keys(store.state.operations).length, 1);
  } finally { store.close(); }
  // Reopening the migrated state with the same identity records nothing new.
  const again = new RunStore(directory, next, { now: () => AT + 1000 });
  try { assert.equal(again.state.changes!.length, 1); assert.equal(again.state.operationKey, legacy.legacyHash); }
  finally { again.close(); }

  const tampered = join(temporary(t), 'state');
  const { state } = legacyState(tampered, config);
  writeFileSync(join(tampered, 'state.json'), JSON.stringify({ ...state, identity: { ...config, model: 'claude-sonnet-5-5' } }));
  const before = readFileSync(join(tampered, 'state.json'), 'utf8');
  assert.throws(() => new RunStore(tampered, next), /Run state is incompatible/u);
  assert.equal(readFileSync(join(tampered, 'state.json'), 'utf8'), before);
  const changed = join(temporary(t), 'state');
  legacyState(changed, config);
  const unchanged = readFileSync(join(changed, 'state.json'), 'utf8');
  assert.throws(() => new RunStore(changed, invocationIdentity({ ...config, model: 'claude-sonnet-5-5' })),
    /Run state is incompatible/u);
  assert.equal(readFileSync(join(changed, 'state.json'), 'utf8'), unchanged);
});

// 5.7 (D) (required)
test('D: added tasks update the stored identity; removed or changed tasks are refused without a write', t => {
  const directory = join(temporary(t), 'state');
  const first = invocationIdentity(resolved());
  const created = new RunStore(directory, first, { now: () => AT });
  const operation = created.intend({ leaf: 'A' }, 'one').id;
  created.close();
  const added = invocationIdentity(resolved({ leaves: ['A', 'B', 'C'],
    authority: { ...resolved().authority, tasks: { ...TASKS, C: 'hash-c' } } }));
  const store = new RunStore(directory, added, { now: () => AT });
  try {
    assert.deepEqual(store.state.changes, [{ kind: 'tasks-added', tasks: ['C'], at: new Date(AT).toISOString() }]);
    assert.deepEqual(store.state.identity, added); assert.equal(store.state.identityHash, hash(added));
    assert.deepEqual(store.state.frozen, ['A', 'B', 'C']);
    assert.equal(store.state.operationKey, hash(first));
    assert.equal(store.intend({ leaf: 'A' }, 'one').id, operation);
  } finally { store.close(); }
  const file = join(directory, 'state.json'); const before = readFileSync(file, 'utf8');
  const removed = invocationIdentity(resolved({ leaves: ['A', 'C'],
    authority: { ...resolved().authority, tasks: { A: 'hash-a', C: 'hash-c' } } }));
  const changed = invocationIdentity(resolved({ leaves: ['A', 'B', 'C'],
    authority: { ...resolved().authority, tasks: { ...TASKS, B: 'changed', C: 'hash-c' } } }));
  for (const identity of [removed, changed]) {
    assert.throws(() => new RunStore(directory, identity), /Run state is incompatible/u);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

// 5.8 (D) (coverage-only): not needed, coverage reached.

// Runner tests: the Git fixture of runnerFixture (a bare origin, the project queue, scripted adapters and the scripted
// pull request host). An invocation is interrupted from afterEffect('implementation') and run again.

/** The number of commits on the claims ledger branch of origin. */
const claimCommits = (f: RunnerFixture) => git(f.remote, 'rev-list', '--count', 'work-queue-claims-main');
const claimOf = (f: RunnerFixture, id: string) => JSON.parse(git(f.remote, 'show', `work-queue-claims-main:${id}.json`));
const sessionsOf = (work: Work, purpose: string) => (work.sessions ?? []).filter(item => item.purpose === purpose).length;
const statePath = (config: RunConfig) => join(config.stateDirectory, 'state.json');

/** Runs `config` until its implementation session returned, then cancels; returns the recorded state. */
async function interrupted(f: RunnerFixture, config: RunConfig, extra: RunOptions = {}) {
  const controller = new AbortController();
  const result = await f.run(config, { signal: controller.signal, ...extra,
    afterEffect: async kind => { if (kind === 'implementation') controller.abort(); } });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  const state = JSON.parse(readFileSync(statePath(config), 'utf8'));
  assert.equal(state.current.stage, 'work');
  return state;
}

/** Rewrites state.json the way the previous runner wrote it: the whole resolved configuration is the identity. */
function toLegacy(config: RunConfig): void {
  const { identitySchema: _schema, operationKey: _key, settings: _settings, changes: _changes, ...state } =
    JSON.parse(readFileSync(statePath(config), 'utf8'));
  const { harness, model, effort, coverage, root, leaves } = state.identity;
  const identity = { ...config, harness, model, effort, coverage, root, leaves };
  writeFileSync(statePath(config), JSON.stringify({ ...state, identity, identityHash: hash(identity) }));
}

const receiptOf = (f: RunnerFixture, index = 0) => {
  git(f.root, 'fetch', '-q', 'origin');
  const task = f.queue.tasks[index];
  return receiptAt(f.root, 'origin/main', `evidence/results/${task.id}.json`, hash(task), null)!;
};

/** Commits `queue` as the project queue on origin/main through the integrator clone. */
function publishQueue(f: RunnerFixture, queue: Queue, message: string): void {
  const clone = f.integrator;
  git(clone, 'fetch', '-q', 'origin'); git(clone, 'checkout', '-q', '-B', 'main', 'origin/main');
  writeFileSync(join(clone, f.project.queue), JSON.stringify(queue));
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', message);
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
}

// 5.9 (C) (required)
test('C: a newer runner resumes legacy state with unchanged settings without a second claim', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config();
  const before = await interrupted(f, config);
  assert.equal(claimCommits(f), '1');
  toLegacy(config);
  // A newer runner resolves an unknown setting and the default archive command explicitly.
  const newer = { ...config, newerRunnerSetting: { enabled: true },
    project: { ...config.project, archive: { command: 'openspec', args: ['archive', '{change}', '--yes'] } } } as RunConfig;
  const result = await f.run(newer);
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A']);
  const state = JSON.parse(readFileSync(statePath(config), 'utf8'));
  const completed = state.completed.A as Work;
  assert.equal(claimCommits(f), '1');
  assert.equal(completed.branch, before.current.branch); assert.equal(completed.path, before.current.path);
  assert.equal(completed.operation, before.current.operation);
  assert.equal(sessionsOf(completed, 'investigate'), 1);
  assert.equal(sessionsOf(completed, 'plan'), sessionsOf(before.current, 'plan'));
  assert.equal(state.identitySchema, 2);
  assert.deepEqual(state.changes.map((change: { kind: string }) => change.kind), ['identity-upgraded']);
  assert.deepEqual(receiptOf(f).invocationChanges, state.changes);
});

// 5.10 (C) (required): a regression guard for the existing selectHarness -> recordedSelection path.
test('C: the frozen model is reused when the invocation no longer names it and the default differs', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const flagged = f.config('one', { model: 'claude-sonnet-5-5' });
  const before = await interrupted(f, flagged);
  assert.equal(before.identity.model, 'claude-sonnet-5-5');
  const { model: _model, ...unset } = flagged;
  const statistics = new Statistics();
  // The selection default is claude-opus-5-5; the recorded selection comes from state.json.
  const result = await f.run(unset as RunConfig, { statistics });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(statistics.finish('exhausted', 0).settings.model.value, 'claude-sonnet-5-5');
  const state = JSON.parse(readFileSync(statePath(flagged), 'utf8'));
  assert.equal(state.identityHash, before.identityHash); assert.deepEqual(state.identity, before.identity);
  assert.equal(state.changes, undefined);
});

// 5.11 (B) (required)
test('B: a missing required setting is refused before any effect and then accepted without losing state', async t => {
  const f = runnerFixture(t, { ids: ['A'] });
  const config = f.config();
  const before = await interrupted(f, config);
  const bytes = readFileSync(statePath(config), 'utf8');
  const requiredSettings = [{ path: 'project.example', example: 'value' }];
  let probed = 0;
  await assert.rejects(f.run(config, { requiredSettings,
    openspec: { probe: () => { probed += 1; return { status: 0 }; }, configPresent: () => true } }),
  (error: MissingSettingError) => {
    assert.ok(error instanceof MissingSettingError);
    assert.equal(error.reason, 'missing-setting'); assert.equal(error.setting, 'project.example');
    assert.equal(error.example, 'value'); assert.match(error.message, /project\.example.*"value"/u);
    return true;
  });
  assert.equal(probed, 0);
  assert.equal(readFileSync(statePath(config), 'utf8'), bytes);
  assert.ok(existsSync(before.current.path)); assert.ok(hasBranch(f.root, before.current.branch));
  assert.equal(claimOf(f, 'A').branch, before.current.branch); assert.equal(claimCommits(f), '1');
  const lines: string[] = [];
  const withSetting = { ...config, project: { ...config.project, example: 'chosen' } } as RunConfig;
  const result = await f.run(withSetting, { requiredSettings, steps: line => lines.push(line) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.match(lines.find(line => line.includes(' A '))!, /A implementation: resuming/u);
  assert.equal(claimCommits(f), '1');
  const state = JSON.parse(readFileSync(statePath(config), 'utf8'));
  assert.equal(sessionsOf(state.completed.A, 'investigate'), 1);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].kind, 'setting-added'); assert.equal(state.changes[0].setting, 'project.example');
  assert.deepEqual(state.settings, { 'project.example': hash('chosen') });
  assert.equal(state.identityHash, before.identityHash);
  assert.deepEqual(receiptOf(f).invocationChanges, state.changes);
});

// 5.12 (B) (required)
test('B: a changed task hash or a removed task of an unfinished invocation is still refused', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  const config = f.config();
  const before = await interrupted(f, config);
  assert.equal(before.current.id, 'A');
  const bytes = readFileSync(statePath(config), 'utf8');
  const unchanged = () => {
    assert.equal(readFileSync(statePath(config), 'utf8'), bytes);
    assert.ok(existsSync(before.current.path)); assert.ok(hasBranch(f.root, before.current.branch));
    assert.equal(claimOf(f, 'A').branch, before.current.branch); assert.equal(claimCommits(f), '1');
  };
  const tasks = config.authority.tasks;
  // (a) A's hash in authority.tasks changes while the queue stays.
  await assert.rejects(f.run({ ...config, authority: { ...config.authority, tasks: { ...tasks, A: '0'.repeat(64) } } }),
    /Task source differs from frozen authority/u);
  unchanged();
  // (c) B, frozen in authority.tasks, is removed.
  await assert.rejects(f.run({ ...config, authority: { ...config.authority, tasks: { A: tasks.A } } }),
    /Run state is incompatible/u);
  unchanged();
  // (b) The queue and authority.tasks change together to a new definition of A.
  const queue = structuredClone(f.queue); queue.tasks[0].title = 'Counter A, revised';
  publishQueue(f, queue, 'test(fixture): revise A');
  await assert.rejects(f.run({ ...config, authority: { ...config.authority, tasks: { ...tasks, A: hash(queue.tasks[0]) } } }),
    /Run state is incompatible/u);
  unchanged();
});

// 5.13 (A) (required)
test('A: an added task is worked after the resumed task, keeping the earlier work and operation ids', async t => {
  const f = runnerFixture(t, { ids: ['A', 'B'] });
  // The invocation starts with A (priority 2) only; B (priority 1, scope src/b) is added later.
  const taskA = { ...f.queue.tasks[0], priority: 2 }; const taskB = f.queue.tasks[1];
  assert.equal(taskB.priority, 1);
  publishQueue(f, { version: 1, tasks: [taskA] }, 'test(fixture): queue only A');
  const initial = f.config();
  const config = { ...initial, authority: { ...initial.authority, tasks: { A: hash(taskA) } } };
  const before = await interrupted(f, config);
  assert.equal(claimCommits(f), '1');
  const operations = Object.keys(before.operations);
  assert.ok(operations.length);
  publishQueue(f, { version: 1, tasks: [taskA, taskB] }, 'test(fixture): add B');
  const added = { ...config, authority: { ...config.authority, tasks: { A: hash(taskA), B: hash(taskB) } } };
  const lines: string[] = [];
  const result = await f.run(added, { steps: line => lines.push(line) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['A', 'B']);
  assert.match(lines.find(line => line.includes(' A '))!, /A implementation: resuming/u);
  const acceptedA = lines.findIndex(line => line.includes(' A acceptance: '));
  const claimB = lines.findIndex(line => line.includes(' B claim: '));
  assert.ok(acceptedA >= 0 && claimB > acceptedA, lines.join(''));
  assert.ok(!lines.some(line => line.includes(' A claim: ')));
  assert.equal(claimCommits(f), '2');
  const state = JSON.parse(readFileSync(statePath(config), 'utf8'));
  assert.equal(state.completed.A.operation, before.current.operation);
  assert.equal(state.completed.A.branch, before.current.branch);
  assert.equal(sessionsOf(state.completed.A, 'investigate'), 1);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].kind, 'tasks-added'); assert.deepEqual(state.changes[0].tasks, ['B']);
  assert.deepEqual(state.frozen, ['A', 'B']);
  assert.equal(state.operationKey, before.operationKey);
  for (const id of operations) assert.deepEqual(Object.keys(state.operations[id] ?? {}).length > 0, true, id);
  assert.deepEqual(receiptOf(f, 1).invocationChanges, state.changes);
});

// 5.14 (A) (coverage-only): not needed, coverage reached.
