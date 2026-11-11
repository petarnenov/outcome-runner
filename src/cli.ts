import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Statistics, appendStatistics, safeFailure } from './statistics.ts';
import type { LedgerEffects, Status } from './statistics.ts';
import { git } from './git.ts';
import { runQueue } from './runner.ts';
import type { RunOptions } from './runner.ts';
import { hash, validateQueue, resolveCoverage } from './model.ts';
import type { Harness, RunConfig } from './model.ts';
import { harnesses } from './harness-catalog.ts';
import { resolveRunPaths } from './run-paths.ts';

type Output = (line: string) => unknown;
type Runner = (config: RunConfig, options: RunOptions) => Promise<{ status: string }>;
type Flag = 'harness' | 'model' | 'effort' | 'coverage';

export interface MainOptions {
  args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  ledger?: { env?: NodeJS.ProcessEnv; home?: string; stderr?: (line: string) => void; effects?: LedgerEffects };
}

const writeOutput: Output = line => process.stdout.write(line);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const flagPattern = /^--(harness|model|effort|coverage)=(.+)$/u;

/**
 * Uses an error's specific `reason` (for example from the OpenSpec or test framework preflight) or the generic
 * startup reason. The message, stack and any `details` stay in the private diagnostics file.
 */
function reportFailure(error: unknown, output: Output): number {
  const { message, stack, reason: specific, details } = error as Error & { reason?: unknown; details?: unknown };
  const reason = typeof specific === 'string' && specific ? specific : 'startup-or-run-failed';
  const directory = mkdtempSync(join(tmpdir(), 'work-queue-error-'));
  const diagnostics = join(directory, 'error.json');
  writeFileSync(diagnostics, JSON.stringify({ reason, message, stack, ...(details === undefined ? {} : { details }) }), { mode: 0o600 });
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
  { args = [], cwd, env, ledger }: MainOptions = {}): Promise<number> {
  const statistics = new Statistics();
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(new Error('Run cancelled'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let code = 4; let status: Status = 'unavailable'; let reason: unknown;
  try {
    const config = resolveRunPaths(readJson(path), { cwd, env });
    let origin: string | null = null;
    try { origin = git(config.root, 'remote', 'get-url', 'origin'); } catch { /* Origin may be undiscovered. */ }
    statistics.metadata(config, config.root, origin);
    const flags = parseFlags(args);
    for (const key of ['harness', 'model', 'effort', 'coverage', 'maxAccepted', 'leaves'] as const) {
      statistics.sources[key] = key in flags ? 'cli-flag' : config[key] !== undefined ? 'invocation-json' : 'default';
    }
    if (flags.harness) config.harness = flags.harness as Harness;
    if (flags.model) config.model = flags.model;
    if (flags.effort) config.effort = flags.effort;
    if (flags.coverage !== undefined) config.coverage = resolveCoverage(Number(flags.coverage));
    const result = await runner(config, { statistics, signal: cancellation.signal,
      report: event => output(JSON.stringify(event) + '\n') });
    const terminalResult = cancellation.signal.aborted ? { ...result, status: 'cancelled' } : result;
    status = terminalResult.status as Status;
    code = ['exhausted', 'limit-reached'].includes(status) ? 0 : 3;
    output(JSON.stringify(terminalResult) + '\n');
  } catch (error) {
    if (cancellation.signal.aborted) {
      status = 'cancelled'; code = 3;
      output(JSON.stringify({ status: 'cancelled', accepted: [], remaining: [], completions: {} }) + '\n');
    } else {
      status = 'unavailable';
      reason = safeFailure((error as { reason?: unknown })?.reason);
      code = reportFailure(error, output);
    }
  } finally {
    // Abort is sticky even when a signal races a normal result.
    if (cancellation.signal.aborted) { status = 'cancelled'; code = 3; }
    appendStatistics(statistics.finish(status, code, reason), { env, ...ledger });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  return code;
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
