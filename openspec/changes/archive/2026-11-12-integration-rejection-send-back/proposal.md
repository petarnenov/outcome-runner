# Proposal: Send a rejected integration back to the worker before blocking

## Why

When the target advances inside a running task's guarded paths, the runner merges it in the task worktree and runs the
`integrate` stage (OR-20, OR-27): setup and product checks, the implementation review and the documentation review of
the merged result. Today a clean merge whose checks fail, or whose review or documentation review does not accept it,
blocks the task at once with `target-integration-rejected`. Often the problem is small, for example a test that needs
a small update for the new target or a README line that needs to mention the merged change. The worker gets no chance
to fix it, so the owner has to step in for something the worker could have repaired.

## What Changes

- A clean integration (`integration.outcome` `clean`) that is not accepted by the checks, the implementation review
  or the documentation review gets **one** send-back session: an implementation session (`work` purpose) given the
  failed check output or the review findings. Its writable paths are limited to the task scopes. The OpenSpec change
  has already been archived at that point, so the change directory files are not writable, and only task scope paths
  are committed after the session.
- After the session the runner commits the result and runs the setup and product checks, the implementation review
  and the documentation review again. Only when all of them accept does the task go on to the receipt, publishing
  and merging. Otherwise the task is blocked with `target-integration-rejected`, and the last findings or check
  output are recorded.
- The send-back is durable. A new integration step `send-back` and a `sendBack` record on the integration entry are
  saved before each next effect. A restart resumes at the recorded step and never starts a second send-back session
  for the same integrated target commit.
- New step lines log the send-back, its session, its commit and its outcome.
- The README describes the send-back session and the `target-integration-rejected` reason in the integration
  section, and the stale sentences elsewhere (the budget section, the leftover-file paragraph, the restart paragraph
  and the step lines section) are updated to match.

Integrations with conflicts are unchanged. They already get one resolution session, and a later rejection still
blocks with `target-conflict-unresolved` and the conflicting paths.

## Capabilities

### New Capabilities

- `integration-rejection-send-back`: one durable worker session that repairs a rejected clean integration before
  the task can be blocked with `target-integration-rejected`.

### Modified Capabilities

- `target-scope-recovery`: the requirement "Rejected clean merge blocks" changes. A rejected clean merge no longer
  blocks at once; it blocks with `target-integration-rejected` only when the result is still rejected after the one
  send-back session.

## Impact

- `src/model.ts`: `IntegrationStep` gains `send-back`. `IntegrationRecord` gains an optional `sendBack` record, with
  the new types `SendBackCause` and `SendBackRecord`.
- `src/runner.ts`: the `integrate` stage loop (checks, review and document-review steps, the new send-back step), and
  an optional `writable` override on the internal `session` helper.
- `test/integration-send-back.test.ts` (new). `test/target-scope-recovery.test.ts`: the clean-rejection test (4.5)
  now expects one send-back session before the block, and the conflict review test (4.8) asserts no send-back
  session.
- `README.md`: the section `## When the target advances during a run` (send-back paragraph, blocker table entry,
  restart paragraph), the budget sentence in `### Review and check budgets`, the leftover-file sentence in
  `### Worktrees and cleanup`, and the step name list and integration sentence in `## Step lines`.
