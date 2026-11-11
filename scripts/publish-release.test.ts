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
