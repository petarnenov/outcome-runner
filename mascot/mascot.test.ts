import test from 'node:test';
import assert from 'node:assert/strict';
import * as mascotModule from './mascot.ts';
import { playMascot } from './mascot.ts';
import type { MascotMood, MascotOptions } from './mascot.ts';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const SGR = /\x1b\[[0-9;]*m/gu;
const CURSOR = /\x1b\[\?25[lh]|\x1b\[\d+A|\r/u;
const HEIGHT = 7;

const EXPECTED: Record<MascotMood, { colour: number; frames: number }> = {
  happy: { colour: 32, frames: 4 },
  angry: { colour: 31, frames: 4 },
  celebrating: { colour: 33, frames: 6 },
  content: { colour: 36, frames: 3 },
  sleepy: { colour: 34, frames: 5 },
  sad: { colour: 34, frames: 4 },
  startled: { colour: 33, frames: 3 },
  dizzy: { colour: 35, frames: 6 },
};
const MOODS = Object.keys(EXPECTED) as MascotMood[];

class MemoryStream {
  chunks: string[] = [];
  isTTY = true;
  failAt: number | undefined;
  onWrite: ((chunk: string) => void) | undefined;
  constructor(failAt?: number) { this.failAt = failAt; }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this.onWrite?.(chunk);
    if (this.chunks.length === this.failAt) throw new Error('write failed');
    return true;
  }
  get text(): string { return this.chunks.join(''); }
}

interface Run { stream: MemoryStream; waits: number[]; text: string }

async function play(mood: MascotMood, caption = 'caption', options: MascotOptions = {}, stream = new MemoryStream()): Promise<Run> {
  const waits: number[] = [];
  const promise = playMascot(mood, caption, {
    stream, isTTY: () => true, env: {}, wait: async (ms: number) => { waits.push(ms); }, ...options,
  });
  await assert.doesNotReject(promise);
  return { stream, waits, text: stream.text };
}

interface Parsed { frames: string[][]; ups: number[]; caption: string | undefined }

function parse(text: string): Parsed {
  assert.ok(text.startsWith(HIDE), 'hide precedes the first frame');
  assert.ok(text.endsWith(SHOW), 'show is the last sequence');
  const parts = text.slice(HIDE.length, -SHOW.length).split(/\x1b\[(\d+)A/u);
  const frames: string[][] = [];
  const ups: number[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const lines = parts[index].split('\n').slice(0, -1);
    if (index > 0) {
      const up = Number(parts[index - 1]);
      ups.push(up);
      assert.ok(lines.slice(0, up).every(line => line.startsWith('\r\x1b[2K')), 'redrawn lines are cleared');
    }
    frames.push(lines.map(line => line.replace('\r\x1b[2K', '')));
  }
  const last = frames[frames.length - 1];
  const caption = last.length > HEIGHT ? last.pop() : undefined;
  return { frames, ups, caption };
}

const plain = (line: string): string => line.replace(SGR, '');
const width = (line: string): number => [...plain(line)].length;

async function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  const record = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  process.stderr.write = record as unknown as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = original; }
  return chunks;
}

function faceOf(frame: string[]): { eyes: string; mouth: string } {
  const face = frame.map(plain).join('\n');
  const eyes = /█ +(\S) +(\S) +█/u.exec(face);
  const mouth = /█ +(\S) +█/u.exec(face);
  if (eyes === null || mouth === null) throw new Error('frame without a face');
  return { eyes: `${eyes[1]}${eyes[2]}`, mouth: mouth[1] };
}

test('the only runtime export is playMascot', () => {
  assert.deepEqual(Object.keys(mascotModule), ['playMascot']);
  assert.equal(typeof mascotModule.playMascot, 'function');
});

for (const mood of MOODS) {
  test(`${mood}: frame count, size limits, duration and colour`, async () => {
    const { waits, text } = await play(mood);
    const { frames, ups } = parse(text);
    assert.equal(frames.length, EXPECTED[mood].frames);
    assert.ok(frames.length >= 3 && frames.length <= 6);
    assert.equal(waits.length, frames.length - 1);
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 1500);
    for (const frame of frames) {
      assert.ok(frame.length <= 7);
      assert.equal(frame.length, HEIGHT);
      for (const line of frame) {
        assert.ok(width(line) <= 20, `${JSON.stringify(plain(line))} is at most 20 columns`);
        if (line !== '') assert.ok(line.startsWith(`\x1b[${EXPECTED[mood].colour}m`), `${mood} line is coloured`);
      }
    }
    assert.deepEqual(ups, frames.slice(1).map(frame => frame.length));
    assert.match(frames[frames.length - 1].map(plain).join('\n'), /[▀-▟]/u);
  });
}

