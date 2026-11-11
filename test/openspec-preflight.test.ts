import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.ts';
import { main } from './support/isolated-cli.ts';
import { runQueue } from '../src/runner.ts';
import type { RunConfig } from '../src/model.ts';
import { OPENSPEC_INSTALL, PreflightError, configAtOrigin, defaultPreflightDeps, isInteractive, openspecPreflight,
  promptOn } from '../src/openspec-preflight.ts';
import type { PreflightDeps } from '../src/openspec-preflight.ts';

const helper = fileURLToPath(new URL('./support/openspec-preflight-child.ts', import.meta.url));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'NODE_OPTIONS'].includes(key)));

interface Script {
  interactive?: boolean;
  answers?: string[];
  /** Statuses returned by successive `probe` calls; the last one repeats. */
  probe?: (number | null)[];
  /** Status of the scripted install; omitted means success (0). */
  install?: number | null;
  config?: boolean | Error;
  files?: string[];
}

function scripted(script: Script = {}) {
  const calls = { probe: [] as [string, string[], string][], exec: [] as [string, string[], string][],
    asked: [] as string[], said: [] as string[], written: new Map<string, string>(), configChecks: [] as [string, string][] };
  const existing = new Set(script.files ?? []);
  const statuses = [...(script.probe ?? [0])];
  const deps: PreflightDeps = {
    interactive: script.interactive ?? true,
    ask: async question => { calls.asked.push(question); return script.answers?.shift() ?? ''; },
    say: text => { calls.said.push(text); },
    probe: (program, args, cwd) => {
      calls.probe.push([program, args, cwd]);
      return { status: statuses.length > 1 ? statuses.shift()! : statuses[0] };
    },
    exec: (program, args, cwd) => {
      calls.exec.push([program, args, cwd]);
      return { status: script.install === undefined ? 0 : script.install };
    },
    configPresent: (root, target) => {
      calls.configChecks.push([root, target]);
      if (script.config instanceof Error) throw script.config;
      return script.config ?? true;
    },
    exists: path => existing.has(path) || calls.written.has(path),
    writeFile: (path, content) => {
      if (existing.has(path) || calls.written.has(path)) throw new Error(`Refusing to overwrite ${path}`);
      calls.written.set(path, content);
    },
  };
  return { deps, calls };
}

function workspace(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'openspec-preflight-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'); mkdirSync(root);
  return { base, root };
}

function repository(t: TestContext) {
  const { base, root } = workspace(t);
  const remote = join(base, 'origin.git');
  git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Preflight Fixture'); git(root, 'config', 'user.email', 'preflight@example.invalid');
  mkdirSync(join(root, 'openspec')); writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: initialize openspec');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'HEAD:main');
  return { base, root, remote };
}

const configFor = (root: string): RunConfig => ({ root, stateDirectory: join(root, '..', 'state'), invocation: 'preflight',
  authority: { reference: 'fixture', instruction: 'fixture', target: 'main', tasks: {} },
  project: { queue: 'planning/outcomes.json', changes: 'openspec/changes', receipts: 'evidence/results', target: 'main',
    checks: [{ command: 'node', args: ['{coverage}'] }], planningCheck: { command: 'openspec', args: ['validate'] } } });

const refusedWith = (reason: string) => (error: PreflightError) => {
  assert.ok(error instanceof PreflightError); assert.equal(error.reason, reason); return true;
};
const plainError = (error: Error & { reason?: unknown }) => {
  assert.ok(!(error instanceof PreflightError)); assert.equal(error.reason, undefined); return true;
};

test('available and initialized continues silently without installing or creating anything', async t => {
  const { root } = workspace(t); const { deps, calls } = scripted();
  await openspecPreflight(configFor(root), deps);
  assert.deepEqual(calls.probe, [['openspec', ['--version'], root]]);
  assert.deepEqual(calls.configChecks, [[root, 'main']]);
  assert.deepEqual(calls.exec, []); assert.deepEqual(calls.asked, []); assert.deepEqual(calls.said, []);
  assert.equal(calls.written.size, 0);
});

