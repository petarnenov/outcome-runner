import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { Harness, RunConfig } from '../src/model.ts';
import { main } from './support/isolated-cli.ts';
import { runQueue } from '../src/runner.ts';
import type { PullRequestHost, RunOptions } from '../src/runner.ts';
import { RunStore } from '../src/run-store.ts';
import { ClaudeAdapter } from '../src/claude-adapter.ts';
import { createHarness, resolveHarness } from '../src/harness.ts';
import type { CodexSelection } from '../src/harness.ts';
import { HarnessUnavailableError, codexDefaultModel, defaultEffort, defaultSelectionDeps, describeAvailability,
  probeHarness, recordedSelection, selectHarness } from '../src/harness-selection.ts';
import type { Availability, Selection, SelectionDeps } from '../src/harness-selection.ts';
import type { HarnessAdapter, HarnessOptions, WorkerReply } from '../src/harness-adapter.ts';

const ready = (harness: Harness): Availability => ({ harness, available: true,
  version: harness === 'claude' ? '2.1.330 (Claude Code)' : 'codex-cli 0.170.0' });
const missing = (harness: Harness): Availability => ({ harness, available: false, reason: 'not-installed' });
const uncertified: Availability = { harness: 'codex', available: false, reason: 'uncertified-codex-version',
  version: 'codex-cli 0.100.0' };
const codexFixture = (patch: Partial<CodexSelection> = {}): CodexSelection => ({ model: 'gpt-b', effort: 'low',
  catalog: new Map([['gpt-a', ['low', 'high']], ['gpt-b', ['low', 'medium', 'high']]]),
  defaultEfforts: new Map([['gpt-a', 'high']]), ...patch });

interface Script {
  interactive?: boolean;
  answers?: string[];
  probes?: Partial<Record<Harness, Availability>>;
  codex?: CodexSelection;
  recorded?: Partial<Selection> | null;
}

/** Scripted answers, probes, Codex reader and record: no real harness, TTY or state is touched. */
function scripted({ interactive = true, answers = [], probes = {}, codex = codexFixture(), recorded = null }: Script = {}) {
  const calls = { asked: [] as string[], said: [] as string[], codexReads: [] as string[], events: [] as string[] };
  const deps: SelectionDeps = {
    interactive,
    ask: async question => { calls.asked.push(question); calls.events.push('ask'); return answers.shift() ?? ''; },
    say: text => { calls.said.push(text); calls.events.push('say'); },
    probe: harness => { calls.events.push(`probe:${harness}`); return probes[harness] ?? ready(harness); },
    readCodex: async cwd => { calls.codexReads.push(cwd); calls.events.push('readCodex'); return codex; },
    recorded: () => recorded,
  };
  return { deps, calls };
}

const base = { root: '/project', stateDirectory: '/state' } as RunConfig;
const picked = (config: RunConfig) => [config.harness, config.model, config.effort, config.coverage];
const noCodex = async (): Promise<CodexSelection> => { throw new Error('Codex must not be read again'); };

test('both harnesses available and Enter at every prompt selects claude, claude-opus-5-5, medium and 85', async () => {
  const { deps, calls } = scripted();
  const { config, codex } = await selectHarness(base, deps);
  assert.deepEqual(picked(config), ['claude', 'claude-opus-5-5', 'medium', 85]);
  assert.equal(codex, undefined); assert.deepEqual(calls.codexReads, []);
  assert.deepEqual(calls.events.slice(0, 2), ['probe:claude', 'probe:codex']);
  assert.equal(calls.said[0], 'claude: available (2.1.330 (Claude Code))\ncodex: available (codex-cli 0.170.0)\n');
  assert.deepEqual(calls.asked, ['Harness [claude]: ', 'Model [claude-opus-5-5]: ', 'Effort [medium]: ',
    'Coverage threshold (1-100) [85]: ']);
  assert.ok(calls.said.includes('Harness options: 1) claude  2) codex\n'));
  assert.ok(calls.said.includes('Model options: 1) claude-opus-5-5  2) claude-sonnet-5-5  3) claude-haiku-5-5  4) claude-fable-5-2\n'));
  assert.ok(calls.said.includes('Effort options: 1) low  2) medium  3) high  4) xhigh  5) max\n'));
  assert.deepEqual(picked(await resolveHarness(config, noCodex)), ['claude', 'claude-opus-5-5', 'medium', 85]);
});

