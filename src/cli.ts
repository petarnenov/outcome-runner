import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueue } from './runner.ts';
import type { RunOptions } from './runner.ts';
import { hash, validateQueue } from './model.ts';
import type { Harness, RunConfig } from './model.ts';
import { resolveRunPaths } from './run-paths.ts';

type Output = (line: string) => unknown;
type Runner = (config: RunConfig, options: RunOptions) => Promise<{ status: string }>;

interface MainOptions { args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

const writeOutput: Output = line => process.stdout.write(line);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function reportFailure(error: unknown, output: Output): number {
  const { message, stack } = error as Error;
  const directory = mkdtempSync(join(tmpdir(), 'work-queue-error-'));
  const diagnostics = join(directory, 'error.json');
  writeFileSync(diagnostics, JSON.stringify({ message, stack }), { mode: 0o600 });
  output(JSON.stringify({ status: 'unavailable', reason: 'startup-or-run-failed', diagnostics }) + '\n');
  return 4;
}

export async function main(path: string, runner: Runner = runQueue, output: Output = writeOutput,
  { args = [], cwd, env }: MainOptions = {}): Promise<number> {
  try {
    const config = resolveRunPaths(readJson(path), { cwd, env });
    if (args.length > 1 || args.some(arg => !/^--harness=(codex|claude)$/u.test(arg))) {
      throw new Error('Expected --harness=codex or --harness=claude');
    }
    if (args.length) config.harness = args[0].slice('--harness='.length) as Harness;
    const result = await runner(config, { report: event => output(JSON.stringify(event) + '\n') });
    output(JSON.stringify(result) + '\n');
    return ['exhausted', 'limit-reached'].includes(result.status) ? 0 : 3;
  } catch (error) {
    return reportFailure(error, output);
  }
}

export function printTaskHashes(queuePath: string, output: Output = writeOutput): number {
  try {
    const { tasks } = validateQueue(readJson(queuePath));
    output(JSON.stringify(Object.fromEntries(tasks.map(task => [task.id, hash(task)]))) + '\n');
    return 0;
  } catch (error) {
    return reportFailure(error, output);
  }
}

export function run([command, ...rest]: string[]): number | Promise<number> {
  return command === 'hash' ? printTaskHashes(rest[0]) : main(command, runQueue, undefined, { args: rest });
}
