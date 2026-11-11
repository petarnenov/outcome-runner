import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSelection, claudeCatalog, codexCatalog, codexModels, defaultSelection, harnessCatalog } from '../src/harness-catalog.ts';
import { CodexAdapter } from '../src/codex-adapter.ts';
import { codexSelection, resolveHarness } from '../src/harness.ts';
import { main, parseFlags } from '../src/cli.ts';
import { runQueue } from '../src/runner.ts';
import { git } from '../src/git.ts';
import type { Harness, RunConfig } from '../src/model.ts';
import type { AdapterOptions, WorkerProcess } from '../src/harness-adapter.ts';
import type { FakeChild } from './support/types.ts';

interface Request { id?: number; method: string; params: { cursor?: string; includeHidden?: boolean } }

const firstPage = { data: [
  { id: 'entry-a', model: 'gpt-a', hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { id: 'entry-hidden', model: 'gpt-hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
  nextCursor: 'page-2' };
const secondPage = { data: [{ id: 'gpt-b',
  supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] }],
  nextCursor: null };
const modelList = (params: Request['params']) => params.cursor === undefined ? firstPage :
  params.cursor === 'page-2' ? secondPage : { data: [] };

function scriptedRpc(respond: (params: Request['params']) => unknown = modelList) {
  const calls: Request[] = [];
  const rpc = async <Result>(method: string, params: object): Promise<Result> => {
    calls.push({ method, params: params as Request['params'] });
    return respond(params as Request['params']) as Result;
  };
  return { rpc, calls };
}

function fakeCodex(config: object = { config: { model: 'gpt-a', model_reasoning_effort: 'high' } }) {
  const spawns: string[][] = []; const requests: Request[][] = []; let killed = 0;
  const spawnProcess = (_file: string, args: string[]) => {
    spawns.push(args); const received: Request[] = []; requests.push(received);
    const child = new EventEmitter() as FakeChild;
    child.pid = 7; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as Request; received.push(request);
        if (request.id === undefined) continue;
        const result = request.method === 'config/read' ? config :
          request.method === 'model/list' ? modelList(request.params) : {};
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      }
      done();
    } });
    child.kill = () => { killed++; child.stdout.end(); child.stderr.end(); };
    return child as unknown as WorkerProcess;
  };
  const create = (options: AdapterOptions) => {
    const adapter = new CodexAdapter({ ...options, spawnProcess });
    adapter.probe = () => ({ status: 'interface-ready' });
    return adapter;
  };
  return { create, spawns, requests, killed: () => killed };
}

