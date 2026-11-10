import { setTimeout as delay } from 'node:timers/promises';

export type MascotMood =
  | 'happy' | 'angry' | 'celebrating' | 'content'
  | 'sleepy' | 'sad' | 'startled' | 'dizzy';

export interface MascotStream { write(chunk: string): unknown; isTTY?: boolean }

export interface MascotOptions {
  /** Output stream. Default: `process.stderr`. */
  stream?: MascotStream;
  /** TTY detection. Default: `stream => stream.isTTY === true`. */
  isTTY?: (stream: MascotStream) => boolean;
  /** Environment. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Frame timer. Default: `setTimeout` from `node:timers/promises` with the signal. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops the animation when aborted. */
  signal?: AbortSignal;
}

interface Pose { eyes?: [string, string]; x?: number; lift?: boolean; extra?: string }

interface MoodArt { colour: number; eyes: [string, string]; mouth: string; delay: number; poses: Pose[] }

interface PlayState { stream: MascotStream | undefined; hideAttempted: boolean; frameAttempted: boolean; finished: boolean }

const HEIGHT = 7;
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const RESET = '\x1b[0m';

const MOODS: Record<MascotMood, MoodArt> = {
  happy: { colour: 32, eyes: ['^', '^'], mouth: 'v', delay: 200, poses: [{ lift: true }, {}, { lift: true }, {}] },
  angry: { colour: 31, eyes: ['>', '<'], mouth: 'm', delay: 150, poses: [{ x: 1 }, { x: 3 }, { x: 1 }, { x: 2 }] },
  celebrating: {
    colour: 33, eyes: ['*', '*'], mouth: 'D', delay: 150, poses: [
      { extra: '   .     +     .' },
      { extra: '  +   *     *   +' },
      { extra: ' *   .   +   .   *' },
      { extra: '  +   *     *   +' },
      { extra: '   .     +     .' },
      { extra: '  *   +  .  +   *' },
    ],
  },
  content: { colour: 36, eyes: ['-', '-'], mouth: 'u', delay: 400, poses: [{}, { eyes: ['o', 'o'] }, {}] },
  sleepy: {
    colour: 34, eyes: ['_', '_'], mouth: '.', delay: 250, poses: [
      {}, { extra: '             z' }, { extra: '              z' }, { extra: '             z Z' }, { extra: '            z  Z' },
    ],
  },
  sad: { colour: 34, eyes: ['T', 'T'], mouth: 'n', delay: 300, poses: [{ lift: true }, { lift: true }, {}, {}] },
  startled: { colour: 33, eyes: ['O', 'O'], mouth: 'o', delay: 200, poses: [{}, { lift: true }, { extra: '       !' }] },
  dizzy: { colour: 35, eyes: ['@', '@'], mouth: '~', delay: 200, poses: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 2 }, { x: 1 }, { x: 2 }] },
};

function drawFrame(art: MoodArt, pose: Pose): string[] {
  const [left, right] = pose.eyes ?? art.eyes;
  const pad = ' '.repeat(pose.x ?? 2);
  const body = [
    '    ▄█▄',
    ' ▄▄▄▄█▄▄▄▄',
    `█  ${left}   ${right}  █`,
    `█    ${art.mouth}    █`,
    ' ▀▀▀▀▀▀▀▀▀',
    '  ▀▀   ▀▀',
  ].map(line => pad + line);
  return pose.lift === true ? [...body, ''] : [pose.extra ?? '', ...body];
}

function paint(line: string, colour: number | undefined): string {
  return colour === undefined || line === '' ? line : `\x1b[${colour}m${line}${RESET}`;
}

function joinLines(frame: string[], prefix: string): string {
  return frame.map(line => `${prefix}${line}\n`).join('');
}

function defaultIsTTY(stream: MascotStream): boolean {
  return stream.isTTY === true;
}

async function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/** Reads the signal state through a call so it is re-evaluated after every wait. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function attempt(stream: MascotStream, chunk: string): void {
  try { stream.write(chunk); } catch { /* restoring the terminal is best effort */ }
}

function moodArt(mood: string): MoodArt | undefined {
  return Object.hasOwn(MOODS, mood) ? MOODS[mood as MascotMood] : undefined;
}

async function run(mood: MascotMood, caption: string, options: MascotOptions, state: PlayState): Promise<void> {
  const stream: MascotStream = options.stream ?? process.stderr;
  state.stream = stream;
  const isTTY = options.isTTY ?? defaultIsTTY;
  const env: Record<string, string | undefined> = options.env ?? process.env;
  const wait = options.wait ?? defaultWait;
  const signal = options.signal;
  const art = moodArt(mood);
  if (art === undefined || !isTTY(stream) || env.OUTCOME_RUNNER_MASCOT === '0' || isAborted(signal)) {
    state.finished = true;
    return;
  }
  const colour = env.NO_COLOR === undefined ? art.colour : undefined;
  const frames = art.poses.map(pose => drawFrame(art, pose).map(line => paint(line, colour)));
  const captionLine = `${String(caption).replace(/[\r\n]/gu, ' ')}\n`;
  if (env.TERM === 'dumb') {
    stream.write(joinLines(frames[frames.length - 1], '') + captionLine);
    state.finished = true;
    return;
  }
  state.hideAttempted = true;
  stream.write(HIDE);
  state.frameAttempted = true;
  stream.write(joinLines(frames[0], ''));
  for (const frame of frames.slice(1)) {
    await wait(art.delay, signal);
    if (isAborted(signal)) return;
    stream.write(`\x1b[${HEIGHT}A${joinLines(frame, '\r\x1b[2K')}`);
  }
  stream.write(captionLine);
  state.finished = true;
}

function restore(state: PlayState): void {
  const stream = state.stream;
  if (stream === undefined) return;
  if (!state.finished && state.frameAttempted) attempt(stream, '\n');
  if (state.hideAttempted) attempt(stream, SHOW);
}

/**
 * Plays a short mood animation in place, then leaves the last frame and the caption on screen.
 * The returned promise resolves when the animation ends and never rejects.
 */
export async function playMascot(mood: MascotMood, caption: string, options: MascotOptions = {}): Promise<void> {
  // The hide flag is set before the hide sequence is written, so a throwing hide write still restores the cursor.
  const state: PlayState = { stream: undefined, hideAttempted: false, frameAttempted: false, finished: false };
  try {
    await run(mood, caption, options, state);
  } catch {
    // A failing write, a rejecting timer or an abort stops the animation.
  } finally {
    restore(state);
  }
}
