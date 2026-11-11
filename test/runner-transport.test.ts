import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, codexEnvironment, codexRestrictions } from '../src/codex-adapter.ts';
import type { SessionHandle, ToolInput, WorkerProcess, WorkerReply } from '../src/harness-adapter.ts';
import { RunStore } from '../src/run-store.ts';
import { CodexFiles, brokerTool } from '../src/codex-files.ts';
import type { FakeChild } from './support/types.ts';

type CodexMessage = Parameters<CodexAdapter['receive']>[0];

interface SentReply {
  result: { success: boolean; contentItems: { text: string }[] };
  error: { code: number };
}

function adapterFixture() {
  const sent: SentReply[] = [];
  const adapter = new CodexAdapter({ cwd: '/fixture', tools: [brokerTool],
    handleTool: async () => ({ status: 'completed' }) });
  adapter.threadId = 'owned'; adapter.send = value => sent.push(value as SentReply);
  return { adapter, sent };
}

test('adapter routes only its private tools and denies every human-input request', async () => {
  const { adapter, sent } = adapterFixture();
  await adapter.receive({ id: 1, method: 'item/tool/call', params: {
    threadId: 'owned', tool: 'backlog_tool', arguments: {} } } as CodexMessage);
  assert.equal(sent[0].result.success, true);
  for (const [index, method] of ['item/tool/requestUserInput',
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval'].entries()) {
    await adapter.receive({ id: index + 2, method, params: { threadId: 'owned' } } as CodexMessage);
  }
  assert.ok(sent.slice(1).every(item => item.error.code === -32000));
  await adapter.receive({ id: 6, method: 'item/tool/call', params: {
    threadId: 'foreign', tool: 'backlog_tool', arguments: {} } } as CodexMessage);
  assert.equal(sent.at(-1)!.error.code, -32000);
});

test('raw text stays private and worker completion never claims task acceptance', async () => {
  const { adapter } = adapterFixture();
  await adapter.receive({ method: 'item/completed', params: { threadId: 'owned',
    item: { type: 'agentMessage', text: 'Please approve this?' } } } as CodexMessage);
  const promise = new Promise<WorkerReply & { acceptanceId?: string }>((resolve, reject) => { adapter.turn = { resolve, reject }; });
  await adapter.receive({ method: 'turn/completed', params: { threadId: 'owned',
    turn: { status: 'completed' } } } as CodexMessage);
  const result = await promise;
  assert.equal(result.status, 'worker-returned');
  assert.equal(result.acceptanceId, undefined);
  assert.equal(result.text, 'Please approve this?');
});

test('child transport context and mutation capabilities are restricted without bypass flags', () => {
  const env = codexEnvironment({ HOME: '/home/test', CODEX_HOME: '/state',
    CODEX_SESSION_ID: 'parent', CODEX_THREAD_ID: 'parent', CODEX_TOOL_CALL_ID: 'parent', PATH: '/bin' });
  assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CODEX_HOME, '/state');
  assert.equal(env.HOME, '/home/test');
  assert.equal(codexRestrictions['agents.enabled'], false);
  assert.equal(codexRestrictions['features.shell_tool'], false);
  assert.equal(codexRestrictions.approval_policy, 'never');
});

test('installed Codex uses scoped broker across actual session resume', {
  skip: process.env.LIVE_OUTCOME_TRANSPORT !== '1', timeout: 180000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'off-codex-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RunStore(join(directory, 'state'), { invocation: 'live-smoke', leaves: ['A'] });
  t.after(() => store.close());
  const broker = new CodexFiles({ root: directory, scopes: [{ mode: 'write', path: 'output' }],
    store, identity: { worker: 'codex-smoke', generation: 1 }, revalidate: async () => true });
  let handle!: SessionHandle;
  const handles: SessionHandle[] = [];
  const create = () => new CodexAdapter({ cwd: directory, tools: [brokerTool],
    model: 'gpt-6.1-sol', effort: 'medium',
    onHandle: async value => { handle = value; handles.push(value); },
    handleTool: (...args: [string, ToolInput]) => broker.call(...args) });
  const first = create(); t.after(() => first.close());
  assert.equal(first.probe().status, 'interface-ready');
  const prompt = (file: string) => `Use backlog_tool exactly once with operation write_file and input ` +
    JSON.stringify({ path: `output/${file}.txt`, content: file, expectedHash: null }) +
    '. Do not use other tools or ask any person anything. Report completion after the broker succeeds.';
  const result = await first.startAction(prompt('first'));
  assert.equal(result.status, 'worker-returned');
  assert.equal(readFileSync(join(directory, 'output/first.txt'), 'utf8'), 'first');
  assert.ok(result.events.some(event => event.type === 'dynamicToolCall'));
  assert.ok(!result.events.some(event => event.type === 'denied-request'));
  first.close();
  const second = create(); t.after(() => second.close());
  const resumed = await second.resumeAction(prompt('second'), handle);
  assert.equal(readFileSync(join(directory, 'output/second.txt'), 'utf8'), 'second');
  assert.equal(resumed.threadId, result.threadId);
  assert.ok(!resumed.events.some(event => event.type === 'denied-request'));
  assert.equal(handles.length, 2);
  t.diagnostic(JSON.stringify({ version: first.probe().version, model: handles[0].model,
    brokerOperations: Object.keys(store.state.operations).length, resumed: true, humanPrompts: 0 }));
});

