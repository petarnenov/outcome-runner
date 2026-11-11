// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, claudeEnvironment } from '../src/claude-adapter.ts';
import { claudeCatalog } from '../src/harness-catalog.ts';
import type { AdapterOptions, SessionHandle, SpawnProcess, ToolDefinition, ToolInput, WorkerProcess, WorkerReply } from '../src/harness-adapter.ts';
import { RunStore } from '../src/run-store.ts';
import { CodexFiles, brokerTool } from '../src/codex-files.ts';
import type { FakeChild } from './support/types.ts';

type ClaudeMessage = Parameters<ClaudeAdapter['observeMessage']>[0];
type MessagePatch = Record<string, unknown>;

interface FakeRun {
  program: string;
  args: string[];
  options: unknown;
  child: FakeChild;
  emit: (message: unknown) => void;
  prompt: string;
}

const tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } } as ToolDefinition;
const session = 'ec05fd87-67cb-411d-a0b4-cfa78df2035d';
const init = (patch?: MessagePatch) => ({ type: 'system', subtype: 'init', session_id: session,
  model: 'claude-opus-5-5', claude_code_version: '2.1.321', permissionMode: 'dontAsk',
  tools: ['mcp__outcome__echo'], mcp_servers: [{ name: 'outcome', status: 'connected' }],
  skills: [], slash_commands: [], plugins: [], ...patch });
const result = (patch?: MessagePatch) => ({ type: 'result', subtype: 'success', session_id: session, is_error: false,
  result: 'Private completion text', modelUsage: { exact: { canonicalModel: 'claude-opus-5-5' } }, ...patch });
const make = (options?: Partial<AdapterOptions>) => new ClaudeAdapter({ cwd: '/tmp', tools: [tool], handleTool: async (_name, input) => input, ...options });

function fakeProcess(run: (invocation: FakeRun) => Promise<unknown>): SpawnProcess {
  return (program, args, options) => {
    const child = new EventEmitter() as FakeChild; child.pid = 1; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    const emit = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');
    let prompt = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { prompt += chunk; done(); },
      final(done) { done(); setImmediate(() => run({ program, args, options, child, emit, prompt })
        .catch(error => child.emit('error', error))); } });
    return child as unknown as WorkerProcess;
  };
}

test('Claude environment and arguments isolate ambient capabilities without bypass flags', () => {
  const env = claudeEnvironment({ HOME: '/home', PATH: '/bin', CLAUDECODE: 'parent',
    CLAUDE_CODE_SETTINGS_SOURCES: 'user', CLAUDE_CONFIG_DIR: '/auth', CLAUDE_CODE_OAUTH_TOKEN: 'fixture' });
  assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CLAUDE_CODE_SETTINGS_SOURCES, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/auth'); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture');
  assert.equal(env.MCP_TOOL_TIMEOUT, '3600000');
  const adapter = make(); const args = adapter.arguments('http://127.0.0.1:1/token', { threadId: session });
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.ok(!args.some(arg => /bypass|fallback|dangerously/u.test(arg)));
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true); assert.deepEqual(settings.enabledPlugins, {});
  assert.throws(() => make({ model: 'opus' }), /Model "opus" is not offered/u);
  assert.throws(() => make({ effort: 'minimal' }), /Effort "minimal" is not supported/u);
  assert.throws(() => make({ model: 'claude-sonnet-5-5', effort: 'ultra' }), /"ultra"/u);
  assert.throws(() => make({ tools: [] }), /catalog/u);
  assert.throws(() => make({ tools: [tool, tool] }), /catalog/u);
  assert.throws(() => make({ tools: [{ ...tool, name: 'unsafe/name' }] }), /catalog/u);
});

test('every Claude catalog model and effort is accepted and passed to claude', () => {
  for (const [model, efforts] of claudeCatalog) {
    for (const effort of efforts) {
      const args = make({ model, effort }).arguments('http://127.0.0.1:1/token', null);
      assert.equal(args[args.indexOf('--model') + 1], model);
      assert.equal(args[args.indexOf('--effort') + 1], effort);
    }
  }
});

