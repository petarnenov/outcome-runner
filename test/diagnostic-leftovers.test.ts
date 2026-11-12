import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { LEFTOVER_FILES_REVIEW, LEFTOVER_FILES_WORK } from '../src/runner.ts';

// 4.1 (E) (required)
test('E: the leftover file fragments name delete_file, changes-required, debug tests and findings', () => {
  assert.match(LEFTOVER_FILES_WORK, /delete_file/u);
  assert.match(LEFTOVER_FILES_WORK, /scratch or diagnostic file/u);
  assert.match(LEFTOVER_FILES_WORK, /temporary debug tests/u);
  assert.match(LEFTOVER_FILES_REVIEW, /changes-required/u);
  assert.match(LEFTOVER_FILES_REVIEW, /temporary debug test/u);
  assert.match(LEFTOVER_FILES_REVIEW, /name each such file by path in findings/u);
  // Neither fragment carries a percentage, so the coverage threshold tests stay unaffected.
  assert.doesNotMatch(LEFTOVER_FILES_WORK + LEFTOVER_FILES_REVIEW, /%/u);
});

// 4.2 (E) (required)
test('E: the leftover diagnostic test file is gone and its README check lives in the preflight tests', () => {
  assert.equal(existsSync(new URL('./zz-debug-capture.test.ts', import.meta.url)), false);
  const preflight = readFileSync(new URL('./openspec-preflight.test.ts', import.meta.url), 'utf8');
  assert.ok(preflight.includes("test('README documents the OpenSpec preflight, install offer, layout creation and " +
    "non-interactive refusals'"));
});
