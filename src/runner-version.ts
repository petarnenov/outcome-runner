import { existsSync, readFileSync } from 'node:fs';

/** The version reported when no `package.json` of the installation can be read, for example in a copied `src`. */
export const UNKNOWN_VERSION = 'unknown';

let cached: string | undefined;

/**
 * The version of the executing installation, read once from its `package.json`: `../package.json` relative to this
 * module in the sources, or `../../package.json` when built into `dist/src`. Reading the version never fails a
 * command: without a readable `package.json` with a string `version` it is `unknown`.
 */
export function runnerVersion(): string {
  if (cached === undefined) {
    const near = new URL('../package.json', import.meta.url);
    const file = existsSync(near) ? near : new URL('../../package.json', import.meta.url);
    try {
      const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      cached = typeof version === 'string' && version ? version : UNKNOWN_VERSION;
    } catch { cached = UNKNOWN_VERSION; }
  }
  return cached;
}
