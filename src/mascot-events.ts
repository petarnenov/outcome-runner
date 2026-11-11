import type { MascotMood } from '../mascot/mascot.ts';

/** Task event statuses that `runQueue` reports through `options.report`. */
export const TASK_EVENT_STATUSES = ['accepted', 'blocked'] as const;
export type TaskEventStatus = typeof TASK_EVENT_STATUSES[number];

/** Final run statuses that `main` can end with (the same values recorded in the statistics ledger). */
export const RUN_STATUSES = ['exhausted', 'limit-reached', 'incomplete', 'cancelled', 'unavailable'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

/** Status literals in the runner source that are neither task events nor run statuses. */
export const NON_OUTCOME_STATUSES = ['recorded'] as const;

export type RunOutcome = 'exhausted' | 'limit-reached' | 'incomplete-waiting' | 'incomplete-blocked' | 'cancelled' | 'unavailable';

export const TASK_EVENT_MOODS = { accepted: 'happy', blocked: 'angry' } as const satisfies Record<TaskEventStatus, MascotMood>;

export const RUN_OUTCOME_MOODS = {
  exhausted: 'celebrating', 'limit-reached': 'content', 'incomplete-waiting': 'sleepy',
  'incomplete-blocked': 'sad', cancelled: 'startled', unavailable: 'dizzy',
} as const satisfies Record<RunOutcome, MascotMood>;

export interface MascotShow { mood: MascotMood; caption: string }

const REASON_LIMIT = 60;
const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** Collapses whitespace runs (including newlines), trims, and truncates to at most 60 code points ending in `…`. */
export function shortReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.replace(/\s+/gu, ' ').trim() : '';
  const points = [...text];
  return points.length > REASON_LIMIT ? points.slice(0, REASON_LIMIT - 1).join('') + '…' : text;
}

/** Chooses the run outcome from the final sticky status, the exit code and the blockers of the terminal line. */
export function runOutcome(status: unknown, code: number, blockers?: unknown): RunOutcome | undefined {
  if (code === 4) return 'unavailable';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'incomplete') {
    const blocked = typeof blockers === 'object' && blockers !== null && Object.keys(blockers).length > 0;
    return blocked ? 'incomplete-blocked' : 'incomplete-waiting';
  }
  return status === 'exhausted' || status === 'limit-reached' || status === 'unavailable' ? status : undefined;
}

/** Mood and caption for a task event, or `undefined` for an unknown event. */
export function taskMascot(event: { status?: unknown; id?: unknown }, detail?: { reason?: unknown }): MascotShow | undefined {
  if (!has(TASK_EVENT_STATUSES, event.status)) return undefined;
  const id = String(event.id);
  if (event.status === 'accepted') return { mood: TASK_EVENT_MOODS.accepted, caption: `${id} merged` };
  const reason = shortReason(detail?.reason);
  return { mood: TASK_EVENT_MOODS.blocked, caption: reason ? `${id} blocked: ${reason}` : `${id} blocked` };
}

const length = (value: unknown): number => Array.isArray(value) ? value.length : 0;

/** Mood and caption for the end of a run, from the final sticky status and code and the terminal stdout object. */
export function runMascot({ status, code, line }: { status: string; code: number; line?: unknown }): MascotShow | undefined {
  const terminal = (typeof line === 'object' && line !== null ? line : {}) as
    { accepted?: unknown; remaining?: unknown; blockers?: unknown };
  const outcome = runOutcome(status, code, terminal.blockers);
  if (outcome === undefined) return undefined;
  const shown = code === 4 ? 'unavailable' : status;
  return { mood: RUN_OUTCOME_MOODS[outcome],
    caption: `${shown}: ${length(terminal.accepted)} accepted, ${length(terminal.remaining)} remaining` };
}
