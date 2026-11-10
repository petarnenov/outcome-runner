import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { release, versionTokens } from './release.ts';

const script = resolve('scripts/release.ts');
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function fixture(t: { after(fn: () => void): void }, tag: string | false = '1.2.3') {
  const cwd = mkdtempSync(join(tmpdir(), 'release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'config', 'user.email', 'release@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'tag.gpgsign', 'false');
  const pkg = '{\r\n  "nested": {"version":"8.0.0", "items":[1,true,null,{"x":"quoted \\"value\\""}]},\r\n  "version" : "0.1.0", "name":"fixture"\r\n}';
  const lock = '{ "packages": {"dependency":{"version":"9.9.9"}, "": {"version" : "0.1.0"}}, "version":"0.1.0", "lockfileVersion":3 }\n';
  writeFileSync(join(cwd, 'package.json'), pkg);
  writeFileSync(join(cwd, 'package-lock.json'), lock);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'docs: initial');
  if (tag) git(cwd, 'tag', 'v' + tag);
  return { cwd, pkg, lock };
}
function commit(cwd: string, message: string): string {
  git(cwd, 'commit', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', '--short', 'HEAD');
}
function snapshot(cwd: string) {
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    index: readFileSync(join(cwd, '.git/index')).toString('hex'),
    status: git(cwd, 'status', '--porcelain'),
    tags: git(cwd, 'show-ref', '--tags'),
    pkg: readFileSync(join(cwd, 'package.json'), 'utf8'),
    lock: readFileSync(join(cwd, 'package-lock.json'), 'utf8'),
  };
}

for (const [message, version] of [
  ['feat(queue)!: change ownership', '2.0.0'],
  ['refactor!: remove legacy', '2.0.0'],
  ['refactor: remove transport\n\nBody text.\n\nBREAKING CHANGE: remove transport\n continued explanation', '2.0.0'],
  ['chore: update API\n\nRefs: #12\nBREAKING-CHANGE: replace API\n continued', '2.0.0'],
  ['feat(work-queue): add scheduling', '1.3.0'],
  ['fix(queue): avoid duplicate claims', '1.2.4'],
  ['perf: reduce polling', '1.2.4'],
] as const) {
  test(message, t => {
    const { cwd } = fixture(t);
    const hash = commit(cwd, message);
    const result = release(cwd);
    assert.ok(result.startsWith(version + '\n'));
    assert.ok(result.includes('(' + hash + ')'));
    assert.equal(git(cwd, 'log', '-1', '--format=%s'), 'chore(release): v' + version);
    assert.equal(git(cwd, 'cat-file', '-t', 'v' + version), 'tag');
    assert.equal(git(cwd, 'rev-parse', 'v' + version + '^{}'), git(cwd, 'rev-parse', 'HEAD'));
    assert.equal(git(cwd, 'remote'), '');
    assert.equal(release(cwd), 'no release\n');
  });
}

test('precedence, grouping, byte preservation, and old changelog', t => {
  const { cwd, pkg, lock } = fixture(t, '0.2.3');
  const old = '# History\r\n\r\nExisting bytes\r\n';
  writeFileSync(join(cwd, 'CHANGELOG.md'), old);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'docs: history');
  const breaking = commit(cwd, 'feat!: break contracts');
  const feature = commit(cwd, 'feat(queue): schedule work');
  const fix = commit(cwd, 'fix: repair claims');
  const perf = commit(cwd, 'perf: faster polling');
  commit(cwd, 'docs: explain usage');
  const output = release(cwd, false, new Date('2026-11-10T23:59:59Z'));
  const section = output.slice(output.indexOf('\n') + 1);
  assert.ok(section.startsWith('## 1.0.0 - 2026-11-10\n'));
  assert.ok(section.indexOf('### Breaking changes') < section.indexOf('### Features'));
  assert.ok(section.indexOf('### Features') < section.indexOf('### Fixes'));
  for (const [description, hash] of [['break contracts', breaking], ['schedule work', feature], ['repair claims', fix], ['faster polling', perf]]) {
    assert.equal(section.split('- ' + description + ' (' + hash + ')').length, 2);
  }
  assert.ok(!section.includes('feat'));
  assert.ok(!section.includes('explain usage'));
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), pkg.replace('"0.1.0"', '"1.0.0"'));
  assert.equal(readFileSync(join(cwd, 'package-lock.json'), 'utf8'), lock.replaceAll('"0.1.0"', '"1.0.0"'));
  assert.equal(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), section + '\n' + old);
  assert.deepEqual(git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'),
    ['CHANGELOG.md', 'package-lock.json', 'package.json']);
});

