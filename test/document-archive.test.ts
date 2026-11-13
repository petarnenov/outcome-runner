import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, receiptAt } from '../src/git.ts';
import { DEFAULT_ARCHIVE, archiveCommand, digest, hash, isDocumentation, specsDirectory, validateConfig } from '../src/model.ts';
import type { Project, PullRequest, Queue, RunConfig, Work } from '../src/model.ts';
import { manifestScopes, outsideManifest, pullRequestBody, rekeyBinding, runQueue } from '../src/runner.ts';
import type { RunOptions } from '../src/runner.ts';
import { RunStore } from '../src/run-store.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';
import { preparedTestFramework } from './support/prepared-test-framework.ts';
import { archiveDate, scriptedArchive } from './support/scripted-archive.ts';
import type { ArchiveCall } from './support/scripted-archive.ts';

// Every run uses scripted adapters, Git fixtures and a scripted archive command; the real openspec never runs.
const passing: RunOptions = { openspec: { probe: () => ({ status: 0 }), configPresent: () => true },
  selection: { interactive: false, probe: harness => ({ harness, available: true, version: 'scripted' }) },
  testFramework: preparedTestFramework, mergePolling: { delay: async () => {} } };
const interrupted = () => Object.assign(new Error('Interrupted'), { interrupted: true });

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'archive-test-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git'); const root = join(base, 'project');
  mkdirSync(root); git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'integration');
  git(root, 'config', 'user.name', 'Fixture Worker'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const project: Project = { queue: 'planning/queue.json', changes: 'openspec/changes', receipts: 'evidence/receipts',
    target: 'proposal', repository: 'fixture', commitScope: 'fixture-tools',
    planningCheck: { command: 'node', args: ['-e', 'process.exit(0)', '{change}'] },
    checks: [{ command: 'node', args: ['checks.mjs'] },
      { command: 'node', args: ['--test', '--experimental-test-coverage', '--test-coverage-lines={coverage}', '{scope}/*.test.mjs'] }] };
  const queue: Queue = { version: 1, tasks: [{ id: 'A', priority: 0, title: 'Implement finite counter A',
    change: 'counter-a', scopes: ['src/a'], dependencies: [],
    criteria: ['Create src/a/result.mjs exporting next(n) that returns n + 1 for finite numbers.'] }] };
  mkdirSync(join(root, 'planning'), { recursive: true });
  writeFileSync(join(root, project.queue), JSON.stringify(queue));
  mkdirSync(join(root, 'openspec'), { recursive: true });
  writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  mkdirSync(join(root, 'src/a'), { recursive: true });
  writeFileSync(join(root, 'src/a/requirements.md'), queue.tasks[0].criteria.join('\n'));
  writeFileSync(join(root, 'checks.mjs'), "import assert from 'node:assert/strict';\nimport {existsSync} from 'node:fs';\n" +
    "if (existsSync('src/a/result.mjs')) { const {next} = await import('./src/a/result.mjs'); assert.equal(next(1), 2); }\n");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test(fixture-tools): define outcomes');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', `HEAD:${project.target}`);
  const integrator = join(base, 'integrator'); git(base, 'clone', remote, integrator);
  git(integrator, 'config', 'user.name', 'Fixture Integrator'); git(integrator, 'config', 'user.email', 'integrator@example.invalid');
  const records: PullRequest[] = []; const bodies: string[] = [];
  const host = { find: (branch: string) => records.find(pr => pr.branch === branch) ?? null,
    create(work: Work, body: string) {
      bodies.push(readFileSync(body, 'utf8'));
      const pr = { number: records.length + 1, branch: work.branch, state: 'OPEN',
        headRefOid: git(work.path, 'rev-parse', 'HEAD') } as PullRequest; records.push(pr); return pr;
    },
    merge(pr: PullRequest, head: string) {
      git(integrator, 'fetch', 'origin'); git(integrator, 'checkout', '-B', project.target, `origin/${project.target}`);
      git(integrator, 'merge', '--no-ff', head, '-m', `feat(fixture-tools): accept ${pr.number}`);
      git(integrator, 'push', 'origin', `HEAD:${project.target}`); pr.state = 'MERGED';
    } };
  const config: RunConfig = { root, harness: 'claude', model: 'claude-opus-5-5', effort: 'medium',
    stateDirectory: join(base, 'state'), invocation: 'archive', project, leaves: ['A'],
    authority: { reference: 'fixture-owner-off', instruction: 'OFF implement these exact outcomes and normally merge.',
      target: project.target, tasks: { A: hash(queue.tasks[0]) } } };
  const state = () => JSON.parse(readFileSync(join(config.stateDirectory, 'state.json'), 'utf8'));
  const advance = (path: string, content: string) => {
    const clone = join(base, `advance-${records.length}-${Math.random().toString(36).slice(2)}`);
    git(base, 'clone', '-b', project.target, remote, clone);
    git(clone, 'config', 'user.name', 'Fixture Advance'); git(clone, 'config', 'user.email', 'advance@example.invalid');
    mkdirSync(join(clone, path, '..'), { recursive: true }); writeFileSync(join(clone, path), content);
    git(clone, 'add', '.'); git(clone, 'commit', '-m', 'test(fixture-tools): advance target');
    git(clone, 'push', 'origin', `HEAD:${project.target}`);
  };
  return { base, root, project, config, host, records, bodies, state, advance };
}