test('choosing Codex, one of its models and an effort lists only that model\'s efforts', async () => {
  for (const harnessAnswer of ['codex', '2']) {
    const codex = codexFixture();
    const { deps, calls } = scripted({ answers: [harnessAnswer, 'gpt-a', 'high', ''], codex });
    const result = await selectHarness(base, deps);
    assert.deepEqual(picked(result.config), ['codex', 'gpt-a', 'high', 85]);
    assert.equal(result.codex, codex); assert.deepEqual(calls.codexReads, ['/project']);
    assert.equal(calls.asked[1], 'Model [gpt-b]: ');
    assert.ok(calls.said.includes('Model options: 1) gpt-a  2) gpt-b\n'));
    assert.ok(calls.said.includes('Effort options: 1) low  2) high\n'));
    // medium is unsupported by gpt-a, so its model/list default reasoning effort is preselected.
    assert.equal(calls.asked[2], 'Effort [high]: ');
    // Codex is read after the harness answer and before the model question.
    assert.deepEqual(calls.events.filter(event => event !== 'say').slice(2, 5), ['ask', 'readCodex', 'ask']);
    assert.deepEqual(picked(await resolveHarness(result.config, async () => result.codex!)), ['codex', 'gpt-a', 'high', 85]);
  }
  const { deps, calls } = scripted({ answers: ['codex', '1', '1', ''] });
  assert.deepEqual(picked((await selectHarness(base, deps)).config), ['codex', 'gpt-a', 'low', 85]);
  assert.equal(calls.asked.length, 4);
});

test('the Codex default model is the configured model, else the model/list default, else the first', async () => {
  const preselected = async (codex: CodexSelection) => {
    const { deps, calls } = scripted({ codex });
    const { config } = await selectHarness({ ...base, harness: 'codex' }, deps);
    assert.equal(calls.codexReads.length, 1);
    return [calls.asked[0], config.model];
  };
  assert.deepEqual(await preselected(codexFixture()), ['Model [gpt-b]: ', 'gpt-b']);
  assert.deepEqual(await preselected(codexFixture({ model: undefined, defaultModel: 'gpt-b' })), ['Model [gpt-b]: ', 'gpt-b']);
  assert.deepEqual(await preselected(codexFixture({ model: 'gpt-gone', defaultModel: 'gpt-b' })), ['Model [gpt-b]: ', 'gpt-b']);
  assert.deepEqual(await preselected(codexFixture({ model: undefined })), ['Model [gpt-a]: ', 'gpt-a']);
  assert.deepEqual(await preselected(codexFixture({ model: undefined, defaultModel: 'gpt-gone' })), ['Model [gpt-a]: ', 'gpt-a']);
  assert.equal(codexDefaultModel(codexFixture(), []), undefined);
});

test('the effort preselection is medium, else the model default, else the configured effort, else the first', () => {
  const codex = codexFixture({ effort: 'high', defaultEfforts: new Map([['gpt-x', 'max']]) });
  assert.equal(defaultEffort(['low', 'medium'], 'gpt-x', codex), 'medium');
  assert.equal(defaultEffort(['low', 'max'], 'gpt-x', codex), 'max');
  assert.equal(defaultEffort(['low', 'high'], 'gpt-y', codex), 'high');
  assert.equal(defaultEffort(['low', 'xhigh'], 'gpt-y', codex), 'low');
  assert.equal(defaultEffort(['low', 'xhigh'], 'gpt-y', codexFixture({ effort: undefined, defaultEfforts: undefined })), 'low');
  assert.equal(defaultEffort(['low', 'medium'], 'claude-opus-5-5'), 'medium');
});

test('only one available harness is shown and preselected; unavailable or unknown answers ask again', async () => {
  const { deps, calls } = scripted({ probes: { claude: missing('claude') }, answers: ['claude', 'nonsense', '3', ''] });
  const { config } = await selectHarness(base, deps);
  assert.equal(config.harness, 'codex');
  assert.equal(calls.said[0], 'claude: unavailable (not-installed)\ncodex: available (codex-cli 0.170.0)\n');
  assert.ok(calls.said.includes('Harness options: 1) codex\n'));
  assert.deepEqual(calls.asked.slice(0, 4), Array(4).fill('Harness [codex]: '));
  assert.equal(calls.codexReads.length, 1);
});