test('a non-Opus Claude model runs and is verified against the selected model', async () => {
  const sonnet = 'claude-sonnet-5-5'; const handles: SessionHandle[] = [];
  const adapter = make({ model: sonnet, effort: 'high', onHandle: handle => handles.push(handle),
    spawnProcess: fakeProcess(async ({ args, emit, child }) => {
      assert.equal(args[args.indexOf('--model') + 1], sonnet);
      assert.equal(args[args.indexOf('--effort') + 1], 'high');
      emit(init({ model: sonnet })); emit({ type: 'assistant', message: { model: sonnet } });
      emit(result({ modelUsage: { exact: { canonicalModel: sonnet } } })); child.emit('exit', 0);
    }) });
  const reply = await adapter.startAction('Sonnet');
  assert.equal(reply.status, 'worker-returned'); assert.equal(reply.text, 'Private completion text');
  assert.equal(reply.events[0].model, sonnet); assert.equal(reply.events[0].requestedEffort, 'high');
  assert.deepEqual([handles[0].model, handles[0].effort, handles[0].harness], [sonnet, 'high', 'claude']);
  adapter.close();
  const initDrift = make({ model: sonnet, effort: 'high' }); initDrift.child = { pid: 1 } as WorkerProcess;
  await assert.rejects(initDrift.observeMessage(init()), /certified scope/u);
  assert.equal(initDrift.certified, false);
  const certified = make({ model: sonnet, effort: 'high' }); certified.child = { pid: 1 } as WorkerProcess;
  await certified.observeMessage(init({ model: sonnet }));
  await assert.rejects(certified.observeMessage({ type: 'assistant', message: { model: 'claude-opus-5-5' } } as ClaudeMessage), /model changed/u);
  await assert.rejects(certified.observeMessage(result() as unknown as ClaudeMessage), /pinned model/u);
});