type Kind = 'investigate' | 'plan' | 'planningReview' | 'work' | 'implementationReview' | 'document' | 'documentReview';
const kindOf = (prompt: string): Kind => prompt.includes('Inspect current files') ? 'investigate' :
  prompt.includes('Create proposal.md') ? 'plan' : prompt.includes('Review planning artifacts') ? 'planningReview' :
  prompt.includes('Implement all approved') ? 'work' : prompt.includes('Update the documentation inside') ? 'document' :
  prompt.includes('Review the documentation changes') ? 'documentReview' : 'implementationReview';

interface Tools {
  call: (name: string, input: ToolInput) => Promise<any>;
  write: (path: string, content: string) => Promise<any>;
}
interface Hooks {
  prompts?: { kind: Kind; prompt: string }[];
  /** Runs in each documentation session; returned strings become its findings. */
  document?: (tools: Tools, round: number) => Promise<string[] | void>;
  /** Decides each documentation review; the default accepts with zero findings. */
  documentReview?: (round: number) => { outcome: string; findings: string[] } | void;
}

// A scripted adapter; it never starts a real harness.
function worker(hooks: Hooks = {}) {
  const rounds = { document: 0, documentReview: 0 };
  return (options: HarnessOptions): HarnessAdapter => {
    const call = (name: string, input: ToolInput) => options.handleTool(name, input, { threadId: 'archive' }) as Promise<any>;
    const write = async (path: string, content: string) => {
      const before = await call('backlog_tool', { operation: 'read_file', input: { path } as BrokerInput });
      return call('backlog_tool', { operation: 'write_file', input: { path, content, expectedHash: before.hash } as BrokerInput });
    };
    return { probe: () => ({ status: 'interface-ready' }), close() {}, async startAction(prompt: string) {
      const kind = kindOf(prompt); hooks.prompts?.push({ kind, prompt });
      const directory = 'openspec/changes/counter-a';
      const result: ToolInput = { outcome: 'ready', summary: 'Scripted archive adapter', findings: [] };
      if (kind === 'investigate') result.inspected = ['src/a/requirements.md'];
      else if (kind === 'plan') {
        await write(`${directory}/proposal.md`, '# Proposal\n\nImplement the finite counter.\n');
        await write(`${directory}/design.md`, '# Design\n\nAdd one to finite input.\n');
        await write(`${directory}/tasks.md`, '# Tasks\n\n- [ ] 1.1 [E] (required) next(1) returns 2.\n');
        await write(`${directory}/specs/finite-counter/spec.md`, '## ADDED Requirements\n\n' +
          '### Requirement: Finite increment\nThe function SHALL increment finite numbers.\n\n' +
          '#### Scenario: Finite input\n- **WHEN** input is one\n- **THEN** the result is two\n');
      } else if (kind === 'work') {
        await write('src/a/result.mjs', 'export function next(n) { if (!Number.isFinite(n)) throw new TypeError(); return n + 1; }\n');
        await write('src/a/result.test.mjs', "import assert from 'node:assert/strict'; import {next} from './result.mjs'; assert.equal(next(1), 2);\n");
      } else if (kind === 'document') {
        const findings = await hooks.document?.({ call, write }, ++rounds.document);
        if (findings) result.findings = findings;
      } else if (kind === 'documentReview') {
        const verdict = hooks.documentReview?.(++rounds.documentReview);
        result.outcome = verdict?.outcome ?? 'accepted'; result.findings = verdict?.findings ?? [];
      } else {
        result.outcome = 'accepted';
        if (kind === 'implementationReview') {
          result.completion = { summary: 'The counter increments finite numbers. Tests cover it.', grade: 'E' };
        }
      }
      await call('outcome_report', result);
      return { threadId: `archive-${kind}`, events: [], text: '' } as unknown as WorkerReply;
    } };
  };
}

