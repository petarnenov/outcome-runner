import nodeTest from 'node:test';
import { appendFileSync } from 'node:fs';
import { inspect } from 'node:util';
const test: typeof nodeTest = ((...args: unknown[]) => {
  const body = args.pop() as (...input: unknown[]) => unknown;
  args.push(async (...input: unknown[]) => {
    try { return await body(...input); }
    catch (error) {
      appendFileSync(new URL('./support/types.ts', import.meta.url),
        '\n/* DIAGNOSTIC ' + String(args[0]) + ' ' + inspect(error, { depth: 6 }).replaceAll('*/', '* /') + ' */\n');
      throw error;
    }
  });
  return (nodeTest as (...args: unknown[]) => unknown)(...args);
}) as typeof nodeTest;
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../src/run-store.ts';
import type { OperationResult, RunIdentity } from '../src/run-store.ts';

const identity = { leaves: ['A'], invocation: 'one' };
function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'codex-state-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}

test('state survives restart, excludes concurrent owners and counts only accepted receipts', t => {
  const root = directory(t); const path = join(root, 'state');
  const store = new RunStore(path, identity);
  assert.throws(() => new RunStore(path, identity), /locked/u);
  const op = store.intend({ leaf: 'A', action: 'write' }, 'one');
  assert.equal(store.intend({ leaf: 'A', action: 'write' }, 'one').id, op.id);
  store.outcome(op.id, { status: 'unresolved' }); assert.equal(store.state.operations[op.id].status, 'pending');
  assert.deepEqual(store.state.accepted, {});
  store.outcome(op.id, { status: 'accepted', acceptanceId: 'receipt-A' });
  assert.equal(store.state.accepted['receipt-A'], op.id);
  assert.throws(() => store.outcome('unknown', {} as OperationResult), /no durable intent/u);
  store.cancel(); store.close();
  const resumed = new RunStore(path, identity); assert.equal(resumed.state.cancelled, true);
  assert.equal(resumed.state.accepted['receipt-A'], op.id); resumed.close();
  assert.throws(() => new RunStore(path, { ...identity, invocation: 'other' }), /incompatible/u);
  const state = JSON.parse(readFileSync(join(path, 'state.json'), 'utf8'));
  writeFileSync(join(path, 'state.json'), JSON.stringify({ ...state, version: 0 }));
  assert.throws(() => new RunStore(path, identity), /incompatible/u);
});

test('state rejects unsafe locations, links and invalid frozen universes', t => {
  const root = directory(t); const repository = join(root, 'repo'); mkdirSync(repository);
  for (const leaves of [undefined, [], [''], ['A', 'A']]) {
    assert.throws(() => new RunStore(join(root, 'bad'), { leaves } as RunIdentity), /nonempty/u);
  }
  assert.throws(() => new RunStore(join(repository, 'state'), identity, { repositoryRoot: repository }), /outside/u);
  const alias = join(root, 'alias'); symlinkSync(repository, alias);
  assert.throws(() => new RunStore(alias, identity), /symlink/u);
  assert.throws(() => new RunStore(join(alias, 'nested'), identity, { repositoryRoot: repository }), /outside/u);
  const state = join(root, 'links'); mkdirSync(state);
  writeFileSync(join(root, 'external'), '{}'); symlinkSync(join(root, 'external'), join(state, 'state.json'));
  assert.throws(() => new RunStore(state, identity), /Unsafe/u);
});
