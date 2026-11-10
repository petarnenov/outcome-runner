# Animated outcome mascot

## Why

The runner reports outcomes only as plain text. A small, original animated
mascot gives operators an at-a-glance signal of how a step went (happy, sad,
dizzy, ...) in an interactive terminal, without affecting non-interactive use,
logs or machine-readable output. This change adds the mascot as a standalone,
fully tested module; wiring it into the runner is out of scope.

## What Changes

- Add `mascot/mascot.ts` (TypeScript, erasable syntax only, Node built-ins only)
  with an original small mascot drawn with Unicode block characters and ANSI
  colours, at most 7 lines high and 20 columns wide. It is inspired by the style
  of compact terminal logos but does not reproduce the Claude Code logo or any
  other existing logo or character.
- Exactly eight moods, each with its own eyes, mouth and colour: `happy` (green),
  `angry` (red), `celebrating` (yellow, with sparkles), `content` (cyan),
  `sleepy` (blue), `sad` (blue), `startled` (yellow), `dizzy` (magenta).
- One exported function `playMascot(mood, caption, options?)` plays a 3 to 6
  frame animation of at most 1.5 seconds, redrawn in place; the last frame stays
  on screen followed by the caption. The returned promise resolves when the
  animation ends and never rejects.
- Output goes to stderr by default. Nothing is written when the stream is not a
  TTY or `OUTCOME_RUNNER_MASCOT=0`. `NO_COLOR` keeps the shapes without colour.
  `TERM=dumb` prints only the last frame and the caption without cursor
  movement.
- The cursor is hidden during the animation and always shown again afterwards,
  including after an abort through an `AbortSignal` option or a failing write.
- Stream, TTY detection, environment, frame timer and abort signal are
  injectable.
- `mascot/mascot.test.ts` covers the behaviour with a fake timer and an
  in-memory stream, without sleeping.
- `package.json` test script also runs `mascot/*.test.ts`, keeping the 85% line,
  branch and function coverage thresholds; `tsconfig.json` includes `mascot`.
- `mascot/README.md` previews the last frame of every mood as plain text and
  documents the function and its options.

## Capabilities

### New Capabilities

- `terminal-mascot`: the animated mood mascot module, its output rules for
  terminals, its injectable dependencies and its documentation.

### Modified Capabilities

None.

## Impact

- New files: `mascot/mascot.ts`, `mascot/mascot.test.ts`, `mascot/README.md`.
- Changed: `package.json` (`test` script only), `tsconfig.json` (`include`).
- No change to `src/`, `bin/`, `test/`, `scripts/`, the runner, the CLI, the
  build configuration (`tsconfig.build.json`) or published package contents.
- No new dependencies.
