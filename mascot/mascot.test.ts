import test from 'node:test';
import assert from 'node:assert/strict';
import * as mascotModule from './mascot.ts';
import { playMascot } from './mascot.ts';
import type { MascotMood, MascotOptions } from './mascot.ts';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const SGR = /\x1b\[[0-9;]*m/gu;
const CURSOR = /\x1b\[\?25[lh]|\x1b\[\d+A|\r/u;
const HEIGHT = 4;

const EXPECTED: Record<MascotMood, { colour: number; frames: number; delay: number }> = {
  happy: { colour: 78, frames: 4, delay: 200 },
  angry: { colour: 160, frames: 5, delay: 150 },
  celebrating: { colour: 220, frames: 4, delay: 150 },
  content: { colour: 44, frames: 3, delay: 400 },
  sleepy: { colour: 69, frames: 3, delay: 250 },
  sad: { colour: 61, frames: 4, delay: 300 },
  startled: { colour: 208, frames: 3, delay: 200 },
  dizzy: { colour: 170, frames: 4, delay: 200 },
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

// Independent fixtures in pixel coordinates; the decoder reads terminal colour channels.
const PATTERNS = {
  open: ['WW', 'WK'], happy: ['WW', 'BB'], angry: ['BW', 'WK'],
  sad: ['WW', 'KW'], sleepy: ['BB', 'WW'], wide: ['WW', 'WW'],
  swirlA: ['KW', 'WK'], swirlB: ['WK', 'KW'], star: ['SW', 'WS'],
} as const;
type Fixture = [keyof typeof PATTERNS, 0 | 1, number, boolean, number | null, string[]];
const FIXTURES: Record<MascotMood, Fixture[]> = {
  happy: [
    ['open',0,0,false,null,[]], ['happy',1,0,false,null,[]],
    ['happy',0,0,true,null,[]], ['happy',1,0,true,null,['♪']],
  ],
  angry: [
    ['angry',0,0,false,null,[]], ['angry',0,1,false,null,[]],
    ['angry',0,0,false,null,[]], ['angry',0,1,false,null,[]],
    ['angry',0,0,false,null,['#']],
  ],
  celebrating: [
    ['star',0,0,false,null,['+','*','.','']],
    ['star',1,0,false,null,['','+','*','.']],
    ['star',0,0,false,null,['.','','+','*']],
    ['star',1,0,false,null,['*','.','','+']],
  ],
  content: [['open',0,0,false,null,[]], ['sleepy',0,0,false,null,[]], ['open',1,0,false,null,[]]],
  sleepy: [
    ['sleepy',0,0,false,null,['','z']], ['sleepy',0,0,false,null,['z']],
    ['sleepy',0,0,false,null,['zZ']],
  ],
  sad: [
    ['sad',0,0,false,6,[]], ['sad',0,0,false,7,[]],
    ['sad',1,0,false,null,[]], ['sad',0,0,false,7,[]],
  ],
  startled: [
    ['open',1,0,false,null,[]], ['wide',0,0,false,null,['!']], ['wide',1,0,false,null,['!!']],
  ],
  dizzy: [
    ['swirlA',0,0,false,null,['*']], ['swirlB',0,1,false,null,['','*']],
    ['swirlA',0,0,false,null,['','','*']], ['swirlB',0,1,false,null,['*']],
  ],
};
const EXTRA_COLOURS: Record<string, number> = { '♪':229, '#':196, '+':229, '*':213, '.':117, z:153, zZ:153, '!':196, '!!':196 };
function fixturePixels(fixture: Fixture): string[][] {
  const [eye, legs, , cheeks, tear] = fixture;
  const rows = [
    '...B...B...', '....B.B....', '..BBBBBBB..', '.BBBBBBBBB.',
    'BB00BBB11BB', 'BB00BBB11BB', '..B.BBB.B..',
    legs === 0 ? '.B.B...B.B.' : 'B.B.....B.B',
  ].map(row => [...row]);
  const [top, bottom] = PATTERNS[eye];
  rows[4].splice(2,2,...top); rows[5].splice(2,2,...bottom);
  rows[4].splice(7,2,...[...top].reverse()); rows[5].splice(7,2,...[...bottom].reverse());
  if (cheeks) { rows[5][1] = 'C'; rows[5][9] = 'C'; }
  if (tear !== null) rows[tear][3] = 'T';
  return rows;
}
interface Cell { glyph: string; fg: number | undefined; bg: number | undefined }
function decode(line: string): Cell[] {
  let fg: number | undefined;
  let bg: number | undefined;
  const cells: Cell[] = [];
  for (const token of line.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0) { fg = undefined; bg = undefined; }
        else if (codes[i] === 38 || codes[i] === 48) {
          assert.equal(codes[i+1], 5);
          if (codes[i] === 38) fg = codes[i+2]; else bg = codes[i+2];
          i += 2;
        } else assert.fail('unexpected SGR');
      }
    } else cells.push({ glyph: token[2], fg, bg });
  }
  return cells;
}
const LAST_FRAMES: Record<MascotMood, string[]> = {
  happy: ['   ▀▄ ▄▀    ♪',' ▄███████▄ ','█▄  ███  ▄█','▄ ▀ ▀▀▀ ▀ ▄'],
  angry: ['   ▀▄ ▄▀    #',' ▄███████▄ ','██▀▄███▄▀██',' ▄▀▄▀▀▀▄▀▄ '],
  celebrating: ['   ▀▄ ▄▀    *',' ▄███████▄  .','██▀▄███▄▀██','▄ ▀ ▀▀▀ ▀ ▄ +'],
  content: ['   ▀▄ ▄▀   ',' ▄███████▄ ','██ ▄███▄ ██','▄ ▀ ▀▀▀ ▀ ▄'],
  sleepy: ['   ▀▄ ▄▀    zZ',' ▄███████▄ ','██▀▀███▀▀██',' ▄▀▄▀▀▀▄▀▄ '],
  sad: ['   ▀▄ ▄▀   ',' ▄███████▄ ','██▄ ███ ▄██',' ▄▀ ▀▀▀▄▀▄ '],
  startled: ['   ▀▄ ▄▀    !!',' ▄███████▄ ','██  ███  ██','▄ ▀ ▀▀▀ ▀ ▄'],
  dizzy: ['    ▀▄ ▄▀    *','  ▄███████▄ ',' ██▄▀███▀▄██','  ▄▀▄▀▀▀▄▀▄ '],
};
test('the only runtime export is playMascot', () => {
  assert.deepEqual(Object.keys(mascotModule), ['playMascot']);
});
for (const mood of MOODS) {
  test(`${mood}: exact pixels, mirrors, palette, packing, frame order and bounds`, async () => {
    const { text, waits } = await play(mood);
    const { frames, ups } = parse(text);
    assert.equal(frames.length, EXPECTED[mood].frames);
    assert.ok(frames.length >= 3 && frames.length <= 6);
    assert.deepEqual(waits, Array<number>(frames.length - 1).fill(EXPECTED[mood].delay));
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 1500);
    assert.deepEqual(ups, Array<number>(frames.length - 1).fill(4));
    const palette: Record<string, number | undefined> = { B:EXPECTED[mood].colour, W:231, K:16, S:226, C:211, T:117 };
    for (const [index, frame] of frames.entries()) {
      const fixture = FIXTURES[mood][index];
      const pixels = fixturePixels(fixture);
      assert.equal(frame.length, 4);
      for (const [lineIndex, line] of frame.entries()) {
        assert.ok(width(line) <= 14);
        const cells = decode(line);
        const offset = fixture[2];
        assert.deepEqual(cells.slice(0, offset), Array.from({length:offset}, () => ({ glyph:' ', fg:undefined, bg:undefined })));
        for (let x = 0; x < 11; x++) {
          const top = palette[pixels[lineIndex*2][x]];
          const bottom = palette[pixels[lineIndex*2+1][x]];
          assert.deepEqual(cells[x+offset], {
            glyph: top === undefined ? bottom === undefined ? ' ' : '▄' : '▀',
            fg: top ?? bottom, bg: top !== undefined ? bottom : undefined,
          }, `${mood} frame ${index} line ${lineIndex} column ${x}`);
        }
        const extra = fixture[5][lineIndex] ?? '';
        assert.deepEqual(cells.slice(offset+11), extra === '' ? [] : [
          {glyph:' ',fg:undefined,bg:undefined},
          ...[...extra].map(glyph => ({glyph,fg:EXTRA_COLOURS[extra],bg:undefined})),
        ]);
      }
    }
  });
  for (const value of ['1', '']) {
    test(`${mood}: NO_COLOR=${JSON.stringify(value)} occupancy and last-frame fixture`, async () => {
      const { text } = await play(mood, 'caption', { env:{ NO_COLOR:value } });
      assert.doesNotMatch(text, SGR);
      const { frames } = parse(text);
      for (const [index, frame] of frames.entries()) {
        const fixture = FIXTURES[mood][index];
        const pixels = fixturePixels(fixture);
        const solid = (pixel: string): boolean => !['.', 'W', 'T'].includes(pixel);
        const expected = [0,2,4,6].map((y, line) => {
          let result = ' '.repeat(fixture[2]);
          for (let x = 0; x < 11; x++) {
            result += solid(pixels[y][x]) ? solid(pixels[y+1][x]) ? '█' : '▀' : solid(pixels[y+1][x]) ? '▄' : ' ';
          }
          const extra = fixture[5][line];
          return result + (extra ? ' ' + extra : '');
        });
        assert.deepEqual(frame, expected);
        assert.equal(frame.length, 4);
        assert.ok(frame.every(line => width(line) <= 14));
      }
      assert.deepEqual(frames.at(-1), LAST_FRAMES[mood]);
    });
  }
}

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
  assert.equal(stream.text.match(/\x1b\[4A/gu)?.length, 1);
  assert.ok(!stream.text.includes('never'));
  assert.equal(stream.chunks[0], HIDE);
  assert.equal(stream.chunks.at(-1), SHOW);
});

test('the default timer stops at once on abort without sleeping', async () => {
  const controller = new AbortController();
  const stream = new MemoryStream();
  stream.onWrite = chunk => { if (chunk.includes('\n')) controller.abort(); };
  await assert.doesNotReject(playMascot('celebrating', 'never', { stream, env: {}, signal: controller.signal }));
  assert.ok(!stream.text.includes('\x1b[4A'));
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
