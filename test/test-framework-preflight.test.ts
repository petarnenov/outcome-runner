import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { git } from '../src/git.ts';
import { hash, within } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';
import { main } from '../src/cli.ts';
import { runQueue } from '../src/runner.ts';
import type { PullRequestHost, RunOptions } from '../src/runner.ts';
import { PreflightError } from '../src/openspec-preflight.ts';
import { SAFE_FAILURE_REASONS, ledgerPath, safeFailure } from '../src/statistics.ts';
import { defaultTestFrameworkDeps, isPrepared, refusedChange, temporaryWorktree, testFrameworkPreflight,
  testFrameworkReportTool, validateReport, workingTreeSnapshot } from '../src/test-framework-preflight.ts';
import type { TestFrameworkDeps, Technology } from '../src/test-framework-preflight.ts';
import type { BrokerInput, HarnessAdapter, HarnessOptions, ToolInput, WorkerReply } from '../src/harness-adapter.ts';

// Every test scripts the harness session, the temporary worktree, the answers, the install executor, the snapshots
// and the file writes; only the default worktree and snapshot tests use git, and no test starts a harness,
// runs a package manager or uses a real TTY.

const TRACKED: Record<string, string> = { 'package.json': '{"name":"fixture"}\n', 'pyproject.toml': '[project]\nname = "fixture"\n',
  'go.mod': 'module fixture\n', 'src/app.py': 'print(1)\n' };
const reply = { status: 'worker-returned', threadId: 'analysis', events: [], text: 'private' } as WorkerReply;
const context = { threadId: 'analysis' };

function workspace(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'test-framework-preflight-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'); mkdirSync(root);
  return { base, root };
}

const configFor = (root: string, coverage?: number, target = 'main'): RunConfig => ({ root, stateDirectory: join(root, '..', 'state'),
  invocation: 'test-framework', coverage,
  authority: { reference: 'fixture', instruction: 'fixture', target, tasks: {} },
  project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target,
    checks: [{ command: 'node', args: ['{coverage}'] }], planningCheck: { command: 'openspec', args: ['validate'] } } });

const thresholds = (value: number | null) => ({ lines: value, branches: value, functions: value });
const prepared = (name = 'Node.js', threshold = 85) => ({ name, kind: 'runtime', evidence: ['package.json'],
  frameworks: [{ name: 'node:test', evidence: ['package.json'], thresholds: thresholds(threshold) }], recommendations: [] });
const recommendation = (framework: string, coverage = 85, patch: object = {}) => ({ framework,
  rationale: `${framework} enforces line, branch and function coverage.`,
  install: [{ command: 'npm', args: ['install', '--save-dev', framework] }],
  changes: [{ path: `${framework}.config.json`, content: `{"threshold":${coverage}}\n` }], thresholds: thresholds(coverage), ...patch });
const python = (patch: object = {}) => ({ name: 'Python', kind: 'language', evidence: ['pyproject.toml'], frameworks: [],
  recommendations: [recommendation('pytest')], ...patch });
const go = (patch: object = {}) => ({ name: 'Go', kind: 'language', evidence: ['go.mod'], frameworks: [],
  recommendations: [recommendation('gotest')], ...patch });

interface Script {
  interactive?: boolean;
  answers?: string[];
  reports?: unknown[];
  probe?: string;
  failure?: Error;
  addFailure?: Error;
  status?: (command: string, args: string[]) => number | null;
  snapshots?: Map<string, string>[];
  files?: string[];
  onSession?: (options: HarnessOptions) => Promise<void>;
  signal?: AbortSignal;
}

function scripted(t: TestContext, script: Script = {}) {
  const calls = { asked: [] as string[], said: [] as string[], exec: [] as [string, string[], string][],
    written: new Map<string, string>(), added: [] as string[], removed: [] as string[], adapters: [] as HarnessOptions[],
    prompts: [] as string[], rejections: [] as string[], closed: 0, snapshots: 0, removedWhenAsked: [] as number[] };
  const answers = [...(script.answers ?? [])]; const snapshots = [...(script.snapshots ?? [])];
  const deps: TestFrameworkDeps = {
    signal: script.signal,
    interactive: script.interactive ?? true,
    ask: async question => { calls.asked.push(question); calls.removedWhenAsked.push(calls.removed.length); return answers.shift() ?? ''; },
    say: text => { calls.said.push(text); },
    createAdapter: options => {
      calls.adapters.push(options);
      return { probe: () => ({ status: script.probe ?? 'interface-ready' }), close: () => { calls.closed += 1; },
        async startAction(prompt: string) {
          calls.prompts.push(prompt);
          await script.onSession?.(options);
          if (script.failure) throw script.failure;
          for (const report of script.reports ?? []) {
            try { await options.handleTool(testFrameworkReportTool.name, report as ToolInput, context); }
            catch (error) { calls.rejections.push((error as Error).message); }
          }
          return reply;
        } } as HarnessAdapter;
    },
    worktree: {
      add: (_root, target) => {
        assert.equal(target, 'main');
        if (script.addFailure) throw script.addFailure;
        const tree = realpathSync(mkdtempSync(join(tmpdir(), 'test-framework-tree-')));
        t.after(() => rmSync(tree, { recursive: true, force: true }));
        for (const [path, content] of Object.entries({ ...TRACKED, 'secret.txt': 'untracked\n' })) {
          mkdirSync(dirname(join(tree, path)), { recursive: true }); writeFileSync(join(tree, path), content);
        }
        calls.added.push(tree); return tree;
      },
      remove: (_root, path) => { calls.removed.push(path); rmSync(path, { recursive: true, force: true }); },
    },
    files: () => script.files ?? Object.keys(TRACKED),
    exec: (command, args, cwd) => { calls.exec.push([command, args, cwd]); return { status: script.status ? script.status(command, args) : 0 }; },
    writeFile: (path, content) => { calls.written.set(path, content); },
    snapshot: () => { calls.snapshots += 1; return snapshots.shift() ?? new Map(); },
  };
  return { deps, calls };
}

