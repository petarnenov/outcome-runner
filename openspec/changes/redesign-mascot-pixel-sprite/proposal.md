# Pixel mascot redesign approved by the owner

## Why

OR-15 replaces the OR-10 pebble artwork with the pixel sprite approved by the owner on 2026-11-11, derived from the owner's reference image: antennae, a wide body, two eye slots and X-shaped legs. OR-10 is the prerequisite and its terminal safety and public API remain in force.

## What Changes

- Replace the art with the exact 11 by 8 pixel matrix, mirrored 2 by 2 eye patterns, two leg poses, palette and ordered mood frames specified in the terminal-mascot delta.
- Render two pixel rows per terminal line using ANSI 256 foreground/background colours and half blocks; provide the specified NO_COLOR silhouette.
- Limit every frame, including offsets and decorations, to four lines and fourteen columns.
- Extend mascot tests for exact pixels, colours, mirroring, rendering and animation sequences while retaining OR-10 regression coverage.
- Replace all eight README previews with the actual NO_COLOR last frames and credit the owner's reference sprite.

## Capabilities

### Modified Capabilities

- `terminal-mascot`: replace the artwork, mood definitions, colour rendering, size limits, preview requirements and related tests. The delta explicitly supersedes the earlier ASCII mouth/distinct-face and same-glyph NO_COLOR requirements.

## Impact

Future implementation is limited to `mascot/mascot.ts`, `mascot/mascot.test.ts` and `mascot/README.md`. No CLI integration, dependencies, export changes, option changes or unrelated project changes are required. Existing TypeScript and coverage gates continue to apply.

## Session Boundary

This session creates only proposal.md, design.md, tasks.md and specs/terminal-mascot/spec.md under this change directory. Specification binding, product edits and frozen project checks belong to a later session. Their deferral is expected, not a blocker. No private findings were supplied.
