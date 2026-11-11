import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueue } from './runner.ts';
import type { RunOptions } from './runner.ts';
import { hash, validateQueue, resolveCoverage } from './model.ts';
import type { Harness, RunConfig } from './model.ts';
import { harnesses } from './harness-catalog.ts';
import { resolveRunPaths } from './run-paths.ts';

type Output = (line: string) => unknown;
type Runner = (config: RunConfig, options: RunOptions) => Promise<{ status: string }>;
type Flag = 'harness' | 'model' | 'effort' | 'coverage';

interface MainOptions { args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

const writeOutput: Output = line => process.stdout.write(line);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const flagPattern = /^--(harness|model|effort|coverage)=(.+)$/u;

/** Uses an error's specific `reason` (for example from the OpenSpec preflight) or the generic startup reason. */
function reportFailure(error: unknown, output: Output): number {
  const { message, stack, reason: specific } = error as Error & { reason?: unknown };
  const reason = typeof specific === 'string' && specific ? specific : 'startup-or-run-failed';
  const directory = mkdtempSync(join(tmpdir(), 'work-queue-error-'));
  const diagnostics = join(directory, 'error.json');
  writeFileSync(diagnostics, JSON.stringify({ reason, message, stack }), { mode: 0o600 });
  output(JSON.stringify({ status: 'unavailable', reason, diagnostics }) + '\n');
  return 4;
}

/** Parses `--harness=`, `--model=`, `--effort=` and `--coverage=`, in any order, each at most once and nonempty. */
export function parseFlags(args: string[]): Partial<Record<Flag, string>> {
  const flags: Partial<Record<Flag, string>> = {};
  for (const arg of args) {
    const match = flagPattern.exec(arg);
    const name = match?.[1] as Flag | undefined;
    if (!match || !name || name in flags || (name === 'harness' && !harnesses.includes(match[2] as Harness))) {
      throw new Error('Expected --harness=<claude|codex>, --model=<id>, --effort=<level> and --coverage=<n>, each at most once; ' +
        `rejected ${JSON.stringify(arg)}`);
    }
    flags[name] = match[2];
  }
  return flags;
}

export async function main(path: string, runner: Runner = runQueue, output: Output = writeOutput,
  { args = [], cwd, env }: MainOptions = {}): Promise<number> {
  try {
    const config = resolveRunPaths(readJson(path), { cwd, env });
    const flags = parseFlags(args);
    if (flags.harness) config.harness = flags.harness as Harness;
    if (flags.model) config.model = flags.model;
    if (flags.effort) config.effort = flags.effort;
    // Coverage stays unset when neither flag nor JSON gives it, so the runner can ask for it interactively.
    if (flags.coverage !== undefined) config.coverage = resolveCoverage(Number(flags.coverage));
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
