# Design: animated outcome mascot

## Context

The repository is a Node >= 24 ESM project that runs TypeScript directly
(`erasableSyntaxOnly`, `verbatimModuleSyntax`, no runtime dependencies). Tests
use `node --test` with an 85% line/branch/function coverage gate. The mascot is
a new, self-contained module in a new top-level `mascot/` directory.

## Goals / Non-Goals

Goals: an original, small, colourful mood mascot; deterministic, sleep-free
tests; safe terminal behaviour (no output when not interactive, cursor always
restored, never rejecting).

Non-goals: wiring the mascot into the runner or CLI, adding it to the published
build (`tsconfig.build.json` is unchanged), Windows console specifics beyond
ANSI.

## Decisions

### Public API

One runtime export (type exports are erased and allowed):

```ts
export type MascotMood =
  | 'happy' | 'angry' | 'celebrating' | 'content'
  | 'sleepy' | 'sad' | 'startled' | 'dizzy';

export interface MascotStream { write(chunk: string): unknown; isTTY?: boolean }

export interface MascotOptions {
  stream?: MascotStream;                        // default process.stderr
  isTTY?: (stream: MascotStream) => boolean;    // default s => s.isTTY === true
  env?: Record<string, string | undefined>;     // default process.env
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>; // frame timer
  signal?: AbortSignal;
}

export function playMascot(
  mood: MascotMood, caption: string, options?: MascotOptions,
): Promise<void>;
```

The default `wait` is `setTimeout` from `node:timers/promises` with the signal;
its abort rejection is caught internally. Only `node:` imports are used.

### Art

An original "pebble" creature: a rounded block-character body with a single
antenna bobble and two small feet, eyes and mouth drawn as narrow ASCII glyphs
inside the body. Reference sketch (final glyphs decided in implementation within
the limits below):

```
      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  ^   ^  █
  █    v    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

It must not resemble the Claude Code logo (no orange pixel crab/asterisk) or any
other known logo or character. All glyphs are single-column: Unicode block
elements (U+2580–U+259F), space, and printable ASCII. Width is measured as code
points per line after stripping ANSI sequences; every frame is at most 20
columns and at most 7 lines. All frames of one mood have the same height so
in-place redraw is exact. The extra (seventh) line is available for sparkles or
`z` above the head.

### Moods

| mood        | eyes  | mouth | colour  | frames | extra                     |
|-------------|-------|-------|---------|--------|---------------------------|
| happy       | `^ ^` | `v`   | green   | 4      | bounce                    |
| angry       | `> <` | `m`   | red     | 4      | shake                     |
| celebrating | `* *` | `D`   | yellow  | 6      | sparkles `*` `+` `.`      |
| content     | `- -` | `u`   | cyan    | 3      | slow blink                |
| sleepy      | `_ _` | `.`   | blue    | 5      | drifting `z`              |
| sad         | `T T` | `n`   | blue    | 4      | droop                     |
| startled    | `O O` | `o`   | yellow  | 3      | jump                      |
| dizzy       | `@ @` | `~`   | magenta | 6      | sway                      |

Eyes and mouths are pairwise distinct across moods. Colours use SGR 32, 31, 33,
36, 34, 34, 33, 35 with reset `\x1b[0m`. Per-frame delays are chosen so the sum
of all `wait` calls per animation is at most 1500 ms; there is no wait after the
last frame.

### Output protocol

Decision order on each call:

1. Unknown mood (from untyped callers), stream not a TTY, `OUTCOME_RUNNER_MASCOT`
   equal to `0`, or signal already aborted: write nothing, resolve.
2. `NO_COLOR` set (the key is present with any value, including the empty
   string, i.e. `env.NO_COLOR !== undefined`): same characters, no SGR
   sequences. This matches the source wording "With NO_COLOR set".
3. `TERM=dumb`: write the last frame lines, then the caption line, each ending in
   `\n`; no cursor hide/show, no cursor movement, no `wait` calls.
4. Otherwise: set `hideAttempted = true`, then write `\x1b[?25l` (hide), then
   frame 1; for each later frame `wait` then move up by the frame height
   (`\x1b[<h>A`) and rewrite each line with `\r\x1b[2K`. After the last frame
   write the caption line + `\n`, then `\x1b[?25h` (show) in a `finally`.

Caption CR/LF characters are replaced by spaces so it stays one line.

### Failure handling

The whole body runs in `try/catch/finally`; the promise always resolves.
A write that throws, a `wait` that rejects, or an abort (checked after each
`wait` and via the signal passed to `wait`) stops the animation.

The `hideAttempted` flag is set *before* the hide write is issued, so a hide
write that throws (possibly after partially flushing) still counts as hidden.
In `finally`, whenever `hideAttempted` is true, `\x1b[?25h` is written inside
its own `try/catch`; this covers the case where the very first write (the hide
sequence) throws. If the show write itself throws, the error is swallowed and
the promise still resolves. On abort or failure after at least one frame line
was started, no caption is written and a `\n` is attempted (in its own
`try/catch`) before the show sequence so the prompt does not overwrite the
partial frame.

### Tests

`mascot/mascot.test.ts` uses an in-memory stream (array of chunks, `isTTY`
configurable, optional throwing on the n-th write, which records the attempted
chunk even when it throws) and a fake `wait` that records durations and
resolves immediately. Frames are reconstructed from the written output by
splitting on redraw sequences. No real timers are used. Cases include
`NO_COLOR=''` (empty) as well as `NO_COLOR='1'`, and a stream whose first write
(the hide sequence) throws, asserting that the show sequence is still attempted.

### Build integration

`package.json` `test` adds `"mascot/*.test.ts"` to the test globs and
`--test-coverage-exclude="mascot/*.test.ts"`, keeping
`--test-coverage-lines=85 --test-coverage-branches=85
--test-coverage-functions=85`. `tsconfig.json` `include` gains `"mascot"`.

## Risks / Trade-offs

- Terminals that render block elements as double width would exceed 20 columns;
  accepted, block elements are narrow in standard terminals.
- Async stream errors (e.g. EPIPE emitted later) are not observed; only
  synchronous write failures are handled, which is enough to guarantee the
  promise never rejects.
- Treating an empty `NO_COLOR` as set is slightly broader than the no-color.org
  convention (non-empty), but follows the task criterion literally.
