# Tasks

## 1. Implementation (after specification binding)
- [x] Add .gitguardian.yaml with the exact canonical version-2 document in design.md: one descriptive /etc/passwd fixture entry and no other keys or exclusions.
- [x] Add docs/secret-scanning.md covering the rationale, configuration location, reviewed pull-request workflow, literal-match scope, and updates to the one-entry contract when a future exception is proposed.
- [x] Keep changes within .gitguardian.yaml, scripts, and docs; do not alter product code, test fixtures, dependencies, or workflows.

## 2. Tests — easiest first (E to A)
Complexity scale: E easiest, then D, C, B, and A most complex. Each planned automated test below is classified and traced to its obligation.

- [x] **E (required)** — In scripts/secret-scan-config.test.ts, read the actual root .gitguardian.yaml and compare the complete normalized document with the independent canonical expectation. Assert version 2, only version/secret root keys, only ignored_matches under secret, exactly one entry, a name describing the /etc/passwd test fixture, literal match /etc/passwd, and no paths-ignore or other exclusion. Whole-document comparison must fail for any extra content. Covers source criteria 1–2 and spec scenarios “Single fixture exception” and “Offline contract verification.”

No D, C, B, or A tests are planned; no coverage-only tests are initially needed. Work sessions implement tests grade by grade beginning with E until the 85% coverage gate passes. All (required) tests are always written even if the gate already passes. If a coverage shortfall requires additional tests, classify them (coverage-only), assign a complexity grade, and preserve E-to-A order before implementation.

## 3. Verification and Documentation Review (after binding)
- [x] Run frozen project checks through run_checks and read all pages of context checks output; record outcomes and the 85% coverage result.
- [x] Review docs/secret-scanning.md against source criterion 3 and the “Reviewed future false positive” scenario: review rationale, minimal literal entry, coordinated contract/test update, and no dashboard-only dismissal or path exclusions.
- [x] Inspect the final diff for scope compliance and the absence of unintended exclusions.
- [x] Use only local contract evidence; do not require external documentation, network access, or hosted scanner execution.

## 4. Planning Handoff
- [x] Create proposal.md, design.md, tasks.md, and specs/secret-scan-config/spec.md.
- [x] Defer product writes and run_checks to the later bound work session.

## Work Verification

Implemented the required grade-E test and ran frozen checks after that grade. Typecheck passed. The test suite passed: 479 tests, 473 passed, 6 skipped, 0 failed. Overall coverage: lines 99.09%, branches 94.63%, functions 95.00%; all exceed the 85% gate. No harder grades or coverage-only tests were planned or needed.

Read the complete checks context (nextOffset null). Reviewed the product diff and documentation against all three scenarios: exact single literal exception, offline whole-document verification, and reviewed future false positives. Product changes are limited to .gitguardian.yaml, scripts/secret-scan-config.test.ts, and docs/secret-scanning.md. Bound proposal, design, and specification remain unchanged. No applicable AGENTS.md was present. Evidence is local only; no hosted scanner or external documentation was used.
