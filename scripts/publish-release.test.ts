import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publish, atomicPush, command } from './publish-release.ts';
import { release } from './release.ts';

test('E T1 workflow serializes through validated publication', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  for (const text of ['branches: [main]', 'group: release', 'cancel-in-progress: false',
    "startsWith(github.event.head_commit.message, 'chore(release):')", 'fetch-depth: 0',
    'fetch-tags: true', "node-version: '24'", '@fission-ai/openspec@1.17.0',
    'openspec --version', 'node scripts/publish-release.ts']) assert.ok(workflow.includes(text), text);
  assert.equal((workflow.match(/group:/g) ?? []).length, 1);
  const script = readFileSync('scripts/publish-release.ts', 'utf8');
  assert.ok(script.includes("[['ci'], ['run', 'typecheck'], ['test']]"));
  assert.ok(script.indexOf('(hooks.push ?? atomicPush)') < script.indexOf('if (hooks.notes)'));
});
test('E T2 release guide matches recovery contract', () => {
  const guide = readFileSync('docs/releasing.md', 'utf8');
  for (const text of ['Close merges', 'consecutive releases', 'combined release',
    'three total attempts', 'recomputes', 'immutable', 'pending-run coalescing',
    'no force push', 'restore only the missing', 'npm run release:dry-run'])
    assert.ok(guide.includes(text), text);
});

function git(cwd: string, ...args: string[]): string { return command(cwd, 'git', args); }
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'publication-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const author = join(root, 'author');
  const queued = join(root, 'queued');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, author);
  const identity = (dir: string) => {
    git(dir, 'config', 'user.name', 'Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'tag.gpgsign', 'false');
  };
  identity(author);
  writeFileSync(join(author, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  writeFileSync(join(author, 'package-lock.json'), '{"name":"fixture","version":"1.2.3","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.2.3"}}}\n');
  git(author, 'add', '.');
  git(author, 'commit', '-m', 'docs: bootstrap');
  git(author, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
  git(author, 'push', 'origin', 'main', '--tags');
  git(root, 'clone', origin, queued);
  identity(queued);
  const advance = (message: string) => {
    git(author, 'pull', '--ff-only', 'origin', 'main');
    git(author, 'commit', '--allow-empty', '-m', message);
    git(author, 'push', 'origin', 'main');
  };
  const merge = (name: string) => {
    git(author, 'pull', '--ff-only', 'origin', 'main');
    git(author, 'checkout', '-b', name);
    writeFileSync(join(author, name), name);
    git(author, 'add', name);
    git(author, 'commit', '-m', 'fix: ' + name);
    git(author, 'checkout', 'main');
    git(author, 'merge', '--no-ff', name, '-m', 'Merge pull request ' + name);
    git(author, 'push', 'origin', 'main');
  };
  return { origin, author, queued, advance, merge };
}
const valid = () => {};
const noNotes = () => { assert.fail('unexpected notes'); };

for (const stage of ['installation', 'typecheck', 'tests']) {
  test('D T3 ' + stage + ' failure prevents mutation and push', t => {
    const f = fixture(t); f.advance('fix: pending');
    const head = git(f.origin, 'rev-parse', 'main');
    assert.throws(() => publish(f.queued, {
      validate: cwd => {
        assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
        assert.equal(git(cwd, 'tag', '--list', 'v1.2.4'), '');
        throw new Error(stage);
      }, push: () => assert.fail('unexpected push'), notes: noNotes,
    }), new RegExp(stage));
    assert.equal(git(f.origin, 'rev-parse', 'main'), head);
    assert.equal(git(f.origin, 'tag', '--list', 'v1.2.4'), '');
  });
}
test('D T3 unchanged-main rejection has no retry', t => {
  const f = fixture(t); f.advance('fix: pending'); let attempts = 0;
  assert.throws(() => publish(f.queued, { validate: valid, notes: noNotes,
    push: () => { attempts++; throw new Error('rejected by policy'); },
  }), /without recoverable main advancement/);
  assert.equal(attempts, 1);
});
test('D T3 controlled advance is capped at three attempts', t => {
  const f = fixture(t); f.advance('fix: pending'); let attempts = 0;
  assert.throws(() => publish(f.queued, { validate: valid, notes: noNotes,
    push: () => { attempts++; f.advance('docs: advance ' + attempts); throw new Error('rejected non-fast-forward'); },
  }), /three total attempts/);
  assert.equal(attempts, 3);
});
