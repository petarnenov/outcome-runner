import type { Completion, TaskCompletion } from './model.ts';

export function validCompletion(value: unknown): value is Completion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { summary, grade } = value as Completion;
  return typeof summary === 'string' && !!summary.trim() &&
    typeof grade === 'string' && ['A', 'B', 'C', 'D', 'E'].includes(grade);
}

export function buildCompletion(completion: unknown, claimedAt: string, acceptedAt: string): TaskCompletion {
  if (!validCompletion(completion)) throw new Error('Accepted implementation review lacks valid completion');
  const elapsed = Date.parse(acceptedAt) - Date.parse(claimedAt);
  if (!Number.isFinite(elapsed)) throw new Error('Invalid claim or acceptance timestamp');
  const durationSeconds = Math.max(0, Math.floor(elapsed / 1000));
  const duration = `${Math.floor(durationSeconds / 3600)}h ${Math.floor(durationSeconds / 60) % 60}m ${durationSeconds % 60}s`;
  return { summary: `${completion.summary} The task took ${duration} from claim to acceptance and has complexity grade ${completion.grade}.`,
    durationSeconds, grade: completion.grade };
}
