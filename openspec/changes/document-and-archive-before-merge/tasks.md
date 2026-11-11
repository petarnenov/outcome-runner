# Tasks

## 1. Model and configuration

- [ ] 1.1 Add stages `document`, `document-review`, `final-checks`, `archive` to `Stage`; add documentation purposes; add `Work` fields `documentation`, `documentationReviews`, `documentationChecks`, `archive`.
- [ ] 1.2 Add optional `Project.archive: CommandSpec`, validated as an argument array; default `openspec archive {change} --yes`.

## 2. Runner stages

- [ ] 2.1 After accepted implementation review move to `document` instead of `receipt`; persist every transition before side effects.
- [ ] 2.2 Documentation session with selected harness; write scope = documentation files (README*, *.md/*.mdx, docs/doc directories) inside task scopes; capture out-of-scope documentation findings.
- [ ] 2.3 Independent documentation review, max 4 rounds, accept only with zero findings, block `Documentation review remains unresolved`.
- [ ] 2.4 Re-run project checks after acceptance; failures block.
- [ ] 2.5 Archive stage: substitute `{change}`, run without shell in the worktree through the injectable command runner, bounded failure output on non-zero exit; detect archived directory; record archive-written `openspec/specs` files; idempotent resume (never run twice).
- [ ] 2.6 Re-key binding to archived paths and verify hashes; block `Archived specification differs from binding`; later integrity checks use archived paths.
- [ ] 2.7 Manifest allow-list: scopes ∪ archived change directory ∪ archive spec files.
- [ ] 2.8 Receipt records archived spec paths; validation accepts archived and unarchived paths.
- [ ] 2.9 Target-advance conflict detection includes archive spec files and archived directory.
- [ ] 2.10 PR body: `Documentation updated`, `Archived change`, `Documentation outside scope`.

## 3. README

- [ ] 3.1 Document new stages, the `archive` command and default, archive location `<changes>/archive/<YYYY-MM-DD>-<change>` and spec updates in `openspec/specs`.

## 4. Tests (graded, easiest first: E -> A)

All use scripted adapters, Git fixtures and a scripted archive command (captured through a scripted command runner; the real `openspec` is never executed).

- [ ] 4.1 (E) (required) Config validation: default archive command value `openspec archive {change} --yes` and rejection of a non-array `archive` command.
- [ ] 4.2 (E) (coverage-only) Documentation path classifier: README, `.md`, `docs/` accepted; source files rejected.
- [ ] 4.3 (D) (required) Receipt validation accepts archived specification paths and an existing receipt with unarchived paths.
- [ ] 4.4 (D) (required) Manifest accepts scope, archived change and archive spec paths; rejects any other path.
- [ ] 4.5 (D) (required) PR body lists updated documentation files and the archived change directory.
- [ ] 4.6 (C) (required) Default archive command invocation: with no project `archive` command, the scripted command runner captures command `openspec` with argument array `['archive', '<change>', '--yes']` (`{change}` substituted with the task change name), `cwd` equal to the task worktree, and no shell.
- [ ] 4.7 (C) (required) Documentation written only inside the scopes; out-of-scope and non-documentation writes refused.
- [ ] 4.8 (C) (required) Documentation outside scope reported in the PR body under `Documentation outside scope`.
- [ ] 4.9 (C) (required) Failing archive command blocks with bounded output.
- [ ] 4.10 (B) (required) Stage order persisted in run state: after accepted implementation review the persisted stage sequence is `document`, `document-review`, `final-checks`, `archive`, `receipt`, `publish`, `pr`, `merge`; a restart while in `document-review` resumes without re-running the documentation session, and a restart while in `final-checks` resumes without re-running the documentation review.
- [ ] 4.11 (B) (required) Documentation review needing a second round then accepted.
- [ ] 4.12 (B) (required) Unresolved documentation review after 4 rounds blocks with `Documentation review remains unresolved`.
- [ ] 4.13 (B) (required) Checks re-run after documentation; a failing re-run blocks before archive.
- [ ] 4.14 (B) (required) Archive relocation to `<changes>/archive/<YYYY-MM-DD>-<change>` and spec update in `openspec/specs`.
- [ ] 4.15 (B) (required) Re-keyed binding after archive, and hash mismatch blocks with `Archived specification differs from binding`.
- [ ] 4.16 (A) (required) Restart between archive and receipt resumes without archiving again.
- [ ] 4.17 (A) (required) Target advance changing the same `openspec/specs` file blocks the task.

## 5. Verification after binding

- [ ] 5.1 Run `npm run typecheck`.
- [ ] 5.2 Run `npm test` with coverage gate 85%.
- [ ] 5.3 Run frozen project checks and inspect output.
