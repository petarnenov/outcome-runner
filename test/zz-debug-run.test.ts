// Temporary diagnostic capture; removed before completion.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';

test('diagnostic capture', { timeout: 3_000_000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  const out: string[] = [];
  const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { encoding: 'utf8', env, maxBuffer: 1e8 });
  out.push(`TSC ${tsc.status}\n${(tsc.stdout + tsc.stderr).slice(0, 20000)}`);
  const only = process.env.DEBUG_ONLY;
  for (const file of readdirSync('test').filter(name => name.endsWith('.test.ts') && !name.startsWith('zz-debug-run') &&
      (!only || name === only))) {
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `test/${file}`],
      { encoding: 'utf8', env, maxBuffer: 1e9 });
    const lines = run.stdout.split('\n'); const failing: string[] = [];
    lines.forEach((line, index) => {
      if (/^\s*not ok/u.test(line)) failing.push(lines.slice(index, index + 30).join('\n').slice(0, 4000));
    });
    out.push(`FILE ${file} status ${run.status}\n${failing.join('\n---\n').slice(0, 30000)}\n${run.stderr.slice(-2000)}`);
  }
  writeFileSync('test/zz-debug-output.txt', out.join('\n=====\n'));
});