test('missing CLI, yes and a successful install runs exactly the npm argument array then re-checks', async t => {
  const { root } = workspace(t);
  const { deps, calls } = scripted({ probe: [1, 0], answers: [' Yes '] });
  await openspecPreflight(configFor(root), deps);
  assert.deepEqual(calls.exec, [['npm', ['install', '-g', '@fission-ai/openspec@latest'], root]]);
  assert.deepEqual(OPENSPEC_INSTALL, ['npm', 'install', '-g', '@fission-ai/openspec@latest']);
  assert.deepEqual(calls.probe.map(([program, args]) => [program, args]), [['openspec', ['--version']], ['openspec', ['--version']]]);
  assert.ok(calls.exec.every(([program]) => program !== 'openspec'));
  assert.equal(calls.asked.length, 1); assert.match(calls.asked[0], /npm install -g @fission-ai\/openspec@latest/u);
  assert.match(calls.said.join(''), /OpenSpec CLI is missing/u);
  assert.deepEqual(calls.configChecks, [[root, 'main']]);
});

test('missing CLI, yes and a failing install refuses with openspec-missing', async t => {
  const { root } = workspace(t);
  for (const install of [1, null]) {
    const { deps, calls } = scripted({ probe: [1], answers: ['y'], install });
    await assert.rejects(openspecPreflight(configFor(root), deps), refusedWith('openspec-missing'));
    assert.equal(calls.exec.length, 1); assert.equal(calls.probe.length, 1); assert.deepEqual(calls.configChecks, []);
  }
});

test('an install that succeeds while the CLI is still missing refuses with openspec-missing', async t => {
  const { root } = workspace(t);
  const { deps, calls } = scripted({ probe: [1, null], answers: ['yes'] });
  await assert.rejects(openspecPreflight(configFor(root), deps), refusedWith('openspec-missing'));
  assert.equal(calls.exec.length, 1); assert.equal(calls.probe.length, 2); assert.deepEqual(calls.configChecks, []);
});

test('declining the install, or an empty answer, installs nothing and refuses with openspec-missing', async t => {
  const { root } = workspace(t);
  for (const answer of ['no', '', 'n', 'install']) {
    const { deps, calls } = scripted({ probe: [1], answers: [answer] });
    await assert.rejects(openspecPreflight(configFor(root), deps), refusedWith('openspec-missing'));
    assert.deepEqual(calls.exec, []); assert.equal(calls.asked.length, 1); assert.deepEqual(calls.configChecks, []);
  }
});

test('missing config and yes creates only the missing layout files and asks to commit and push', async t => {
  const { root } = workspace(t);
  const existing = join(root, 'openspec/changes/.gitkeep');
  const { deps, calls } = scripted({ config: false, answers: ['yes'], files: [existing] });
  await assert.rejects(openspecPreflight(configFor(root), deps), (error: PreflightError) => {
    refusedWith('openspec-layout-created')(error);
    assert.match(error.message, /commit and push them to origin\/main/u);
    assert.match(error.message, /openspec\/config\.yaml/u); assert.match(error.message, /evidence\/results\/\.gitkeep/u);
    return true;
  });
  assert.deepEqual([...calls.written], [[join(root, 'openspec/config.yaml'), 'schema: spec-driven\n'],
    [join(root, 'evidence/results/.gitkeep'), '']]);
  assert.deepEqual(calls.exec, []); assert.equal(calls.asked.length, 1);
  assert.match(calls.said.join(''), /missing at origin\/main/u);
  assert.match(calls.said.join(''), /commit and push/u);
});

