/** The marker file whose presence makes the hang script hang, relative to the check's working directory. */
export const HANG_MARKER = 'src/a/hang.md';

/**
 * A Node script for `node -e <script> <pid file>`. Without `src/a/hang.md` (relative to its working directory) it
 * exits 0 at once. With it, it prints `check started`, appends its pid to the pid file named by its argument and
 * sleeps for ten minutes.
 */
export const HANG_SCRIPT = [
  "const fs = require('node:fs');",
  `if (!fs.existsSync('${HANG_MARKER}')) process.exit(0);`,
  "console.log('check started');",
  "fs.appendFileSync(process.argv[1], process.pid + '\\n');",
  'setTimeout(() => {}, 600000);',
].join('\n');

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
