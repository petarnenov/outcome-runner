# Design: owner-approved pixel mascot

## Context and Scope

OR-15 depends on OR-10. The existing module is a standalone TypeScript module using erasable syntax and Node built-ins; it already owns stream injection, TTY/environment gates, timer injection, abort handling, redraw and cursor restoration. Replace its art construction and rendering while preserving those lifecycle guarantees.

The normative geometry, palette and frame sequences are in specs/terminal-mascot/spec.md. The owner's supplied pixel description is authoritative; no new image generation or interpretation of an unavailable reference is needed. The earlier OR-10 pebble sketch, ASCII mouth uniqueness and seven-line layout are superseded.

## Decisions

### Pixel composition

Use a private, typed 11 by 8 pixel grid and private declarative mood/frame data. Do not add runtime exports. Build each frame from the fixed first six rows and selected leg rows, then overlay eyes, cheeks and tear. Coordinates are zero-based. Apply left eye pattern columns in order 2,3 and right eye pattern columns in order 8,7, so asymmetric pupils are mirrored. Body-coloured B pixels in an eye pattern remain solid body pixels; W is white, not transparency until NO_COLOR conversion.

Overlay precedence is base, eyes, cheeks, tear. The tear at (3,6) or (3,7) replaces that cell even if the leg pixel there is empty. Add the horizontal offset only after composing and rendering the sprite; it never changes pixel coordinates.

### Packing pixel pairs

Pair rows (0,1), (2,3), (4,5), (6,7). For each column render both set pixels as ▀ with top foreground and bottom background, top-only as ▀ with foreground, bottom-only as ▄ with foreground, neither as a space. Use SGR 38;5;n and 48;5;n for ANSI 256 colours and reset styles so backgrounds do not leak into empty cells, padding, decorations or subsequent output. Both set pixels still use the two-colour protocol when their colours match.

In NO_COLOR mode, remove W and T pixels before pairing. All remaining pixels are solid regardless of their original palette role: both becomes █, top-only ▀, bottom-only ▄, neither space. Suppress colour SGR only; normal interactive cursor control still applies. This deliberately replaces OR-10's same-characters-after-stripping-colour rule.

Every frame has exactly four lines. Preserve the eleven-column sprite canvas, prepend zero or one offset columns, and place decorations after exactly one separating space to the right of that canvas. A two-character decoration fits fourteen columns at offset one. The caption is outside frame bounds.

### Deterministic choices where the source leaves freedom

Defaults are eye pattern as named, pose 0, offset 0 and no extras; sad frames other than its third use pose 0, sleepy and dizzy use pose 0. Startled ! and !! appear on line 0. For celebrating frame index f (0..3), place + on line f, * on line (f+1) modulo 4 and . on line (f+2) modulo 4. Each decoration occupies its own line, one space right of the sprite. Their colours are respectively 229, 213 and 117. Dizzy * uses sparkle colour 213. This makes all four celebration frames and last-frame documentation reproducible within the stated bounds.

Keep existing per-transition delays where applicable: happy 200 ms, angry 150, celebrating 150, content 400, sleepy 250, sad 300, startled 200 and dizzy 200. New frame counts are 4,5,4,3,3,4,3,4 respectively; waits total 600,600,450,800,500,900,400,600 ms. No wait follows the last frame.

### Terminal lifecycle and API

Retain exactly one runtime export, playMascot(mood, caption, options?), all eight existing mood names and type exports. Preserve options stream, isTTY, env, wait and signal with their current types and defaults. Default output remains stderr. Unknown moods, non-TTY output, OUTCOME_RUNNER_MASCOT=0 and an already aborted signal produce nothing.

Use four-line cursor-up redraw and clear every line on each redraw to erase old offsets and longer decorations. Keep the last frame, then the sanitized caption on its own line. TERM=dumb skips animation, waits and cursor controls and emits the last frame plus caption; NO_COLOR still applies.

Preserve try/finally restoration: mark hide attempted before writing it and always attempt show afterwards, even if hide, frame, caption, timer or restoration writes fail. Stop after abort/failure, suppress an unfinished caption and resolve the promise. Preserve fully injected, sleep-free operation.

## Validation Plan for the Implementation Session

Use the public function with an in-memory stream and fake timer. Decode ANSI half blocks to independent pixel/colour assertions against literal expected matrices and eye patterns, rather than deriving expected values from implementation tables. Keep all helpers private; do not change the runtime export surface for tests.

Cover both leg poses, all nine eye patterns on both sides, cheeks and each tear position, every frame of every mood in exact order, the four packing cases and both ANSI colour channels. Check NO_COLOR with empty and nonempty values, all frame bounds including offsets and extras, and independent NO_COLOR last-frame fixtures. Retain default stderr, injection, disabled/non-TTY, TERM=dumb, caption, timing, redraw, abort and throwing/rejecting dependency tests, including failed hide and failed show writes.

Update README previews from verified last-frame fixtures and describe provenance, dimensions, palette and NO_COLOR behaviour. Later run npm run typecheck and npm test, retaining existing 85% line/branch/function thresholds. No checks or product changes run in this planning session.

## Risks and Trade-offs

Mirroring and row pairing can silently invert eye expressions; literal pixel tests resolve this. Background SGR can leak into spaces; explicit resets and channel-aware tests resolve it. The old same-glyph NO_COLOR and distinct-mouth tests conflict with the approved art and must be replaced, while unrelated OR-10 assertions stay. Standard terminal single-column block and decoration glyph widths are assumed, consistent with the existing Unicode terminal design.