type Calls = ReturnType<typeof scripted>['calls'];

/** The scripted worktree was removed exactly once for every add, and before any prompt. */
function removedOnce(calls: Calls) {
  assert.deepEqual(calls.removed, calls.added);
  for (const path of calls.removed) assert.equal(existsSync(path), false);
  assert.ok(calls.removedWhenAsked.every(count => count === calls.added.length));
}

const refusedWith = (reason: string, check: (error: PreflightError) => void = () => {}) => (error: PreflightError) => {
  assert.ok(error instanceof PreflightError, String(error)); assert.equal(error.reason, reason); check(error); return true;
};
const nothingDone = (calls: Calls) => {
  assert.deepEqual(calls.exec, []); assert.equal(calls.written.size, 0);
};

test('E: all technologies prepared: nothing is asked, executed or written and startup continues', async t => {
  const { root } = workspace(t);
  for (const interactive of [true, false]) {
    const { deps, calls } = scripted(t, { interactive, reports: [{ technologies: [prepared('Node.js', 95)] }] });
    await testFrameworkPreflight(configFor(root), deps);
    assert.deepEqual(calls.asked, []); nothingDone(calls); assert.equal(calls.snapshots, 0);
    assert.equal(calls.adapters.length, 1); assert.equal(calls.closed, 1); removedOnce(calls);
    if (interactive) {
      assert.match(calls.said.join(''), /Node\.js \(runtime\) prepared; evidence: package\.json/u);
      assert.match(calls.said.join(''), /framework node:test \(lines 95%, branches 95%, functions 95%\)/u);
    } else assert.deepEqual(calls.said, []);
  }
});

test('E: non-interactive with an unprepared technology refuses with the report and changes nothing', async t => {
  const { root } = workspace(t);
  const { deps, calls } = scripted(t, { interactive: false, reports: [{ technologies: [prepared(), python()] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-missing', error => {
    assert.match(error.message, /Test framework missing for Python/u);
    assert.match(error.message, /at least 85%/u);
    const details = error.details as { unprepared: string[]; report: { technologies: Technology[] } };
    assert.deepEqual(details.unprepared, ['Python']);
    assert.deepEqual(details.report.technologies.map(technology => technology.name), ['Node.js', 'Python']);
    assert.equal(details.report.technologies[1].recommendations[0].framework, 'pytest');
  }));
  assert.deepEqual(calls.asked, []); assert.deepEqual(calls.said, []); nothingDone(calls);
  assert.equal(calls.snapshots, 0); removedOnce(calls);
});

test('E: a failing analysis session refuses with test-framework-analysis-failed and removes the worktree', async t => {
  const { root } = workspace(t);
  const cases: [Script, RegExp][] = [
    [{ probe: 'unavailable' }, /interface unavailable/u],
    [{ failure: new Error('session crashed') }, /session crashed/u],
    [{ reports: [] }, /without a test framework report/u],
    [{ addFailure: new Error('git fetch failed') }, /temporary worktree of origin\/main unavailable: git fetch failed/u],
  ];
  for (const [script, message] of cases) {
    const { deps, calls } = scripted(t, script);
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-analysis-failed', error => {
      assert.match(error.message, message); assert.match((error.details as { error: string }).error, message);
    }));
    assert.deepEqual(calls.asked, []); nothingDone(calls); removedOnce(calls);
    assert.equal(calls.added.length, script.addFailure ? 0 : 1);
    assert.equal(calls.closed, script.addFailure ? 0 : 1);
  }
  // A removal failure after a valid analysis is an analysis failure; after a failed analysis the first error wins.
  for (const failure of [undefined, new Error('session crashed')]) {
    const { deps, calls } = scripted(t, { failure, reports: [{ technologies: [prepared()] }] });
    const remove = deps.worktree.remove;
    deps.worktree = { ...deps.worktree, remove: (rootPath, path) => { remove(rootPath, path); throw new Error('removal refused'); } };
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-analysis-failed', error =>
      assert.match(error.message, failure ? /session crashed/u : /removal refused/u)));
    removedOnce(calls);
  }
  // A missing adapter factory never reaches a harness.
  const { deps, calls } = scripted(t);
  await assert.rejects(testFrameworkPreflight(configFor(root), { ...deps, createAdapter: undefined as unknown as TestFrameworkDeps['createAdapter'] }),
    refusedWith('test-framework-analysis-failed', error => assert.match(error.message, /adapter factory/u)));
  removedOnce(calls);
});

