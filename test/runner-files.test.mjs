import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/run-store.mjs';
import { CodexFiles } from '../src/codex-files.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'off-broker-'));
  const root = join(directory, 'work'); mkdirSync(root);
  const store = new RunStore(join(directory, 'state'), { leaves: ['A'], invocation: 'test' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let current = true;
  const broker = new CodexFiles({ root, scopes: [{ mode: 'write', path: 'src' }],
    store, identity: { worker: 'codex-test', generation: 1 }, revalidate: async () => current });
  return { directory, root, store, broker, fence: () => { current = false; } };
}

test('scoped writes have durable intent, preserve expected content and replay once', async t => {
  const f = fixture(t);
  const request = { operation: 'write_file', input: { path: 'src/file.txt', content: 'one', expectedHash: null } };
  const result = await f.broker.call('backlog_tool', request);
  assert.equal(readFileSync(join(f.root, 'src/file.txt'), 'utf8'), 'one');
  assert.deepEqual(await f.broker.call('backlog_tool', request), result);
  assert.equal(Object.keys(f.store.state.operations).length, 1);
  await assert.rejects(() => f.broker.call('backlog_tool', { operation: 'write_file',
    input: { ...request.input, content: 'two' } }), /changed before write/);
  f.fence();
  await assert.rejects(() => f.broker.call('backlog_tool', request), /Owner or authority/);
});

test('broker denies traversal, symlink escape, native tools and human-input calls', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'src')); symlinkSync(f.directory, join(f.root, 'src/outside'));
  for (const path of ['../escape', 'other/file', 'src/outside/file']) {
    await assert.rejects(() => f.broker.call('backlog_tool', { operation: 'write_file',
      input: { path, content: 'denied', expectedHash: null } }));
  }
  for (const operation of ['shell', 'request_user_input', 'approve', 'spawn_agent']) {
    await assert.rejects(() => f.broker.call('backlog_tool', { operation, input: {} }), /Unknown fixed operation/);
  }
  assert.equal(Object.keys(f.store.state.operations).length, 0);
});


test('fixed files reject malformed requests and support missing-file inspection', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.broker.call('backlog_tool', { operation: 'read_file', input: { path: 'src/new' } }),
    { content: null, hash: null });
  await assert.rejects(f.broker.call('other', {}), /Unknown/u);
  for (const input of [{ path: 'src/a', content: 1, expectedHash: null },
    { path: 'src/a', content: 'one', expectedHash: 'invalid' }]) {
    await assert.rejects(f.broker.call('backlog_tool', { operation: 'write_file', input }), /bounded/u);
  }
});
