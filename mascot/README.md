# Outcome mascot

The design comes from the owner's reference sprite, approved on 2026-11-11:
two antennae, a wide body with mirrored eye slots, and X-shaped legs.
The standalone TypeScript module uses erasable syntax and Node built-ins only
and is not wired into the runner.

The sprite is 11 by 8 pixels, packed into 11 columns by 4 text lines.
Including offsets and decorations, every frame is exactly 4 lines and at most
14 columns wide. Each mood has 3 to 6 frames and at most 1.5 seconds of waits.

Coloured output uses ANSI 256 foreground and background colours with half blocks.
Body colours are happy 78, angry 160, celebrating 220, content 44, sleepy 69,
sad 61, startled 208 and dizzy 170. Eye whites use 231, pupils 16, star eyes 226,
cheeks 211 and tears 117.

## Moods

These are the exact NO_COLOR last frames, including offsets and decorations.
Eye whites and tears disappear; all other pixels become solid.

### `happy`

```text
   ▀▄ ▄▀    ♪
 ▄███████▄ 
██▄▄███▄▄██
▄ ▀ ▀▀▀ ▀ ▄
```

### `angry`

```text
   ▀▄ ▄▀    #
 ▄███████▄ 
██▀▄███▄▀██
 ▄▀▄▀▀▀▄▀▄ 
```

### `celebrating`

```text
   ▀▄ ▄▀    *
 ▄███████▄  .
██▀▄███▄▀██
▄ ▀ ▀▀▀ ▀ ▄ +
```

### `content`

```text
   ▀▄ ▄▀   
 ▄███████▄ 
██ ▄███▄ ██
▄ ▀ ▀▀▀ ▀ ▄
```

### `sleepy`

```text
   ▀▄ ▄▀    zZ
 ▄███████▄ 
██▀▀███▀▀██
 ▄▀▄▀▀▀▄▀▄ 
```

### `sad`

```text
   ▀▄ ▄▀   
 ▄███████▄ 
██▄ ███ ▄██
 ▄▀ ▀▀▀▄▀▄ 
```

### `startled`

```text
   ▀▄ ▄▀    !!
 ▄███████▄ 
██  ███  ██
▄ ▀ ▀▀▀ ▀ ▄
```

### `dizzy`

```text
    ▀▄ ▄▀    *
  ▄███████▄ 
 ██▄▀███▀▄██
  ▄▀▄▀▀▀▄▀▄ 
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
- `NO_COLOR` set to any value, including the empty string, removes eye whites and tears before packing; every other pixel is solid.
  Both pixels print as `█`, top only as `▀`, bottom only as `▄`, neither as a
  space. Decorations remain, without ANSI colour codes.
- `TERM=dumb` prints only the last frame and the caption, with no cursor
  movement, no cursor hide/show and no waiting.

## Tests

`mascot/mascot.test.ts` uses an in-memory stream and a fake frame timer and
never sleeps. It runs as part of `npm test`.