test('D: invalid reports are refused to the harness and fail the analysis', async t => {
  const { root } = workspace(t);
  const withRecommendation = (patch: object) => ({ technologies: [python({ recommendations: [recommendation('pytest', 85, patch)] })] });
  const framework = (patch: object) => ({ technologies: [python({ frameworks: [{ name: 'unittest', evidence: ['src/app.py'],
    thresholds: thresholds(null), ...patch }] })] });
  const invalid: [unknown, RegExp][] = [
    [null, /at least one technology/u], [{}, /at least one technology/u], [{ technologies: [] }, /at least one technology/u],
    [{ technologies: ['Python'] }, /Technology 1 needs a name/u], [{ technologies: [python({ name: '' })] }, /needs a name/u],
    [{ technologies: [python(), python()] }, /listed twice/u], [{ technologies: [python({ kind: 'library' })] }, /needs a kind/u],
    [{ technologies: [python({ evidence: [] })] }, /at least one evidence path/u],
    [{ technologies: [python({ evidence: 'pyproject.toml' })] }, /at least one evidence path/u],
    [{ technologies: [python({ evidence: ['missing.txt'] })] }, /"missing.txt" is not a tracked path/u],
    [{ technologies: [python({ evidence: ['secret.txt'] })] }, /"secret.txt" is not a tracked path/u],
    [{ technologies: [python({ frameworks: 'unittest' })] }, /existing test frameworks/u],
    [{ technologies: [python({ frameworks: ['unittest'] })] }, /A framework of Python needs a name/u],
    [framework({ thresholds: undefined }), /line, branch and function thresholds/u],
    [framework({ thresholds: { lines: 85, branches: 85 } }), /line, branch and function thresholds/u],
    [framework({ thresholds: { lines: 101, branches: 85, functions: 85 } }), /line, branch and function thresholds/u],
    [framework({ thresholds: { lines: '85', branches: 85, functions: 85 } }), /line, branch and function thresholds/u],
    [framework({ evidence: [] }), /Framework unittest of Python needs at least one evidence path/u],
    [framework({ evidence: ['tests/missing.py'] }), /is not a tracked path/u],
    [{ technologies: [python({ recommendations: [] })] }, /one to three recommendations/u],
    [{ technologies: [python({ recommendations: null })] }, /one to three recommendations/u],
    [{ technologies: [python({ recommendations: ['a', 'b', 'c', 'd'].map(name => recommendation(name)) })] }, /one to three/u],
    [{ technologies: [python({ recommendations: ['pytest'] })] }, /Recommendation 1 of Python is not an object/u],
    [withRecommendation({ framework: '' }), /needs a framework name/u],
    [withRecommendation({ rationale: undefined }), /one-sentence rationale/u],
    [withRecommendation({ rationale: ' ' }), /one-sentence rationale/u],
    [withRecommendation({ rationale: 'First line.\nSecond line.' }), /one-sentence rationale/u],
    [withRecommendation({ install: undefined }), /install commands/u],
    [withRecommendation({ install: 'npm install pytest' }), /install commands/u],
    [withRecommendation({ install: ['npm'] }), /install commands/u],
    [withRecommendation({ install: [{ command: '', args: [] }] }), /install commands/u],
    [withRecommendation({ install: [{ command: 'npm', args: 'install' }] }), /install commands/u],
    [withRecommendation({ install: [{ command: 'npm', args: [1] }] }), /install commands/u],
    [withRecommendation({ changes: undefined }), /file changes/u],
    [withRecommendation({ changes: [] }), /file changes/u],
    [withRecommendation({ changes: [{ path: '', content: '' }] }), /file changes/u],
    [withRecommendation({ changes: [{ path: 'pytest.ini' }] }), /file changes/u],
    [withRecommendation({ thresholds: undefined }), /thresholds equal to 85/u],
    [withRecommendation({ thresholds: { lines: 85, branches: 85, functions: 80 } }), /thresholds equal to 85/u],
    [withRecommendation({ thresholds: thresholds(90) }), /thresholds equal to 85/u],
  ];
  for (const [report, message] of invalid) {
    const { deps, calls } = scripted(t, { interactive: false, reports: [report] });
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-analysis-failed', error => {
      assert.match(error.message, /Invalid test framework report/u); assert.match(error.message, message);
      assert.match((error.details as { error: string }).error, message);
    }), JSON.stringify(report));
    assert.equal(calls.rejections.length, 1); assert.match(calls.rejections[0], message);
    nothingDone(calls); removedOnce(calls);
  }
  // A corrected report after a refused one is accepted.
  const retry = scripted(t, { interactive: false, reports: [{ technologies: [] }, { technologies: [prepared()] }] });
  await testFrameworkPreflight(configFor(root), retry.deps);
  assert.equal(retry.calls.rejections.length, 1); removedOnce(retry.calls);
  // A framework stating no thresholds is accepted but not prepared; prepared technologies ignore recommendations.
  const stated = scripted(t, { interactive: false, reports: [{ technologies: [{ ...prepared(), recommendations: 'ignored' },
    framework({}).technologies[0]] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root), stated.deps), refusedWith('test-framework-missing', error =>
    assert.deepEqual((error.details as { unprepared: string[] }).unprepared, ['Python'])));
  assert.equal(stated.calls.rejections.length, 0);
  assert.equal(isPrepared(validateReport({ technologies: [prepared('Node.js', 84)] }, 85, new Set(['package.json'])).technologies[0], 85), false);
});

test('D: skipping a technology executes and writes nothing and names it', async t => {
  const { root } = workspace(t);
  for (const answer of ['s', 'skip', '0', '2', 'x']) {
    const { deps, calls } = scripted(t, { answers: [answer], reports: [{ technologies: [prepared(), python()] }] });
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-missing', error => {
      assert.equal(error.message, 'Test framework missing for Python');
      assert.deepEqual(error.details, { unprepared: ['Python'], changedFiles: [] });
    }));
    assert.deepEqual(calls.asked, ['Choose 1-1 or s to skip [1]: ']);
    const said = calls.said.join('');
    assert.match(said, /Python \(language\) not prepared; evidence: pyproject\.toml/u);
    assert.match(said, /1\) pytest: pytest enforces line, branch and function coverage\./u);
    assert.match(said, /Skipped Python\./u);
    assert.equal(calls.said.at(-1), 'Test framework missing for Python\n');
    nothingDone(calls); assert.equal(calls.snapshots, 2); removedOnce(calls);
  }
});