test('Claude catalog lists exactly the four model IDs with the claude --effort values', async () => {
  assert.deepEqual([...claudeCatalog.keys()],
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']);
  for (const efforts of claudeCatalog.values()) assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(await harnessCatalog('claude'), claudeCatalog);
  assert.deepEqual(defaultSelection, { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
});

test('Codex catalog follows every model/list page, excludes hidden models and keeps per-model efforts', async () => {
  const { rpc, calls } = scriptedRpc();
  const catalog = await codexCatalog(rpc);
  assert.deepEqual(calls.map(call => call.method), ['model/list', 'model/list']);
  assert.equal(calls[0].params.cursor, undefined); assert.equal(calls[1].params.cursor, 'page-2');
  assert.ok(calls.every(call => call.params.includeHidden === false));
  assert.deepEqual([...catalog.keys()], ['gpt-a', 'gpt-b']);
  assert.equal(catalog.has('gpt-hidden'), false);
  assert.deepEqual(catalog.get('gpt-a'), ['low', 'high']);
  assert.deepEqual(catalog.get('gpt-b'), ['minimal', 'medium', 'xhigh']);
  const provided = await harnessCatalog('codex', () => codexCatalog(rpc));
  assert.deepEqual([...provided.keys()], ['gpt-a', 'gpt-b']);
  await assert.rejects(harnessCatalog('codex'), /app-server/u);
  await assert.rejects(harnessCatalog('other' as unknown as Harness), /Unknown outcome harness/u);
});

test('Codex catalog refuses malformed pages, entries and repeated cursors', async () => {
  for (const page of [null, {}, { data: 'x' }, { data: [{ hidden: false }] }, { data: [], nextCursor: 5 }]) {
    await assert.rejects(codexCatalog(scriptedRpc(() => page).rpc), /Codex model\/list/u);
  }
  const loop = scriptedRpc(() => ({ data: [{ model: 'gpt-loop' }], nextCursor: 'same' }));
  await assert.rejects(codexCatalog(loop.rpc), /repeated cursor/u);
  assert.equal(loop.calls.length, 2);
  const sparse = await codexCatalog(scriptedRpc(() => ({ data: [{ id: 'gpt-id', supportedReasoningEfforts: [{}, { reasoningEffort: 'low' }] },
    { id: 'gpt-none' }], nextCursor: '' })).rpc);
  assert.deepEqual(sparse.get('gpt-id'), ['low']); assert.deepEqual(sparse.get('gpt-none'), []);
});

test('Codex model/list defaults record the first visible default model and supported per-model default efforts', async () => {
  const efforts = (...names: string[]) => names.map(reasoningEffort => ({ reasoningEffort }));
  const pages = [{ data: [
    { model: 'gpt-hidden', hidden: true, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts('low') },
    { model: 'gpt-a', isDefault: 'yes', defaultReasoningEffort: 'high', supportedReasoningEfforts: efforts('low', 'high') },
    { model: 'gpt-b', isDefault: true, defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: efforts('low', 'medium') }],
  nextCursor: 'next' }, { data: [
    { model: 'gpt-c', isDefault: true, defaultReasoningEffort: 7, supportedReasoningEfforts: efforts('low') },
    { model: 'gpt-a', defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts('low', 'minimal') },
    { model: 'gpt-d', defaultReasoningEffort: '', supportedReasoningEfforts: efforts('low') }], nextCursor: null }];
  const models = await codexModels(scriptedRpc(params => pages[params.cursor === 'next' ? 1 : 0]).rpc);
  assert.equal(models.defaultModel, 'gpt-b');
  assert.deepEqual([...models.defaultEfforts], [['gpt-a', 'high']]);
  assert.deepEqual(models.catalog.get('gpt-a'), ['low', 'high', 'minimal']);
  assert.equal(models.catalog.has('gpt-hidden'), false);
  const plain = await codexModels(scriptedRpc().rpc);
  assert.equal(plain.defaultModel, undefined); assert.equal('defaultModel' in plain, false);
  assert.equal(plain.defaultEfforts.size, 0);
  assert.deepEqual([...plain.catalog], [...await codexCatalog(scriptedRpc().rpc)]);
});

test('selection names the rejected model or effort', async () => {
  assert.doesNotThrow(() => assertSelection('claude', claudeCatalog, 'claude-haiku-5-5', 'max'));
  assert.throws(() => assertSelection('claude', claudeCatalog, 'claude-opus-4', 'medium'), /"claude-opus-4" is not offered/u);
  assert.throws(() => assertSelection('claude', claudeCatalog, 'claude-opus-5-5', 'minimal'), /"minimal" is not supported/u);
  const catalog = await codexCatalog(scriptedRpc().rpc);
  assert.throws(() => assertSelection('codex', catalog, 'gpt-a', 'xhigh'), /Effort "xhigh".*"gpt-a"/u);
  await assert.rejects(resolveHarness({ model: 'claude-opus-4' } as RunConfig), /claude-opus-4/u);
  await assert.rejects(resolveHarness({ effort: 'minimal' } as RunConfig), /minimal/u);
  await assert.rejects(resolveHarness({ harness: 'codex', model: 'gpt-a', effort: 'xhigh' } as RunConfig,
    async () => ({ catalog })), /xhigh/u);
  await assert.rejects(resolveHarness({ harness: 'codex', model: 'gpt-hidden', effort: 'medium' } as RunConfig,
    async () => ({ catalog })), /gpt-hidden/u);
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']) {
    for (const effort of ['low', 'xhigh', 'max']) {
      assert.deepEqual(await resolveHarness({ model, effort } as RunConfig),
        { harness: 'claude', model, effort, coverage: 85 });
    }
  }
});

test('one Codex app-server session supplies defaults and the catalog and closes before allocation', async () => {
  const codex = fakeCodex();
  const selection = await codexSelection('/project', codex.create);
  assert.equal(codex.spawns.length, 1); assert.equal(codex.killed(), 1);
  const methods = codex.requests[0].map(request => request.method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'config/read', 'model/list', 'model/list']);
  assert.equal(selection.model, 'gpt-a'); assert.equal(selection.effort, 'high');
  assert.deepEqual([...selection.catalog.keys()], ['gpt-a', 'gpt-b']);
  assert.equal(selection.defaultModel, undefined); assert.equal(selection.defaultEfforts?.size, 0);
  const resolved = await resolveHarness({ root: '/project', harness: 'codex' } as RunConfig,
    cwd => codexSelection(cwd, codex.create));
  assert.deepEqual([resolved.model, resolved.effort], ['gpt-a', 'high']);
  const partial = await resolveHarness({ root: '/project', harness: 'codex', model: 'gpt-b' } as RunConfig,
    cwd => codexSelection(cwd, fakeCodex({ config: { model: 'gpt-a', model_reasoning_effort: 'medium' } }).create));
  assert.deepEqual([partial.model, partial.effort], ['gpt-b', 'medium']);
  const invalidDefault = fakeCodex({ config: { model: 'gpt-a', model_reasoning_effort: 'xhigh' } });
  await assert.rejects(resolveHarness({ root: '/project', harness: 'codex' } as RunConfig,
    cwd => codexSelection(cwd, invalidDefault.create)), /xhigh/u);
  assert.equal(invalidDefault.spawns.length, 1); assert.equal(invalidDefault.killed(), 1);
});

test('Codex models() and modelList() require a connected adapter and never spawn', async () => {
  let spawned = 0;
  const adapter = new CodexAdapter({ cwd: '/project', tools: [], handleTool: async () => {},
    spawnProcess: () => { spawned++; throw new Error('Must not spawn'); } });
  await assert.rejects(adapter.models(), /not connected/u);
  await assert.rejects(adapter.modelList(), /not connected/u);
  assert.equal(spawned, 0);
});

test('CLI flags parse in any order, at most once each, and override the invocation JSON', async t => {
  assert.deepEqual(parseFlags(['--effort=high', '--model=claude-haiku-5-5', '--harness=claude']),
    { effort: 'high', model: 'claude-haiku-5-5', harness: 'claude' });
  assert.deepEqual(parseFlags([]), {});
  for (const args of [['--model=a', '--model=b'], ['--model='], ['--verbose'], ['--effort'], ['--harness=other'],
    ['--effort=low', '--effort=low'], ['model=a']]) {
    assert.throws(() => parseFlags(args), /Expected --harness=<claude\|codex>, --model=<id>, --effort=<level> and --coverage=<n>/u);
  }
  const directory = mkdtempSync(join(tmpdir(), 'catalog-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ invocation: 'fixture', model: 'claude-opus-5-5', effort: 'low' }));
  let received!: RunConfig;
  const runner = async (config: RunConfig) => { received = config; return { status: 'exhausted' }; };
  assert.equal(await main(path, runner, () => {}, { args: ['--effort=high', '--model=claude-haiku-5-5', '--harness=claude'] }), 0);
  assert.deepEqual([received.harness, received.model, received.effort], ['claude', 'claude-haiku-5-5', 'high']);
  assert.equal(await main(path, runner, () => {}, { args: ['--model=claude-sonnet-5-5', '--effort=max'] }), 0);
  assert.deepEqual([received.model, received.effort], ['claude-sonnet-5-5', 'max']);
  assert.equal(await main(path, runner, () => {}, {}), 0);
  assert.deepEqual([received.harness, received.model, received.effort], [undefined, 'claude-opus-5-5', 'low']);
  for (const args of [['--model=a', '--model=b'], ['--model='], ['--verbose']]) {
    const lines: string[] = []; let ran = false;
    assert.equal(await main(path, async () => { ran = true; return { status: 'exhausted' }; },
      line => lines.push(line), { args }), 4);
    assert.equal(ran, false); assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(report), ['status', 'reason', 'diagnostics']);
    rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
  }
});

// The OpenSpec preflight and harness availability run before harness resolution; both are scripted to pass,
// non-interactively, so the refusal comes from the catalog and no real harness is probed.
const project = { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target: 'main',
  checks: [{ command: 'node', args: ['{coverage}'] }], planningCheck: { command: 'openspec', args: ['validate'] } };
const withPassingOpenspec: typeof runQueue = (config, options = {}) =>
  runQueue(config, { ...options, openspec: { probe: () => ({ status: 0 }), configPresent: () => true },
    selection: { interactive: false, probe: harness => ({ harness, available: true, version: 'scripted' }) } });

async function refused(t: TestContext, args: string[], rejected: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-refusal-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'); mkdirSync(root); git(root, 'init', '-b', 'main');
  const path = join(base, 'invocation.json'); writeFileSync(path, JSON.stringify({ invocation: 'fixture', project }));
  const lines: string[] = [];
  assert.equal(await main(path, withPassingOpenspec, line => lines.push(line), { args, cwd: root, env: { XDG_STATE_HOME: join(base, 'state') } }), 4);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  t.after(() => rmSync(join(report.diagnostics, '..'), { recursive: true, force: true }));
  assert.ok(JSON.parse(readFileSync(report.diagnostics, 'utf8')).message.includes(rejected));
  assert.equal(existsSync(join(base, '.work-queue-locks')), false);
  assert.equal(existsSync(join(base, 'state')), false);
}

test('an unknown Claude model is refused before allocation with exit code 4', async t => {
  await refused(t, ['--model=claude-opus-4'], 'claude-opus-4');
});

test('an unsupported Claude effort is refused before allocation with exit code 4', async t => {
  await refused(t, ['--effort=minimal', '--model=claude-sonnet-5-5'], 'minimal');
});