function transportFixture(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const child = new EventEmitter() as FakeChild;
  child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const request = JSON.parse(chunk.toString()); calls.push(request);
    queueMicrotask(() => {
      if (request.id === undefined || !request.method) return;
      if (overrides.error === request.method) { send({ id: request.id, error: { code: -1 } }); return; }
      const responses: Record<string, unknown> = { initialize: {}, 'config/read': { config: { mcp_servers: { inherited: {} } } },
        'thread/start': { thread: { id: 'controlled' }, model: 'transport-test' },
        'thread/resume': { thread: { id: 'controlled' }, model: 'transport-test' },
        'mcpServerStatus/list': { data: [{ runtimeStatus: 'disabled', tools: {} }] },
        'turn/start': { turn: { id: 'turn' } }, 'turn/interrupt': {} };
      send({ id: request.id, result: overrides[request.method] ?? responses[request.method] });
      if (request.method === 'turn/start') setTimeout(() => send({ method: 'turn/completed',
        params: { threadId: 'controlled', turn: { status: overrides.turnStatus ?? 'completed' } } }), 1);
    });
    done();
  } });
  child.kill = () => { child.stdout.end(); child.stderr.end(); child.emit('exit'); };
  const adapter = new CodexAdapter({ cwd: '/fixture', tools: [brokerTool], handleTool: async () => ({}),
    spawnProcess: (file, args, options) => { calls.push({ file, args, options }); return child as unknown as WorkerProcess; },
    onHandle: async () => calls.push({ handleSaved: true }) });
  return { adapter, child, calls, send };
}

test('machine transport starts, saves handle, resumes and interrupts without native capabilities', async t => {
  const f = transportFixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.startAction('private');
  assert.equal(result.status, 'worker-returned');
  assert.equal(f.adapter.observe().turnId, 'turn');
  assert.ok(f.calls[0].args.includes('--strict-config'));
  assert.equal(f.calls[0].options.stdio[0], 'pipe');
  assert.ok(f.calls.findIndex(c => c.handleSaved) < f.calls.findIndex(c => c.method === 'turn/start'));
  assert.equal(f.calls.find(c => c.method === 'thread/start').params.config['mcp_servers.inherited.enabled'], false);
  await f.adapter.cancelAction();
  const second = transportFixture(); t.after(() => second.adapter.close());
  await second.adapter.resumeAction('continue internally', { threadId: result.threadId });
  assert.ok(second.calls.some(c => c.method === 'thread/resume'));
});

test('machine transport fails closed on RPC error, enabled MCP and failed turns', async t => {
  for (const overrides of [{ error: 'initialize' },
    { 'config/read': {} }, { 'config/read': { config: { mcp_servers: { 'bad.name': {} } } } },
    { 'mcpServerStatus/list': { data: [{ runtimeStatus: 'ready', tools: { shell: {} } }] } },
    { turnStatus: 'failed' }]) {
    const f = transportFixture(overrides); t.after(() => f.adapter.close());
    await assert.rejects(f.adapter.startAction('no prompt'));
  }
});

test('transport failure rejects pending operations and private tool errors return only to worker', async t => {
  const f = transportFixture(); t.after(() => f.adapter.close());
  await f.adapter.connect();
  const pending = f.adapter.rpc('unknown', {});
  f.child.stdout.write('not-json\n');
  await assert.rejects(pending, /Malformed/u);
  const { adapter, sent } = adapterFixture();
  adapter.handleTool = async () => { throw new Error('Expected file hash is stale'); };
  await adapter.receive({ id: 9, method: 'item/tool/call', params: { threadId: 'owned',
    tool: 'backlog_tool', arguments: {} } } as CodexMessage);
  assert.equal(sent[0].result.success, false);
  assert.match(sent[0].result.contentItems[0].text, /stale/u);
  await adapter.receive({ id: 999, result: {} } as CodexMessage);
});

test('Codex requests frozen model and effort and rejects a different actual model', async () => {
  const good = transportFixture(); good.adapter.model = 'transport-test'; good.adapter.effort = 'medium';
  await good.adapter.startAction('pinned');
  const launch = good.calls.find(call => call.args);
  assert.ok(launch.args.includes('model="transport-test"'));
  assert.ok(launch.args.includes('model_reasoning_effort="medium"'));
  good.adapter.close();
  const wrong = transportFixture(); wrong.adapter.model = 'different'; wrong.adapter.effort = 'high';
  await assert.rejects(wrong.adapter.startAction('wrong model'), /model/u);
  wrong.adapter.close();
});

test('B: Codex forwards only owned documented cumulative usage counters', async () => {
  const reports: unknown[] = [];
  const adapter = new CodexAdapter({ cwd: '/unused', tools: [brokerTool], handleTool: async () => {},
    onUsage: usage => reports.push(usage) });
  adapter.threadId = 'owned';
  for (const [threadId, total] of [['foreign', { inputTokens: 99 }], ['owned', { inputTokens: 2, outputTokens: 3, totalTokens: 5 }],
    ['owned', { inputTokens: 4, outputTokens: 5, totalTokens: 9, private: 'SECRET' }]] as const) {
    await adapter.receive({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total } } } as CodexMessage);
  }
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.at(-1), { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  assert.ok(!JSON.stringify(adapter.events).includes('SECRET'));
});