test('D: a declined confirmation shows the exact plan and executes or writes nothing', async t => {
  const { root } = workspace(t);
  for (const answer of ['no', '', 'n', 'maybe']) {
    const { deps, calls } = scripted(t, { answers: ['', answer], reports: [{ technologies: [python()] }] });
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-missing', error =>
      assert.match(error.message, /Python/u)));
    assert.deepEqual(calls.asked, ['Choose 1-1 or s to skip [1]: ', 'Run these commands and apply these changes? [y/N] ']);
    const said = calls.said.join('');
    assert.ok(said.includes('["npm","install","--save-dev","pytest"]'));
    assert.ok(said.includes('--- pytest.config.json\n{"threshold":85}\n'));
    assert.match(said, /Declined pytest for Python\./u);
    nothingDone(calls); removedOnce(calls);
  }
});

test('D: a non-default coverage threshold of 90 reaches the prompt and the prepared rule', async t => {
  const { root } = workspace(t);
  const at85 = { name: 'pytest', evidence: ['pyproject.toml'], thresholds: thresholds(85) };
  const { deps, calls } = scripted(t, { interactive: false,
    reports: [{ technologies: [python({ frameworks: [at85], recommendations: [recommendation('pytest-cov', 90)] })] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root, 90), deps), refusedWith('test-framework-missing', error =>
    assert.match(error.message, /at least 90%/u)));
  assert.equal(calls.prompts.length, 1);
  assert.ok(calls.prompts[0].includes('Resolved coverage threshold: 90%.'));
  assert.ok(calls.prompts[0].includes('thresholds {lines:90,branches:90,functions:90}'));
  assert.ok(calls.prompts[0].includes('at least 90'));
  assert.ok(calls.prompts[0].includes('origin/main'));
  removedOnce(calls);
  const wrong = scripted(t, { interactive: false, reports: [{ technologies: [python({ frameworks: [at85] })] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root, 90), wrong.deps), refusedWith('test-framework-analysis-failed', error =>
    assert.match(error.message, /thresholds equal to 90/u)));
  removedOnce(wrong.calls);
  const enough = scripted(t, { interactive: false, reports: [{ technologies: [prepared('Node.js', 90)] }] });
  await testFrameworkPreflight(configFor(root, 90), enough.deps);
  removedOnce(enough.calls);
  const invalid = scripted(t);
  await assert.rejects(testFrameworkPreflight(configFor(root, 0), invalid.deps), /Invalid coverage/u);
  assert.deepEqual(invalid.calls.added, []);
});

test('C: the first recommendation is preselected, installed without a shell and written, then the run stops for a commit', async t => {
  const { root } = workspace(t);
  const after = new Map([['package-lock.json', '??:lock'], ['pytest.config.json', '??:config']]);
  const { deps, calls } = scripted(t, { answers: ['', 'y'], snapshots: [new Map(), after],
    reports: [{ technologies: [prepared(), python({ recommendations: [recommendation('pytest'), recommendation('coverage-py')] })] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-prepared', error => {
    assert.equal(error.message, 'Changed package-lock.json, pytest.config.json; commit and push them to origin/main, then run again');
    assert.deepEqual(error.details, { changedFiles: ['package-lock.json', 'pytest.config.json'] });
  }));
  assert.deepEqual(calls.exec, [['npm', ['install', '--save-dev', 'pytest'], root]]);
  assert.deepEqual([...calls.written], [[join(root, 'pytest.config.json'), '{"threshold":85}\n']]);
  assert.ok(calls.exec.every(([command]) => command !== 'git'));
  assert.equal(calls.said.at(-1), 'Changed package-lock.json, pytest.config.json; commit and push them to origin/main, then run again\n');
  assert.ok(calls.said.join('').includes('without a shell'));
  assert.equal(calls.asked.length, 2); removedOnce(calls);
});

test('C: choosing a later recommendation uses only its commands and changes', async t => {
  const { root } = workspace(t);
  const { deps, calls } = scripted(t, { answers: ['2', 'yes'],
    reports: [{ technologies: [python({ recommendations: [recommendation('pytest'), recommendation('coverage-py')] })] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-prepared', error =>
    assert.deepEqual(error.details, { changedFiles: ['coverage-py.config.json'] })));
  assert.deepEqual(calls.asked[0], 'Choose 1-2 or s to skip [1]: ');
  assert.match(calls.said.join(''), /1\) pytest: .*\n {2}2\) coverage-py: /u);
  assert.deepEqual(calls.exec, [['npm', ['install', '--save-dev', 'coverage-py'], root]]);
  assert.deepEqual([...calls.written.keys()], [join(root, 'coverage-py.config.json')]);
  removedOnce(calls);
});

test('C: a failing install command stops later commands and the file changes', async t => {
  const { root } = workspace(t);
  for (const failing of [1, null]) {
    const install = [{ command: 'npm', args: ['install', 'pytest'] }, { command: 'npm', args: ['install', 'pytest-cov'] }];
    const { deps, calls } = scripted(t, { answers: ['', 'y'], status: () => failing,
      reports: [{ technologies: [python({ recommendations: [recommendation('pytest', 85, { install })] })] }] });
    await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-missing', error =>
      assert.equal(error.message, 'Test framework missing for Python')));
    assert.deepEqual(calls.exec, [['npm', ['install', 'pytest'], root]]);
    assert.equal(calls.written.size, 0);
    assert.match(calls.said.join(''), /Install command failed: \["npm","install","pytest"\]; no file changes were applied for Python/u);
    removedOnce(calls);
  }
  // A failing file write also leaves the technology unprepared but keeps the files already written.
  const changes = [{ path: 'a.cfg', content: 'a' }, { path: 'b.cfg', content: 'b' }];
  const { deps, calls } = scripted(t, { answers: ['', 'y'], reports: [{ technologies: [python({ recommendations: [recommendation('pytest', 85, { changes })] })] }] });
  deps.writeFile = path => { if (path.endsWith('b.cfg')) throw new Error('disk full'); calls.written.set(path, 'a'); };
  await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-missing', error => {
    assert.equal(error.message, 'Test framework missing for Python; changed a.cfg; commit and push them to origin/main, then run again');
    assert.deepEqual(error.details, { unprepared: ['Python'], changedFiles: ['a.cfg'] });
  }));
  assert.match(calls.said.join(''), /disk full/u);
});

