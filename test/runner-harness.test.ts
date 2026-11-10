import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarness, codexDefaults, createHarness } from '../src/harness.ts';
import { ClaudeAdapter } from '../src/claude-adapter.ts';
import { CodexAdapter } from '../src/codex-adapter.ts';
import { RunStore } from '../src/run-store.ts';
import { main } from '../src/cli.ts';
import type { RunConfig } from '../src/model.ts';
import type { HarnessOptions, ToolDefinition } from '../src/harness-adapter.ts';

const tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } } as ToolDefinition;
test('Claude is exact default while Codex resolves and freezes its own settings', async () => {
  assert.deepEqual(await resolveHarness({ root: '/project' } as RunConfig),
    { root: '/project', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
  const codex = await resolveHarness({ root: '/project', harness: 'codex' } as RunConfig,
    async cwd => { assert.equal(cwd, '/project'); return { model: 'gpt-6.1-sol', effort: 'high' }; });
  assert.equal(codex.model, 'gpt-6.1-sol'); assert.equal(codex.effort, 'high');
  assert.equal((await resolveHarness({ harness: 'codex', model: 'pinned', effort: 'medium' } as RunConfig,
    () => { throw new Error('Unexpected defaults read'); })).model, 'pinned');
  assert.equal((await resolveHarness({ harness: 'codex', model: 'pinned' } as RunConfig,
    async () => ({ model: 'other', effort: 'low' }))).model, 'pinned');
  for (const config of [{ harness: 'unknown' }, { model: 'opus' }, { effort: 'high' },
    { harness: 'codex', model: '', effort: 'medium' }, { harness: 'codex', model: 'm', effort: 'invalid' }]) {
    await assert.rejects(resolveHarness(config as RunConfig, async () => ({})));
  }
  assert.ok(createHarness({ cwd: '.', tools: [tool] } as HarnessOptions, codex) instanceof CodexAdapter);
  assert.ok(createHarness({ cwd: '.', tools: [tool] } as HarnessOptions, await resolveHarness({} as RunConfig)) instanceof ClaudeAdapter);
});

test('Codex default discovery is read-only and closes on success and refusal', async () => {
  let closed = 0;
  const create = () => ({ probe: () => ({ status: 'interface-ready' }),
    connect: async () => {}, rpc: async (method: string, params: { includeLayers: boolean }) => {
      assert.equal(method, 'config/read'); assert.equal(params.includeLayers, false);
      return { config: { model: 'pinned', model_reasoning_effort: 'medium' } };
    }, close: () => { closed++; } });
  assert.deepEqual(await codexDefaults('/project', create as unknown as () => CodexAdapter), { model: 'pinned', effort: 'medium' });
  await assert.rejects(codexDefaults('.', () => ({ ...create(), probe: () => ({ status: 'unavailable' }) }) as unknown as CodexAdapter), /unavailable/u);
  assert.equal(closed, 2);
});

test('resolved harness model and effort changes and legacy identity cannot rewrite saved state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-state-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = { ...(await resolveHarness({} as RunConfig)), leaves: ['A'], invocation: 'one' };
  const first = new RunStore(directory, identity); first.close();
  const before = readFileSync(join(directory, 'state.json'), 'utf8');
  for (const patch of [{ harness: 'codex' }, { model: 'other' }, { effort: 'high' }]) {
    assert.throws(() => new RunStore(directory, { ...identity, ...patch }), /incompatible/u);
    assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), before);
  }
  const legacy = join(directory, 'legacy'); const old = new RunStore(legacy, { leaves: ['A'], invocation: 'old' }); old.close();
  assert.throws(() => new RunStore(legacy, { ...identity, invocation: 'old' }), /incompatible/u);
});

test('CLI accepts only one explicit harness flag and keeps invalid input private', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); writeFileSync(path, '{"invocation":"fixture"}');
  let received!: RunConfig; const lines: string[] = [];
  const runner = async (config: RunConfig) => { received = config; return { status: 'exhausted' }; };
  assert.equal(await main(path, runner, value => lines.push(value), { args: ['--harness=codex'] }), 0);
  assert.equal(received.harness, 'codex');
  assert.equal(await main(path, runner, value => lines.push(value), { args: ['--harness=claude'] }), 0);
  assert.equal(received.harness, 'claude');
  for (const args of [['--harness=unknown'], ['--harness=codex', '--harness=claude']]) {
    assert.equal(await main(path, runner, value => lines.push(value), { args }), 4);
    assert.equal(JSON.parse(lines.at(-1)!).reason, 'startup-or-run-failed');
  }
});

test('CLI never publishes private transport questions or authentication errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-private-error-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json'); writeFileSync(config, '{"invocation":"fixture"}');
  let output = '';
  const code = await main(config, async () => { throw new Error('PRIVATE authentication: approve this?'); },
    line => { output += line; });
  assert.equal(code, 4); assert.ok(!output.includes('approve')); assert.ok(!output.includes('authentication'));
  const report = JSON.parse(output);
  assert.match(readFileSync(report.diagnostics, 'utf8'), /PRIVATE authentication: approve this/u);
  rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
});