test('missing config and yes with every file already present still stops for commit and push', async t => {
  const { root } = workspace(t);
  const files = ['openspec/config.yaml', 'openspec/changes/.gitkeep', 'evidence/results/.gitkeep'].map(path => join(root, path));
  const { deps, calls } = scripted({ config: false, answers: ['y'], files });
  await assert.rejects(openspecPreflight(configFor(root), deps), (error: PreflightError) => {
    refusedWith('openspec-layout-created')(error); assert.match(error.message, /already exist/u); return true;
  });
  assert.equal(calls.written.size, 0);
});

test('real layout creation writes files in the working tree without committing or pushing', async t => {
  const { root } = repository(t);
  mkdirSync(join(root, 'openspec/changes'), { recursive: true });
  writeFileSync(join(root, 'openspec/changes/.gitkeep'), 'kept');
  git(root, 'rm', '-q', 'openspec/config.yaml'); git(root, 'commit', '-m', 'test: remove config'); git(root, 'push', 'origin', 'HEAD:main');
  const head = git(root, 'rev-parse', 'HEAD'); const said: string[] = [];
  await assert.rejects(openspecPreflight(configFor(root), { interactive: true, ask: async () => 'yes', say: text => { said.push(text); },
    probe: () => ({ status: 0 }), exec: () => { throw new Error('No process may run'); } }), refusedWith('openspec-layout-created'));
  assert.equal(readFileSync(join(root, 'openspec/config.yaml'), 'utf8'), 'schema: spec-driven\n');
  assert.equal(readFileSync(join(root, 'evidence/results/.gitkeep'), 'utf8'), '');
  assert.equal(readFileSync(join(root, 'openspec/changes/.gitkeep'), 'utf8'), 'kept');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'origin/main'), head);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.match(said.join(''), /commit and push/u);
});

test('missing config and no creates nothing and refuses with openspec-not-initialized', async t => {
  const { root } = workspace(t);
  for (const answer of ['no', '']) {
    const { deps, calls } = scripted({ config: false, answers: [answer] });
    await assert.rejects(openspecPreflight(configFor(root), deps), refusedWith('openspec-not-initialized'));
    assert.equal(calls.written.size, 0); assert.equal(calls.asked.length, 1);
  }
});

test('non-interactive refusals never ask, install or create', async t => {
  const { root } = workspace(t);
  const cli = scripted({ interactive: false, probe: [1] });
  await assert.rejects(openspecPreflight(configFor(root), cli.deps), refusedWith('openspec-missing'));
  assert.deepEqual(cli.calls.asked, []); assert.deepEqual(cli.calls.exec, []); assert.deepEqual(cli.calls.said, []);
  assert.deepEqual(cli.calls.configChecks, []);
  const config = scripted({ interactive: false, config: false });
  await assert.rejects(openspecPreflight(configFor(root), config.deps), refusedWith('openspec-not-initialized'));
  assert.deepEqual(config.calls.asked, []); assert.deepEqual(config.calls.said, []); assert.equal(config.calls.written.size, 0);
});

test('a git failure in the config check propagates without a reason, prompt, explanation or file', async t => {
  const { root } = workspace(t);
  for (const interactive of [true, false]) {
    const { deps, calls } = scripted({ interactive, config: new Error('git fetch origin main failed'), answers: ['yes'] });
    await assert.rejects(openspecPreflight(configFor(root), deps), (error: Error & { reason?: unknown }) => {
      plainError(error); assert.match(error.message, /git fetch/u); return true;
    });
    assert.deepEqual(calls.asked, []); assert.deepEqual(calls.said, []); assert.equal(calls.written.size, 0);
  }
});

test('the preflight rejects unsafe project paths and targets before any effect', async t => {
  const { root } = workspace(t);
  for (const project of [{ target: '../main' }, { target: 'main/' }, { changes: '../escape' }, { receipts: '/abs' }]) {
    const { deps, calls } = scripted();
    const config = configFor(root);
    await assert.rejects(openspecPreflight({ ...config, project: { ...config.project, ...project } }, deps));
    assert.deepEqual(calls.probe, []);
  }
});