test('C: a file change outside the allowed paths refuses the recommendation without confirmation', async t => {
  const { base, root } = workspace(t);
  symlinkSync(base, join(root, 'link'));
  mkdirSync(join(root, '.git')); symlinkSync(join(root, '.git'), join(root, 'gitlink'));
  const config = configFor(root);
  for (const path of ['../outside.txt', '/etc/passwd', '.git/config', 'sub/.git/hooks/pre-commit', 'planning/outcomes.json',
    'evidence/results/OR-1.json', 'openspec/changes/x/proposal.md', 'openspec/changes', 'link/escape.txt', 'gitlink/config']) {
    const changes = [{ path: 'pytest.ini', content: '[pytest]\n' }, { path, content: 'refused\n' }];
    const { deps, calls } = scripted(t, { answers: [''], reports: [{ technologies: [python({ recommendations: [recommendation('pytest', 85, { changes })] })] }] });
    await assert.rejects(testFrameworkPreflight(config, deps), refusedWith('test-framework-missing', error =>
      assert.deepEqual((error.details as { unprepared: string[] }).unprepared, ['Python'])), path);
    assert.equal(calls.asked.length, 1, path);
    assert.match(calls.said.join(''), /Refused pytest for Python: /u);
    nothingDone(calls); removedOnce(calls);
    assert.notEqual(refusedChange(root, path, config.project), null);
  }
  for (const path of ['pytest.ini', 'src/new/vitest.config.ts', 'planning/other.json', 'openspec/config.yaml']) {
    assert.equal(refusedChange(root, path, config.project), null, path);
  }
});

test('C: the analysis session is read-only and offers only the broker and report tools', async t => {
  const { root } = workspace(t);
  const generated = Array.from({ length: 250 }, (_, index) => `generated/${index}.txt`);
  const files = [...Object.keys(TRACKED), ...generated];
  let checked = false;
  const { deps, calls } = scripted(t, { files, interactive: false, reports: [{ technologies: [prepared()] }],
    onSession: async options => {
      const tool = (name: string, operation: string, input: object = {}) =>
        options.handleTool(name, { operation, input: input as BrokerInput }, context) as Promise<Record<string, unknown>>;
      assert.deepEqual(options.tools.map(item => item.name), ['backlog_tool', 'test_framework_report']);
      assert.equal(options.cwd, calls.added[0]);
      const read = await tool('backlog_tool', 'read_file', { path: 'package.json' });
      assert.equal(read.content, TRACKED['package.json']); assert.match(String(read.hash), /^[a-f0-9]{64}$/u);
      assert.deepEqual(await tool('backlog_tool', 'read_file', { path: 'generated/1.txt' }), { content: null, hash: null });
      await assert.rejects(tool('backlog_tool', 'read_file', { path: 'secret.txt' }), /outside reserved scope/u);
      await assert.rejects(tool('backlog_tool', 'read_file', { path: '../escape' }), /safe repository-relative/u);
      for (const operation of ['write_file', 'run_checks', 'shell', 'request_user_input']) {
        await assert.rejects(tool('backlog_tool', operation, { path: 'package.json', content: 'x', expectedHash: null }), /read-only/u);
      }
      const first = await tool('backlog_tool', 'context');
      assert.equal((first.files as string[]).length, 200); assert.equal(first.nextOffset, 200);
      const second = await tool('backlog_tool', 'context', { section: 'paths', offset: 200 });
      assert.deepEqual(second.files, files.slice(200)); assert.equal(second.nextOffset, null);
      for (const section of ['diff', 'checks', 'findings']) await assert.rejects(tool('backlog_tool', 'context', { section }), /read-only/u);
      await assert.rejects(tool('backlog_tool', 'context', { offset: -1 }), /offset/u);
      await assert.rejects(options.handleTool('outcome_report', { outcome: 'ready', summary: 'x', findings: [] }, context), /read-only/u);
      assert.deepEqual(await options.handleTool(testFrameworkReportTool.name, { technologies: [prepared()] } as unknown as ToolInput, context),
        { status: 'recorded' });
      checked = true;
    } });
  await testFrameworkPreflight(configFor(root), deps);
  assert.ok(checked); removedOnce(calls);
  assert.ok(calls.prompts[0].includes('read-only'));
  assert.ok(calls.prompts[0].includes('no write_file, no run_checks, no shell'));
});

test('C: files already dirty or untracked before the setup are not listed unless the setup changes them', async t => {
  const { root } = workspace(t);
  const before = new Map([['src/app.py', ' M:aaa'], ['openspec/changes/test-framework-preflight/proposal.md', '??:bbb'],
    ['package.json', ' M:ccc']]);
  const after = new Map([...before, ['package.json', ' M:ddd'], ['pytest.config.json', '??:eee']]);
  const { deps, calls } = scripted(t, { answers: ['', 'y'], snapshots: [before, after], reports: [{ technologies: [python()] }] });
  await assert.rejects(testFrameworkPreflight(configFor(root), deps), refusedWith('test-framework-prepared', error =>
    assert.deepEqual(error.details, { changedFiles: ['package.json', 'pytest.config.json'] })));
  const message = calls.said.at(-1)!;
  assert.match(message, /^Changed package\.json, pytest\.config\.json; commit and push/u);
  assert.ok(!message.includes('src/app.py')); assert.ok(!message.includes('openspec/changes'));
  removedOnce(calls);
});