test('every mood has its own eyes, mouth and face', async () => {
  const eyes = new Set<string>();
  const mouths = new Set<string>();
  for (const mood of MOODS) {
    const face = faceOf(parse((await play(mood)).text).frames.at(-1) ?? []);
    eyes.add(face.eyes);
    mouths.add(face.mouth);
  }
  assert.equal(eyes.size, MOODS.length);
  assert.equal(mouths.size, MOODS.length);
  assert.throws(() => faceOf(['no face']), /without a face/u);
});

test('celebrating shows sparkles outside the body', async () => {
  const { frames } = parse((await play('celebrating')).text);
  for (const frame of frames) assert.match(plain(frame[0]), /^[ *+.]*[*+.][ *+.]*$/u);
});

test('the caption follows the last frame on its own line', async () => {
  const { text } = await play('happy', 'All checks passed');
  const { frames, caption } = parse(text);
  assert.equal(caption, 'All checks passed');
  assert.ok(text.endsWith(`${frames.at(-1)?.at(-1)}\nAll checks passed\n${SHOW}`));
});

test('a multi-line caption stays on one line', async () => {
  const { caption } = parse((await play('content', 'one\r\ntwo')).text);
  assert.equal(caption, 'one  two');
});

test('a non-TTY stream gets no output', async () => {
  const injected = await play('happy', 'x', { isTTY: () => false });
  assert.deepEqual(injected.stream.chunks, []);
  assert.deepEqual(injected.waits, []);
  const stream = new MemoryStream();
  stream.isTTY = false;
  await assert.doesNotReject(playMascot('happy', 'x', { stream, wait: async () => { throw new Error('no wait'); } }));
  assert.deepEqual(stream.chunks, []);
});

test('the default TTY detection uses stream.isTTY', async () => {
  const stream = new MemoryStream();
  await assert.doesNotReject(playMascot('startled', 'x', { stream, env: {}, wait: async () => {} }));
  assert.equal(parse(stream.text).caption, 'x');
});

test('OUTCOME_RUNNER_MASCOT=0 disables output', async () => {
  const { stream, waits } = await play('sad', 'x', { env: { OUTCOME_RUNNER_MASCOT: '0' } });
  assert.deepEqual(stream.chunks, []);
  assert.deepEqual(waits, []);
  const enabled = await play('sad', 'x', { env: { OUTCOME_RUNNER_MASCOT: '1' } });
  assert.notDeepEqual(enabled.stream.chunks, []);
});

for (const value of ['1', '']) {
  test(`NO_COLOR=${JSON.stringify(value)} keeps the shapes without colour`, async () => {
    for (const mood of MOODS) {
      const coloured = parse((await play(mood)).text);
      const { text } = await play(mood, 'caption', { env: { NO_COLOR: value } });
      assert.doesNotMatch(text, SGR);
      const uncoloured = parse(text);
      assert.deepEqual(uncoloured.frames, coloured.frames.map(frame => frame.map(plain)));
      assert.equal(uncoloured.caption, 'caption');
    }
  });
}

test('TERM=dumb prints only the last frame and the caption', async () => {
  for (const mood of MOODS) {
    const last = parse((await play(mood)).text).frames.at(-1) ?? [];
    const { text, waits } = await play(mood, 'Done', { env: { TERM: 'dumb' } });
    assert.equal(text, `${last.join('\n')}\nDone\n`);
    assert.doesNotMatch(text, CURSOR);
    assert.deepEqual(waits, []);
  }
  const { text } = await play('dizzy', 'Done', { env: { TERM: 'dumb', NO_COLOR: '1' } });
  assert.ok(!text.includes('\x1b'));
});