test('the default config check reads origin, distinguishes missing from git failures', async t => {
  const { base, root } = repository(t);
  assert.equal(configAtOrigin(root, 'main'), true);
  git(root, 'checkout', '-q', '-b', 'bare');
  git(root, 'rm', '-q', '--cached', 'openspec/config.yaml'); git(root, 'commit', '-m', 'test: untrack config');
  git(root, 'push', 'origin', 'HEAD:bare');
  assert.ok(existsSync(join(root, 'openspec/config.yaml')), 'the working tree still has the config');
  assert.equal(configAtOrigin(root, 'bare'), false);
  assert.throws(() => configAtOrigin(root, 'missing-branch'), (error: Error) => plainError(error) && /fetch/u.test(error.message));
  const lonely = join(base, 'lonely'); mkdirSync(lonely); git(lonely, 'init', '-b', 'main');
  assert.throws(() => configAtOrigin(lonely, 'main'), plainError);
  const { deps, calls } = scripted({ config: false });
  await assert.rejects(openspecPreflight(configFor(lonely), { ...deps, configPresent: configAtOrigin }), plainError);
  assert.deepEqual(calls.asked, []); assert.deepEqual(calls.said, []); assert.equal(calls.written.size, 0);
});

test('startup is interactive only when stdin and stderr are both TTYs', () => {
  assert.equal(isInteractive({ isTTY: true }, { isTTY: true }), true);
  assert.equal(isInteractive({ isTTY: true }, {}), false);
  assert.equal(isInteractive({}, { isTTY: true }), false);
  assert.equal(isInteractive({ isTTY: false }, { isTTY: false }), false);
});

test('the prompt writes its question to the given stream and treats a closed input as no answer', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let written = '';
  output.on('data', chunk => { written += chunk; });
  const answer = promptOn(input, output)('Install? ');
  input.write('yes\n');
  assert.equal(await answer, 'yes'); assert.equal(written, 'Install? ');
  const closed = new PassThrough(); const pending = promptOn(closed, new PassThrough())('Create? ');
  closed.end();
  assert.equal(await pending, '');
});

const runHelper = (args: string[], input = '') => spawnSync(process.execPath, ['--no-warnings', helper, ...args],
  { encoding: 'utf8', input, env: childEnv });

test('the default version check discards all child output and reports the status', () => {
  const child = runHelper(['probe', process.execPath, '-e',
    "process.stdout.write('openspec 9.9.9'); process.stderr.write('version-noise')"]);
  assert.equal(child.stdout, ''); assert.equal(child.stderr, ''); assert.equal(child.status, 0);
  assert.equal(runHelper(['probe', process.execPath, '-e', 'process.exit(3)']).status, 7);
  const deps = defaultPreflightDeps();
  assert.notEqual(deps.probe(join(tmpdir(), 'no-such-openspec-program'), ['--version'], tmpdir()).status, 0);
  assert.equal(deps.probe(process.execPath, ['-e', ''], tmpdir()).status, 0);
});

test('the default installer forwards child output to stderr and never to stdout', () => {
  const child = runHelper(['exec', process.execPath, '-e',
    "process.stdout.write('install-progress'); process.stderr.write('install-warning')"]);
  assert.equal(child.status, 0); assert.equal(child.stdout, '');
  assert.match(child.stderr, /install-progress/u); assert.match(child.stderr, /install-warning/u);
  const deps = defaultPreflightDeps();
  assert.equal(deps.exec(process.execPath, ['-e', 'process.exit(2)'], tmpdir()).status, 2);
  assert.equal(deps.exec(join(tmpdir(), 'no-such-npm-program'), [], tmpdir()).status, null);
});