test('B: a repository with two technologies prints both and asks once per unprepared technology', async t => {
  const { root } = workspace(t);
  const unittest = { name: 'unittest', evidence: ['src/app.py'], thresholds: thresholds(null) };
  const report = { technologies: [python({ frameworks: [unittest] }), go()] };
  const mixed = scripted(t, { answers: ['', 'y', 's'], reports: [report] });
  await assert.rejects(testFrameworkPreflight(configFor(root), mixed.deps), refusedWith('test-framework-missing', error => {
    assert.equal(error.message, 'Test framework missing for Go; changed pytest.config.json; commit and push them to origin/main, then run again');
    assert.deepEqual(error.details, { unprepared: ['Go'], changedFiles: ['pytest.config.json'] });
  }));
  const said = mixed.calls.said.join('');
  assert.match(said, /- Python \(language\) not prepared; evidence: pyproject\.toml\n {2}framework unittest \(lines none, branches none, functions none\); evidence: src\/app\.py/u);
  assert.match(said, /- Go \(language\) not prepared; evidence: go\.mod\n {2}no test framework/u);
  assert.deepEqual(mixed.calls.asked, ['Choose 1-1 or s to skip [1]: ', 'Run these commands and apply these changes? [y/N] ',
    'Choose 1-1 or s to skip [1]: ']);
  assert.deepEqual(mixed.calls.exec.map(([, args]) => args.at(-1)), ['pytest']);
  removedOnce(mixed.calls);
  const both = scripted(t, { answers: ['', 'y', '1', 'Y'], reports: [report] });
  await assert.rejects(testFrameworkPreflight(configFor(root), both.deps), refusedWith('test-framework-prepared', error =>
    assert.deepEqual(error.details, { changedFiles: ['gotest.config.json', 'pytest.config.json'] })));
  assert.deepEqual(both.calls.exec.map(([, args]) => args.at(-1)), ['pytest', 'gotest']);
  removedOnce(both.calls);
});

test('B: cancellation before or during the analysis and during a prompt propagates without a reason', async t => {
  const { root } = workspace(t);
  const early = new AbortController(); early.abort(new Error('stopped early'));
  const before = scripted(t, { signal: early.signal });
  await assert.rejects(testFrameworkPreflight(configFor(root), before.deps), /stopped early/u);
  assert.deepEqual(before.calls.added, []);
  const during = new AbortController();
  const session = scripted(t, { signal: during.signal, reports: [{ technologies: [prepared()] }],
    onSession: async () => { during.abort(new Error('stopped during analysis')); } });
  await assert.rejects(testFrameworkPreflight(configFor(root), session.deps), (error: Error) => {
    assert.ok(!(error instanceof PreflightError)); assert.match(error.message, /stopped during analysis/u); return true;
  });
  removedOnce(session.calls);
  const asking = new AbortController();
  const prompt = scripted(t, { signal: asking.signal, reports: [{ technologies: [python()] }] });
  const ask = prompt.deps.ask;
  prompt.deps.ask = async question => { const answer = await ask(question); asking.abort(new Error('stopped at prompt')); return answer; };
  await assert.rejects(testFrameworkPreflight(configFor(root), prompt.deps), /stopped at prompt/u);
  nothingDone(prompt.calls); removedOnce(prompt.calls);
});

function invocation(base: string) {
  const path = join(base, 'invocation.json');
  writeFileSync(path, JSON.stringify({ invocation: 'test-framework' }));
  return path;
}

test('B: the CLI exits 4 with the new reasons and keeps the details in the private diagnostics file', async t => {
  const { base, root } = workspace(t); git(root, 'init', '-b', 'main');
  const env = { XDG_STATE_HOME: join(base, 'xdg') }; const path = invocation(base);
  for (const reason of ['test-framework-missing', 'test-framework-analysis-failed', 'test-framework-prepared']) {
    const details = { unprepared: ['Python'], changedFiles: ['pytest.ini'], report: { technologies: [] } };
    const lines: string[] = [];
    assert.equal(await main(path, async () => { throw new PreflightError(reason, `refused: ${reason}`, details); },
      line => lines.push(line), { cwd: root, env }), 4);
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(report), ['status', 'reason', 'diagnostics']); assert.equal(report.reason, reason);
    assert.ok(!lines[0].includes('pytest.ini'));
    const diagnostic = JSON.parse(readFileSync(report.diagnostics, 'utf8'));
    assert.equal(diagnostic.reason, reason); assert.equal(diagnostic.message, `refused: ${reason}`);
    assert.deepEqual(diagnostic.details, details);
    rmSync(dirname(report.diagnostics), { recursive: true, force: true });
    const record = JSON.parse(readFileSync(ledgerPath(env), 'utf8').trim().split('\n').at(-1)!);
    assert.equal(record.failureReason, reason); assert.equal(record.exitCode, 4);
    assert.equal(safeFailure(reason), reason); assert.ok(SAFE_FAILURE_REASONS.includes(reason));
  }
  const lines: string[] = [];
  assert.equal(await main(path, async () => { throw new PreflightError('test-framework-missing', 'no details'); },
    line => lines.push(line), { cwd: root, env }), 4);
  const diagnostic = JSON.parse(readFileSync(JSON.parse(lines[0]).diagnostics, 'utf8'));
  assert.equal('details' in diagnostic, false);
  rmSync(dirname(JSON.parse(lines[0]).diagnostics), { recursive: true, force: true });
  assert.equal(safeFailure('test-framework-other'), 'startup-or-run-failed');
});

