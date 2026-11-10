## MODIFIED Requirements

### Requirement: Original mascot art within size limits

The mascot SHALL replace the OR-10 art with the owner's reference-derived pixel sprite approved on 2026-11-11: antennae, a wide body with two eye slots and X-shaped legs. The sprite SHALL be exactly 11 columns by 8 pixel rows, packed into exactly four terminal lines. Every frame, including offsets and decorations, SHALL be at most four lines high and fourteen columns wide after removing ANSI sequences. The caption SHALL be outside this frame measurement.

Coordinates SHALL be zero-based. The first six rows SHALL be:
```text
...B...B...
....B.B....
..BBBBBBB..
.BBBBBBBBB.
BB00BBB11BB
BB00BBB11BB
```
Rows 6 and 7 SHALL be selected from these two leg poses:

| Pose | Row 6 | Row 7 |
| --- | --- | --- |
| 0 | `..B.BBB.B..` | `.B.B...B.B.` |
| 1 | `..B.BBB.B..` | `B.B.....B.B` |

Here . SHALL be empty, B SHALL be body, 0 SHALL mark the left eye slot and 1 SHALL mark the right eye slot. Eye and optional cheek/tear overlays SHALL be applied before packing.

#### Scenario: Exact base geometry and leg poses

- **WHEN** frames using each leg pose are decoded into pixel rows before optional overlays
- **THEN** rows 0 through 5 match the six literal rows above
- **AND** rows 6 and 7 match the selected pose exactly
- **AND** the canvas is 11 by 8 pixels

#### Scenario: Frame bounds

- **WHEN** any frame of any mood is rendered in colour or NO_COLOR mode
- **THEN** it contains exactly four lines
- **AND** each line, including leading offsets and decorations, has at most fourteen terminal columns

### Requirement: Eight moods

The module SHALL retain exactly happy, angry, celebrating, content, sleepy, sad, startled and dizzy. It SHALL use the following ANSI 256 body colours:

| Mood | Colour |
| --- | --- |
| happy | 78 |
| angry | 160 |
| celebrating | 220 |
| content | 44 |
| sleepy | 69 |
| sad | 61 |
| startled | 208 |
| dizzy | 170 |

The two eyes SHALL each occupy rows 4 and 5. The left pattern's first and second columns SHALL map to columns 2 and 3; the right pattern's first and second columns SHALL map to columns 8 and 7, mirroring the pattern horizontally. Patterns SHALL be interpreted top row then bottom row:

| Pattern | Top row | Bottom row |
| --- | --- | --- |
| open | WW | WK |
| happy | WW | BB |
| angry | BW | WK |
| sad | WW | KW |
| sleepy | BB | WW |
| wide | WW | WW |
| swirlA | KW | WK |
| swirlB | WK | KW |
| star | SW | WS |

W SHALL be eye white 231, K pupil 16, S sparkle 226, and B the mood's body colour. Optional cheeks C SHALL use 211 at row 5, columns 1 and 9. Optional tear T SHALL use 117 at column 3 in row 6 or 7, replacing the existing cell.

Decorations SHALL appear exactly one space to the right of the rendered eleven-column sprite canvas, shifted with any frame offset. ♪ SHALL use 229, # 196, sparkle + 229, sparkle * 213, sparkle . 117, z and zZ 153, and ! and !! 196.

The ordered frame sequences SHALL be:

| Mood | Frames in order |
| --- | --- |
| happy | open/0; happy/1; happy/0 with cheeks; happy/1 with cheeks and ♪ on line 0 |
| angry | angry/0 offset 0; angry/0 offset 1; angry/0 offset 0; angry/0 offset 1; angry/0 offset 0 with # on line 0 |
| celebrating | star/0; star/1; star/0; star/1, with changing sparkles on lines 0 through 3 |
| content | open/0; sleepy/0; open/1 |
| sleepy | sleepy/0 with z on line 1; sleepy/0 with z on line 0; sleepy/0 with zZ on line 0 |
| sad | sad/0 with tear at row 6; sad/0 with tear at row 7; sad/1 with no tear; sad/0 with tear at row 7 |
| startled | open/1; wide/0 with ! on line 0; wide/1 with !! on line 0 |
| dizzy | swirlA/0 with * on line 0; swirlB/0 offset 1 with * on line 1; swirlA/0 with * on line 2; swirlB/0 offset 1 with * on line 0 |