test('an abort stops the animation and shows the cursor', async () => {
  const controller = new AbortController();
  const stream = new MemoryStream();
  const waits: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  await assert.doesNotReject(playMascot('dizzy', 'never', {
    stream, isTTY: () => true, env: {}, signal: controller.signal,
    wait: async (ms: number, signal?: AbortSignal) => { waits.push(ms); signals.push(signal); if (waits.length === 2) controller.abort(); },
  }));
  assert.equal(waits.length, 2);
  assert.ok(signals.every(signal => signal === controller.signal));
  assert.equal(stream.text.match(/\x1b\[7A/gu)?.length, 1);
  assert.ok(!stream.text.includes('never'));
  assert.equal(stream.chunks[0], HIDE);
  assert.equal(stream.chunks.at(-1), SHOW);
});

test('the default timer stops at once on abort without sleeping', async () => {
  const controller = new AbortController();
  const stream = new MemoryStream();
  stream.onWrite = chunk => { if (chunk.includes('\n')) controller.abort(); };
  await assert.doesNotReject(playMascot('celebrating', 'never', { stream, env: {}, signal: controller.signal }));
  assert.ok(!stream.text.includes('\x1b[7A'));
  assert.ok(!stream.text.includes('never'));
  assert.equal(stream.chunks.at(-1), SHOW);
});

test('an already aborted signal writes nothing', async () => {
  const { stream, waits } = await play('happy', 'x', { signal: AbortSignal.abort() });
  assert.deepEqual(stream.chunks, []);
  assert.deepEqual(waits, []);
});

for (const failAt of [2, 3]) {
  test(`a failing frame write (#${failAt}) still shows the cursor`, async () => {
    const { stream } = await play('angry', 'never', {}, new MemoryStream(failAt));
    assert.equal(stream.chunks.length, failAt + 2);
    assert.equal(stream.chunks.at(-2), '\n');
    assert.equal(stream.chunks.at(-1), SHOW);
    assert.ok(!stream.text.includes('never'));
  });
}

test('a failing hide-cursor write still attempts to show the cursor', async () => {
  const { stream, waits } = await play('happy', 'x', {}, new MemoryStream(1));
  assert.deepEqual(stream.chunks, [HIDE, SHOW]);
  assert.deepEqual(waits, []);
});

test('a failing show-cursor write still resolves', async () => {
  const count = (await play('sleepy')).stream.chunks.length;
  const { stream } = await play('sleepy', 'caption', {}, new MemoryStream(count));
  assert.equal(stream.chunks.length, count);
  assert.equal(stream.chunks.at(-1), SHOW);
});

test('a failing dumb write resolves without cursor sequences', async () => {
  const { stream } = await play('happy', 'x', { env: { TERM: 'dumb' } }, new MemoryStream(1));
  assert.equal(stream.chunks.length, 1);
  assert.doesNotMatch(stream.text, CURSOR);
});

test('a rejecting timer resolves and shows the cursor', async () => {
  const { stream } = await play('content', 'never', { wait: async () => { throw new Error('timer failed'); } });
  assert.equal(stream.chunks.at(-1), SHOW);
  assert.ok(!stream.text.includes('never'));
});

test('an unknown mood or failing TTY detection resolves without output', async () => {
  const unknownMood: string = 'grumpy';
  const unknown = await play(unknownMood as MascotMood);
  assert.deepEqual(unknown.stream.chunks, []);
  const failing = await play('happy', 'x', { isTTY: () => { throw new Error('detection failed'); } });
  assert.deepEqual(failing.stream.chunks, []);
});

test('stderr is the default stream', async () => {
  const chunks = await captureStderr(() => playMascot('happy', 'to stderr', { isTTY: () => true, env: {}, wait: async () => {} }));
  const text = chunks.join('');
  assert.ok(text.includes(HIDE) && text.includes('to stderr\n') && text.includes(SHOW));
  const disabled = await captureStderr(() => playMascot('happy', 'disabled', { env: { OUTCOME_RUNNER_MASCOT: '0' } }));
  assert.ok(!disabled.join('').includes('disabled'));
});

test('a fully injected run never touches stderr', async () => {
  const stream = new MemoryStream();
  const controller = new AbortController();
  const chunks = await captureStderr(async () => {
    await play('celebrating', 'injected', { signal: controller.signal }, stream);
  });
  assert.ok(!chunks.join('').includes('injected'));
  assert.ok(!chunks.join('').includes(HIDE));
  assert.equal(parse(stream.text).caption, 'injected');
});
