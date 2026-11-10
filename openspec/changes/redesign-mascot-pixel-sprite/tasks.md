# Tasks: OR-15

These are implementation tasks for the later session after specification binding. All are intentionally unchecked in this planning-only session.

## 1. Bind and confirm scope

- [ ] 1.1 Bind OR-15 to this proposal, design and terminal-mascot delta; retain dependency OR-10 and the owner's 2026-11-11 approval/provenance.
- [ ] 1.2 Confirm the product change is confined to mascot/mascot.ts, mascot/mascot.test.ts and mascot/README.md, with the existing exports, options and project gates preserved.

## 2. Implement the approved artwork

- [ ] 2.1 Replace pebble/ASCII art with the exact 11 by 8 matrix, both leg poses, nine eye patterns mirrored at the specified columns, cheeks and tear overlays.
- [ ] 2.2 Implement two-pixel-row half-block rendering with ANSI 256 foreground/background colours, empty-cell resets and NO_COLOR occupancy conversion.
- [ ] 2.3 Encode all eight mood colours and ordered frame sequences, offsets and decorations, including the deterministic celebration sparkle schedule from design.md.
- [ ] 2.4 Render four lines per frame, limit all frames to fourteen columns including offsets/decorations, and adapt cursor-up redraw to four lines with clearing.
- [ ] 2.5 Preserve stderr default, all options, TTY/disable gates, TERM=dumb last-frame output, captions, timing, abort behaviour, cursor restoration and the never-reject promise.

## 3. Verify behaviour

- [ ] 3.1 Add independent expected pixel fixtures for base rows, both legs, every eye pattern and its right-eye mirror, cheeks and tear positions.
- [ ] 3.2 Assert every mood's complete ordered frames, body and decoration palette, offsets, extras and timing using in-memory streams and fake waits.
- [ ] 3.3 Assert top-only, bottom-only, both and empty cells with exact foreground/background colours and no style leakage; verify NO_COLOR whites/tears disappear and remaining pixels are solid.
- [ ] 3.4 Assert four-line/fourteen-column bounds for every coloured and NO_COLOR frame including decorations and offsets.
- [ ] 3.5 Update superseded artwork assertions and retain OR-10 safety/API regression tests, including empty NO_COLOR, TERM=dumb, default stderr, full injection, caption sanitation, unknown moods, pre-abort, mid-animation abort, rejecting timers and failed hide/frame/show writes.

## 4. Document and run project gates

- [ ] 4.1 Replace all eight mascot/README.md previews with independently verified NO_COLOR last frames, credit the owner's reference sprite and update dimensions and rendering descriptions while retaining API/options documentation.
- [ ] 4.2 Run npm run typecheck and npm test after binding and implementation; confirm existing 85% line, branch and function coverage gates remain passing.
- [ ] 4.3 Review final diff against every OR-15 criterion and the delta, confirming no unrelated product or public API changes.
