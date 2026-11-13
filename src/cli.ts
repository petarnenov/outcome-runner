import { readFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Statistics, appendStatistics, safeFailure } from './statistics.ts';
import type { LedgerEffects, Status } from './statistics.ts';
import { git } from './git.ts';
import { runQueue } from './runner.ts';
import type { PullRequestHost, RunEvent, RunOptions } from './runner.ts';
import { hash, validateQueue, resolveCoverage } from './model.ts';
import type { Harness, RunConfig } from './model.ts';
import { harnesses } from './harness-catalog.ts';
import { resolveRunPaths } from './run-paths.ts';
import { disposeInvocation } from './dispose.ts';
import { runnerVersion } from './runner-version.ts';
import { playMascot } from '../mascot/mascot.ts';
import type { MascotMood } from '../mascot/mascot.ts';
import { runMascot, taskMascot } from './mascot-events.ts';

type Output = (line: string) => unknown;
type Runner = (config: RunConfig, options: RunOptions) => Promise<{ status: string }>;
type Flag = 'harness' | 'model' | 'effort' | 'coverage';
type Flags = Partial<Record<Flag, string>> & { noMascot?: true; retry?: string[] };

/** Plays one mascot animation. It receives its own abort signal and never gets stdout. */
export type MascotPlayer = (mood: MascotMood, caption: string,
  options: { signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<void> | void;

export interface MainOptions {
  args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  ledger?: { env?: NodeJS.ProcessEnv; home?: string; stderr?: (line: string) => void; effects?: LedgerEffects };
  /** Mascot player; the default plays `mascot/mascot.ts` on stderr. */
  mascot?: MascotPlayer;
}

export interface DisposeCommandOptions {
  /** Only `--remove-work`, at most once. */
  args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  /** The pull request host; the default is the GitHub host of the project. */
  host?: PullRequestHost;
}

export interface HashOptions {
  /** Task ids to print; empty prints every task. Every id must name a task of the queue. */
  ids?: string[];
  /** Receives the one-line usage errors (missing queue file, unknown task id); the default is stderr. */
  error?: Output;
}

const writeOutput: Output = line => process.stdout.write(line);
const writeError: Output = line => process.stderr.write(line);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const flagPattern = /^--(harness|model|effort|coverage)=(.+)$/u;
const defaultMascot: MascotPlayer = (mood, caption, { signal, env }) => playMascot(mood, caption, { signal, env });

/** The commands and their arguments, printed by `--help` and `-h`. */
export const USAGE = 'Usage:\n' +
  '  outcome-runner <invocation file> [--harness=<claude|codex>] [--model=<id>] [--effort=<level>] [--coverage=<n>] ' +
  '[--no-mascot] [--retry <task id>]...\n' +
  '  outcome-runner hash <queue file> [<task id>...]\n' +
  '  outcome-runner dispose <invocation file> [--remove-work]\n' +
  '  outcome-runner --version\n' +
  '  outcome-runner --help\n' +
  '\n' +
  'Commands:\n' +
  '  <invocation file>  Run the outcomes of the invocation in the Git repository of the current directory.\n' +
  '  hash               Print the task hashes of a queue file, or only those of the given task ids.\n' +
  '  dispose            Release an unfinished invocation; --remove-work also removes its worktrees and branches.\n' +
  '  --version          Print the version of this runner.\n' +
  '  --help, -h         Print this help.\n' +
  '\n' +
  'Documentation: https://github.com/petarnenov/outcome-runner#readme\n';

/**
 * Uses an error's specific `reason` (for example from the OpenSpec preflight) or the generic
 * startup reason. A `missing-setting` refusal also names the missing `setting` and an `example` of it. The message,
 * stack, any `details` and the `runnerVersion` stay in the private diagnostics file.
 * Returns the line object it wrote; the exit code is always 4.
 */
function reportFailure(error: unknown, output: Output): object {
  const { message, stack, reason: specific, details, setting, example } = error as Error &
    { reason?: unknown; details?: unknown; setting?: unknown; example?: unknown };
  const reason = typeof specific === 'string' && specific ? specific : 'startup-or-run-failed';
  const directory = mkdtempSync(join(tmpdir(), 'work-queue-error-'));
  const diagnostics = join(directory, 'error.json');
  writeFileSync(diagnostics, JSON.stringify({ reason, message, stack, runnerVersion: runnerVersion(),
    ...(details === undefined ? {} : { details }) }), { mode: 0o600 });
  const line = { status: 'unavailable', reason,
    ...(typeof setting === 'string' && setting ? { setting, example } : {}), diagnostics };
  output(JSON.stringify(line) + '\n');
  return line;
}

const flagError = (arg: string) => new Error('Expected --harness=<claude|codex>, --model=<id>, ' +
  '--effort=<level> and --coverage=<n>, each at most once, --retry <task id> once per task id, ' +
  `and --no-mascot at most once; rejected ${JSON.stringify(arg)}`);

/**
 * Parses `--harness=`, `--model=`, `--effort=` and `--coverage=`, in any order, each at most once and nonempty,
 * the valueless `--no-mascot` at most once, and `--retry <task id>` with the id as the next argument, once per id.
 */
export function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--retry') {
      const id = args[index + 1];
      if (!id || id.startsWith('-') || flags.retry?.includes(id)) throw flagError(id === undefined ? arg : `${arg} ${id}`);
      flags.retry = [...(flags.retry ?? []), id]; index += 1;
      continue;
    }
    if (arg === '--no-mascot' && !flags.noMascot) { flags.noMascot = true; continue; }
    const match = flagPattern.exec(arg);
    const name = match?.[1] as Flag | undefined;
    if (!match || !name || name in flags || (name === 'harness' && !harnesses.includes(match[2] as Harness))) {
      throw flagError(arg);
    }
    flags[name] = match[2];
  }
  return flags;
}

