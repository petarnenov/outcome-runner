import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/claude-adapter.ts';
import { CodexAdapter } from '../src/codex-adapter.ts';
import { isAtLeast } from '../src/harness-version.ts';
import type { ToolDefinition } from '../src/harness-adapter.ts';

for (const [version, minimum, expected] of [
  ['2.1.321', '2.1.321', true], ['2.1.322', '2.1.321', true], ['2.2.0', '2.1.321', true], ['3.0.0', '2.1.321', true],
  ['2.1.1000', '2.1.321', true], ['2.1.320', '2.1.321', false], ['2.0.999', '2.1.321', false], ['1.9.999', '2.1.321', false],
  ['2.1.322-beta.1', '2.1.321', false], ['future', '2.1.321', false], ['', '2.1.321', false], [undefined, '2.1.321', false],
] as [string | undefined, string, boolean][]) {
  test(`${version} against minimum ${minimum} is ${expected}`, () => assert.equal(isAtLeast(version, minimum), expected));
}

function harnessPrinting(t: TestContext, output: string) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'harness');
  writeFileSync(executable, `#!/bin/sh\necho "${output}"\n`); chmodSync(executable, 0o755);
  return executable;
}
const options = { cwd: '/tmp', tools: [{ name: 'echo' }] as ToolDefinition[], handleTool: async () => {} };

for (const [Adapter, output, status] of [
  [ClaudeAdapter, '2.1.321 (Claude Code)', 'interface-ready'], [ClaudeAdapter, '2.1.322 (Claude Code)', 'interface-ready'],
  [ClaudeAdapter, '2.1.320 (Claude Code)', 'unavailable'], [ClaudeAdapter, '2.1.322', 'unavailable'],
  [CodexAdapter, 'codex-cli 0.167.0', 'interface-ready'], [CodexAdapter, 'codex-cli 0.168.2', 'interface-ready'],
  [CodexAdapter, 'codex-cli 0.166.9', 'unavailable'], [CodexAdapter, '0.168.0', 'unavailable'],
] as [typeof ClaudeAdapter | typeof CodexAdapter, string, string][]) {
  test(`${Adapter.name} probe of "${output}" is ${status}`, t => {
    const adapter = new Adapter({ ...options, executable: harnessPrinting(t, output) });
    assert.equal(adapter.probe().status, status);
  });
}
