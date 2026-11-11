import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { compareIdentity, invocationIdentity, missingSetting, MissingSettingError, REQUIRED_SETTINGS }
  from '../src/invocation-identity.ts';
import type { InvocationIdentity } from '../src/invocation-identity.ts';

const TASKS = { A: 'hash-a', B: 'hash-b' };

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