export async function main(path: string, runner: Runner = runQueue, output: Output = writeOutput,
  { args = [], cwd, env, ledger, mascot = defaultMascot }: MainOptions = {}): Promise<number> {
  // Any spelling of the off switch keeps the mascot off, even one that flag parsing refuses later.
  const mascotEnv = env ?? process.env;
  const enabled = !args.some(arg => arg === '--no-mascot' || arg.startsWith('--no-mascot=')) &&
    mascotEnv.OUTCOME_RUNNER_MASCOT !== '0';
  const statistics = new Statistics();
  const cancellation = new AbortController();
  const active = new Set<AbortController>();
  let pending: Promise<void> = Promise.resolve();
  // Animations are serialized; a failing player is isolated from the result, exit code and state.
  const animate = (mood: MascotMood, caption: string): Promise<void> => {
    const controller = new AbortController(); active.add(controller);
    pending = pending.then(() => mascot(mood, caption, { signal: controller.signal, env: mascotEnv }))
      .catch(() => {}).finally(() => { active.delete(controller); });
    return pending;
  };
  const stop = () => {
    cancellation.abort(new Error('Run cancelled'));
    for (const controller of active) controller.abort(new Error('Run cancelled'));
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let code = 4; let status: Status = 'unavailable'; let reason: unknown; let line: unknown;
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
    const report = (event: RunEvent, detail?: { reason?: string }) => {
      output(JSON.stringify(event) + '\n');
      const shown = enabled ? taskMascot(event, detail) : undefined;
      if (shown) void animate(shown.mood, shown.caption);
    };
    // `--retry` is an operational run option; it never enters the configuration and so never the identity.
    const result = await runner(config, { statistics, signal: cancellation.signal, report,
      ...(flags.retry ? { retry: [...flags.retry] } : {}) });
    await pending;
    const terminalResult = cancellation.signal.aborted ? { ...result, status: 'cancelled' } : result;
    status = terminalResult.status as Status;
    code = ['exhausted', 'limit-reached'].includes(status) ? 0 : 3;
    line = terminalResult;
    output(JSON.stringify(terminalResult) + '\n');
  } catch (error) {
    // An aborted animation restores the cursor before the terminal line is written.
    await pending;
    if (cancellation.signal.aborted) {
      status = 'cancelled'; code = 3;
      line = { status: 'cancelled', accepted: [], remaining: [], completions: {} };
      output(JSON.stringify(line) + '\n');
    } else {
      status = 'unavailable';
      reason = safeFailure((error as { reason?: unknown })?.reason);
      code = 4; line = reportFailure(error, output);
    }
  } finally {
    // Abort is sticky even when a signal races a normal result.
    if (cancellation.signal.aborted) { status = 'cancelled'; code = 3; }
    appendStatistics(statistics.finish(status, code, reason), { env, ...ledger });
    // The run mood uses a fresh controller, so startled still plays after cancellation; stop can abort it.
    const shown = enabled ? runMascot({ status, code, line }) : undefined;
    if (shown) await animate(shown.mood, shown.caption);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  return code;
}

/**
 * `outcome-runner dispose <invocation file> [--remove-work]`: resolves the invocation like a run, disposes of it and
 * prints the summary as one JSON line (exit 0). A refusal or failure prints the `unavailable` line (exit 4). It plays
 * no mascot and records no statistics, because it is not a run.
 */
export async function dispose(path: string, output: Output = writeOutput,
  { args = [], cwd, env, host }: DisposeCommandOptions = {}): Promise<number> {
  try {
    if (args.length > 1 || args.some(arg => arg !== '--remove-work')) {
      throw new Error(`Expected only --remove-work, at most once; rejected ${JSON.stringify(args)}`);
    }
    const config = resolveRunPaths(readJson(path), { cwd, env });
    const summary = await disposeInvocation(config, { removeWork: args.length === 1, host });
    output(JSON.stringify(summary) + '\n');
    return 0;
  } catch (error) {
    reportFailure(error, output);
    return 4;
  }
}

/** An argument as it appears in a one-line error: quoted only when it contains a control character. */
const shown = (argument: string): string => /[\u0000-\u001f\u007f]/u.test(argument) ? JSON.stringify(argument) : argument;

/** Whether `path` is absent (`ENOENT`) or not a regular file; any other stat failure is left to the queue read. */
function queueFileMissing(path: string): boolean {
  try { return !statSync(path).isFile(); }
  catch (failure) { return (failure as NodeJS.ErrnoException).code === 'ENOENT'; }
}

/**
 * `outcome-runner hash <queue file> [<task id>...]`: prints one JSON line mapping the requested task ids (every task
 * when none is given) to their hashes, in queue order, and returns 0. A missing queue argument or file and unknown
 * task ids are one line on `error` with exit 4 and nothing on `output`; an invalid or malformed queue prints the
 * `unavailable` line with a diagnostics file (exit 4).
 */
export function printTaskHashes(queuePath: string | undefined, output: Output = writeOutput,
  { ids = [], error = writeError }: HashOptions = {}): number {
  if (!queuePath) {
    error('outcome-runner hash: missing queue file argument\n');
    return 4;
  }
  if (queueFileMissing(queuePath)) {
    error(`outcome-runner hash: queue file not found: ${shown(queuePath)}\n`);
    return 4;
  }
  try {
    const { tasks } = validateQueue(readJson(queuePath));
    const unknown = [...new Set(ids)].filter(id => !tasks.some(task => task.id === id));
    if (unknown.length) {
      error(`outcome-runner hash: unknown task id${unknown.length > 1 ? 's' : ''}: ${unknown.map(shown).join(', ')}\n`);
      return 4;
    }
    const selected = ids.length ? tasks.filter(task => ids.includes(task.id)) : tasks;
    output(JSON.stringify(Object.fromEntries(selected.map(task => [task.id, hash(task)]))) + '\n');
    return 0;
  } catch (failure) {
    reportFailure(failure, output);
    return 4;
  }
}

/** Entry points of the subcommands; the parameter exists so tests can check the dispatch. */
export interface Commands { dispose: typeof dispose }

/** Where `--version`, `--help` and `hash` write; the defaults are stdout and stderr. */
export interface RunStreams { output?: Output; error?: Output }

export function run([command, ...rest]: string[], commands: Commands = { dispose },
  { output = writeOutput, error = writeError }: RunStreams = {}): number | Promise<number> {
  // Version and help come first: they read no file and touch no ledger, state or diagnostics.
  if (command === '--version') { output(`${runnerVersion()}\n`); return 0; }
  if (command === '--help' || command === '-h') { output(USAGE); return 0; }
  if (command === 'dispose') return commands.dispose(rest[0], undefined, { args: rest.slice(1) });
  if (command === 'hash') return printTaskHashes(rest[0], output, { ids: rest.slice(1), error });
  return main(command, runQueue, undefined, { args: rest });
}