const count = (prompts: { kind: Kind }[], kind: Kind) => prompts.filter(entry => entry.kind === kind).length;
const archived = `openspec/changes/archive/${archiveDate()}-counter-a`;

// E (required): the archive command defaults to openspec archive {change} --yes and must be an argument array.
test('E: the archive command defaults to openspec archive and is validated as an argument array', t => {
  const f = fixture(t);
  assert.deepEqual(DEFAULT_ARCHIVE, { command: 'openspec', args: ['archive', '{change}', '--yes'] });
  assert.deepEqual(archiveCommand(f.project), DEFAULT_ARCHIVE);
  validateConfig(f.config);
  const custom = { command: 'node', args: ['archive.mjs', '{change}'] };
  assert.deepEqual(archiveCommand({ ...f.project, archive: custom }), custom);
  validateConfig({ ...f.config, project: { ...f.project, archive: custom } });
  for (const archive of [{ command: 'openspec', args: 'archive {change} --yes' }, { command: '', args: [] },
    { command: 'openspec', args: ['archive', 3] }, 'openspec archive {change} --yes']) {
    assert.throws(() => validateConfig({ ...f.config, project: { ...f.project, archive } as unknown as Project }),
      /argument arrays/u);
  }
  assert.equal(specsDirectory('openspec/changes'), 'openspec/specs');
  assert.equal(specsDirectory('changes'), 'specs');
});

// E (coverage-only): the documentation classifier.
test('E: documentation paths are README files, Markdown files and docs directories', () => {
  for (const path of ['README.md', 'README', 'src/a/readme.txt', 'src/a/guide.md', 'src/a/page.mdx', 'docs/setup.txt',
    'src/a/doc/diagram.svg', 'src/a/docs/index.html']) assert.ok(isDocumentation(path), path);
  for (const path of ['src/a/result.mjs', 'src/a/result.test.mjs', 'src/a/docsy.ts', 'src/a/readmefile.ts',
    'documentation.json']) assert.ok(!isDocumentation(path), path);
});

function receiptRepository(t: TestContext, specification: string) {
  const root = mkdtempSync(join(tmpdir(), 'archive-receipt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const files: Record<string, string> = { [specification]: '## ADDED Requirements\n', 'src/a/result.mjs': 'export {};\n',
    'openspec/specs/finite-counter/spec.md': '# Finite counter\n' };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
  }
  const receipt = { version: 1, id: 'A', taskHash: 'task', authority: 'fixture-owner-off',
    specification: { [specification]: digest(files[specification]) },
    review: { reviewer: 'claude:review', outcome: 'accepted', accepted: true },
    checks: [{ command: 'node', args: ['checks.mjs'], outcome: 'passed' }],
    manifest: Object.entries(files).map(([path, content]) => ({ path, hash: digest(content) })), head: 'head', base: 'base' };
  mkdirSync(join(root, 'evidence/receipts'), { recursive: true });
  writeFileSync(join(root, 'evidence/receipts/A.json'), JSON.stringify(receipt));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: record receipt');
  return root;
}

// D (required): receipts with archived specification paths and existing receipts with unarchived paths are valid.
test('D: receipt validation accepts archived specification paths and existing unarchived receipts', t => {
  for (const path of [`${archived}/specs/finite-counter/spec.md`, 'openspec/changes/counter-a/specs/finite-counter/spec.md']) {
    const root = receiptRepository(t, path);
    const receipt = receiptAt(root, 'HEAD', 'evidence/receipts/A.json', 'task', null)!;
    assert.deepEqual(Object.keys(receipt.specification), [path]);
  }
  const root = receiptRepository(t, `${archived}/specs/finite-counter/spec.md`);
  writeFileSync(join(root, archived, 'specs/finite-counter/spec.md'), 'changed\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: change archived spec');
  // Validation reads the files of the commit that added the receipt, so later commits keep it valid.
  assert.ok(receiptAt(root, 'HEAD', 'evidence/receipts/A.json', 'task', null));
  assert.throws(() => receiptAt(root, 'HEAD', 'evidence/receipts/A.json', 'other', null), /Invalid accepted outcome receipt/u);
});

