## ADDED Requirements

### Requirement: Mascot module source

The system SHALL provide `mascot/mascot.ts`, written in TypeScript with erasable
syntax only and importing only Node built-in modules.

#### Scenario: Erasable syntax and built-ins only

- **WHEN** `mascot/mascot.ts` is type-checked with the project configuration
- **THEN** it compiles under `erasableSyntaxOnly`
- **AND** every import specifier starts with `node:`

### Requirement: Original mascot art within size limits

The mascot SHALL be an original small figure drawn with Unicode block characters
and ANSI colours. It SHALL NOT reproduce the Claude Code logo or any other
existing logo or character. Every frame SHALL be at most 7 lines high and at most
20 columns wide, measured after stripping ANSI sequences.

#### Scenario: Size limits

- **WHEN** any mood is played on a TTY stream
- **THEN** every frame written has at most 7 lines
- **AND** every line has at most 20 columns after ANSI sequences are removed

#### Scenario: Block characters

- **WHEN** the last frame of any mood is inspected
- **THEN** its body contains Unicode block element characters

### Requirement: Single exported function

The module SHALL export exactly one runtime function,
`playMascot(mood, caption, options?)`.

#### Scenario: Single runtime export

- **WHEN** the module namespace of `mascot/mascot.ts` is imported
- **THEN** its only runtime export is the function `playMascot`

### Requirement: Eight moods

The module SHALL offer exactly the moods `happy` (green), `angry` (red),
`celebrating` (yellow, with sparkles), `content` (cyan), `sleepy` (blue), `sad`
(blue), `startled` (yellow) and `dizzy` (magenta), each with its own eyes,
mouth and colour.

#### Scenario: Mood colours

- **WHEN** each mood is played on a TTY stream without `NO_COLOR`
- **THEN** its frames use the SGR colour green, red, yellow, cyan, blue, blue,
  yellow and magenta respectively

#### Scenario: Distinct faces

- **WHEN** the last frames of all eight moods are compared
- **THEN** no two moods have the same face (eyes and mouth)

#### Scenario: Celebrating sparkles

- **WHEN** `celebrating` is played
- **THEN** its frames contain sparkle characters outside the body

### Requirement: Animation and caption

`playMascot` SHALL play an animation of 3 to 6 frames whose frame-timer waits
total at most 1500 ms, redrawn in place, after which the last frame stays on
screen followed by the caption on its own line. The returned promise SHALL
resolve when the animation ends and SHALL never reject.

#### Scenario: Frame count and duration

- **WHEN** each mood is played with a fake timer
- **THEN** between 3 and 6 frames are drawn
- **AND** the sum of requested waits is at most 1500 ms

#### Scenario: Redrawn in place

- **WHEN** a frame after the first is drawn
- **THEN** the cursor is moved up by the frame height before the frame is
  rewritten

#### Scenario: Caption after last frame

- **WHEN** `playMascot('happy', 'All checks passed')` completes on a TTY
- **THEN** the output ends with the last frame followed by the line
  `All checks passed`

#### Scenario: Never rejects

- **WHEN** the timer rejects, a write throws, or an unknown mood is passed
- **THEN** the returned promise resolves

### Requirement: Output conditions

`playMascot` SHALL write to `process.stderr` by default. It SHALL write nothing
when the stream is not a TTY or the environment variable `OUTCOME_RUNNER_MASCOT`
is `0`. With `NO_COLOR` set to any value, including the empty string, it SHALL
write the same shapes without colour codes. With `TERM=dumb` it SHALL write only
the last frame and the caption, without cursor movement or cursor visibility
sequences.

#### Scenario: Non-TTY stream

- **WHEN** the injected TTY detection reports false
- **THEN** nothing is written and the promise resolves

#### Scenario: Disabled by environment

- **WHEN** the environment has `OUTCOME_RUNNER_MASCOT=0` and the stream is a TTY
- **THEN** nothing is written and the promise resolves

#### Scenario: NO_COLOR

- **WHEN** a mood is played with `NO_COLOR=1`
- **THEN** the output contains no SGR colour sequences
- **AND** the frames have the same characters as with colour

#### Scenario: Empty NO_COLOR

- **WHEN** a mood is played with `NO_COLOR` set to the empty string
- **THEN** the output contains no SGR colour sequences
- **AND** the frames have the same characters as with colour

#### Scenario: Dumb terminal

- **WHEN** a mood is played with `TERM=dumb`
- **THEN** the output is exactly the last frame lines followed by the caption
  line
- **AND** it contains no cursor movement or cursor hide/show sequences
- **AND** the frame timer is not called

### Requirement: Cursor restored

The cursor SHALL be hidden while an animation plays and SHALL always be shown
again afterwards, including when the animation is stopped through the
`AbortSignal` option or a write fails. The show-cursor sequence SHALL be
attempted whenever the hide-cursor write was attempted, even if that hide write
itself threw.

#### Scenario: Normal completion

- **WHEN** an animation completes
- **THEN** a hide-cursor sequence precedes the first frame and the last write is
  the show-cursor sequence

#### Scenario: Abort

- **WHEN** the signal is aborted during the animation
- **THEN** no further frames are drawn, the cursor is shown again and the
  promise resolves

#### Scenario: Failing write

- **WHEN** a write of a frame throws
- **THEN** the show-cursor sequence is still attempted and the promise resolves

#### Scenario: Failing hide-cursor write

- **WHEN** the very first write, the hide-cursor sequence, throws
- **THEN** the show-cursor sequence is still attempted
- **AND** the promise resolves

#### Scenario: Failing show-cursor write

- **WHEN** the show-cursor write throws
- **THEN** the promise still resolves

### Requirement: Injectable dependencies

The output stream, TTY detection, environment, frame timer and abort signal
SHALL be injectable through options.

#### Scenario: Fully injected run

- **WHEN** `playMascot` is called with an in-memory stream, a TTY detector, an
  environment object, a fake timer and a signal
- **THEN** it uses only those, writes nothing to `process.stderr` and never
  sleeps

### Requirement: Mascot tests

`mascot/mascot.test.ts` SHALL use a fake timer and an in-memory stream, SHALL
never sleep, and SHALL cover every behaviour required by this capability.

#### Scenario: Sleep-free tests

- **WHEN** the mascot tests run
- **THEN** no real timer is used and every test completes without waiting

### Requirement: Project build integration

The `package.json` test script SHALL also run `mascot/*.test.ts` and keep the
85% line, branch and function coverage thresholds. `tsconfig.json` SHALL include
`mascot` so `npm run typecheck` checks it.

#### Scenario: Checks pass

- **WHEN** `npm run typecheck` and `npm test` are run
- **THEN** both pass, the mascot tests are executed and coverage stays at or above
  85% for lines, branches and functions

### Requirement: Mascot documentation

`mascot/README.md` SHALL show the last frame of every mood as a plain-text
preview and document `playMascot` and its options.

#### Scenario: README preview

- **WHEN** `mascot/README.md` is read
- **THEN** it contains a plain-text preview of the last frame of each of the eight
  moods and documents every option of `playMascot`
