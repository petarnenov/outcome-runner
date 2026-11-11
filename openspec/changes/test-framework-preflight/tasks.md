# Tasks: Harness-analysed test framework preflight

## 1. Implementation

- [ ] 1.1 Add `src/test-framework-preflight.ts` with `TestFrameworkDeps`, defaults
      (TTY rule, stderr prompts, shell-free `exec`, `writeFile`, status and
      content `snapshot`, temporary detached worktree add/remove) and
      `testFrameworkPreflight`.
- [ ] 1.2 Implement the read-only analysis session: tracked-file read scopes,
      refusing store, `read_file` and `context` paths only, `write_file`,
      `run_checks` and other operations refused, `test_framework_report` tool,
      prompt with the resolved coverage threshold; remove the worktree in
      `finally`.
- [ ] 1.3 Implement report validation (technologies, kinds, tracked evidence,
      framework thresholds, 1–3 recommendations with single-line rationale,
      install arrays, file changes, thresholds equal to coverage) and the
      prepared rule.
- [ ] 1.4 Implement the interactive flow (summary, snapshot before setup,
      choice with first preselected or skip, path refusal, confirmation,
      installs without shell, file writes, changed files computed as new or
      changed snapshot entries plus written paths) and the non-interactive
      refusal; `say` the final message on stderr before throwing
      `PreflightError` with reasons `test-framework-missing` and
      `test-framework-prepared`; throw `test-framework-analysis-failed` on
      analysis failure.
- [ ] 1.5 Add optional `details` to `PreflightError` and write it in the
      `src/cli.ts` diagnostics file; add the new reasons to `safeFailure` in
      `src/statistics.ts`.
- [ ] 1.6 Wire `testFrameworkPreflight` into `runQueue` after `validateConfig`
      and before the lock, with `RunOptions.testFramework` and the resolved
      adapter factory; update existing runner tests to pass a scripted
      prepared analysis.
- [ ] 1.7 Document the analysis, choice and confirmation, thresholds, no commit
      or push, non-interactive behaviour and reasons in `README.md`.

## 2. Tests (graded, E to A)

Grades: A (most complex), B, C, D, E (easiest). All tests use scripted
adapters, answers, executors, snapshots and in-memory writes; none starts a
real harness, runs a package manager or uses a real TTY. Every test asserts
that the scripted worktree `remove` was called once for its `add`.

- [ ] 2.1 (E) (required) All technologies prepared: nothing asked, executed or
      written; preflight returns.
- [ ] 2.2 (E) (required) Non-interactive refusal with an unprepared technology:
      no ask/exec/write; reason `test-framework-missing`; details contain the
      report.
- [ ] 2.3 (E) (required) Analysis failure (probe not ready, session throws, no
      report) yields `test-framework-analysis-failed`.
- [ ] 2.4 (D) (required) Invalid reports are refused (missing technologies,
      untracked evidence, missing thresholds, 0 or 4 recommendations, missing
      rationale/install/changes, thresholds differing from coverage) and yield
      `test-framework-analysis-failed`.
- [ ] 2.5 (D) (required) Skip: answer `s`; nothing executed or written;
      `test-framework-missing` naming the technology, and the said stderr
      output names it too.
- [ ] 2.6 (D) (required) Declined confirmation: nothing executed or written;
      `test-framework-missing`.
- [ ] 2.7 (D) (required) Non-default coverage threshold 90 appears in the
      prompt, an 85 framework is unprepared and recommendation thresholds must
      equal 90.
- [ ] 2.8 (C) (required) One unprepared technology, empty answer selects the
      first recommendation, yes runs installs as argument arrays in the root
      without a shell and writes the file changes; reason
      `test-framework-prepared`; the said stderr output lists the changed
      files (written paths and paths the scripted snapshot shows the installs
      changed) to commit and push; no git commit or push.
- [ ] 2.9 (C) (required) Choosing a later recommendation (`2`) uses only its
      commands and changes.
- [ ] 2.10 (C) (required) Failing install command stops later commands and file
      changes; `test-framework-missing` naming the technology.
- [ ] 2.11 (C) (required) File change outside the repository, under `.git`, the
      queue, the receipts or the changes directory refuses the recommendation
      without confirmation; nothing executed or written.
- [ ] 2.12 (C) (required) Read-only session tools: `read_file` works on tracked
      files; `write_file`, `run_checks` and unknown operations are refused; only
      the broker and report tools are offered.
- [ ] 2.13 (C) (required) Pre-existing dirty files: the snapshot before setup
      already shows a modified file and an untracked `openspec/changes/...`
      directory that the setup does not touch; after a successful setup the
      said list and `details.changedFiles` exclude them, while a pre-existing
      dirty file whose content the install changes is listed.
- [ ] 2.14 (B) (required) Repository with two technologies: both printed with
      evidence and frameworks; one choice per unprepared technology; mixed
      outcome reports the remaining unprepared one.
- [ ] 2.15 (B) (required) CLI diagnostics: a `PreflightError` with the new
      reasons and `details` exits 4 and writes reason and details to the
      diagnostics file; `safeFailure` keeps the new reasons.
- [ ] 2.16 (A) (required) Default worktree and snapshot functions against a
      temporary git repository with a bare origin: detached at
      `origin/<target>`, outside the repository, and removed (directory and
      `git worktree list`) after success and after a failing session; the
      default snapshot changes value when a dirty file's content changes.
- [ ] 2.17 (A) (required) Runner ordering: analysis runs after selection with
      the resolved harness, model and effort and before the lock and claims; a
      failing analysis creates no lock, claim or task worktree.

## 3. Verification

- [ ] 3.1 `npm run typecheck` passes.
- [ ] 3.2 `npm test` passes at the resolved coverage threshold.