// D (required): a path the task deleted is recorded with hash null and is valid only while it is absent.
function deletionRepository(t: TestContext, nullPath: string) {
  const root = mkdtempSync(join(tmpdir(), 'deletion-receipt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  const specification = `${archived}/specs/finite-counter/spec.md`;
  const leftover = 'test/zz-debug-capture.test.ts';
  const files: Record<string, string> = { [specification]: '## ADDED Requirements\n', 'src/a/result.mjs': 'export {};\n' };
  for (const [path, content] of Object.entries({ ...files, [leftover]: 'debug\n' })) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
  }
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: base with a leftover');
  rmSync(join(root, leftover));
  const manifest = [...Object.entries(files).map(([path, content]) => ({ path, hash: digest(content) })),
    { path: leftover, hash: null }].map(entry => entry.path === nullPath ? { ...entry, hash: null } : entry);
  const receipt = { version: 1, id: 'A', taskHash: 'task', authority: 'fixture-owner-off',
    specification: { [specification]: digest(files[specification]) },
    review: { reviewer: 'claude:review', outcome: 'accepted', accepted: true },
    checks: [{ command: 'node', args: ['checks.mjs'], outcome: 'passed' }], manifest, head: 'head', base: 'base' };
  mkdirSync(join(root, 'evidence/receipts'), { recursive: true });
  writeFileSync(join(root, 'evidence/receipts/A.json'), JSON.stringify(receipt));
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'test: delete the leftover and record receipt');
  return root;
}

test('D: receipt validation accepts a deleted path with hash null and rejects null for a present file', t => {
  const deleted = deletionRepository(t, 'test/zz-debug-capture.test.ts');
  assert.ok(receiptAt(deleted, 'HEAD', 'evidence/receipts/A.json', 'task', null));
  const present = deletionRepository(t, 'src/a/result.mjs');
  assert.throws(() => receiptAt(present, 'HEAD', 'evidence/receipts/A.json', 'task', null), /Accepted result differs from receipt/u);
});

// D (required): the manifest accepts scopes, the archived change and archive spec files and rejects anything else.
test('D: the result manifest accepts scope, archived change and archive spec paths only', () => {
  const work = { scopes: ['src/a'], directory: 'openspec/changes/counter-a',
    archive: { directory: archived, specs: ['openspec/specs/finite-counter/spec.md'], head: 'head' } };
  const accepted = ['src/a/result.mjs', 'src/a/README.md', `${archived}/proposal.md`, `${archived}/specs/finite-counter/spec.md`,
    'openspec/specs/finite-counter/spec.md'];
  assert.deepEqual(outsideManifest(accepted, work), []);
  const rejected = ['src/b/result.mjs', 'README.md', 'openspec/specs/other/spec.md', 'openspec/changes/counter-a/proposal.md',
    'openspec/changes/archive/2026-01-01-counter-b/proposal.md', 'evidence/receipts/A.json'];
  assert.deepEqual(outsideManifest([...accepted, ...rejected], work), rejected);
  assert.deepEqual(manifestScopes(work), ['src/a', archived, 'openspec/specs/finite-counter/spec.md']);
  // A run recorded before the archive stage keeps its change directory.
  assert.deepEqual(outsideManifest(['openspec/changes/counter-a/proposal.md'], { scopes: ['src/a'],
    directory: 'openspec/changes/counter-a' }), []);
  assert.deepEqual(rekeyBinding({ 'openspec/changes/counter-a/proposal.md': 'one', 'other/file.md': 'two' },
    'openspec/changes/counter-a', archived), { [`${archived}/proposal.md`]: 'one', 'other/file.md': 'two' });
});