Unspecified offsets SHALL be zero and unspecified extras SHALL be absent. For celebrating zero-based frame f, + SHALL appear on line f, * on line (f+1) modulo 4 and . on line (f+2) modulo 4. These explicit defaults and decoration placements resolve source freedom without changing the approved geometry or mood order. ASCII mouths and pairwise distinct mouth/face requirements from OR-10 SHALL be superseded by these pixel patterns.

#### Scenario: Eye patterns and mirrors

- **WHEN** each of the nine named eye patterns is rendered
- **THEN** its four left-eye pixels match the literal pattern above
- **AND** its right-eye pixels match the horizontal mirror at columns 7 and 8
- **AND** W, K, S and B have their specified colours

#### Scenario: Happy and angry sequences

- **WHEN** happy and angry are played with an injected fake timer
- **THEN** happy has exactly the four specified frames, with cheeks only on frames 3 and 4 and ♪ only on frame 4 line 0
- **AND** angry has exactly five angry/0 frames at offsets 0,1,0,1,0, with # only on frame 5 line 0

#### Scenario: Celebrating sequence and decoration colours

- **WHEN** celebrating is played
- **THEN** its four frames use star eyes and leg poses 0,1,0,1
- **AND** every frame places +, * and . on the three lines specified by its frame index, in colours 229, 213 and 117
- **AND** the sparkle placement changes every frame and stays inside the bounds

#### Scenario: Content and sleepy sequences

- **WHEN** content and sleepy are played
- **THEN** content has exactly open/0, sleepy/0 and open/1
- **AND** sleepy has exactly three sleepy/0 frames with z on line 1, z on line 0 and zZ on line 0 respectively, in colour 153

#### Scenario: Sad sequence and tears

- **WHEN** sad is played
- **THEN** its four sad-eye frames use poses 0,0,1,0
- **AND** their tears are at (3,6), (3,7), absent and (3,7) respectively in colour 117

#### Scenario: Startled and dizzy sequences

- **WHEN** startled and dizzy are played
- **THEN** startled has open/1, wide/0 with ! and wide/1 with !!, with both decorations on line 0 in colour 196
- **AND** dizzy alternates swirlA, swirlB, swirlA, swirlB with pose 0, offsets 0,1,0,1 and * on lines 0,1,2,0 respectively in colour 213

#### Scenario: Mood palette

- **WHEN** every mood's coloured frames are decoded
- **THEN** every B pixel uses that mood's listed ANSI 256 colour
- **AND** eyes, cheeks, tears and decorations use their independently specified colours

### Requirement: Output conditions

playMascot SHALL default to process.stderr and SHALL preserve injected stream, TTY detector, environment, frame timer and abort signal options. It SHALL produce no output for a non-TTY stream, OUTCOME_RUNNER_MASCOT=0, an unknown mood or an already aborted signal.

Pixel rows SHALL be packed in pairs (0,1), (2,3), (4,5), (6,7). With colour enabled, both pixels set SHALL print ▀ with top foreground SGR 38;5;n and bottom background SGR 48;5;n; only top SHALL print ▀ in the top colour; only bottom SHALL print ▄ in the bottom colour; neither SHALL print a space. Unset halves SHALL use the terminal's default background, with resets preventing style leakage into empty cells, padding, decorations or later output.

With NO_COLOR set to any value including the empty string, no colour codes SHALL be written. W eye-white and T tear pixels SHALL become empty; every other pixel SHALL become solid. Pair packing SHALL then emit █ for both solid, ▀ for top only, ▄ for bottom only and space for both empty. Decorations SHALL retain their characters without colour. This supersedes OR-10's same-glyph coloured/NO_COLOR requirement.

With TERM=dumb the module SHALL print only the last frame and caption with no cursor movement, cursor visibility sequences or timer calls. NO_COLOR SHALL still apply.