test('the default prompt asks on stderr and reads stdin, leaving stdout to the caller', () => {
  const yes = runHelper(['ask', 'Install OpenSpec? '], 'yes\n');
  assert.equal(yes.stderr, 'Install OpenSpec? '); assert.deepEqual(JSON.parse(yes.stdout), { answer: 'yes' });
  const closed = runHelper(['ask', 'Create layout? ']);
  assert.equal(closed.stderr, 'Create layout? '); assert.deepEqual(JSON.parse(closed.stdout), { answer: '' });
  defaultPreflightDeps().say('');
});

test('the default file creation makes parents and never overwrites', t => {
  const { root } = workspace(t); const deps = defaultPreflightDeps();
  const path = join(root, 'a/b/.gitkeep');
  assert.equal(deps.exists(path), false);
  deps.writeFile(path, 'first');
  assert.equal(deps.exists(path), true);
  assert.throws(() => deps.writeFile(path, 'second'), /EEXIST/u);
  assert.equal(readFileSync(path, 'utf8'), 'first');
});

test('a refusing preflight stops runQueue before harness resolution, adapters, lock, claims or worktrees', async t => {
  const { base, root } = repository(t);
  for (const [script, reason] of [[{ interactive: false, probe: [1] }, 'openspec-missing'],
    [{ interactive: false, config: false }, 'openspec-not-initialized']] as [Script, string][]) {
    let adapters = 0; const { deps } = scripted(script);
    // Codex without a model would start the app-server during harness resolution; the preflight must come first.
    await assert.rejects(runQueue({ ...configFor(root), harness: 'codex' }, {
      createAdapter: () => { adapters += 1; throw new Error('No adapter may be created'); }, openspec: deps }), refusedWith(reason));
    assert.equal(adapters, 0);
    assert.equal(existsSync(join(base, '.work-queue-locks')), false);
    assert.equal(existsSync(join(base, 'state')), false);
    assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(git(root, 'ls-remote', 'origin', 'work-queue-claims-main'), '');
  }
});

function invocation(base: string) {
  const { root: _root, stateDirectory: _state, ...rest } = configFor('/unused');
  const path = join(base, 'invocation.json');
  writeFileSync(path, JSON.stringify(rest));
  return path;
}

test('main reports a preflight refusal reason with exit code 4 and keeps prompts off stdout', async t => {
  const { base, root } = repository(t); const path = invocation(base);
  const options = { cwd: root, env: { XDG_STATE_HOME: join(base, 'xdg') } };
  for (const reason of ['openspec-missing', 'openspec-not-initialized', 'openspec-layout-created']) {
    const lines: string[] = [];
    assert.equal(await main(path, async () => { throw new PreflightError(reason, `refused: ${reason}`); },
      line => lines.push(line), options), 4);
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.equal(report.status, 'unavailable'); assert.equal(report.reason, reason);
    const diagnostic = JSON.parse(readFileSync(report.diagnostics, 'utf8'));
    assert.equal(diagnostic.reason, reason); assert.equal(diagnostic.message, `refused: ${reason}`);
    rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
  }
  const plain: string[] = [];
  assert.equal(await main(path, async () => { throw new Error('git fetch origin main failed'); }, line => plain.push(line), options), 4);
  const report = JSON.parse(plain[0]); assert.equal(report.reason, 'startup-or-run-failed');
  rmSync(join(report.diagnostics, '..'), { recursive: true, force: true });
  const lines: string[] = []; const { deps, calls } = scripted({ probe: [1], answers: ['no'] });
  assert.equal(await main(path, (config, runOptions) => runQueue(config, { ...runOptions, openspec: deps }),
    line => lines.push(line), options), 4);
  assert.equal(calls.asked.length, 1); assert.ok(calls.said.length);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).reason, 'openspec-missing');
  for (const text of [...calls.asked, ...calls.said]) assert.ok(!lines[0].includes(text.trim()));
  rmSync(join(JSON.parse(lines[0]).diagnostics, '..'), { recursive: true, force: true });
  assert.equal(existsSync(join(base, 'xdg')), false);
});
