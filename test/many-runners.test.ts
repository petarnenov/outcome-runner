import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { digest, hash, validBranchName, validateConfig } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { invocationLockFiles } from '../src/runner.ts';

const configFor = (target: string): RunConfig => ({ root: '/repository', stateDirectory: '/state/one', invocation: 'one',
  authority: { reference: 'owner', instruction: 'OFF', target, tasks: {} },
  project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target,
    checks: [{ command: 'node', args: ['--test-coverage-lines={coverage}'] }], planningCheck: { command: 'openspec', args: ['validate'] } } });

// Grade E

test('E (required): the resolved target is part of the frozen invocation identity', () => {
  assert.notEqual(hash(configFor('main')), hash(configFor('feature/x')));
  assert.equal(hash(configFor('main')), hash(configFor('main')));
});

test('E (required): every valid Git branch name is a target and invalid names are refused', () => {
  for (const name of ['main', 'release/1.2', 'fix/v2.0', 'feature/x']) {
    assert.equal(validBranchName(name), true, name);
    assert.equal(validateConfig(configFor(name)).project.target, name);
  }
  for (const name of ['-x', 'a..b', 'a/', 'a.lock', '.a', 'a b', 'a@{b', '@']) {
    assert.equal(validBranchName(name), false, name);
    assert.throws(() => validateConfig(configFor(name)), /Invalid OFF configuration or authority/u, name);
  }
  for (const name of ['', '/a', 'a//b', 'a.', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a/.b', 'a\u0007', undefined, 3]) {
    assert.equal(validBranchName(name), false, String(name));
  }
});

test('E (coverage-only): lock and ownership files are per invocation of one clone', () => {
  const one = invocationLockFiles('/clone', '/state/one');
  assert.deepEqual(invocationLockFiles('/clone', '/state/one'), one);
  const other = invocationLockFiles('/clone', '/state/other');
  assert.notEqual(other.lock, one.lock); assert.notEqual(other.ownership, one.ownership);
  assert.equal(one.lock, join('/', '.work-queue-locks', `${hash('/clone')}-${hash('/state/one')}.sqlite`));
  assert.equal(one.ownership, join('/', '.work-queue-locks', `${hash('/clone')}-${hash('/state/one')}-owner.json`));
});

function receiptRepository(t: TestContext, target: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'many-runners-receipt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const spec = 'openspec/changes/a/specs/a/spec.md';
  mkdirSync(join(root, 'openspec/changes/a/specs/a'), { recursive: true }); writeFileSync(join(root, spec), '# A\n');
  const receipt = { version: 1, id: 'A', taskHash: 'task', authority: 'owner', ...(target === undefined ? {} : { target }),
    specification: { [spec]: digest('# A\n') }, review: { reviewer: 'claude:review', outcome: 'accepted', accepted: true },
    checks: [{ command: 'node', args: [], outcome: 'passed' }], manifest: [{ path: spec, hash: digest('# A\n') }],
    head: 'head', base: 'base' };
  mkdirSync(join(root, 'evidence/results'), { recursive: true });
  writeFileSync(join(root, 'evidence/results/A.json'), JSON.stringify(receipt));
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'test: receipt');
  return root;
}

test('E (coverage-only): receipts without a target stay valid and an empty target is refused', t => {
  assert.equal(receiptAt(receiptRepository(t, undefined), 'HEAD', 'evidence/results/A.json', 'task', null)!.target, undefined);
  assert.equal(receiptAt(receiptRepository(t, 'feature/x'), 'HEAD', 'evidence/results/A.json', 'task', null)!.target, 'feature/x');
  for (const target of ['', 7]) {
    assert.throws(() => receiptAt(receiptRepository(t, target), 'HEAD', 'evidence/results/A.json', 'task', null),
      /Invalid accepted outcome receipt/u);
  }
});
