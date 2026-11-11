import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { printTaskHashes } from '../src/cli.ts';
import { main } from './support/isolated-cli.ts';
import { git } from '../src/git.ts';
import { hash } from '../src/model.ts';
import type { RunConfig } from '../src/model.ts';

const task = { id: 'A', title: 'One', change: 'one', priority: 1, criteria: ['Works.'], scopes: ['src/a'], dependencies: [] };

function workspace(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function repository(base: string, name: string) {
  const root = join(base, name);
  mkdirSync(join(root, 'nested/deep'), { recursive: true });
  git(root, 'init', '-b', 'main');
  return root;
}
function invocationFile(base: string, content: object = { invocation: 'nightly' }) {
  const path = join(base, 'invocation.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}
async function resolvedConfig(path: string, cwd: string, env: NodeJS.ProcessEnv = { XDG_STATE_HOME: '/state-home' }) {
  let received!: RunConfig;
  const code = await main(path, async config => { received = config; return { status: 'exhausted' }; }, () => {}, { cwd, env });
  assert.equal(code, 0);
  return received;
}
async function assertRefused(path: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const code = await main(path, async () => { throw new Error('Must not run'); }, () => {}, { cwd, env });
  assert.equal(code, 4);
}

test('the installed link starts the command', t => {
  const base = workspace(t);
  const link = join(base, 'outcome-runner');
  symlinkSync(resolve('bin/outcome-runner.ts'), link);
  const queue = join(base, 'queue.json');
  writeFileSync(queue, JSON.stringify({ version: 1, tasks: [task] }));
  const result = spawnSync(link, ['hash', queue], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { A: hash(task) });
});

test('a subdirectory resolves to the repository top level', async t => {
  const base = workspace(t); const root = repository(base, 'project');
  assert.equal((await resolvedConfig(invocationFile(base), join(root, 'nested/deep'))).root, root);
});

test('outside a repository the run is refused', async t => {
  const base = workspace(t);
  await assertRefused(invocationFile(base), base);
});

test('one invocation file operates on the repository it is started in', async t => {
  const base = workspace(t); const path = invocationFile(base);
  const first = repository(base, 'first'); const second = repository(base, 'second');
  assert.equal((await resolvedConfig(path, first)).root, first);
  assert.equal((await resolvedConfig(path, second)).root, second);
});

for (const field of ['root', 'stateDirectory']) {
  for (const value of ['relative/path', '/absolute/path']) {
    test(`an invocation file setting ${field} to ${value} is refused`, async t => {
      const base = workspace(t); const root = repository(base, 'project');
      await assertRefused(invocationFile(base, { invocation: 'nightly', [field]: value }), root);
    });
  }
}

test('a restart from another subdirectory keeps the same state', async t => {
  const base = workspace(t); const root = repository(base, 'project'); const path = invocationFile(base);
  const top = await resolvedConfig(path, root);
  const nested = await resolvedConfig(path, join(root, 'nested'));
  assert.equal(top.stateDirectory, nested.stateDirectory);
});

test('two clones keep separate state outside the checkout', async t => {
  const base = workspace(t); const path = invocationFile(base);
  const first = await resolvedConfig(path, repository(join(base, 'a'), 'project'));
  const second = await resolvedConfig(path, repository(join(base, 'b'), 'project'));
  assert.notEqual(first.stateDirectory, second.stateDirectory);
  assert.ok(first.stateDirectory.startsWith('/state-home/outcome-runner/project-'));
  assert.ok(first.stateDirectory.endsWith('/nightly'));
});

test('state falls back to the home state directory for an unusable XDG_STATE_HOME', async t => {
  const base = workspace(t); const root = repository(base, 'project');
  const config = await resolvedConfig(invocationFile(base), root, { XDG_STATE_HOME: 'relative' });
  assert.match(config.stateDirectory, /\/\.local\/state\/outcome-runner\/project-/u);
});

for (const invocation of ['../escape', 'a/b', '.hidden', '', undefined]) {
  test(`invocation name ${JSON.stringify(invocation)} is refused`, async t => {
    const base = workspace(t); const root = repository(base, 'project');
    await assertRefused(invocationFile(base, { invocation }), root);
  });
}

test('hash prints the mapping the runner compares with authority', t => {
  const base = workspace(t); const queue = join(base, 'queue.json'); const lines: string[] = [];
  writeFileSync(queue, JSON.stringify({ version: 1, tasks: [task] }));
  assert.equal(printTaskHashes(queue, line => lines.push(line)), 0);
  assert.deepEqual(JSON.parse(lines[0]), { A: hash(task) });
});

for (const [name, content] of [['missing', null], ['invalid', '{"version":1,"tasks":[]}'], ['malformed', '{']]) {
  test(`hash prints no mapping for a ${name} queue`, t => {
    const base = workspace(t); const queue = join(base, 'queue.json'); const lines: string[] = [];
    if (content !== null) writeFileSync(queue, content);
    assert.equal(printTaskHashes(queue, line => lines.push(line)), 4);
    assert.equal(JSON.parse(lines[0]).status, 'unavailable');
    assert.equal(lines.length, 1);
  });
}

test('coverage passes JSON values and CLI overrides to the runner and stays unset when not given', async t => {
  const base = workspace(t); const root = repository(base, 'project');
  // Unset coverage lets the runner ask for it interactively; non-interactive runs then default to 85.
  for (const [json, args, expected] of [
    [{}, [], undefined],
    [{ coverage: 90 }, [], 90],
    [{ coverage: 90 }, ['--coverage=95'], 95],
    [{ coverage: 'invalid' }, ['--coverage=92'], 92],
    ...[1, 100].flatMap(coverage => [[{ coverage }, [], coverage], [{}, [`--coverage=${coverage}`], coverage]]),
  ] as [object, string[], number | undefined][]) {
    let received!: RunConfig;
    assert.equal(await main(invocationFile(base, { invocation: 'nightly', ...json }),
      async config => { received = config; return { status: 'exhausted' }; }, () => {}, { cwd: root, args }), 0);
    assert.equal(received.coverage, expected);
  }
  let received!: RunConfig;
  assert.equal(await main(invocationFile(base), async config => {
    received = config; return { status: 'exhausted' };
  }, () => {}, { cwd: root, args: ['--effort=high', '--coverage=93', '--model=claude-sonnet-5-5', '--harness=claude'] }), 0);
  assert.equal(received.coverage, 93); assert.equal(received.effort, 'high');
  for (const value of ['0', '101', '85.5', 'abc']) {
    let ran = false; let output = '';
    assert.equal(await main(invocationFile(base), async () => { ran = true; return { status: 'exhausted' }; },
      line => { output += line; }, { cwd: root, args: [`--coverage=${value}`] }), 4);
    assert.equal(ran, false);
    rmSync(join(JSON.parse(output).diagnostics, '..'), { recursive: true, force: true });
  }
});