test('private MCP endpoint authenticates callers and denies unknown or pre-init operations', async t => {
  let calls = 0; const adapter = make({ handleTool: async (_name, input) => { calls++; return input; } });
  const url = await adapter.serve(); t.after(() => adapter.close());
  const send = (method: string, params = {}, extra = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...extra });
  assert.equal((await fetch(url + 'bad', { method: 'POST' })).status, 403);
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await send('ping', {}, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await send('ping', {}, { body: 'invalid' })).status, 400);
  assert.equal((await send('ping', {}, { body: '{}' })).status, 400);
  assert.equal((await send('notifications/initialized', {},
    { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
  assert.equal((await (await send('initialize', { protocolVersion: '2025-03-26' })).json()).result.protocolVersion, '2025-03-26');
  assert.deepEqual((await (await send('server/discover')).json()).result, {});
  assert.deepEqual((await (await send('ping')).json()).result, {});
  assert.equal((await (await send('tools/list')).json()).result.tools[0].name, 'echo');
  assert.ok((await (await send('tools/call', { name: 'echo', arguments: {} })).json()).error);
  adapter.certified = true;
  assert.ok((await (await send('tools/call', { name: 'AskUserQuestion' })).json()).error);
  assert.ok((await (await send('unknown')).json()).error);
  assert.equal(calls, 0);
  const echo = await (await send('tools/call', { name: 'echo', arguments: { value: 1 } })).json();
  assert.equal(JSON.parse(echo.result.content[0].text).value, 1); assert.equal(calls, 1);
  adapter.handleTool = async () => { throw new Error('Private scope failure'); };
  const denied = await (await send('tools/call', { name: 'echo' })).json();
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /Private scope failure/u);
  assert.equal((await send('ping', {}, { body: 'x'.repeat(1024 * 1024 + 1) })).status, 400);
});

test('startup rejects drift, foreign tools, hooks, ambient plugins and fallback models', async () => {
  for (const patch of [{ model: 'other' }, { claude_code_version: 'future' }, { claude_code_version: '2.1.320' }, { permissionMode: 'auto' },
    { tools: ['Bash'] }, { tools: null }, { mcp_servers: [] },
    { mcp_servers: [{ name: 'foreign', status: 'connected' }] },
    { mcp_servers: [{ name: 'outcome', status: 'failed' }] }, { skills: ['geo.loop'] },
    { slash_commands: ['foreign'] }, { plugins: [{ name: 'foreign', path: '/plugin' }] },
    { plugins: [{ name: 'foreign', path: 'builtin' }] }, { session_id: 'bad' }]) {
    const adapter = make(); adapter.child = { pid: 1 } as WorkerProcess;
    await assert.rejects(adapter.observeMessage(init(patch)));
    assert.equal(adapter.certified, false);
  }
  const newer = make(); newer.child = { pid: 1 } as WorkerProcess;
  await newer.observeMessage(init({ claude_code_version: '2.2.0' }));
  assert.equal(newer.certified, true);
  const adapter = make(); adapter.child = { pid: 1 } as WorkerProcess;
  await adapter.observeMessage(init({ plugins: [{ name: 'cc-plugin-privacy', path: 'builtin' }] }));
  assert.equal(adapter.certified, true);
  await assert.rejects(adapter.observeMessage({ type: 'system', subtype: 'hook_started' } as ClaudeMessage), /hook/u);
  await assert.rejects(adapter.observeMessage({ type: 'assistant', message: { model: 'other' } } as ClaudeMessage), /model changed/u);
  for (const patch of [{ session_id: 'foreign' }, { is_error: true }, { subtype: 'error' },
    { modelUsage: null }, { modelUsage: {} }, { modelUsage: { other: { canonicalModel: 'other' } } }]) {
    await assert.rejects(adapter.observeMessage(result(patch) as unknown as ClaudeMessage), /pinned model/u);
  }
});

test('machine adapter retains private text and session identity across resume', async () => {
  const handles: SessionHandle[] = []; let started = 0;
  const adapter = make({ onHandle: handle => handles.push(handle), spawnProcess: fakeProcess(async ({ args, emit, child, prompt }) => {
    assert.ok(prompt.includes('mcp__outcome__')); started++;
    if (started === 2) assert.equal(args[args.indexOf('--resume') + 1], session);
    emit(init()); emit({ type: 'assistant', message: { model: 'claude-opus-5-5' } });
    emit(result()); child.emit('exit', 0);
  }) });
  const first = await adapter.startAction('First'); assert.equal(first.text, 'Private completion text');
  assert.equal(first.status, 'worker-returned'); assert.equal((first as WorkerReply & { acceptanceId?: string }).acceptanceId, undefined);
  const second = await adapter.resumeAction('Second', handles[0]); assert.equal(second.threadId, session);
  assert.equal(handles.length, 2); adapter.close();
  await assert.rejects(adapter.resumeAction('bad', { threadId: 'interactive-picker' }), /resume identity/u);
});

test('transport corruption, child failure and cancellation never claim completion', async () => {
  for (const behavior of [async ({ child }: FakeRun) => child.emit('error', new Error('spawn failed')),
    async ({ child }: FakeRun) => child.emit('exit', 0), async ({ child }: FakeRun) => { child.stdout.write('bad-json\n'); child.emit('exit', 1); }]) {
    const adapter = make({ spawnProcess: fakeProcess(behavior) });
    await assert.rejects(adapter.startAction('private')); adapter.close();
  }
  let adapter: ClaudeAdapter;
  adapter = make({ spawnProcess: fakeProcess(async () => adapter.cancelAction()) });
  await assert.rejects(adapter.startAction('cancel'), /interrupted/u); adapter.close();
  const unsupported = make({ executable: process.execPath });
  assert.equal(unsupported.probe().status, 'unavailable');
});

test('real Claude Opus 5.5 medium uses only scoped broker and resumes without ambient hooks', {
  skip: process.env.LIVE_OUTCOME_CLAUDE_TRANSPORT !== '1', timeout: 240000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outcome-claude-live-'));
  t.after(() => { if (process.env.KEEP_OUTCOME_FIXTURE !== '1') rmSync(directory, { recursive: true, force: true }); });
  mkdirSync(join(directory, '.claude'));
  writeFileSync(join(directory, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: 'touch unexpected-hook' }] }] }, permissions: { allow: ['Bash'] } }));
  const store = new RunStore(join(directory, 'state'), { leaves: ['A'], invocation: 'claude-smoke' }); t.after(() => store.close());
  const broker = new CodexFiles({ root: directory, scopes: [{ mode: 'write', path: 'output' }], store,
    identity: { worker: 'claude-smoke' }, revalidate: async () => true });
  const handles: SessionHandle[] = [];
  const create = () => make({ cwd: directory, tools: [brokerTool], onHandle: value => handles.push(value),
    handleTool: (...args: [string, ToolInput]) => broker.call(...args) });
  const prompt = (name: string) => 'Use backlog_tool write_file exactly once with input ' +
    JSON.stringify({ path: `output/${name}.txt`, content: name, expectedHash: null }) +
    '. Do not use any other operation or ask anyone anything. Return COMPLETE after the broker succeeds.';
  const first = create(); t.after(() => first.close()); assert.equal(first.probe().status, 'interface-ready');
  const a = await first.startAction(prompt('first')); first.close();
  const second = create(); t.after(() => second.close()); const b = await second.resumeAction(prompt('second'), handles[0]);
  assert.equal(readFileSync(join(directory, 'output/first.txt'), 'utf8'), 'first');
  assert.equal(readFileSync(join(directory, 'output/second.txt'), 'utf8'), 'second');
  assert.equal(a.threadId, b.threadId); assert.equal(existsSync(join(directory, 'unexpected-hook')), false);
  for (const response of [a, b]) {
    assert.deepEqual(response.events[0].tools, ['mcp__outcome__backlog_tool']);
    assert.ok(response.events.some(event => event.type === 'tool-call'));
  }
  t.diagnostic(JSON.stringify({ harness: 'claude', model: handles[0].model, effort: handles[0].effort,
    sessions: handles.map(handle => handle.threadId), fixture: directory }));
});

 test('resume rejects missing results and changed sessions instead of reusing completion', async () => {
  for (const mismatch of [false, true]) {
    let count = 0;
    const adapter = make({ spawnProcess: fakeProcess(async ({ emit, child }) => {
      count++;
      emit(init(count === 2 && mismatch ? { session_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } : {}));
      if (count === 1) emit(result());
      child.emit('exit', 0);
    }) });
    await adapter.startAction('first');
    await assert.rejects(adapter.resumeAction('second', { threadId: session }),
      mismatch ? /resume session changed/u : /without a complete private result/u);
    adapter.close();
  }
});