test('no available harness, or an unavailable given harness, is refused without asking or reading Codex', async () => {
  for (const interactive of [true, false]) {
    const { deps, calls } = scripted({ interactive, probes: { claude: missing('claude'), codex: uncertified } });
    await assert.rejects(selectHarness(base, deps), (error: HarnessUnavailableError) => {
      assert.ok(error instanceof HarnessUnavailableError); assert.equal(error.reason, 'harness-unavailable');
      assert.equal(error.message, 'No available harness: claude: not-installed; codex: uncertified-codex-version (codex-cli 0.100.0)');
      return true;
    });
    assert.deepEqual(calls.asked, []); assert.deepEqual(calls.codexReads, []);
    if (interactive) assert.match(calls.said[0], /codex: unavailable \(uncertified-codex-version, codex-cli 0\.100\.0\)/u);
    else assert.deepEqual(calls.said, []);
  }
  const flagged = scripted({ probes: { codex: missing('codex') } });
  await assert.rejects(selectHarness({ ...base, harness: 'codex' }, flagged.deps), (error: HarnessUnavailableError) => {
    assert.equal(error.reason, 'harness-unavailable');
    assert.equal(error.message, 'Harness codex is unavailable: claude: available (2.1.330 (Claude Code)); codex: not-installed');
    return true;
  });
  assert.deepEqual(flagged.calls.asked, []); assert.deepEqual(flagged.calls.codexReads, []);
  const fallback = scripted({ interactive: false, probes: { claude: missing('claude') } });
  await assert.rejects(selectHarness(base, fallback.deps), /Harness claude is unavailable/u);
  assert.deepEqual(fallback.calls.codexReads, []);
});