// D (required): the pull request body lists the updated documentation and the archived change.
test('D: the pull request body lists updated documentation and the archived change directory', () => {
  const work = { id: 'A', change: 'counter-a', head: 'head', testedTarget: 'target', finalChecks: [], reviews: [],
    documentation: { base: 'base', files: ['src/a/README.md', 'src/a/docs/usage.md'], outsideScope: [] },
    archive: { directory: archived, specs: ['openspec/specs/finite-counter/spec.md'], head: 'head' } } as unknown as Work;
  const body = pullRequestBody(work, 'fixture-owner-off');
  assert.ok(body.includes('Documentation updated:\n- src/a/README.md\n- src/a/docs/usage.md\n'));
  assert.ok(body.includes(`Archived change: ${archived}\n`));
  assert.ok(!body.includes('Documentation outside scope'));
  const empty = pullRequestBody({ ...work, documentation: undefined, archive: undefined }, 'fixture-owner-off');
  assert.ok(empty.includes('Documentation updated:\n- none\n')); assert.ok(empty.includes('Archived change: none\n'));
});

// C (required): the default archive command runs as an argument array in the task worktree.
test('C: without a project archive command the runner invokes openspec archive <change> --yes in the worktree', async t => {
  const f = fixture(t); const calls: ArchiveCall[] = [];
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(calls, [{ cwd: f.state().completed.A.path, program: 'openspec', args: ['archive', 'counter-a', '--yes'] }]);
});

// C: a configured archive command runs through the default runner without a shell, with {change} substituted.
test('C: a configured archive command runs without a shell and receives the change name', async t => {
  const f = fixture(t);
  const script = "const f=require('node:fs');const c=process.argv[1];const d='openspec/changes/archive/2026-01-02-'+c;" +
    "f.mkdirSync('openspec/changes/archive',{recursive:true});f.renameSync('openspec/changes/'+c,d);" +
    "f.mkdirSync('openspec/specs/finite-counter',{recursive:true});" +
    "f.copyFileSync(d+'/specs/finite-counter/spec.md','openspec/specs/finite-counter/spec.md');";
  const project = { ...f.project, archive: { command: 'node', args: ['-e', script, '{change}'] } };
  const result = await runQueue({ ...f.config, project }, { ...passing, host: f.host, createAdapter: worker() });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(f.state().completed.A.archive.directory, 'openspec/changes/archive/2026-01-02-counter-a');
  assert.ok(git(f.root, 'show', `origin/proposal:openspec/changes/archive/2026-01-02-counter-a/proposal.md`));
});

// C (required): documentation is written only to documentation files inside the scopes.
test('C: the documentation session writes only documentation files inside the task scopes', async t => {
  const f = fixture(t); const refusals: string[] = [];
  const result = await runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive(),
    createAdapter: worker({ document: async ({ write, call }) => {
      await write('src/a/README.md', '# Counter\n\nnext(n) returns n + 1 for finite numbers.\n');
      for (const path of ['src/a/result.mjs', 'docs/guide.md', 'README.md', 'openspec/changes/counter-a/tasks.md']) {
        await assert.rejects(write(path, 'changed\n'), (error: Error) => { refusals.push(`${path}: ${error.message}`); return true; });
      }
      const before = await call('backlog_tool', { operation: 'read_file', input: { path: 'src/a/result.mjs' } as BrokerInput });
      await assert.rejects(call('backlog_tool', { operation: 'delete_file',
        input: { path: 'src/a/result.mjs', expectedHash: before.hash } as BrokerInput }), /documentation files/u);
    } }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.match(refusals[0], /^src\/a\/result\.mjs: Documentation sessions write only documentation files/u);
  for (const refusal of refusals.slice(1)) assert.match(refusal, /outside reserved scope/u);
  assert.deepEqual(f.state().completed.A.documentation.files, ['src/a/README.md']);
  assert.match(git(f.root, 'show', 'origin/proposal:src/a/README.md'), /finite numbers/u);
  assert.match(git(f.root, 'show', 'origin/proposal:src/a/result.mjs'), /Number\.isFinite/u);
  assert.ok(f.bodies[0].includes('Documentation updated:\n- src/a/README.md\n'));
});

// C (required): documentation outside the scopes is reported in the pull request body.
test('C: documentation outside the scopes is listed in the pull request body', async t => {
  const f = fixture(t);
  const outside = 'README.md: describe the finite counter in the project overview';
  const result = await runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive(),
    createAdapter: worker({ document: async () => [outside] }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.ok(f.bodies[0].includes(`Documentation outside scope:\n- ${outside}\n`));
  assert.ok(f.bodies[0].includes(`Archived change: ${archived}\n`));
  assert.deepEqual(f.state().completed.A.documentation.outsideScope, [outside]);
});

// C (required): a failing archive command blocks with bounded output.
test('C: a failing archive command blocks the task with bounded output', async t => {
  const f = fixture(t); const calls: ArchiveCall[] = [];
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls, fail: 'x'.repeat(40000) + 'ARCHIVE-END' }) });
  assert.equal(result.status, 'incomplete'); assert.equal(f.records.length, 0); assert.equal(calls.length, 1);
  const blocked = f.state().blocked.A;
  assert.equal(blocked.work.stage, 'archive');
  assert.match(blocked.reason, /^Archive command failed: x+ARCHIVE-END$/u);
  assert.ok(blocked.reason.length <= 16100);
});

