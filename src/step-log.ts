/** The longest step line, without its trailing newline. */
export const STEP_LINE_LIMIT = 120;

/** Writes one step line (including its trailing newline); the default writes to stderr. */
export type StepOutput = (line: string) => void;

export interface StepOptions {
  /** The attempt number of a retried step; 2 or more appends ` (attempt N)`. */
  attempt?: number;
  /** Marks the first continued step of work found in durable state. */
  resuming?: boolean;
}

/** Writes one step line for `subject` (`run` or a task id) before the step has any effect. */
export type StepLog = (subject: string, step: string, message: string, options?: StepOptions) => void;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Replaces every control character with a space and collapses runs of spaces. */
const clean = (text: string): string =>
  String(text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/ {2,}/gu, ' ').trim();

/**
 * Formats `[outcome-runner] HH:MM:SS <subject> <step>: <message>` in local 24-hour time. A line longer than
 * 120 characters has its message cut and ended with `...`, so the line is exactly 120 characters.
 */
export function formatStep(time: Date, subject: string, step: string, message: string): string {
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const line = `[outcome-runner] ${clock} ${clean(subject)} ${clean(step)}: ${clean(message)}`;
  return line.length <= STEP_LINE_LIMIT ? line : `${line.slice(0, STEP_LINE_LIMIT - 3)}...`;
}

const cap = (value: unknown, limit: number): string => {
  const text = clean(typeof value === 'string' && value ? value : 'auto') || 'auto';
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
};

/**
 * The run start message. Invocation and model are shortened to 16 characters, harness and effort to 8, so the
 * run start line always names all four values within 120 characters. Unset values are shown as `auto`.
 */
export function runStartMessage({ invocation, harness, model, effort }:
  { invocation?: unknown; harness?: unknown; model?: unknown; effort?: unknown }): string {
  return `invocation=${cap(invocation, 16)} harness=${cap(harness, 8)} model=${cap(model, 16)} effort=${cap(effort, 8)}`;
}

/** Creates the step logger. A failing output is swallowed, so step logging never changes the run result. */
export function createStepLog({ write, now = Date.now }: { write?: StepOutput; now?: () => number } = {}): StepLog {
  const output: StepOutput = write ?? (line => { process.stderr.write(line); });
  return (subject, step, message, { attempt, resuming } = {}) => {
    try {
      const suffix = attempt !== undefined && attempt >= 2 ? ` (attempt ${attempt})` : '';
      output(formatStep(new Date(now()), subject, step, `${resuming ? 'resuming ' : ''}${message}${suffix}`) + '\n');
    } catch { /* Step logging never changes the run. */ }
  };
}