test('flag and JSON values skip their prompts', async () => {
  const flags = scripted();
  const { config } = await selectHarness({ ...base, harness: 'claude', coverage: 70 }, flags.deps);
  assert.deepEqual(flags.calls.asked, ['Model [claude-opus-5-5]: ', 'Effort [medium]: ']);
  assert.deepEqual(picked(config), ['claude', 'claude-opus-5-5', 'medium', 70]);
  const json = scripted();
  const fromJson = await selectHarness({ ...base, model: 'claude-haiku-5-5' }, json.deps);
  assert.ok(!json.calls.asked.some(question => question.startsWith('Model')));
  assert.equal(fromJson.config.model, 'claude-haiku-5-5'); assert.equal(json.calls.asked.length, 3);
  const all = scripted();
  await selectHarness({ ...base, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', coverage: 99 }, all.deps);
  assert.deepEqual(all.calls.asked, []);
  // An unoffered model skips the effort prompt so harness resolution can name the rejected model.
  const unknown = scripted();
  const rejected = await selectHarness({ ...base, model: 'claude-opus-4' }, unknown.deps);
  assert.ok(!unknown.calls.asked.some(question => question.startsWith('Effort')));
  await assert.rejects(resolveHarness(rejected.config, noCodex), /claude-opus-4/u);
  // Invalid given coverage is passed through untouched so harness resolution refuses it.
  const invalid = scripted({ interactive: false });
  const nullCoverage = await selectHarness({ ...base, coverage: null } as unknown as RunConfig, invalid.deps);
  assert.equal(nullCoverage.config.coverage, null);
  await assert.rejects(resolveHarness(nullCoverage.config, noCodex), /Invalid coverage/u);
});

test('CLI flags and invocation JSON reach the selection, which asks only the remaining questions', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'selection-cli-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); mkdirSync(root); git(root, 'init', '-b', 'main');
  const path = join(directory, 'invocation.json');
  writeFileSync(path, JSON.stringify({ invocation: 'selection', model: 'claude-haiku-5-5' }));
  const { deps, calls } = scripted();
  let selected!: RunConfig;
  assert.equal(await main(path, async config => { selected = (await selectHarness(config, deps)).config; return { status: 'exhausted' }; },
    () => {}, { cwd: root, args: ['--harness=claude', '--coverage=70'], env: { XDG_STATE_HOME: join(directory, 'xdg') } }), 0);
  assert.deepEqual(calls.asked, ['Effort [medium]: ']);
  assert.deepEqual(picked(selected), ['claude', 'claude-haiku-5-5', 'medium', 70]);
});

test('an invalid coverage answer is asked again until a valid integer from 1 to 100', async () => {
  const { deps, calls } = scripted({ answers: ['', '', '', 'abc', '0', '90'] });
  const { config } = await selectHarness(base, deps);
  assert.equal(config.coverage, 90);
  assert.equal(calls.asked.filter(question => question.startsWith('Coverage')).length, 3);
  assert.equal(calls.said.filter(text => text === 'Coverage must be an integer from 1 to 100.\n').length, 2);
  const more = scripted({ answers: ['', '', '', '101', '85.5', '-1', ' 100 '] });
  assert.equal((await selectHarness(base, more.deps)).config.coverage, 100);
  assert.equal(more.calls.asked.filter(question => question.startsWith('Coverage')).length, 4);
});

test('non-interactive startup asks nothing and applies defaults', async () => {
  const { deps, calls } = scripted({ interactive: false });
  assert.deepEqual(picked((await selectHarness(base, deps)).config), ['claude', 'claude-opus-5-5', 'medium', 85]);
  assert.deepEqual(calls.asked, []); assert.deepEqual(calls.said, []); assert.deepEqual(calls.codexReads, []);
  const codex = scripted({ interactive: false });
  const result = await selectHarness({ ...base, harness: 'codex' }, codex.deps);
  assert.deepEqual(picked(result.config), ['codex', undefined, undefined, 85]);
  assert.equal(codex.calls.codexReads.length, 1); assert.deepEqual(codex.calls.asked, []);
  // Resolution reuses the single read and keeps the configured Codex defaults.
  assert.deepEqual(picked(await resolveHarness(result.config, async () => result.codex!)), ['codex', 'gpt-b', 'low', 85]);
});

test('a recorded selection is reused without prompts; given values pass through unchanged', async () => {
  const recorded = { harness: 'codex' as Harness, model: 'gpt-a', effort: 'high', coverage: 90 };
  const { deps, calls } = scripted({ recorded });
  const result = await selectHarness(base, deps);
  assert.deepEqual(picked(result.config), ['codex', 'gpt-a', 'high', 90]);
  assert.deepEqual(calls.asked, []); assert.deepEqual(calls.codexReads, ['/project']);
  const differing = scripted({ recorded });
  assert.deepEqual(picked((await selectHarness({ ...base, model: 'gpt-b', coverage: 70 }, differing.deps)).config),
    ['codex', 'gpt-b', 'high', 70]);
  assert.deepEqual(differing.calls.asked, []);
  const unavailable = scripted({ recorded, probes: { codex: missing('codex') } });
  await assert.rejects(selectHarness(base, unavailable.deps), /Harness codex is unavailable/u);
});

test('an unknown harness and an empty Codex catalog are left to harness resolution', async () => {
  const unknown = scripted();
  const { config } = await selectHarness({ ...base, harness: 'other' as Harness }, unknown.deps);
  assert.equal(config.harness, 'other'); assert.deepEqual(unknown.calls.asked, []); assert.deepEqual(unknown.calls.codexReads, []);
  await assert.rejects(resolveHarness(config, noCodex), /Unknown outcome harness/u);
  const empty = scripted({ codex: { catalog: new Map() } });
  const result = await selectHarness({ ...base, harness: 'codex' }, empty.deps);
  assert.deepEqual(empty.calls.asked, ['Coverage threshold (1-100) [85]: ']);
  await assert.rejects(resolveHarness(result.config, async () => result.codex!), /model and effort are required/u);
});

test('the default probe maps versions, a missing executable and probe failures without throwing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'selection-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const path = join(directory, name); writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return path;
  };
  assert.deepEqual(probeHarness('codex', join(directory, 'no-such-codex')), missing('codex'));
  assert.deepEqual(probeHarness('claude', join(directory, 'no-such-claude')), missing('claude'));
  assert.deepEqual(probeHarness('claude', script('claude', "echo '2.1.330 (Claude Code)'")),
    { harness: 'claude', available: true, version: '2.1.330 (Claude Code)' });
  assert.deepEqual(probeHarness('claude', script('old-claude', "echo '2.1.320 (Claude Code)'")),
    { harness: 'claude', available: false, reason: 'uncertified-claude-version', version: '2.1.320 (Claude Code)' });
  assert.deepEqual(probeHarness('codex', script('codex', "echo 'codex-cli 0.170.0'")),
    { harness: 'codex', available: true, version: 'codex-cli 0.170.0' });
  assert.deepEqual(probeHarness('codex', script('old-codex', "echo 'codex-cli 0.100.0'")), uncertified);
  assert.deepEqual(probeHarness('codex', script('broken', 'exit 3')), { harness: 'codex', available: false, reason: 'probe-failed' });
  const deps = defaultSelectionDeps();
  assert.equal(typeof deps.interactive, 'boolean'); assert.equal(deps.probe, probeHarness);
  assert.equal(deps.recorded, recordedSelection); deps.say('');
  assert.equal(describeAvailability({ harness: 'codex', available: false, reason: 'probe-failed' }), 'codex: unavailable (probe-failed)');
});

