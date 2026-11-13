import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { commandEnvironment } from './git.ts';
import type { CheckRecord, CommandSpec } from './model.ts';

/** The wait between SIGTERM to the process group of a timed-out check and SIGKILL to what is left of it. */
export const CHECK_KILL_GRACE_MS = 10000;

/** The newest characters of the output kept in a failed or timed-out check record. */
export const CHECK_OUTPUT_TAIL = 16000;
/** The newest bytes kept of each output stream, like the `maxBuffer` of `command`. */
const OUTPUT_CAP = 32 * 1024 * 1024;
/** The interval of the polls that wait for the process group to be gone. */
const GROUP_POLL_MS = 25;

/** `N minutes` (or `1 minute`) when `ms` is a whole number of minutes, otherwise `N ms`. */
export function limitText(ms: number): string {
  if (ms > 0 && ms % 60000 === 0) {
    const minutes = ms / 60000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

/** The line that ends the output of a timed-out check, for example `Check timed out after 30 minutes`. */
export const checkTimeoutLine = (ms: number): string => `Check timed out after ${limitText(ms)}`;

/**
 * A product check that ran past its limit. `detail` is the last 16000 characters of its output, a newline and the
 * limit line; `row` is its `timed-out` check record.
 */
export class CheckTimedOut extends Error {
  detail: string;
  timeLimitMs: number;
  row: CheckRecord;
  constructor(output: string, timeLimitMs: number, check: CommandSpec = { command: '', args: [] }) {
    super(checkTimeoutLine(timeLimitMs));
    this.name = 'CheckTimedOut';
    this.timeLimitMs = timeLimitMs;
    this.detail = `${output.slice(-CHECK_OUTPUT_TAIL)}\n${checkTimeoutLine(timeLimitMs)}`;
    this.row = { command: check.command, args: [...check.args], outcome: 'timed-out', timeLimitMs, output: this.detail };
  }
}

export interface LimitedCheckOptions {
  /** The time limit of the check in milliseconds. */
  limitMs: number;
  /** The wait between SIGTERM and SIGKILL; `CHECK_KILL_GRACE_MS` when omitted. */
  graceMs?: number;
  /** The environment of the check; `commandEnvironment()` when omitted. */
  env?: NodeJS.ProcessEnv;
}

export type LimitedCheckResult = { status: 'passed'; output: string } | { status: 'timed-out'; output: string };

/** A failing exit, with the shape of the `execFileSync` error: `message`, `status`, `signal`, `stdout`, `stderr`. */
export interface CheckFailure extends Error {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Collects a stream as bytes, keeping only the newest `OUTPUT_CAP` bytes. */
function collect(stream: Readable): () => string {
  const chunks: Buffer[] = []; let size = 0;
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk); size += chunk.length;
    while (size > OUTPUT_CAP) {
      const excess = size - OUTPUT_CAP; const head = chunks[0];
      if (head.length <= excess) { chunks.shift(); size -= head.length; }
      else { chunks[0] = head.subarray(excess); size -= excess; }
    }
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

/** Sends `signal` to the process group `pid`; false when the group no longer exists. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Polls until the process group `pid` is gone or `deadline` (epoch milliseconds) has passed. */
async function waitForGroup(pid: number, deadline = Infinity): Promise<boolean> {
  for (;;) {
    if (!signalGroup(pid, 0)) return true;
    if (Date.now() >= deadline) return false;
    await delay(GROUP_POLL_MS);
  }
}

/**
 * Stops the process group `pid`: SIGTERM, a wait of at most `graceMs` for the leader and then for every member,
 * and SIGKILL when anything is left, followed by a poll until the group is gone.
 */
async function stopGroup(pid: number, graceMs: number, exited: Promise<void>): Promise<void> {
  const deadline = Date.now() + graceMs;
  signalGroup(pid, 'SIGTERM');
  // An unreaped leader can still count as a member, so the leader's exit is waited for first.
  const grace = new AbortController();
  await Promise.race([exited, delay(graceMs, undefined, { signal: grace.signal }).catch(() => {})]);
  grace.abort();
  if (await waitForGroup(pid, deadline)) return;
  signalGroup(pid, 'SIGKILL');
  await exited;
  await waitForGroup(pid);
}

/**
 * Runs one check program with an argument array and no shell in `cwd`, as the leader of a new process group, with a
 * time limit. Within the limit, exit code 0 resolves `passed` with the trimmed stdout, and any other exit rejects
 * with a `CheckFailure`. When the limit passes first, the whole group is stopped (see `stopGroup`) and the promise
 * resolves `timed-out` with the trimmed stdout and stderr joined by a newline, only after no process of the group
 * remains.
 */
export async function runLimitedCheck(cwd: string, program: string, args: string[],
  { limitMs, graceMs = CHECK_KILL_GRACE_MS, env = commandEnvironment() }: LimitedCheckOptions): Promise<LimitedCheckResult> {
  const child = spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout!); const stderr = collect(child.stderr!);
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const failed = await new Promise<Error | null>(resolve => {
    child.once('spawn', () => resolve(null));
    child.once('error', resolve);
  });
  if (failed) throw failed;
  // Later errors (for example of a signal to an already reaped leader) never decide the result.
  child.on('error', () => {});
  const pid = child.pid!;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), limitMs); });
  const first = await Promise.race([closed, limit]);
  if (first !== 'timeout') {
    clearTimeout(timer);
    if (first.code === 0) return { status: 'passed', output: stdout().trim() };
    const out = stdout(); const err = stderr();
    throw Object.assign(new Error(`Command failed: ${[program, ...args].join(' ')}\n${err}`),
      { status: first.code, signal: first.signal, stdout: out, stderr: err }) as CheckFailure;
  }
  await stopGroup(pid, graceMs, exited);
  // A stopped group can no longer hold the pipes open.
  await closed;
  const output = [stdout(), stderr()].map(stream => stream.trim()).filter(Boolean).join('\n');
  return { status: 'timed-out', output };
}
