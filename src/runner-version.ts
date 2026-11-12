import { existsSync, readFileSync } from 'node:fs';

let cached: string | undefined;

/**
 * The version of the executing installation, read once from its `package.json`: `../package.json` relative to this
 * module in the sources, or `../../package.json` when built into `dist/src`.
 */
export function runnerVersion(): string {
  if (cached === undefined) {
    const near = new URL('../package.json', import.meta.url);
    const file = existsSync(near) ? near : new URL('../../package.json', import.meta.url);
    cached = String(JSON.parse(readFileSync(file, 'utf8')).version);
  }
  return cached;
}
