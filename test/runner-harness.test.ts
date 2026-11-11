import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarness, codexSelection, createHarness } from '../src/harness.ts';
import type { CodexSelection } from '../src/harness.ts';
import { ClaudeAdapter } from '../src/claude-adapter.ts';
import { CodexAdapter } from '../src/codex-adapter.ts';
import { RunStore } from '../src/run-store.ts';
import type { InvocationIdentity } from '../src/invocation-identity.ts';
import { git } from '../src/git.ts';
import { main } from './support/isolated-cli.ts';
import { publishToOrigin } from './support/git-origin.ts';
import type { RunConfig } from '../src/model.ts';
import type { HarnessOptions, ToolDefinition } from '../src/harness-adapter.ts';

const tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } } as ToolDefinition;
const codexCatalogFixture = new Map([['gpt-6.1-sol', ['low', 'medium', 'high']], ['pinned', ['medium']], ['other', ['low']]]);
const codex = (defaults: Partial<CodexSelection> = {}) => async (): Promise<CodexSelection> =>
  ({ catalog: codexCatalogFixture, ...defaults });
/** The store compares whatever identity it is given; these tests use partial identities. */
const asIdentity = (value: object) => value as unknown as InvocationIdentity;

/** A repository whose start branch exists on origin, so the CLI resolves its run target. */
function startCheckout(t: TestContext, directory: string): string {
  const root = join(directory, 'project'); mkdirSync(root); git(root, 'init', '-q', '-b', 'main'); publishToOrigin(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Claude is the exact default while Codex resolves and freezes its own settings', async () => {
  assert.deepEqual(await resolveHarness({ root: '/project' } as RunConfig, () => { throw new Error('No Codex for Claude'); }),
    { root: '/project', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', coverage: 85 });
  const resolved = await resolveHarness({ root: '/project', harness: 'codex' } as RunConfig,
    async cwd => { assert.equal(cwd, '/project'); return { model: 'gpt-6.1-sol', effort: 'high', catalog: codexCatalogFixture }; });
  assert.equal(resolved.model, 'gpt-6.1-sol'); assert.equal(resolved.effort, 'high');
  assert.equal((await resolveHarness({ harness: 'codex', model: 'pinned', effort: 'medium' } as RunConfig,
    codex({ model: 'other', effort: 'low' }))).model, 'pinned');
  const partial = await resolveHarness({ harness: 'codex', model: 'gpt-6.1-sol' } as RunConfig,
    codex({ model: 'other', effort: 'low' }));
  assert.equal(partial.model, 'gpt-6.1-sol'); assert.equal(partial.effort, 'low');
  for (const config of [{ harness: 'unknown' }, { model: 'opus' }, { effort: 'invalid' },
    { harness: 'codex', model: '', effort: 'medium' }, { harness: 'codex', model: 'pinned', effort: 'invalid' },
    { harness: 'codex' }]) {
    await assert.rejects(resolveHarness(config as RunConfig, codex()));
  }
  assert.ok(createHarness({ cwd: '.', tools: [tool] } as HarnessOptions, resolved) instanceof CodexAdapter);
  assert.ok(createHarness({ cwd: '.', tools: [tool] } as HarnessOptions, await resolveHarness({} as RunConfig)) instanceof ClaudeAdapter);
});

test('Codex selection is read-only and closes on success and refusal', async () => {
  let closed = 0; const methods: string[] = [];
  const catalog = new Map([['pinned', ['medium']]]);
  const defaultEfforts = new Map([['pinned', 'medium']]);
  let defaultModel: string | undefined = 'pinned';
  const create = () => ({ probe: () => ({ status: 'interface-ready' }),
    connect: async () => { methods.push('connect'); }, rpc: async (method: string, params: { includeLayers: boolean }) => {
      methods.push(method); assert.equal(method, 'config/read'); assert.equal(params.includeLayers, false);
      return { config: { model: 'pinned', model_reasoning_effort: 'medium' } };
    }, modelList: async () => { methods.push('modelList');
      return defaultModel === undefined ? { catalog, defaultEfforts } : { catalog, defaultModel, defaultEfforts }; },
    close: () => { closed++; } });
  assert.deepEqual(await codexSelection('/project', create as unknown as () => CodexAdapter),
    { model: 'pinned', effort: 'medium', catalog, defaultModel: 'pinned', defaultEfforts });
  assert.deepEqual(methods, ['connect', 'config/read', 'modelList']);
  defaultModel = undefined;
  assert.deepEqual(await codexSelection('/project', create as unknown as () => CodexAdapter),
    { model: 'pinned', effort: 'medium', catalog, defaultEfforts });
  await assert.rejects(codexSelection('.', () => ({ ...create(), probe: () => ({ status: 'unavailable' }) }) as unknown as CodexAdapter), /unavailable/u);
  assert.equal(closed, 3);
});

test('resolved harness model and effort changes and legacy identity cannot rewrite saved state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-state-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = { ...(await resolveHarness({} as RunConfig)), leaves: ['A'], invocation: 'one' };
  const first = new RunStore(directory, asIdentity(identity)); first.close();
  const before = readFileSync(join(directory, 'state.json'), 'utf8');
  const sonnet = await resolveHarness({ model: 'claude-sonnet-5-5' } as RunConfig);
  for (const patch of [{ harness: 'codex' }, { model: sonnet.model }, { effort: 'high' }, { coverage: 90 }]) {
    assert.throws(() => new RunStore(directory, asIdentity({ ...identity, ...patch })), /incompatible/u);
    assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), before);
  }
  const legacy = join(directory, 'legacy');
  const old = new RunStore(legacy, asIdentity({ leaves: ['A'], invocation: 'old' })); old.close();
  assert.throws(() => new RunStore(legacy, asIdentity({ ...identity, invocation: 'old' })), /incompatible/u);
});

test('CLI accepts each selection flag once and keeps invalid input private', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); writeFileSync(path, '{"invocation":"fixture"}');
  const cwd = startCheckout(t, directory);
  let received!: RunConfig; const lines: string[] = [];
  const runner = async (config: RunConfig) => { received = config; return { status: 'exhausted' }; };
  assert.equal(await main(path, runner, value => lines.push(value), { cwd, args: ['--harness=codex'] }), 0);
  assert.equal(received.harness, 'codex');
  assert.equal(await main(path, runner, value => lines.push(value), { cwd, args: ['--harness=claude'] }), 0);
  assert.equal(received.harness, 'claude');
  for (const args of [['--harness=unknown'], ['--harness=codex', '--harness=claude']]) {
    assert.equal(await main(path, runner, value => lines.push(value), { cwd, args }), 4);
    assert.equal(JSON.parse(lines.at(-1)!).reason, 'startup-or-run-failed');
  }
});

test('CLI never publishes private transport questions or authentication errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-private-error-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json'); writeFileSync(config, '{"invocation":"fixture"}');
  let output = '';
  const code = await main(config, async () => { throw new Error('PRIVATE authentication: approve this?'); },
    line => { output += line; }, { cwd: startCheckout(t, directory) });
  assert.equal(code, 4); assert.ok(!output.includes('approve')); assert.ok(!output.includes('authentication'));
  const report = JSON.parse(output);
  assert.match(readFileSync(report.diagnostics, 'utf8'), /PRIVATE authentication: approve this/u);
  rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
});
