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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/run-store.ts';
import { CodexFiles } from '../src/codex-files.ts';
import { PAGE_BYTES } from '../src/text-page.ts';
import type { BrokerInput } from '../src/harness-adapter.ts';

function fixture(t: TestContext) {
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
    await assert.rejects(() => f.broker.call('backlog_tool', { operation, input: {} as BrokerInput }), /Unknown fixed operation/);
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
    await assert.rejects(f.broker.call('backlog_tool', { operation: 'write_file', input: input as BrokerInput }), /bounded/u);
  }
});

test('a large file reads in bounded pages whose hash allows a following write', async t => {
  const f = fixture(t);
  const text = 'жълт ред\n'.repeat(12_000);
  mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src/large.txt'), text);
  const whole = createHash('sha256').update(text).digest('hex');
  const read = (offset?: number) => f.broker.call('backlog_tool', { operation: 'read_file',
    input: { path: 'src/large.txt', offset } as BrokerInput }) as Promise<{ content: string; hash: string; nextOffset: number | null }>;
  let page = await read(); let rebuilt = ''; let pages = 0;
  for (;;) {
    assert.equal(page.hash, whole);
    assert.ok(Buffer.byteLength(page.content) <= PAGE_BYTES);
    rebuilt += page.content; pages += 1;
    if (page.nextOffset === null) break;
    page = await read(page.nextOffset);
  }
  assert.ok(pages > 1);
  assert.equal(rebuilt, text);
  await assert.rejects(read(-1), /offset/u);
  const written = await f.broker.call('backlog_tool', { operation: 'write_file',
    input: { path: 'src/large.txt', content: 'replaced', expectedHash: whole } });
  assert.equal((written as { status: string }).status, 'completed');
});
