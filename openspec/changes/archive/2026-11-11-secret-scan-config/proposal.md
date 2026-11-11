# OR-26: Secret scanning without false positives on test fixtures

## Why
The literal /etc/passwd used by a test fixture needs a reviewed, repository-controlled false-positive exception. Broad path exclusions would reduce scanning coverage, while dashboard-only dismissals do not record the decision alongside the code.

## What Changes
- Add root .gitguardian.yaml with version 2 and exactly one secret.ignored_matches entry describing the /etc/passwd test fixture and matching the literal /etc/passwd.
- Add a local contract test in scripts that checks the entire configuration shape, including the absence of every other exclusion.
- Document the review process for configuration-based false positives in docs/secret-scanning.md.

## Capabilities
### New Capabilities
- secret-scan-config: Narrow fixture exception, offline configuration contract verification, and documented review workflow.

## Impact
Future implementation touches only .gitguardian.yaml, scripts/secret-scan-config.test.ts, and docs/secret-scanning.md. Existing scripts/*.test.ts discovery already includes the planned test. No dependency, workflow, package, product, or fixture changes are needed. No external documentation, network access, or hosted scanner is part of acceptance evidence.

This session creates planning artifacts only. Implementation and frozen project checks occur in a later session after specification binding.

## Source Acceptance Criteria
1. A .gitguardian.yaml in the repository root has exactly this shape: version: 2, and secret.ignored_matches with a single entry whose name describes the /etc/passwd test fixture and whose match is the literal string /etc/passwd. It has no paths-ignore or other exclusions, so all product and test code stays scanned.
2. A test in scripts reads .gitguardian.yaml and checks the shape above: version 2, exactly one ignored_matches entry with match /etc/passwd, and no paths-ignore or other exclusion. The shape given here is the whole contract; no external documentation, hosted GitGuardian scanner or network access is needed or part of the evidence.
3. docs explain how to add a reviewed false positive to the configuration instead of marking it by hand in the dashboard.
