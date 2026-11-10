# Tasks

## 1. Mascot module

- [ ] 1.1 Create `mascot/mascot.ts` (erasable syntax, `node:` imports only) with
  types `MascotMood`, `MascotStream`, `MascotOptions` and the single runtime
  export `playMascot(mood, caption, options?)`.
- [ ] 1.2 Draw the original pebble mascot with block elements and ASCII glyphs;
  frames at most 7 lines and 20 columns, equal height per mood; must not
  resemble the Claude Code logo or any existing logo/character.
- [ ] 1.3 Define the eight moods with distinct eyes/mouths and colours (happy
  green, angry red, celebrating yellow with sparkles, content cyan, sleepy blue,
  sad blue, startled yellow, dizzy magenta); 3–6 frames each, waits totalling
  at most 1500 ms, no wait after the last frame.
- [ ] 1.4 Output protocol: default stream `process.stderr`; nothing for non-TTY,
  `OUTCOME_RUNNER_MASCOT=0`, unknown mood or pre-aborted signal; `NO_COLOR` set
  to any value, including the empty string (`env.NO_COLOR !== undefined`),
  strips SGR only; `TERM=dumb` writes last frame + caption only, no cursor
  sequences, no waits; otherwise hide cursor, redraw in place with cursor-up,
  write caption, show cursor.
- [ ] 1.5 Failure handling: `try/catch/finally`, never reject; on abort, failing
  write or rejecting timer stop. Set the `hideAttempted` flag *before* writing
  the hide sequence `\x1b[?25l`, so a hide write that throws still counts as
  hidden; in `finally`, whenever `hideAttempted` is true, attempt the
  show-cursor sequence `\x1b[?25h` in its own `try/catch`.

## 2. Tests

- [ ] 2.1 `mascot/mascot.test.ts` with an in-memory stream (records every
  attempted chunk, can throw on the n-th write) and fake `wait`; no real timers
  or sleeps.
- [ ] 2.2 Every mood: frame count 3–6, height ≤ 7, width ≤ 20, total waits
  ≤ 1500 ms, expected colour, distinct faces, celebrating sparkles.
- [ ] 2.3 Caption follows the last frame; redraw uses cursor-up.
- [ ] 2.4 No output for non-TTY and for `OUTCOME_RUNNER_MASCOT=0`.
- [ ] 2.5 No colour codes with `NO_COLOR=1` and with `NO_COLOR=''` (empty),
  same shapes as with colour.
- [ ] 2.6 `TERM=dumb`: only last frame + caption, no cursor sequences, no waits.
- [ ] 2.7 Cursor shown after abort, after a failing frame write, and when the
  very first write (the hide sequence) throws — the show sequence is still
  attempted; promise resolves for rejecting timer, throwing write (including a
  throwing show write) and unknown mood.
- [ ] 2.8 Only runtime export is `playMascot`.

## 3. Project configuration

- [ ] 3.1 `package.json` `test`: add `"mascot/*.test.ts"` and
  `--test-coverage-exclude="mascot/*.test.ts"`; keep the 85% line, branch and
  function thresholds.
- [ ] 3.2 `tsconfig.json`: add `"mascot"` to `include`.

## 4. Documentation

- [ ] 4.1 `mascot/README.md`: plain-text preview of the last frame of every mood,
  documentation of `playMascot`, its parameters, every option, defaults and the
  environment rules (`OUTCOME_RUNNER_MASCOT`, `NO_COLOR` set to any value,
  `TERM=dumb`).

## 5. Verification

- [ ] 5.1 `npm run typecheck` passes.
- [ ] 5.2 `npm test` passes, including the 85% coverage gate.
