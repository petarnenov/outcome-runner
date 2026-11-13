/**
 * Retrying a worker or review session that ended without an outcome report because its harness was lost: the
 * process exited, the transport closed or timed out, or the connection failed. Every other failure is final.
 */
import { isConnectionFailure } from './network-retry.ts';
import type { Purpose, SessionAttemptOwner, Work } from './model.ts';

/** The attempts of one session in total, the first included. */
export const SESSION_ATTEMPTS = 3;

/** The wait before attempt `n` (n >= 2) is `SESSION_RETRY_DELAYS_MS[n - 2]`. */
export const SESSION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([10000, 30000]);

/** How the `session retry` step line names each session purpose; the longest label has 20 characters. */
export const SESSION_LABELS: Readonly<Record<Purpose, string>> = Object.freeze({ investigate: 'investigation',
  plan: 'planning', review: 'review', work: 'implementation', document: 'documentation',
  'document-review': 'documentation review' });

/** The message of the `session retry` step line, for example `planning: no report; retry in 10 s`. */
export const sessionRetryMessage = (purpose: Purpose, milliseconds: number): string =>
  `${SESSION_LABELS[purpose]}: no report; retry in ${milliseconds / 1000} s`;

const TRANSPORT_CODES: readonly string[] = ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'ENOTCONN'];

/** Whether `error` means that the harness was lost before the session reported. */
export function isSessionTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSPORT_CODES.includes(code)) return true;
  if (/transport exited/iu.test(error.message) || /timed out/iu.test(error.message)) return true;
  return isConnectionFailure(error);
}

/** The private detail of a failed attempt: its message without control characters, at most the last 2000 characters. */
export function sessionFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(-2000);
}

/** The private blocked reason after the last failed attempt. */
export const sessionAttemptsMessage = (purpose: Purpose, attempts: number, lastFailure: string): string =>
  `Session ${purpose} ended without a report after ${attempts} attempts; last failure: ${lastFailure}`;

/** Every attempt of a session ended without a report because of a transport failure. */
export class SessionAttemptsExhausted extends Error {
  purpose: Purpose;
  attempts: number;
  lastFailure: string;
  constructor(purpose: Purpose, attempts: number, lastFailure: string) {
    super(sessionAttemptsMessage(purpose, attempts, lastFailure));
    this.name = 'SessionAttemptsExhausted';
    this.purpose = purpose;
    this.attempts = attempts;
    this.lastFailure = lastFailure;
  }
}

/**
 * The session a record of `work` belongs to: the purpose and stage and, in the `integrate` stage, the integrated
 * target commit and the integration step.
 */
export function sessionAttemptOwner(work: Pick<Work, 'stage' | 'integration'>, purpose: Purpose): SessionAttemptOwner {
  const integration = work.stage === 'integrate' && work.integration ?
    { integration: { target: work.integration.target, step: work.integration.step } } : {};
  return { purpose, stage: work.stage, ...integration };
}

/** Whether two records name the same session; false when either is missing. */
export function sameSessionAttemptOwner(first: SessionAttemptOwner | undefined,
  second: SessionAttemptOwner | undefined): boolean {
  if (!first || !second || first.purpose !== second.purpose || first.stage !== second.stage) return false;
  if (!first.integration || !second.integration) return !first.integration && !second.integration;
  return first.integration.target === second.integration.target && first.integration.step === second.integration.step;
}