function recordStages(t: TestContext): string[] {
  const stages: string[] = []; const update = RunStore.prototype.update;
  RunStore.prototype.update = function (this: RunStore, ...args: Parameters<RunStore['update']>) {
    const result = update.apply(this, args);
    const stage = this.state.current?.stage;
    if (stage && stages.at(-1) !== stage) stages.push(stage);
    return result;
  };
  t.after(() => { RunStore.prototype.update = update; });
  return stages;
}

// B (required): the persisted stage order after the accepted implementation review.
test('B: the run state persists every stage after the accepted implementation review in order', async t => {
  const f = fixture(t); const stages = recordStages(t);
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(), runCommand: scriptedArchive() });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.deepEqual(stages.slice(stages.lastIndexOf('work') + 1),
    ['document', 'document-review', 'final-checks', 'archive', 'receipt', 'publish', 'pr', 'merge']);
});

// B (required): a restart in document-review does not repeat the documentation session.
test('B: a restart in document-review reviews again without another documentation session', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = [];
  await assert.rejects(runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive(),
    createAdapter: worker({ prompts, documentReview: () => { throw interrupted(); } }) }), /Interrupted/u);
  assert.equal(f.state().current.stage, 'document-review');
  const result = await runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive(),
    createAdapter: worker({ prompts }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(count(prompts, 'document'), 1); assert.equal(count(prompts, 'documentReview'), 2);
});

