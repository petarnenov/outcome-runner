// TEMPORARY: captures typecheck and suite output for diagnosis; removed before completion.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';

test('debug capture', { timeout: 900000 }, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('NODE_TEST') && key !== 'NODE_V8_COVERAGE'));
  const tsc = spawnSync('node_modules/.bin/tsc', [], { encoding: 'utf8', env });
  const files = readdirSync('test').filter(name => name.endsWith('.test.ts') && name !== 'zz-debug-capture.test.ts')
    .map(name => `test/${name}`);
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--experimental-test-coverage',
    '--test-coverage-exclude=test/**', '--test-coverage-exclude=scripts/*.test.ts', ...files, 'scripts/release.test.ts'],
  { encoding: 'utf8', env, timeout: 850000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync('openspec/changes/openspec-preflight-install-offer/verification.md',
    `# debug\n\ntsc status ${tsc.status} ${tsc.error?.message ?? ''}\n${tsc.stdout}\n${tsc.stderr}\n\n` +
    `tests status ${run.status} ${run.error?.message ?? ''}\nSTDERR\n${run.stderr.slice(-8000)}\nSTDOUT\n${run.stdout.slice(-60000)}\n`);
});