function repository(t: TestContext) {
  const { base, root } = workspace(t);
  const remote = join(base, 'origin.git');
  git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test Framework Fixture'); git(root, 'config', 'user.email', 'framework@example.invalid');
  writeFileSync(join(root, 'package.json'), TRACKED['package.json']);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/app.py'), TRACKED['src/app.py']);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: initial');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'HEAD:main');
  return { base, root, remote };
}

interface Observed { tree: string; head: string; branch: string; list: string }

const observingAdapter = (root: string, seen: Observed[], failure?: Error) => (options: HarnessOptions): HarnessAdapter => ({
  probe: () => ({ status: 'interface-ready' }), close() {},
  async startAction() {
    const tree = options.cwd;
    seen.push({ tree, head: git(tree, 'rev-parse', 'HEAD'), branch: git(tree, 'branch', '--show-current'),
      list: git(root, 'worktree', 'list', '--porcelain') });
    if (failure) throw failure;
    await options.handleTool(testFrameworkReportTool.name, { technologies: [prepared()] } as unknown as ToolInput, context);
    return reply;
  } });

test('A: the default worktree is detached at origin/<target> outside the repository and always removed', async t => {
  const { root } = repository(t);
  const origin = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'local.txt'), 'local only\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'test: local only');
  for (const failure of [undefined, new Error('session crashed')]) {
    const seen: Observed[] = [];
    const run = testFrameworkPreflight(configFor(root), { interactive: false, createAdapter: observingAdapter(root, seen, failure) });
    if (failure) await assert.rejects(run, refusedWith('test-framework-analysis-failed'));
    else await run;
    assert.equal(seen.length, 1); const [observed] = seen;
    assert.equal(observed.head, origin); assert.notEqual(observed.head, git(root, 'rev-parse', 'HEAD'));
    assert.equal(observed.branch, '');
    assert.ok(!within(observed.tree, root)); assert.equal(basename(observed.tree), 'tree');
    assert.ok(basename(dirname(observed.tree)).startsWith('outcome-test-framework-'));
    assert.ok(observed.list.includes(observed.tree));
    assert.equal(existsSync(observed.tree), false); assert.equal(existsSync(dirname(observed.tree)), false);
    assert.ok(!git(root, 'worktree', 'list', '--porcelain').includes(observed.tree));
    assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  }
  // Evidence must be tracked at origin/<target>: the local-only commit is not visible to the analysis.
  let refused = false;
  const local = testFrameworkPreflight(configFor(root), { interactive: false, createAdapter: options => ({
    probe: () => ({ status: 'interface-ready' }), close() {},
    async startAction() {
      try {
        await options.handleTool(testFrameworkReportTool.name, { technologies: [{ ...prepared(), evidence: ['local.txt'] }] } as unknown as ToolInput, context);
      } catch (error) { refused = /not a tracked path/u.test((error as Error).message); }
      return reply;
    } }) });
  await assert.rejects(local, refusedWith('test-framework-analysis-failed'));
  assert.ok(refused);
  // An unknown target cannot be fetched; nothing is left behind.
  await assert.rejects(testFrameworkPreflight(configFor(root, undefined, 'absent'), { interactive: false,
    createAdapter: () => { throw new Error('No session without a worktree'); } }),
  refusedWith('test-framework-analysis-failed', error => assert.match(error.message, /origin\/absent unavailable/u)));
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  assert.throws(() => temporaryWorktree.remove(root, join(root, '..', 'not-a-worktree', 'tree')), /removal failed/u);
});

test('A: the default snapshot records status and content so changed dirty files are detected', async t => {
  const { root } = repository(t);
  const deps = defaultTestFrameworkDeps();
  assert.equal(deps.snapshot, workingTreeSnapshot); assert.equal(typeof deps.interactive, 'boolean');
  assert.deepEqual(deps.files(root), ['package.json', 'src/app.py']);
  deps.say('');
  assert.deepEqual(workingTreeSnapshot(root), new Map());
  writeFileSync(join(root, 'package.json'), 'changed\n'); writeFileSync(join(root, 'new file.txt'), 'new\n');
  const first = workingTreeSnapshot(root);
  assert.match(first.get('package.json')!, /^ M:[a-f0-9]{64}$/u);
  assert.match(first.get('new file.txt')!, /^\?\?:[a-f0-9]{64}$/u);
  writeFileSync(join(root, 'package.json'), 'changed again\n');
  const second = workingTreeSnapshot(root);
  assert.notEqual(second.get('package.json'), first.get('package.json'));
  assert.equal(second.get('new file.txt'), first.get('new file.txt'));
  rmSync(join(root, 'src/app.py'));
  assert.equal(workingTreeSnapshot(root).get('src/app.py'), ' D:missing');
  git(root, 'mv', 'package.json', 'renamed.json');
  const renamed = workingTreeSnapshot(root);
  assert.ok(renamed.has('renamed.json')); assert.ok(!renamed.has('package.json'));
});

test('A: the default executor never uses a shell and the default writer creates parents and overwrites', t => {
  const { root } = workspace(t);
  const deps = defaultTestFrameworkDeps();
  assert.equal(deps.exec(process.execPath, ['-e', 'process.exit(process.argv[1] === "$HOME" ? 0 : 3)', '$HOME'], root).status, 0);
  assert.equal(deps.exec(process.execPath, ['-e', 'process.exit(2)'], root).status, 2);
  assert.equal(deps.exec(join(root, 'no-such-package-manager'), [], root).status, null);
  const path = join(root, 'a/b/vitest.config.ts');
  deps.writeFile(path, 'first'); deps.writeFile(path, 'second');
  assert.equal(readFileSync(path, 'utf8'), 'second');
});