// B (required): checks re-run after documentation; a failure blocks before the archive, and the restart
// resumes in final-checks without another documentation session or review.
test('B: checks re-run after documentation, a failure blocks before archive and the restart resumes there', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = []; const calls: ArchiveCall[] = [];
  const counter = join(f.base, 'check-count');
  // The check passes after implementation, fails once when checks run again after documentation, then passes.
  const script = "const f=require('node:fs'),p=process.argv[1];const n=f.existsSync(p)?Number(f.readFileSync(p)):0;" +
    'f.writeFileSync(p,String(n+1));if(n===1)process.exit(1)';
  const config = { ...f.config, project: { ...f.project,
    checks: [...f.project.checks, { command: 'node', args: ['-e', script, counter] }] } };
  const first = await runQueue(config, { ...passing, host: f.host, createAdapter: worker({ prompts }),
    runCommand: scriptedArchive({ calls }) });
  assert.equal(first.status, 'incomplete');
  assert.equal(f.state().blocked.A.work.stage, 'final-checks'); assert.equal(calls.length, 0);
  assert.equal(f.state().blocked.A.work.documentationReviews.length, 1);
  const result = await runQueue(config, { ...passing, host: f.host, createAdapter: worker({ prompts }),
    runCommand: scriptedArchive({ calls }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(count(prompts, 'document'), 1); assert.equal(count(prompts, 'documentReview'), 1);
  assert.equal(calls.length, 1);
  const completed = f.state().completed.A;
  assert.ok(completed.documentationChecks.length === config.project.checks.length &&
    completed.documentationChecks.every((check: { outcome: string }) => check.outcome === 'passed'));
});

// B (required): a documentation review that needs a second round.
test('B: a documentation review finding is repaired in a second round', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = [];
  const finding = 'Describe that nonfinite input throws TypeError.';
  const result = await runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive(),
    createAdapter: worker({ prompts,
      document: async ({ write }, round) => {
        await write('src/a/README.md', round === 1 ? '# Counter\n' : '# Counter\n\nNonfinite input throws TypeError.\n');
      },
      documentReview: round => round === 1 ? { outcome: 'changes-required', findings: [finding] } : undefined }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(count(prompts, 'document'), 2); assert.equal(count(prompts, 'documentReview'), 2);
  const second = prompts.filter(entry => entry.kind === 'document')[1].prompt;
  assert.ok(second.includes(JSON.stringify([finding])));
  const completed = f.state().completed.A;
  assert.deepEqual(completed.documentationReviews.map((review: { outcome: string }) => review.outcome),
    ['changes-required', 'accepted']);
  assert.match(git(f.root, 'show', 'origin/proposal:src/a/README.md'), /TypeError/u);
});

// B (required): an unresolved documentation review blocks after four rounds with the exhausted documentation budget.
test('B: a documentation review unresolved after four rounds blocks the task', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = []; const calls: ArchiveCall[] = [];
  const result = await runQueue(f.config, { ...passing, host: f.host, runCommand: scriptedArchive({ calls }),
    createAdapter: worker({ prompts, documentReview: () => ({ outcome: 'changes-required', findings: ['Still incomplete.'] }) }) });
  assert.equal(result.status, 'incomplete'); assert.equal(f.records.length, 0); assert.equal(calls.length, 0);
  const blocked = f.state().blocked.A;
  assert.equal(blocked.reason, 'Documentation review budget exhausted: 4 of 4 review rounds and 0 of 0 check attempts used');
  assert.equal(blocked.work.documentationReviews.length, 4);
  assert.equal(count(prompts, 'document'), 4); assert.equal(count(prompts, 'documentReview'), 4);
});

// B (required): the archive relocates the change and updates openspec/specs.
test('B: the archive relocates the change to the dated archive directory and updates openspec/specs', async t => {
  const f = fixture(t);
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(), runCommand: scriptedArchive() });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const files = git(f.root, 'ls-tree', '-r', '--name-only', 'origin/proposal').split('\n');
  assert.match(archived, /^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-counter-a$/u);
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/finite-counter/spec.md']) {
    assert.ok(files.includes(`${archived}/${path}`), path);
  }
  assert.ok(!files.some(path => path.startsWith('openspec/changes/counter-a/')));
  assert.match(git(f.root, 'show', 'origin/proposal:openspec/specs/finite-counter/spec.md'), /Finite increment/u);
  assert.deepEqual(f.state().completed.A.archive.specs, ['openspec/specs/finite-counter/spec.md']);
  assert.equal(f.state().completed.A.archive.directory, archived);
});

// B (required): the binding follows the archived files, and a changed archived file blocks.
test('B: the binding is re-keyed to the archived paths and a hash mismatch blocks', async t => {
  const f = fixture(t);
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(), runCommand: scriptedArchive() });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  const completed = f.state().completed.A;
  const keys = Object.keys(completed.specification);
  assert.ok(keys.length && keys.every(path => path.startsWith(`${archived}/`)), keys.join());
  const receipt = JSON.parse(git(f.root, 'show', 'origin/proposal:evidence/receipts/A.json'));
  assert.deepEqual(receipt.specification, completed.specification);
  for (const [path, value] of Object.entries(receipt.specification)) {
    assert.equal(digest(git(f.root, 'show', `origin/proposal:${path}`) + '\n'), value);
  }
  const g = fixture(t);
  const blocked = await runQueue(g.config, { ...passing, host: g.host, createAdapter: worker(),
    runCommand: scriptedArchive({ after: (cwd, directory) => writeFileSync(join(cwd, directory, 'design.md'), '# Altered\n') }) });
  assert.equal(blocked.status, 'incomplete'); assert.equal(g.records.length, 0);
  assert.equal(g.state().blocked.A.reason, 'Archived specification differs from binding');
  assert.equal(g.state().blocked.A.work.stage, 'archive');
  const h = fixture(t);
  const extra = await runQueue(h.config, { ...passing, host: h.host, createAdapter: worker(),
    runCommand: scriptedArchive({ after: (cwd, directory) => {
      mkdirSync(join(cwd, directory, 'specs/other'), { recursive: true });
      writeFileSync(join(cwd, directory, 'specs/other/spec.md'), '# Unbound\n');
    } }) });
  assert.equal(extra.status, 'incomplete');
  assert.equal(h.state().blocked.A.reason, 'Archived specification differs from binding');
});

