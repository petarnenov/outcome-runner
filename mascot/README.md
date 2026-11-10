# Outcome mascot

`mascot/mascot.ts` is a small, original animated "pebble" creature for interactive
terminals: a rounded block-character body with one antenna bobble, two feet and
an ASCII face. It is a standalone module (TypeScript with erasable syntax only,
Node built-ins only) and is not wired into the runner.

Every frame is 7 lines high and at most 20 columns wide; each animation has 3 to
6 frames and waits at most 1.5 seconds in total.

## Moods

Plain-text previews of the last frame of every mood (the first line is reserved
for sparkles, `z` or `!` and may be empty).

### `happy` (green, 4 frames, bounce)

```text

      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  ^   ^  █
  █    v    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `angry` (red, 4 frames, shake)

```text

      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  >   <  █
  █    m    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `celebrating` (yellow, 6 frames, sparkles)

```text
  *   +  .  +   *
      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  *   *  █
  █    D    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `content` (cyan, 3 frames, slow blink)

```text

      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  -   -  █
  █    u    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `sleepy` (blue, 5 frames, drifting `z`)

```text
            z  Z
      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  _   _  █
  █    .    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `sad` (blue, 4 frames, droop)

```text

      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  T   T  █
  █    n    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `startled` (yellow, 3 frames, jump)

```text
       !
      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  O   O  █
  █    o    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

### `dizzy` (magenta, 6 frames, sway)

```text

      ▄█▄
   ▄▄▄▄█▄▄▄▄
  █  @   @  █
  █    ~    █
   ▀▀▀▀▀▀▀▀▀
    ▀▀   ▀▀
```

## API

The module has one runtime export:

```ts
import { playMascot } from './mascot/mascot.ts';
import type { MascotMood, MascotOptions, MascotStream } from './mascot/mascot.ts';

playMascot(mood: MascotMood, caption: string, options?: MascotOptions): Promise<void>
```

- `mood`: one of `happy`, `angry`, `celebrating`, `content`, `sleepy`, `sad`,
  `startled`, `dizzy`. An unknown mood (from untyped callers) writes nothing.
- `caption`: one line printed below the last frame; CR and LF characters are
  replaced by spaces.
- Returns a promise that resolves when the animation ends. It never rejects.

The animation is redrawn in place (cursor up, clear line); the cursor is hidden
while it plays and is always shown again afterwards, also after an abort or a
failing write. After an abort or failure no caption is written.

### Options

| option   | type                                                | default                                                         |
|----------|-----------------------------------------------------|-----------------------------------------------------------------|
| `stream` | `MascotStream` (`{ write(chunk: string): unknown; isTTY?: boolean }`) | `process.stderr`                              |
| `isTTY`  | `(stream: MascotStream) => boolean`                 | `stream => stream.isTTY === true`                               |
| `env`    | `Record<string, string \| undefined>`               | `process.env`                                                   |
| `wait`   | `(ms: number, signal?: AbortSignal) => Promise<void>` (frame timer) | `setTimeout` from `node:timers/promises` with the signal |
| `signal` | `AbortSignal`                                       | none; when aborted the animation stops, an already aborted signal writes nothing |

### Environment rules

- Nothing is written when the stream is not a TTY or `OUTCOME_RUNNER_MASCOT=0`.
- `NO_COLOR` set to any value, including the empty string, keeps the same
  shapes without ANSI colour codes.
- `TERM=dumb` prints only the last frame and the caption, with no cursor
  movement, no cursor hide/show and no waiting.

## Tests

`mascot/mascot.test.ts` uses an in-memory stream and a fake frame timer and
never sleeps. It runs as part of `npm test`.
