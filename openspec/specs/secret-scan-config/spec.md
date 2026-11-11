# secret-scan-config Specification

## Purpose
TBD - created by archiving change secret-scan-config. Update Purpose after archive.

## Requirements

### Requirement: Exact fixture exception configuration
The repository SHALL contain .gitguardian.yaml at its root. Its only root keys SHALL be version and secret. version SHALL be the number 2. secret SHALL contain only ignored_matches, a sequence of exactly one entry. That entry SHALL contain only name and match; name SHALL describe the /etc/passwd test fixture and match SHALL be the literal string /etc/passwd. The configuration SHALL contain no paths-ignore or any other exclusion, leaving all product and test paths scanned.

#### Scenario: Single fixture exception
- **WHEN** the repository configuration is inspected
- **THEN** it has version 2 and exactly one secret.ignored_matches entry with a descriptive /etc/passwd test-fixture name and literal match /etc/passwd
- **AND** it contains only the specified keys, with no paths-ignore or other exclusion

### Requirement: Local configuration contract test
A test in scripts SHALL read the actual repository-root .gitguardian.yaml and verify the complete shape required above. The supplied shape SHALL be the entire acceptance contract; evidence SHALL require no external documentation, network access, or hosted GitGuardian scanner.

#### Scenario: Offline contract verification
- **WHEN** the local configuration contract test runs
- **THEN** it reads .gitguardian.yaml and passes only when version, nesting, entry count, descriptive name, literal match, and absence of all other keys and exclusions satisfy the contract
- **AND** verification requires no network or hosted scanner

### Requirement: Reviewed false-positive workflow
Documentation in docs SHALL explain how to propose a reviewed false-positive exception in .gitguardian.yaml instead of marking it by hand in the dashboard. It SHALL describe documenting the rationale, choosing a minimal literal match, submitting the configuration for review, and coordinating specification and test updates if the current single-entry contract changes.

#### Scenario: Reviewed future false positive
- **WHEN** a contributor consults the documentation to address another suspected false positive
- **THEN** the instructions explain confirming that it is not a real secret, recording a descriptive name and rationale, and proposing the minimal literal match through a reviewed configuration change
- **AND** they explain updating the specification and contract test before expanding the current single-entry configuration
- **AND** they direct contributors away from dashboard-only dismissal and path exclusions
