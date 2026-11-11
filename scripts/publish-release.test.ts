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

for (const stage of ['preinstall', 'typecheck', 'test']) {
  test('D T3 actual npm validation stops at ' + stage, t => {
    const f = fixture(t);
    const scripts = Object.fromEntries(['preinstall', 'typecheck', 'test'].map(name =>
      [name, 'node -e "process.exit(' + (name === stage ? 1 : 0) + ')"']));
    writeFileSync(join(f.author, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3', scripts }));
    git(f.author, 'add', '.'); git(f.author, 'commit', '-m', 'fix: failing validation');
    git(f.author, 'push', 'origin', 'main');
    const head = git(f.origin, 'rev-parse', 'main');
    assert.throws(() => publish(f.queued, { push: () => assert.fail('push after failed validation'), notes: noNotes }), /Command failed/);
    assert.equal(git(f.origin, 'rev-parse', 'main'), head);
    assert.equal(git(f.origin, 'tag', '--list', 'v1.2.4'), '');
  });
}

test('C T4 covered range is a no-op', t => {
  const f = fixture(t);
  assert.equal(publish(f.queued, { validate: valid, push: () => assert.fail('push'), notes: noNotes }), 'no release\n');
});
test('C T4 unrelated existing candidate tag stays immutable', t => {
  const f = fixture(t);
  git(f.author, 'checkout', '-b', 'unrelated');
  git(f.author, 'commit', '--allow-empty', '-m', 'docs: unrelated');
  git(f.author, 'tag', '-a', 'v1.2.4', '-m', 'unrelated');
  git(f.author, 'push', 'origin', 'refs/tags/v1.2.4');
  git(f.author, 'checkout', 'main');
  f.advance('fix: pending');
  const object = git(f.origin, 'rev-parse', 'v1.2.4');
  const head = git(f.origin, 'rev-parse', 'main');
  const pkg = git(f.origin, 'show', 'main:package.json');
  assert.throws(() => publish(f.queued, { validate: valid, notes: noNotes }), /already exists/);
  assert.equal(git(f.origin, 'rev-parse', 'v1.2.4'), object);
  assert.equal(git(f.origin, 'rev-parse', 'main'), head);
  assert.equal(git(f.origin, 'show', 'main:package.json'), pkg);
});
for (const transport of ['normal', 'confirmed', 'indeterminate', 'notes-failure']) {
  test('C T5 publication outputs: ' + transport, t => {
    const f = fixture(t); f.advance('fix: final section');
    let notes = 0;
    const run = () => publish(f.queued, {
      validate: valid,
      push: (cwd, tag) => {
        assert.equal(notes, 0);
        atomicPush(cwd, tag);
        if (transport === 'confirmed' || transport === 'indeterminate') throw new Error('connection lost');
      },
      ...(transport === 'indeterminate' ? { inspect: () => { throw new Error('offline'); } } : {}),
      notes: (cwd, tag, section) => {
        notes++;
        assert.equal(tag, 'v1.2.4');
        assert.equal(git(f.origin, 'rev-parse', tag + '^{}'), git(f.origin, 'rev-parse', 'main'));
        assert.equal(section, readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'));
        assert.ok(section.startsWith('## 1.2.4'));
        if (transport === 'notes-failure') throw new Error('GitHub offline');
      },
    });
    if (transport === 'indeterminate') assert.throws(run, /Publication uncertain/);
    else if (transport === 'notes-failure') assert.throws(run, /restore only missing/);
    else assert.ok(run().startsWith('1.2.4\n'));
    assert.equal(notes, transport === 'indeterminate' ? 0 : 1);
    assert.equal(publish(f.queued, { validate: valid, notes: noNotes, push: () => assert.fail('duplicate push') }), 'no release\n');
  });
}

test('B T6 main advancement recomputes patch to minor and revalidates', t => {
  const f = fixture(t); f.advance('fix: first patch');
  const bases: string[] = []; let attempts = 0; let notes = 0;
  const output = publish(f.queued, {
    validate: cwd => { bases.push(git(cwd, 'rev-parse', 'HEAD')); },
    push: (cwd, tag) => {
      attempts++;
      if (attempts === 1) {
        assert.equal(tag, 'v1.2.4');
        f.advance('feat: new feature');
        try { atomicPush(cwd, tag); }
        catch (error) {
          assert.equal(git(f.origin, 'tag', '--list', tag), '');
          assert.notEqual(git(f.origin, 'rev-parse', 'main'), git(cwd, 'rev-parse', 'HEAD'));
          throw error;
        }
        assert.fail('stale push unexpectedly accepted');
      }
      atomicPush(cwd, tag);
    },
    notes: (_cwd, tag, section) => {
      notes++; assert.equal(tag, 'v1.3.0');
      assert.equal(section.split('first patch').length, 2);
      assert.equal(section.split('new feature').length, 2);
      assert.ok(!section.includes('1.2.4'));
    },
  });
  assert.ok(output.startsWith('1.3.0\n'));
  assert.equal(attempts, 2); assert.equal(notes, 1);
  assert.equal(bases.length, 2); assert.notEqual(bases[0], bases[1]);
  assert.equal(git(f.origin, 'tag', '--list', 'v1.2.4'), '');
});
for (const additional of [false, true]) {
  test('B T7 independent remote release refreshes boundary: ' + additional, t => {
    const f = fixture(t); f.advance('fix: already covered');
    let attempts = 0; let object = ''; let notes = 0;
    const output = publish(f.queued, {
      validate: valid,
      push: (cwd, tag) => {
        if (++attempts === 1) {
          release(f.author, false, new Date('2020-01-01'));
          atomicPush(f.author, 'v1.2.4');
          object = git(f.origin, 'rev-parse', 'v1.2.4');
          if (additional) f.advance('fix: next change');
        }
        atomicPush(cwd, tag);
      },
      notes: (_cwd, tag, section) => {
        notes++; assert.equal(tag, 'v1.2.5');
        assert.ok(section.includes('next change'));
        assert.ok(!section.includes('already covered'));
      },
    });
    assert.ok(additional ? output.startsWith('1.2.5\n') : output === 'no release\n');
    assert.equal(notes, additional ? 1 : 0);
    assert.equal(git(f.origin, 'rev-parse', 'v1.2.4'), object);
    const history = git(f.origin, 'show', 'main:CHANGELOG.md');
    assert.equal(history.split('already covered').length, 2);
  });
}
test('B T8 real atomic rejections exhaust exactly three attempts', t => {
  const f = fixture(t); f.advance('fix: pending');
  let attempts = 0;
  assert.throws(() => publish(f.queued, {
    validate: valid, notes: noNotes,
    push: (cwd, tag) => {
      attempts++; f.advance('docs: concurrent ' + attempts);
      try { atomicPush(cwd, tag); }
      finally { assert.equal(git(f.origin, 'tag', '--list', tag), ''); }
    },
  }), /three total attempts/);
  assert.equal(attempts, 3);
  assert.equal(git(f.origin, 'log', '--format=%s').includes('chore(release):'), false);
});