test('the recorded selection is read only from a complete state identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'selection-record-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = (content: string) => { writeFileSync(join(directory, 'state.json'), content); return recordedSelection(directory); };
  assert.equal(recordedSelection(''), null);
  assert.equal(recordedSelection(join(directory, 'absent')), null);
  assert.equal(state('{'), null);
  assert.equal(state('null'), null);
  assert.equal(state(JSON.stringify({ identity: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' } })), null);
  assert.deepEqual(state(JSON.stringify({ identity: { harness: 'codex', model: 'gpt-a', effort: 'high', coverage: 90, leaves: ['A'] } })),
    { harness: 'codex', model: 'gpt-a', effort: 'high', coverage: 90 });
  assert.equal(existsSync(join(directory, 'lock.sqlite')), false);
});

// Runner integration: a scripted OpenSpec preflight, scripted selection and a worker that returns no report,
// so each run claims the task, records its identity and stops incomplete without a real harness.
const passingOpenspec: RunOptions['openspec'] = { probe: () => ({ status: 0 }), configPresent: () => true };
const host: PullRequestHost = { find: () => null, create: () => null, merge: () => {} };

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'selection-run-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, 'origin.git'); const root = join(directory, 'project'); mkdirSync(root);
  git(directory, 'init', '--bare', remote); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Selection Fixture'); git(root, 'config', 'user.email', 'selection@example.invalid');
  const task = { id: 'A', title: 'Select', change: 'select-a', priority: 1, criteria: ['Works.'], scopes: ['src/a'], dependencies: [] };
  mkdirSync(join(root, 'planning')); writeFileSync(join(root, 'planning/outcomes.json'), JSON.stringify({ version: 1, tasks: [task] }));
  mkdirSync(join(root, 'src/a'), { recursive: true }); writeFileSync(join(root, 'src/a/notes.md'), 'a\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: define outcome');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'HEAD:main');
  const config: RunConfig = { root, stateDirectory: join(directory, 'state'), invocation: 'selection', leaves: ['A'],
    authority: { reference: 'fixture', instruction: 'fixture', target: 'main', tasks: { A: hash(task) } },
    project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target: 'main',
      repository: 'fixture', checks: [{ command: 'node', args: ['-e', '', '{coverage}'] }],
      planningCheck: { command: 'node', args: ['-e', ''] } } };
  const prompts: string[] = [];
  const createAdapter = (_options: HarnessOptions): HarnessAdapter => ({ probe: () => ({ status: 'interface-ready' }), close() {},
    async startAction(prompt) { prompts.push(prompt); return { status: 'worker-returned', threadId: 'selection', events: [], text: '' } as WorkerReply; } });
  const state = () => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
  const run = (candidate: RunConfig, selection: Partial<SelectionDeps>) =>
    runQueue(candidate, { host, createAdapter, openspec: passingOpenspec, selection });
  return { directory, root, config, prompts, state, run };
}

