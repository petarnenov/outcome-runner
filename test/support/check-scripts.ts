import type { CommandSpec } from '../../src/model.ts';

/** The marker file whose presence makes the hang script hang, relative to the check's working directory. */
export const HANG_MARKER = 'src/a/hang.md';

/**
 * A shell script for `sh -c <script> sh <pid file>`. Without `src/a/hang.md` (relative to its working directory) it
 * exits 0 at once. With it, it prints `check started`, appends its pid to the pid file named by its argument and
 * becomes a ten-minute `sleep` with the same pid. A shell starts in a few milliseconds, so the script decides well
 * within a limit of a few hundred milliseconds even on a loaded machine.
 */
export const HANG_SCRIPT = `[ -f ${HANG_MARKER} ] || exit 0; echo 'check started'; echo $$ >> "$1"; exec sleep 600`;

/** The hang check of the runner tests, writing its pid to `pidFile`. */
export const hangCheck = (pidFile: string): CommandSpec => ({ command: 'sh', args: ['-c', HANG_SCRIPT, 'sh', pidFile] });

/**
 * Product checks that start in a few milliseconds, for runs with a limit of a few hundred milliseconds: the fixture
 * check script must exist, and the coverage gate argument must be a positive number.
 */
export const FAST_CHECKS: readonly CommandSpec[] = Object.freeze([
  { command: 'sh', args: ['-c', 'test -f checks.mjs'] },
  { command: 'sh', args: ['-c', 'test "$1" -ge 1', 'sh', '{coverage}'] },
]);

/**
 * A shell script for `sh -c <script> sh <pid file>`. It ignores SIGTERM, starts a `sleep` child that inherits the
 * ignored SIGTERM, writes its own pid and the child's pid (separated by a space) to the pid file, prints `started`
 * and waits for the child.
 */
export const IGNORE_TERM_SCRIPT = 'trap "" TERM; sleep 600 & echo "$$ $!" > "$1"; echo started; wait';

/** Whether a process with `pid` exists; only `ESRCH` means it does not. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