#### Scenario: Half-block colour channels

- **WHEN** a pixel pair has top colour a and bottom colour b
- **THEN** it emits ▀ with foreground a and background b when both are set, even when a equals b
- **AND** top-only emits ▀ with foreground a and default background
- **AND** bottom-only emits ▄ with foreground b and default background
- **AND** both empty emits a space with no inherited background

#### Scenario: NO_COLOR conversion

- **WHEN** any mood is played with NO_COLOR equal to 1 or the empty string
- **THEN** no SGR colour codes are emitted
- **AND** eye-white and tear pixels disappear before packing
- **AND** body, pupil, sparkle and cheek pixels become solid using the four specified occupancy glyphs
- **AND** decorations retain their positions and uncoloured characters

#### Scenario: Gating and stderr

- **WHEN** the default stream is used on an enabled TTY
- **THEN** output is written to stderr and not stdout
- **WHEN** the stream is not a TTY, the mascot is disabled, the mood is unknown or the signal is already aborted
- **THEN** nothing is written and the promise resolves

#### Scenario: Dumb terminal

- **WHEN** TERM=dumb is set for any mood, with or without NO_COLOR
- **THEN** output is precisely that mode's last four-line frame followed by the sanitized caption on its own line
- **AND** no cursor-control sequences or waits occur

### Requirement: Mascot tests

mascot/mascot.test.ts SHALL use in-memory streams and fake frame timers without real sleeps. It SHALL verify literal sprite rows, both leg poses, every eye pattern and its mirror, cheeks, tears, every mood's full frame sequence and palette, four half-block cases and colour channels, NO_COLOR occupancy rendering and every frame's four-line/fourteen-column bound.

Tests SHALL retain the unchanged OR-10 contracts: exactly one runtime export playMascot(mood, caption, options?), unchanged options and eight mood names, Node built-ins and erasable syntax, stderr default, full injection, TTY and disable gates, 3 to 6 frames and at most 1500 ms total frame waits, in-place redraw, final frame and sanitized caption, TERM=dumb behaviour, cursor hiding/restoration and a never-rejecting promise. Superseded art, size, mouth and NO_COLOR glyph assertions SHALL be replaced.

#### Scenario: Exact art regression coverage

- **WHEN** mascot tests run
- **THEN** independent expected matrices and frame fixtures verify all specified geometry, overlays, ordered sequences, palettes and rendering cases
- **AND** every coloured and NO_COLOR frame is checked including offsets and extras
- **AND** no real timer waits are used

#### Scenario: Lifecycle regressions

- **WHEN** all moods run with fake waits
- **THEN** each has 3 to 6 frames, waits total at most 1500 ms and no wait follows the final frame
- **AND** later frames move up exactly four lines and clear each rewritten line
- **AND** the last frame stays on screen followed by the caption on its own line
- **AND** the cursor is hidden while playing and restored on completion

#### Scenario: Abort and failure regressions

- **WHEN** animation aborts, a timer rejects, or a hide, frame, caption or show write throws
- **THEN** the returned promise resolves
- **AND** show-cursor is attempted whenever hide-cursor was attempted, even if the hide write itself failed
- **AND** abort or failure stops further animation and does not emit an unfinished caption

#### Scenario: Project gates

- **WHEN** npm run typecheck and npm test run after specification binding and implementation
- **THEN** both pass with mascot tests included and the existing 85% line, branch and function coverage thresholds preserved

### Requirement: Mascot documentation

mascot/README.md SHALL replace its previews with the NO_COLOR last frame of every mood, state that the design comes from the owner's reference sprite approved on 2026-11-11, describe the 11 by 8 pixel / 11 by 4 text-line sprite and four-line/fourteen-column frame limit, and retain accurate public function and option documentation.

#### Scenario: README previews and provenance

- **WHEN** mascot/README.md is compared with verified NO_COLOR output
- **THEN** it contains each of the eight moods' exact last-frame previews, including final offsets and decorations
- **AND** it credits the owner's reference sprite and documents the updated dimensions and NO_COLOR behaviour
- **AND** playMascot and every unchanged option remain documented
