import { setTimeout as delay } from 'node:timers/promises';

export type MascotMood =
  | 'happy' | 'angry' | 'celebrating' | 'content'
  | 'sleepy' | 'sad' | 'startled' | 'dizzy';

export interface MascotStream { write(chunk: string): unknown; isTTY?: boolean }

export interface MascotOptions {
  stream?: MascotStream;
  isTTY?: (stream: MascotStream) => boolean;
  env?: Record<string, string | undefined>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

interface Pose { eyes?: [string, string]; x?: number; lift?: boolean; extra?: string }

interface MoodArt { colour: number; eyes: [string, string]; mouth: string; delay: number; poses: Pose[] }

const MOODS: Record<MascotMood, MoodArt> = {
  happy: { colour: 32, eyes: ['^', '^'], mouth: 'v', delay: 200, poses: [{ lift: true }, {}, { lift: true }, {}] },
  angry: { colour: 31, eyes: ['>', '<'], mouth: 'm', delay: 150, poses: [{ x: 1 }, { x: 3 }, { x: 1 }, { x: 2 }] },
  celebrating: {
    colour: 33, eyes: ['*', '*'], mouth: 'D', delay: 150, poses: [
      { extra: '   .     +     .' },
    ],
  },
  content: { colour: 36, eyes: ['-', '-'], mouth: 'u', delay: 400, poses: [{}, { eyes: ['o', 'o'] }, {}] },
  sleepy: { colour: 34, eyes: ['_', '_'], mouth: '.', delay: 250, poses: [{}] },
  sad: { colour: 34, eyes: ['T', 'T'], mouth: 'n', delay: 300, poses: [{ lift: true }, { lift: true }, {}, {}] },
  startled: { colour: 33, eyes: ['O', 'O'], mouth: 'o', delay: 200, poses: [{}, { lift: true }, { extra: '       !' }] },
  dizzy: { colour: 35, eyes: ['@', '@'], mouth: '~', delay: 200, poses: [{ x: 1 }] },
};

export function drawFrame(art: MoodArt, pose: Pose): string[] {
  const [left, right] = pose.eyes ?? art.eyes;
  const pad = ' '.repeat(pose.x ?? 2);
  const body = [
    '    ▄█▄',
    `█  ${left}   ${right}  █`,
  ].map(line => pad + line);
  return pose.lift === true ? [...body, ''] : [pose.extra ?? '', ...body];
}

export async function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal === undefined ? {} : { signal });
}

export async function playMascot(mood: MascotMood, caption: string, options: MascotOptions = {}): Promise<void> {
  void mood; void caption; void options; void MOODS;
}
