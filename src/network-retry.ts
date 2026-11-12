/**
 * Waiting out a lost network connection. Only failures that happen while connecting (host lookup, refused or
 * unreachable connection) are retried: the request never reached the server, so repeating any command is safe.
 */

/** Messages of Git (curl and ssh) and gh when the connection cannot be made. */
const CONNECTION_FAILURES: readonly RegExp[] = [
  /Could not resolve host/iu,
  /Could not resolve hostname/iu,
  /Temporary failure in name resolution/iu,
  /nodename nor servname provided/iu,
  /Name or service not known/iu,
  /no such host/iu,
  /Failed to connect to/iu,
  /Network is unreachable/iu,
  /Connection refused/iu,
  /error connecting to /iu,
];

/** About 15 minutes of waiting in total before the failure is given up and reported. */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [5000, 10000, 20000, 40000, ...Array<number>(13).fill(60000)];

export interface NetworkRetryPolicy {
  /** The wait before each retry; the number of entries is the number of retries. */
  delaysMs: readonly number[];
  /** Blocks for `milliseconds`; runner commands are synchronous, so the wait is too. */
  sleep: (milliseconds: number) => void;
  /** Called before each wait with the retry number (1 for the first), the wait and the failed command. */
  onWait: (retry: number, milliseconds: number, failed: string) => void;
}

const blockingSleep = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const DEFAULT_POLICY: NetworkRetryPolicy = { delaysMs: NETWORK_RETRY_DELAYS_MS, sleep: blockingSleep, onWait: () => {} };
let policy: NetworkRetryPolicy = DEFAULT_POLICY;

/** Replaces parts of the retry policy until the returned function restores the previous one. */
export function useNetworkRetry(changes: Partial<NetworkRetryPolicy>): () => void {
  const previous = policy;
  policy = { ...previous, ...changes };
  return () => { policy = previous; };
}

/** Whether `error` is a command failure caused by a connection that could not be made. */
export function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`;
  return CONNECTION_FAILURES.some(pattern => pattern.test(text));
}

/**
 * Runs `run`; while it fails because the connection could not be made, waits by the policy and runs it again.
 * Any other failure, or a connection failure after the last wait, is thrown unchanged.
 */
export function withNetworkRetry<T>(run: () => T, describe: () => string): T {
  const { delaysMs, sleep, onWait } = policy;
  for (let retry = 1; ; retry += 1) {
    try { return run(); }
    catch (error) {
      if (retry > delaysMs.length || !isConnectionFailure(error)) throw error;
      const milliseconds = delaysMs[retry - 1];
      onWait(retry, milliseconds, describe());
      sleep(milliseconds);
    }
  }
}
