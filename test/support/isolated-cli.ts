import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as cliMain } from '../../src/cli.ts';

/** Existing CLI tests can assert invocation paths while keeping the ledger in a temporary XDG state home. */
export async function main(...[path, runner, output, options]: Parameters<typeof cliMain>): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), 'isolated-cli-ledger-'));
  try {
    return await cliMain(path, runner, output, { ...options,
      ledger: { ...options?.ledger, env: { XDG_STATE_HOME: directory } } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