/** Runner tests read the real state record, so the scripted `recorded` is dropped. */
function live(script: Script) {
  const { deps, calls } = scripted(script);
  const { recorded: _ignored, ...rest } = deps;
  return { deps: rest, calls };
}

test('runner: both probes run after the preflight and before any prompt; a preflight refusal skips them', async t => {
  const f = fixture(t);
  const refused = live({});
  await assert.rejects(runQueue(f.config, { host, openspec: { ...passingOpenspec, interactive: false, probe: () => ({ status: 1 }) },
    selection: refused.deps }), /OpenSpec CLI unavailable/u);
  assert.deepEqual(refused.calls.events, []);
  const { deps, calls } = live({});
  assert.equal((await f.run(f.config, deps)).status, 'incomplete');
  assert.deepEqual(calls.events.slice(0, 2), ['probe:claude', 'probe:codex']);
  assert.equal(calls.events.filter(event => event.startsWith('probe')).length, 2);
  assert.deepEqual(picked(f.state().identity), ['claude', 'claude-opus-5-5', 'medium', 85]);
});

test('runner: an interactive choice is frozen exactly like the same flags and drives the worker sessions', async t => {
  const f = fixture(t);
  const { deps } = live({ answers: ['', 'claude-sonnet-5-5', 'high', '90'] });
  assert.equal((await f.run(f.config, deps)).status, 'incomplete');
  const recorded = f.state();
  const flagged = { ...f.config, harness: 'claude' as Harness, model: 'claude-sonnet-5-5', effort: 'high', coverage: 90 };
  assert.equal(recorded.identityHash, hash({ ...flagged, leaves: ['A'] }));
  assert.ok(f.prompts.length && f.prompts.every(prompt => prompt.includes('Resolved coverage threshold: 90%.')));
  // A flag restart with the same values has the same identity and is accepted without prompts.
  const again = live({ interactive: false });
  assert.equal((await f.run(flagged, again.deps)).status, 'incomplete');
  assert.equal(f.state().identityHash, recorded.identityHash); assert.deepEqual(again.calls.asked, []);
  const adapter = createHarness({ cwd: f.root, tools: [{ type: 'function', name: 'echo', description: 'Echo', inputSchema: {} }],
    handleTool: async () => ({}) }, await resolveHarness(flagged, noCodex));
  assert.ok(adapter instanceof ClaudeAdapter);
  assert.deepEqual([adapter.model, adapter.effort], ['claude-sonnet-5-5', 'high']);
});

test('runner: choosing Codex reads it once and resolution validates against that catalog', async t => {
  const f = fixture(t);
  const { deps, calls } = live({ answers: ['codex', 'gpt-a', 'high', '90'] });
  assert.equal((await f.run(f.config, deps)).status, 'incomplete');
  assert.deepEqual(calls.codexReads, [f.root]);
  assert.deepEqual(picked(f.state().identity), ['codex', 'gpt-a', 'high', 90]);
  const flagged = live({ interactive: false, codex: codexFixture({ catalog: new Map([['gpt-a', ['low']]]) }) });
  await assert.rejects(f.run({ ...f.config, harness: 'codex', model: 'gpt-a', effort: 'high', stateDirectory: join(f.directory, 'other') },
    flagged.deps), /Effort "high" is not supported by model "gpt-a"/u);
  assert.equal(flagged.calls.codexReads.length, 1);
});

test('runner: a restart reuses the recorded Codex selection without prompts and reads Codex once', async t => {
  const f = fixture(t);
  const identity = { ...f.config, harness: 'codex', model: 'gpt-a', effort: 'high', coverage: 90, leaves: ['A'] };
  new RunStore(f.config.stateDirectory, identity, { repositoryRoot: f.root }).close();
  const before = f.state().identityHash;
  const { deps, calls } = live({ answers: [] });
  deps.ask = async question => { throw new Error(`No question may be asked: ${question}`); };
  assert.equal((await f.run(f.config, deps)).status, 'incomplete');
  assert.deepEqual(calls.codexReads, [f.root]);
  assert.equal(f.state().identityHash, before);
  assert.ok(f.prompts.length && f.prompts.every(prompt => prompt.includes('Resolved coverage threshold: 90%.')));
});