test('feature outranks patches and empty groups disappear', t => {
  const { cwd } = fixture(t);
  commit(cwd, 'fix: repair');
  commit(cwd, 'perf: accelerate');
  commit(cwd, 'feat: add transport');
  const result = release(cwd);
  assert.ok(result.startsWith('1.3.0\n'));
  assert.ok(!result.includes('### Breaking changes'));
  assert.ok(result.includes('### Features') && result.includes('### Fixes'));
});

test('patch-only section omits empty groups', t => {
  const { cwd } = fixture(t);
  commit(cwd, 'fix: repair');
  const result = release(cwd);
  assert.ok(!result.includes('### Breaking changes') && !result.includes('### Features'));
  assert.ok(result.includes('### Fixes'));
});

test('invalid, prose, other types and release messages leave all state intact', t => {
  const { cwd } = fixture(t);
  for (const message of [
    'ordinary message\n\nBREAKING CHANGE: ignored',
    'feat:no space', 'feat: ', 'docs: explain',
    'chore: tooling\n\nExample includes BREAKING CHANGE: quoted text',
    'chore: explain\n\n> BREAKING CHANGE: quoted example',
    'chore(release): v1.2.3\n\nBREAKING CHANGE: ignored',
  ]) commit(cwd, message);
  const before = snapshot(cwd);
  assert.equal(release(cwd), 'no release\n');
  assert.equal(release(cwd, true), 'no release\n');
  assert.deepEqual(snapshot(cwd), before);
});

test('merged branches contribute; actual conventional merge messages do not', t => {
  const { cwd } = fixture(t);
  git(cwd, 'checkout', '-b', 'feature');
  const hash = commit(cwd, 'feat: merged scheduling');
  git(cwd, 'checkout', 'main');
  commit(cwd, 'docs: main progress');
  git(cwd, 'merge', '--no-ff', 'feature', '-m', 'feat!: misleading merge\n\nBREAKING CHANGE: ignore merge');
  const output = release(cwd);
  assert.ok(output.startsWith('1.3.0\n'));
  assert.ok(output.includes(hash));
  assert.ok(!output.includes('misleading'));
});

test('greatest reachable numeric stable tag excludes all its ancestry', t => {
  const { cwd } = fixture(t, '1.9.0');
  commit(cwd, 'feat!: already released');
  git(cwd, 'tag', '-a', 'v1.10.0', '-m', 'release');
  git(cwd, 'tag', 'v1.09.0');
  git(cwd, 'tag', 'v99.0.0-rc.1');
  git(cwd, 'tag', 'v99.0.0+build');
  git(cwd, 'checkout', '-b', 'unmerged');
  commit(cwd, 'feat!: unrelated');
  git(cwd, 'tag', 'v99.0.0');
  git(cwd, 'checkout', 'main');
  commit(cwd, 'fix: new fix');
  assert.ok(release(cwd).startsWith('1.10.1\n'));
});

for (const message of ['feat!: bootstrap break', 'docs: bootstrap without entries']) {
  test('bootstrap: ' + message, t => {
    const { cwd, pkg, lock } = fixture(t, false);
    commit(cwd, message);
    const preview = release(cwd, true);
    assert.ok(preview.startsWith('0.1.0\n'));
    const result = release(cwd);
    assert.equal(result, preview);
    assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), pkg);
    assert.equal(readFileSync(join(cwd, 'package-lock.json'), 'utf8'), lock);
    assert.equal(git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'CHANGELOG.md');
    assert.equal(git(cwd, 'cat-file', '-t', 'v0.1.0'), 'tag');
    if (message.startsWith('docs')) assert.ok(!result.includes('###'));
  });
}

