# Proposal: Dispose of an invocation with one command

## Why

An invocation the owner no longer wants (a blocked task, an abandoned experiment, a changed plan) keeps its claims in
the `work-queue-claims-<target>` ledger, keeps its ownership file unreleased and keeps `state.json` saying it is
`blocked` or `incomplete`. Other invocations then wait on its claims (`waiting-for-claim`) and the same invocation file
cannot be changed (`Another durable invocation owns unfinished work in this repository`). Today the only way out is
editing the ownership JSON beside the primary checkout and committing to the claims branch by hand, which is easy to
get wrong and can damage another invocation's claims.

## What Changes

- New command `outcome-runner dispose <invocation file> [--remove-work]`.
- It resolves the invocation like a run (same root, target and state directory), refuses with exit code 4 when a
  process of that invocation is running (`invocation-running`) or when no matching invocation state exists
  (`unknown-invocation`).
- Otherwise it removes the invocation's claims of unaccepted tasks from the claims ledger with one commit naming the
  invocation, marks the invocation's ownership file released, records the disposed work in `state.json` and sets its
  `status` to `released`. Accepted tasks, their claims, receipts, `completed` entries and merged pull requests are not
  touched.
- Worktrees, local branches and remote branches of the unaccepted tasks are kept and listed by default; with
  `--remove-work` they are removed. Open pull requests of the invocation are listed and never merged.
- Dispose prints one JSON summary on stdout (released claims, ownership, kept or removed worktrees and branches, open
  pull requests) and exits 0. A second dispose is safe and reports `nothing-to-release`.
- A disposed invocation state is never resumed: running the same invocation file afterwards is refused with exit
  code 4 and reason `invocation-disposed`, so kept work is never picked up without a claim.
- README documents when and how to dispose of an invocation, replacing manual edits of ownership files or the
  claims branch.

## Capabilities

### New Capabilities

- `invocation-disposal`: the `dispose` command, its refusals, its summary and its isolation from other invocations.

## Impact

- New `src/dispose.ts`; `src/claims.ts` (claim release commit); `src/cli.ts` (`dispose` command); `src/runner.ts`
  (refusal of a disposed state).
- New tests in `test/` with Git fixtures (`test/support/runner-fixture.ts`).
- `README.md`.
