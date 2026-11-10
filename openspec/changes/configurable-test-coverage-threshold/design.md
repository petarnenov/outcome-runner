# Design: configurable test coverage threshold

## Existing Behavior

`src/model.ts` defines invocation configuration and validates fixed command/argument arrays. `src/cli.ts` parses equals-form selection flags, overlays JSON and maps startup failures to exit code 4 with private diagnostics. `src/runner.ts` resolves selection before allocating locks, hashes configuration for durable ownership and RunStore identity, expands check arguments and builds every worker session prompt. `src/run-store.ts` compares canonical invocation hashes on restart.

## Resolution and Validation

Add optional numeric `coverage` to RunConfig and make it required on the fully resolved runner configuration. Resolve once, before allocation or identity hashing: CLI override, then JSON value, then 85. Direct runQueue callers must receive the same default and runtime validation as CLI callers; TypeScript annotations alone do not validate JSON.

Extend CLI parsing with `--coverage=<n>`, preserving arbitrary flag order, at-most-once flags, nonempty values and unknown-argument rejection. Parse the complete numeric value without truncation or partial parsing. Reject nonnumeric, nonfinite, fractional and out-of-range values; do not coerce JSON strings into numbers. Apply the override before effective configuration validation, as with existing selection flags. An invalid supplied CLI value cannot fall back to JSON or 85.

After existing check-shape validation, require at least one argument in project.checks to contain the exact substring `{coverage}`. A placeholder only in planningCheck, setup or the command executable does not qualify. Missing gates must produce private diagnostics saying `A coverage gate check is required`. Both threshold and gate failures propagate through the existing exit-code-4 startup error path before any lock, claim or worktree allocation.

## Frozen Identity

Use the resolved numeric coverage in the same configuration object used for ownership and durable RunStore hashing. Do not retain CLI spelling or input-source metadata in identity. Omitted coverage and explicit 85 therefore identify the same threshold; changing the resolved threshold refuses restart through existing incompatibility handling. Preserve saved state and ownership on refusal. Do not silently migrate legacy state whose frozen identity lacks coverage; use existing incompatible-state behavior.

## Check Expansion

Extend the existing shared argument substitution with `replaceAll('{coverage}', String(config.coverage))`. Retain change, target and scope substitution and executable/argument-array execution. Replace embedded and repeated occurrences, including `--test-coverage-lines={coverage}`. The shared helper covers worker-requested checks, acceptance checks and final reruns, so each consumes the same frozen threshold. Existing consumers of that helper continue to share substitution behavior; only project.checks satisfy the mandatory gate.

## Worker Prompts

Place a line such as `Resolved coverage threshold: 90%.` in the common session instruction prefix. This covers investigation, planning, planning review, implementation, implementation review and retry/recovery sessions for either harness without duplicating text in each stage.

## Tests and Fixtures

Extend CLI tests for default 85, JSON selection, CLI precedence, boundaries 1 and 100, duplicate/empty flags and rejection of 0, 101, 85.5 and nonnumeric values. Verify JSON strings are rejected when effective and direct runner calls validate coverage. Startup failures must assert exit code 4, private diagnostic content and lack of allocation.

Update existing valid runner fixtures within test/ with a deterministic executable coverage-gate argument. The mandatory gate otherwise causes unrelated tests to fail before their intended path. Preserve test intent; do not edit package.json or weaken npm test coverage settings.

Exercise actual check argument expansion with a nondefault threshold and capture the executed argument and persisted check record, including embedded/repeated placeholders alongside existing placeholders. Test that planning/setup/command-only placeholders do not satisfy the project.checks gate. Capture prompts across worker purposes and retries to assert the resolved percentage. Reuse restart fixtures to show changed coverage refuses without mutating saved state, while omitted versus explicit 85 resumes compatibly.

## Documentation and Validation

Update README invocation JSON with optional coverage and a real gate, for example command `node` with args `["--test", "--experimental-test-coverage", "--test-coverage-lines={coverage}", "{scope}/*.test.mjs"]`. Document default, integer range, CLI override, required gate, exit code 4 and frozen restart identity. Keep the description of this repository's fixed npm test thresholds accurate.

After binding, run `npm run typecheck` and `npm test`, plus frozen project checks through the controller. This planning session does not execute checks or write product files.

## Tradeoffs

A literal placeholder proves configuration intent, not the effectiveness of arbitrary commands; owners remain responsible for selecting an enforcing gate. Requiring the gate intentionally rejects older invocation files without it. Strict identity comparison protects unfinished work rather than guessing a threshold for legacy state.
