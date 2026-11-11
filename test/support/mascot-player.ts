import type { MascotPlayer } from '../../src/cli.ts';

export interface PlayerCall { mood: string; caption: string; signal: AbortSignal }

/** An injected mascot player that only records each mood, caption and abort signal it receives. */
export function recordingPlayer(): { calls: PlayerCall[]; player: MascotPlayer } {
  const calls: PlayerCall[] = [];
  const player: MascotPlayer = (mood, caption, { signal }) => { calls.push({ mood, caption, signal }); };
  return { calls, player };
}
