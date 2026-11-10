// Documentation check for the OpenSpec preflight (OR-3). The file name is a leftover of a diagnostic step;
// its content only verifies that README.md documents the preflight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('README documents the OpenSpec preflight, install offer, layout creation and non-interactive refusals', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## OpenSpec preflight'));
  assert.ok(readme.includes('## OpenSpec preflight'));
  for (const text of ['openspec --version', 'openspec/config.yaml', 'origin/<target>',
    'npm install -g @fission-ai/openspec@latest', 'schema: spec-driven', '.gitkeep', 'never commits or pushes',
    'both stdin and stderr are terminals', 'stderr', 'Non-interactive',
    'openspec-missing', 'openspec-not-initialized', 'openspec-layout-created', 'startup-or-run-failed']) {
    assert.ok(section.includes(text), `README preflight section mentions ${text}`);
  }
});
