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

type Eye = 'open' | 'happy' | 'angry' | 'sad' | 'sleepy' | 'wide' | 'swirlA' | 'swirlB' | 'star';
interface Decoration { line: number; text: string; colour: number }
interface Pose { eyes: Eye; legs: 0 | 1; x?: number; cheeks?: boolean; tear?: 6 | 7; extras?: Decoration[] }
interface MoodArt { colour: number; delay: number; poses: Pose[] }
interface PlayState { stream: MascotStream | undefined; hideAttempted: boolean; frameAttempted: boolean; finished: boolean }

const HEIGHT = 4;
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const RESET = '\x1b[0m';
const BODY = ['...B...B...', '....B.B....', '..BBBBBBB..', '.BBBBBBBBB.', 'BB00BBB11BB', 'BB00BBB11BB'];
const LEGS = [['..B.BBB.B..', '.B.B...B.B.'], ['..B.BBB.B..', 'B.B.....B.B']];
const EYES: Record<Eye, [string, string]> = {
  open: ['WW', 'WK'], happy: ['WW', 'BB'], angry: ['BW', 'WK'],
  sad: ['WW', 'KW'], sleepy: ['BB', 'WW'], wide: ['WW', 'WW'],
  swirlA: ['KW', 'WK'], swirlB: ['WK', 'KW'], star: ['SW', 'WS'],
};
const decoration = (line: number, text: string, colour: number): Decoration => ({ line, text, colour });
const MOODS: Record<MascotMood, MoodArt> = {
  happy: { colour: 78, delay: 200, poses: [
    { eyes: 'open', legs: 0 }, { eyes: 'happy', legs: 1 },
    { eyes: 'happy', legs: 0, cheeks: true },
    { eyes: 'happy', legs: 1, cheeks: true, extras: [decoration(0, '♪', 229)] },
  ] },
  angry: { colour: 160, delay: 150, poses: [
    { eyes: 'angry', legs: 0 }, { eyes: 'angry', legs: 0, x: 1 },
    { eyes: 'angry', legs: 0 }, { eyes: 'angry', legs: 0, x: 1 },
    { eyes: 'angry', legs: 0, extras: [decoration(0, '#', 196)] },
  ] },
  celebrating: { colour: 220, delay: 150, poses: [0, 1, 2, 3].map(f => ({
    eyes: 'star', legs: f % 2 === 0 ? 0 : 1,
    extras: [decoration(f, '+', 229), decoration((f + 1) % 4, '*', 213), decoration((f + 2) % 4, '.', 117)],
  })) },
  content: { colour: 44, delay: 400, poses: [
    { eyes: 'open', legs: 0 }, { eyes: 'sleepy', legs: 0 }, { eyes: 'open', legs: 1 },
  ] },
  sleepy: { colour: 69, delay: 250, poses: [
    { eyes: 'sleepy', legs: 0, extras: [decoration(1, 'z', 153)] },
    { eyes: 'sleepy', legs: 0, extras: [decoration(0, 'z', 153)] },
    { eyes: 'sleepy', legs: 0, extras: [decoration(0, 'zZ', 153)] },
  ] },
  sad: { colour: 61, delay: 300, poses: [
    { eyes: 'sad', legs: 0, tear: 6 }, { eyes: 'sad', legs: 0, tear: 7 },
    { eyes: 'sad', legs: 1 }, { eyes: 'sad', legs: 0, tear: 7 },
  ] },
  startled: { colour: 208, delay: 200, poses: [
    { eyes: 'open', legs: 1 },
    { eyes: 'wide', legs: 0, extras: [decoration(0, '!', 196)] },
    { eyes: 'wide', legs: 1, extras: [decoration(0, '!!', 196)] },
  ] },
  dizzy: { colour: 170, delay: 200, poses: [
    { eyes: 'swirlA', legs: 0, extras: [decoration(0, '*', 213)] },
    { eyes: 'swirlB', legs: 0, x: 1, extras: [decoration(1, '*', 213)] },
    { eyes: 'swirlA', legs: 0, extras: [decoration(2, '*', 213)] },
    { eyes: 'swirlB', legs: 0, x: 1, extras: [decoration(0, '*', 213)] },
  ] },
};

function drawFrame(art: MoodArt, pose: Pose, noColour: boolean): string[] {
  const pixels = [...BODY, ...LEGS[pose.legs]].map(row => [...row]);
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      pixels[4 + row][2 + column] = EYES[pose.eyes][row][column];
      pixels[4 + row][8 - column] = EYES[pose.eyes][row][column];
    }
  }
  if (pose.cheeks === true) { pixels[5][1] = 'C'; pixels[5][9] = 'C'; }
  if (pose.tear !== undefined) pixels[pose.tear][3] = 'T';
  const palette: Record<string, number> = { B: art.colour, W: 231, K: 16, S: 226, C: 211, T: 117 };
  const colourOf = (pixel: string): number | undefined =>
    noColour && (pixel === 'W' || pixel === 'T') ? undefined : palette[pixel];
  const lines: string[] = [];
  for (let row = 0; row < 8; row += 2) {
    let line = ' '.repeat(pose.x ?? 0);
    for (let column = 0; column < 11; column++) {
      const top = colourOf(pixels[row][column]);
      const bottom = colourOf(pixels[row + 1][column]);
      if (top === undefined && bottom === undefined) { line += ' '; continue; }
      if (noColour) {
        line += top === undefined ? '▄' : bottom === undefined ? '▀' : '█';
      } else {
        const foreground = top ?? bottom;
        const background = top !== undefined && bottom !== undefined ? `;48;5;${bottom}` : '';
        line += `\x1b[38;5;${foreground}${background}m${top === undefined ? '▄' : '▀'}${RESET}`;
      }
    }
    const extra = pose.extras?.find(item => item.line === row / 2);
    if (extra !== undefined) {
      line += ' ' + (noColour ? extra.text : `\x1b[38;5;${extra.colour}m${extra.text}${RESET}`);
    }
    lines.push(line);
  }
  return lines;
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
  const frames = art.poses.map(pose => drawFrame(art, pose, env.NO_COLOR !== undefined));
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
