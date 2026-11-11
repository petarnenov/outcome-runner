# Configurable test coverage threshold

## Why

OR-2 requires an invocation-wide coverage threshold that project checks enforce. Currently invocation configuration and CLI flags select a harness, model and effort, while check arguments substitute only change, target and scope. No coverage value is frozen or communicated to workers, and a project can omit a coverage gate.

## What Changes

- Accept optional JSON `coverage` and CLI `--coverage=<n>`; resolve CLI over JSON over default 85, requiring an integer from 1 through 100.
- Reject invalid coverage and project checks lacking an argument containing literal `{coverage}` before allocation, with exit code 4 and private diagnostics.
- Freeze the resolved numeric threshold with invocation identity and refuse incompatible restarts.
- Substitute every `{coverage}` occurrence in check arguments and state the threshold as a percentage in every worker prompt.
- Add focused regression coverage and document configuration, precedence, restart behavior and an enforcing invocation example.

## Impact and Scope

Depends on accepted OR-1 (selectable harness, model and effort). Future implementation is limited to `src`, `test` and `README.md`. This session creates only proposal, design, task and capability specification artifacts.

Reuse existing command arrays, private diagnostics, preallocation validation, identity hashing and prompt construction. No changes to harness catalogs, allocation policy, package scripts or coverage tooling are required. Presence of the placeholder establishes a configured gate; the runner does not inspect command semantics or invent a coverage command.

## Acceptance

The capability delta specifies all OR-2 behavior and regression cases. Implementation acceptance requires `npm run typecheck` and `npm test` to pass after specification binding.