test('nonzero transport diagnostics retain a bounded private stderr tail', async () => {
  const adapter = make({ spawnProcess: fakeProcess(async ({ child }) => {
    child.stderr.write('x'.repeat(5000) + 'PRIVATE: approve this request?');
    child.emit('exit', 23);
  }) });
  await assert.rejects(adapter.startAction('private'), (error: Error) => {
    assert.match(error.message, /\(23\).*PRIVATE: approve this request\?/u);
    assert.ok(error.message.length < 4200); return true;
  });
  adapter.close();
});

test('B: Claude reports deduplicated assistant usage before completion and result usage even on failure', async () => {
  const reports: unknown[] = [];
  const adapter = make({ onUsage: usage => reports.push(usage) }); adapter.child = { pid: 1 } as WorkerProcess;
  await adapter.observeMessage(init() as ClaudeMessage);
  const assistant = (id: string, input: number, output: number) => ({ type: 'assistant', session_id: session,
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output }, content: 'SECRET' } });
  await adapter.observeMessage(assistant('one', 2, 3) as ClaudeMessage);
  await adapter.observeMessage(assistant('one', 4, 5) as ClaudeMessage);
  await adapter.observeMessage(assistant('one', 4, 5) as ClaudeMessage);
  await adapter.observeMessage(assistant('two', 6, 7) as ClaudeMessage);
  assert.deepEqual(reports.at(-1), { inputTokens: 10, outputTokens: 12, totalTokens: null });
  await assert.rejects(adapter.observeMessage(result({ is_error: true,
    usage: { input_tokens: 15, output_tokens: 20, arbitrary: 'SECRET' } }) as ClaudeMessage));
  assert.deepEqual(reports.at(-1), { inputTokens: 15, outputTokens: 20, totalTokens: null });
  assert.ok(!JSON.stringify(reports).includes('SECRET'));
});
