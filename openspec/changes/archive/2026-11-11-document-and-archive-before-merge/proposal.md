# Proposal: Update documentation and archive the OpenSpec change before merge

## Why

Tasks currently move from an accepted implementation review straight to receipt, publish, pull request and merge. Documentation can drift from the implemented behaviour, and accepted OpenSpec changes stay in `openspec/changes/` instead of being archived and folded into `openspec/specs`. Both must happen inside the task's own branch, before the pull request, so that what is merged is documented, reviewed, checked and archived.

## What Changes

- New task stages after an accepted implementation review: `document`, `document-review`, `final-checks`, `archive`; the full order becomes implementation review accepted, documentation, documentation review, project checks, archive, receipt, publish, pull request, merge. Every stage is persisted in the run state and resumes after restart without repeating completed work; the archive never runs twice.
- Documentation stage: a worker session with the selected harness updates documentation files (README files, `*.md` files and documentation directories such as `docs`) inside the task scopes only. Documentation outside the scopes needing change is reported as findings and listed in the pull request body under `Documentation outside scope`.
- Documentation review stage: an independent review session, at most 4 rounds, accepting only with zero findings; unresolved reviews block with `Documentation review remains unresolved`. Project checks run again afterwards and must pass.
- Archive stage: a new optional project command `archive` (argument array, run in the worktree, `{change}` placeholder) defaulting to `openspec archive {change} --yes`. It moves the change to `<changes>/archive/<YYYY-MM-DD>-<change>` and applies spec deltas to `openspec/specs`. A failing command blocks with bounded failure output.
- Specification binding is re-keyed to the archived paths and verified by hash; mismatch blocks with `Archived specification differs from binding`. Later integrity checks use archived paths.
- Result manifest accepts task-scope paths, the archived change directory and archive-written `openspec/specs` files; other paths still block. Receipts record archived specification paths; receipt validation accepts them and existing receipts with unarchived paths stay valid.
- Target-advance conflict detection treats changes to the same `openspec/specs` files or the archived change directory like in-scope changes.
- Pull request body lists updated documentation files and the archived change directory.
- README documents the new stages, the archive command and default, and where archived changes and specs end up.

## Impact

- Affected code: `src/model.ts` (stages, purposes, project `archive`, work fields), `src/runner.ts` (stages, manifest, binding, receipt, PR body, target conflicts), `src/run-store.ts` if state shape needs it, and adapters' prompt/write-scope handling for the documentation purpose.
- Tests in `test/` with scripted adapters, Git fixtures and a scripted archive command.
- `README.md`.
- Backward compatible: `archive` is optional; existing receipts remain valid.