// Runner ordering: a real repository with a scripted OpenSpec preflight, selection and workers.
const host: PullRequestHost = { find: () => null, create: () => null, merge: () => {} };
const passing: Pick<RunOptions, 'openspec' | 'selection'> = { openspec: { probe: () => ({ status: 0 }), configPresent: () => true },
  selection: { interactive: false, recorded: () => null, probe: harness => ({ harness, available: true, version: 'scripted' }) } };

function runnerFixture(t: TestContext) {
  const { base, root } = repository(t);
  const task = { id: 'A', title: 'Analyse', change: 'analyse-a', priority: 1, criteria: ['Works.'], scopes: ['src/a'], dependencies: [] };
  mkdirSync(join(root, 'planning')); writeFileSync(join(root, 'planning/outcomes.json'), JSON.stringify({ version: 1, tasks: [task] }));
  mkdirSync(join(root, 'openspec')); writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: define outcome'); git(root, 'push', 'origin', 'HEAD:main');
  const config: RunConfig = { ...configFor(root, 90), stateDirectory: join(base, 'state'), leaves: ['A'], harness: 'claude',
    model: 'claude-sonnet-5-5', effort: 'high', authority: { reference: 'fixture', instruction: 'fixture', target: 'main', tasks: { A: hash(task) } },
    project: { ...configFor(root).project, repository: 'fixture', checks: [{ command: 'node', args: ['-e', '', '{coverage}'] }],
      planningCheck: { command: 'node', args: ['-e', ''] } } };
  const untouched = () => {
    assert.equal(existsSync(join(base, '.work-queue-locks')), false);
    assert.equal(existsSync(config.stateDirectory), false);
    assert.equal(git(root, 'ls-remote', 'origin', 'work-queue-claims-main'), '');
  };
  return { base, root, config, untouched };
}

const silentWorker: HarnessAdapter = { probe: () => ({ status: 'interface-ready' }), close() {},
  async startAction() { return reply; } };

test('A: the runner analyses after selection with the resolved settings and before the lock and claims', async t => {
  const f = runnerFixture(t); const events: string[] = []; let seen: unknown[] = [];
  const result = await runQueue(f.config, { ...passing, host,
    selection: { ...passing.selection, probe: harness => { events.push('probe'); return { harness, available: true, version: 'scripted' }; } },
    createAdapter: () => { events.push('worker'); return silentWorker; },
    testFramework: { interactive: false, analyse: async (config, tree) => {
      events.push('analysis'); seen = [config.harness, config.model, config.effort, config.coverage];
      f.untouched(); assert.ok(git(f.root, 'worktree', 'list', '--porcelain').includes(tree));
      return { technologies: [prepared('Node.js', 90)] };
    } } });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(events.slice(0, 3), ['probe', 'probe', 'analysis']); assert.ok(events.slice(3).every(event => event === 'worker'));
  assert.ok(events.length > 3);
  assert.deepEqual(seen, ['claude', 'claude-sonnet-5-5', 'high', 90]);
  assert.ok(existsSync(join(f.base, '.work-queue-locks')));
});

test('A: the analysis uses the runner adapter factory, and a failing analysis creates no lock, claim or worktree', async t => {
  const f = runnerFixture(t); const sessions: string[][] = [];
  const factory = (report: boolean) => (options: HarnessOptions): HarnessAdapter => {
    sessions.push(options.tools.map(tool => tool.name));
    if (sessions.length > 1) return silentWorker;
    return { probe: () => ({ status: 'interface-ready' }), close() {}, async startAction(prompt: string) {
      f.untouched(); assert.ok(prompt.includes('Resolved coverage threshold: 90%.')); assert.notEqual(options.cwd, f.root);
      if (report) await options.handleTool(testFrameworkReportTool.name, { technologies: [prepared('Node.js', 90)] } as unknown as ToolInput, context);
      return reply;
    } };
  };
  await assert.rejects(runQueue(f.config, { ...passing, host, createAdapter: factory(false), testFramework: { interactive: false } }),
    refusedWith('test-framework-analysis-failed'));
  assert.deepEqual(sessions, [['backlog_tool', 'test_framework_report']]);
  f.untouched(); assert.equal(git(f.root, 'worktree', 'list').split('\n').length, 1);
  sessions.length = 0;
  const result = await runQueue(f.config, { ...passing, host, createAdapter: factory(true), testFramework: { interactive: false } });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(sessions[0], ['backlog_tool', 'test_framework_report']);
  assert.ok(sessions.length > 1 && sessions.slice(1).every(tools => tools.includes('outcome_report')));
});

test('README documents the analysis, choice, confirmation, thresholds and non-interactive behaviour', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('## Test framework preflight'));
  const start = readme.indexOf('## Test framework preflight');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  for (const text of ['origin/<target>', 'temporary', 'detached', 'read-only', 'test_framework_report', 'no `run_checks`', 'no shell',
    'one to three', 'one-sentence rationale', 'line, branch and function', 'resolved coverage', '85', 'Choose 1-n or s to skip [1]',
    'Run these commands and apply these changes? [y/N]', 'never through a shell', '.git', 'never commits or pushes',
    'Non-interactive', 'stderr', 'test-framework-missing', 'test-framework-analysis-failed', 'test-framework-prepared']) {
    assert.ok(section.includes(text), `README test framework section mentions ${text}`);
  }
});