test('runner: a restart with a differing flag is refused as incompatible and leaves the state unchanged', async t => {
  const f = fixture(t);
  new RunStore(f.config.stateDirectory, { ...f.config, harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', coverage: 85,
    leaves: ['A'] }, { repositoryRoot: f.root }).close();
  const before = readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8');
  const { deps, calls } = live({});
  await assert.rejects(f.run({ ...f.config, model: 'claude-sonnet-5-5' }, deps), /incompatible/u);
  assert.deepEqual(calls.asked, []);
  assert.equal(readFileSync(join(f.config.stateDirectory, 'state.json'), 'utf8'), before);
  assert.equal(f.prompts.length, 0);
});

test('CLI: default answers keep stdout to JSON lines; an unavailable harness exits 4 before allocation', async t => {
  const f = fixture(t);
  const { root: _root, stateDirectory: _state, ...invocation } = f.config;
  const path = join(f.directory, 'invocation.json'); writeFileSync(path, JSON.stringify(invocation));
  const options = { cwd: f.root, env: { XDG_STATE_HOME: join(f.directory, 'xdg') } };
  const refused = live({ probes: { claude: missing('claude'), codex: uncertified } });
  const lines: string[] = [];
  assert.equal(await main(path, (config, runOptions) => runQueue(config, { ...runOptions, host, openspec: passingOpenspec,
    selection: refused.deps }), line => lines.push(line), options), 4);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  t.after(() => rmSync(join(report.diagnostics, '..'), { recursive: true, force: true }));
  assert.equal(report.reason, 'harness-unavailable');
  const message = JSON.parse(readFileSync(report.diagnostics, 'utf8')).message as string;
  for (const text of ['claude', 'not-installed', 'codex', 'uncertified-codex-version']) assert.ok(message.includes(text));
  assert.deepEqual(refused.calls.asked, []);
  assert.equal(existsSync(join(f.directory, '.work-queue-locks')), false);
  assert.equal(existsSync(join(f.directory, 'xdg')), false);
  const flagged = live({ probes: { codex: missing('codex') } });
  const flaggedLines: string[] = [];
  assert.equal(await main(path, (config, runOptions) => runQueue(config, { ...runOptions, host, openspec: passingOpenspec,
    selection: flagged.deps }), line => flaggedLines.push(line), { ...options, args: ['--harness=codex'] }), 4);
  const flaggedReport = JSON.parse(flaggedLines[0]);
  t.after(() => rmSync(join(flaggedReport.diagnostics, '..'), { recursive: true, force: true }));
  assert.equal(flaggedReport.reason, 'harness-unavailable');
  assert.match(JSON.parse(readFileSync(flaggedReport.diagnostics, 'utf8')).message, /claude: available.*codex: not-installed/u);
  const { deps, calls } = live({});
  const output: string[] = [];
  assert.equal(await main(path, (config, runOptions) => runQueue(config, { ...runOptions, host, openspec: passingOpenspec,
    createAdapter: () => ({ probe: () => ({ status: 'interface-ready' }), close() {},
      async startAction() { return { status: 'worker-returned', threadId: 'cli', events: [], text: 'private' } as WorkerReply; } }),
    selection: deps }), line => output.push(line), options), 3);
  assert.ok(output.length >= 2);
  for (const line of output) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(!output.join('').includes('available ('));
  assert.match(calls.said[0], /claude: available/u); assert.equal(calls.asked.length, 4);
});

test('README documents the interactive startup order, preselections, defaults, restart reuse and refusal', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Harness selection'));
  assert.ok(readme.includes('## Harness selection'));
  const order = ['OpenSpec preflight', 'Harness availability', 'Harness', 'Model', 'Effort', 'Coverage']
    .map(step => section.indexOf(`. **${step}**`));
  assert.ok(order.every(index => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(new Set(order).size, order.length);
  for (const text of ['claude-opus-5-5', 'medium', '85', 'Enter', 'isDefault', 'defaultReasoningEffort', 'Non-interactive',
    'harness-unavailable', 'not-installed', 'uncertified-claude-version', 'uncertified-codex-version', 'probe-failed',
    'restart', 'stderr']) {
    assert.ok(section.includes(text), `README selection section mentions ${text}`);
  }
});