for (const tag of [false, '1.2.3'] as const) {
  test('CLI dry run preserves files, index, HEAD and tags: ' + tag, t => {
    const { cwd } = fixture(t, tag);
    // snapshot also works for bootstrap by giving it a nonrelease tag.
    git(cwd, 'tag', 'fixture');
    commit(cwd, 'feat: preview');
    writeFileSync(join(cwd, 'CHANGELOG.md'), 'untracked history\n');
    writeFileSync(join(cwd, 'staged.txt'), 'existing staged file');
    git(cwd, 'add', 'staged.txt');
    const before = snapshot(cwd);
    const result = execFileSync(process.execPath, [script, '--dry-run'], { cwd, encoding: 'utf8' });
    assert.ok(result.startsWith(tag ? '1.3.0\n' : '0.1.0\n'));
    assert.deepEqual(snapshot(cwd), before);
    assert.equal(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), 'untracked history\n');
  });
}

test('actual CLI releases and reports errors', t => {
  const { cwd } = fixture(t);
  commit(cwd, 'fix: cli');
  assert.ok(execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' }).startsWith('1.2.4\n'));
  const invalid = spawnSync(process.execPath, [script, '--unknown'], { cwd, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  assert.equal(execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' }), 'no release\n');
});

test('dirty and colliding repositories fail before mutation', t => {
  const { cwd } = fixture(t);
  commit(cwd, 'feat: candidate');
  writeFileSync(join(cwd, 'unrelated'), 'dirty');
  let before = snapshot(cwd);
  assert.throws(() => release(cwd), /clean working tree/);
  assert.deepEqual(snapshot(cwd), before);
  git(cwd, 'add', 'unrelated');
  assert.throws(() => release(cwd), /clean working tree/);
  git(cwd, 'commit', '-m', 'docs: unrelated');
  git(cwd, 'checkout', '-b', 'collision');
  commit(cwd, 'docs: unrelated tag');
  git(cwd, 'tag', 'v1.3.0');
  git(cwd, 'checkout', 'main');
  before = snapshot(cwd);
  assert.throws(() => release(cwd), /already exists/);
  assert.deepEqual(snapshot(cwd), before);
});

test('metadata validation, escaped keys and exact large version arithmetic', t => {
  assert.equal(versionTokens('{"ver\\u0073ion":"old","x":[]}', [['version']], '2.0.0'),
    '{"ver\\u0073ion":"2.0.0","x":[]}');
  assert.throws(() => versionTokens('{"version":1}', [['version']], '2.0.0'), /string/);
  assert.throws(() => versionTokens('{}', [['version']], '2.0.0'), /Missing/);
  assert.throws(() => versionTokens('{"version":"a","version":"b"}', [['version']], '2.0.0'), /duplicate/);
  assert.throws(() => versionTokens('invalid', [['version']], '2.0.0'), SyntaxError);
  const { cwd } = fixture(t, '9007199254740993.2.3');
  git(cwd, 'tag', 'v9007199254740992.99.99');
  commit(cwd, 'fix: exact increment');
  assert.ok(release(cwd, true).startsWith('9007199254740993.2.4\n'));
});

test('invalid bootstrap metadata fails before mutation', t => {
  const { cwd } = fixture(t, false);
  writeFileSync(join(cwd, 'package.json'), '{"version":"01.2.3"}');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'docs: invalid version');
  assert.throws(() => release(cwd), /stable package version/);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('atomic publication succeeds and rejection publishes neither ref', t => {
  const { cwd } = fixture(t);
  const remote = mkdtempSync(join(tmpdir(), 'release-remote-'));
  const other = mkdtempSync(join(tmpdir(), 'release-other-'));
  t.after(() => { rmSync(remote, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  git(remote, 'init', '--bare', '-b', 'main');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', 'origin', 'main');
  commit(cwd, 'fix: first publication');
  release(cwd);
  git(cwd, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.2.4');
  assert.equal(git(remote, 'rev-parse', 'main'), git(cwd, 'rev-parse', 'HEAD'));
  git(other, 'clone', remote, '.');
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.invalid');
  git(other, 'config', 'commit.gpgsign', 'false');
  commit(other, 'docs: advance main');
  git(other, 'push', 'origin', 'main');
  const remoteHead = git(remote, 'rev-parse', 'main');
  commit(cwd, 'fix: stale publication');
  release(cwd);
  assert.throws(() => git(cwd, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.2.5'));
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
  assert.equal(git(remote, 'tag', '--list', 'v1.2.5'), '');
});