// A (required): a restart between archive and receipt never archives again.
test('A: a restart between archive and receipt resumes without running the archive again', async t => {
  const f = fixture(t); const calls: ArchiveCall[] = [];
  await assert.rejects(runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls }), afterEffect: async kind => { if (kind === 'archive') throw interrupted(); } }),
  /Interrupted/u);
  const current = f.state().current;
  assert.equal(current.stage, 'receipt'); assert.equal(current.archive.directory, archived); assert.equal(calls.length, 1);
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls }) });
  assert.equal(result.status, 'exhausted', JSON.stringify(result));
  assert.equal(calls.length, 1); assert.equal(f.records.length, 1);
  // A run whose state still says archive after the files moved treats the archive as done.
  const g = fixture(t); const again: ArchiveCall[] = [];
  await assert.rejects(runQueue(g.config, { ...passing, host: g.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls: again }), afterEffect: async kind => { if (kind === 'archive') throw interrupted(); } }),
  /Interrupted/u);
  const path = join(g.config.stateDirectory, 'state.json'); const state = JSON.parse(readFileSync(path, 'utf8'));
  state.current.stage = 'archive'; state.current.specification = Object.fromEntries(Object.entries(state.current.specification)
    .map(([key, value]) => [key.replace(`${archived}/`, 'openspec/changes/counter-a/'), value]));
  delete state.current.archive; writeFileSync(path, JSON.stringify(state));
  const resumed = await runQueue(g.config, { ...passing, host: g.host, createAdapter: worker(),
    runCommand: scriptedArchive({ calls: again }) });
  assert.equal(resumed.status, 'exhausted', JSON.stringify(resumed)); assert.equal(again.length, 1);
  assert.deepEqual(g.state().completed.A.archive.specs, ['openspec/specs/finite-counter/spec.md']);
});

// A (required): a target change to the same openspec/specs file conflicts outside the task scopes; the worker gets its
// resolution session, and the task blocks with target-conflict-unresolved and that path when the markers remain.
test('A: a target advance changing the same spec file blocks with its path when the resolution leaves markers', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = [];
  const path = 'openspec/specs/finite-counter/spec.md';
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker({ prompts }),
    runCommand: scriptedArchive(), afterEffect: async kind => { if (kind === 'archive') f.advance(path, '# Foreign change\n'); } });
  assert.equal(result.status, 'incomplete'); assert.equal(f.records.length, 0);
  const blocked = f.state().blocked.A;
  assert.equal(blocked.reason, 'target-conflict-unresolved');
  assert.deepEqual(blocked.paths, [path]);
  assert.equal(blocked.work.stage, 'integrate');
  assert.deepEqual(result.blockers!.A.paths, [path]);
  assert.equal(prompts.filter(entry => entry.prompt.includes('Resolve the merge conflicts')).length, 1);
});

// A (required): a target change to the archived change is merged, and the result is checked and reviewed again.
test('A: a target advance changing the archived change is merged, checked and reviewed again', async t => {
  const f = fixture(t); const prompts: { kind: Kind; prompt: string }[] = [];
  const result = await runQueue(f.config, { ...passing, host: f.host, createAdapter: worker({ prompts }),
    runCommand: scriptedArchive(),
    afterEffect: async kind => { if (kind === 'archive') f.advance(`${archived}/notes.md`, '# Foreign change\n'); } });
  assert.equal(result.status, 'exhausted', JSON.stringify(result)); assert.equal(f.records.length, 1);
  const completed = f.state().completed.A;
  assert.equal(completed.integrations.length, 1); assert.equal(completed.integrations[0].outcome, 'clean');
  assert.equal(count(prompts, 'implementationReview'), 2); assert.equal(count(prompts, 'documentReview'), 2);
  assert.ok(git(f.root, 'show', `origin/proposal:${archived}/notes.md`));
});

test('README documents the documentation and archive stages', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Documentation and archive'));
  assert.ok(readme.includes('## Documentation and archive'));
  for (const text of ['document', 'document-review', 'final-checks', 'archive', 'openspec archive {change} --yes',
    '<changes>/archive/<YYYY-MM-DD>-<change>', 'openspec/specs', 'Documentation outside scope',
    'Documentation review budget exhausted', 'Archived specification differs from binding']) {
    assert.ok(section.includes(text), `README documentation section mentions ${text}`);
  }
});
