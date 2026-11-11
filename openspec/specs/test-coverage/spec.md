# test-coverage Specification

## Purpose
Freeze an invocation-wide test coverage threshold that every project check enforces and every worker is told about.

## Requirements

### Requirement: Resolve a validated invocation coverage threshold

The system SHALL accept an optional JSON numeric integer field `coverage` and CLI flag `--coverage=<n>`. The resolved threshold SHALL be the CLI value when supplied, otherwise the JSON value when supplied, otherwise 85. The effective threshold SHALL be an integer from 1 through 100 inclusive. Invalid effective values SHALL refuse the run with exit code 4 and private diagnostics before any lock, claim or worktree allocation. Direct runner calls SHALL use the same default and validation.

#### Scenario: Default threshold

- **WHEN** neither JSON nor CLI supplies coverage
- **THEN** the resolved coverage threshold is the number 85

#### Scenario: JSON threshold

- **WHEN** JSON supplies `"coverage": 90` and no CLI coverage is supplied
- **THEN** the resolved coverage threshold is 90

#### Scenario: CLI overrides JSON

- **WHEN** JSON supplies `"coverage": 90` and the CLI supplies `--coverage=95`
- **THEN** the resolved coverage threshold is 95

#### Scenario: Inclusive boundaries

- **WHEN** an effective JSON or CLI threshold is 1 or 100
- **THEN** the threshold is accepted

#### Scenario: Invalid thresholds

- **WHEN** the effective JSON value is 0, 101, 85.5 or a nonnumeric value, or the CLI supplies `--coverage=0`, `--coverage=101`, `--coverage=85.5` or `--coverage=abc`
- **THEN** the run is refused with exit code 4 and private diagnostics identifying invalid coverage
- **AND** no lock, claim or worktree is allocated

#### Scenario: JSON values are not coerced

- **WHEN** the effective JSON coverage is a string such as `"90"`, null or a boolean
- **THEN** the run is refused with exit code 4 rather than coercing or defaulting the value

#### Scenario: CLI syntax follows selection flags

- **WHEN** coverage is supplied once in equals form alongside harness, model and effort flags in any order
- **THEN** it is parsed and overrides the JSON coverage
- **AND** duplicate coverage flags, an empty coverage flag or a malformed numeric value are refused with exit code 4

### Requirement: Require a configured coverage gate before allocation

The system SHALL require at least one argument in `project.checks` to contain the literal placeholder `{coverage}`. If none does, the run SHALL be refused before allocation with exit code 4 and private diagnostics stating that a coverage gate check is required.

#### Scenario: Missing coverage gate

- **WHEN** no project.checks argument contains `{coverage}`
- **THEN** the run exits with code 4
- **AND** the diagnostics message says `A coverage gate check is required`
- **AND** no lock, claim or worktree is allocated

#### Scenario: Placeholder outside result check arguments

- **WHEN** `{coverage}` occurs only in planningCheck, setup or a command executable
- **THEN** the run is refused as lacking a coverage gate check

#### Scenario: Embedded placeholder satisfies configuration requirement

- **WHEN** a project.checks argument is `--test-coverage-lines={coverage}`
- **THEN** that check satisfies the required coverage gate configuration

### Requirement: Freeze the resolved threshold in invocation identity

The system SHALL include the resolved numeric threshold in frozen invocation identity, like harness, model and effort. Restart with a different resolved threshold SHALL be refused as incompatible without changing saved invocation state or ownership.

#### Scenario: Changed threshold on restart

- **WHEN** an invocation frozen with coverage 85 is restarted against the same state with resolved coverage 90
- **THEN** the restart is refused with exit code 4 through existing incompatibility handling
- **AND** saved invocation state and ownership are unchanged

#### Scenario: Equivalent resolved thresholds

- **WHEN** an invocation started without coverage is restarted with explicit JSON or CLI coverage 85 and otherwise identical configuration
- **THEN** coverage does not cause an identity mismatch

### Requirement: Substitute coverage in check arguments

The runner SHALL replace every literal `{coverage}` occurrence in project check arguments with the resolved threshold in decimal form. Expansion SHALL preserve existing `{change}`, `{target}` and `{scope}` substitutions and fixed executable/argument-array execution. All executions of frozen project checks SHALL use the same resolved value.

#### Scenario: Enforcing Node coverage argument

- **WHEN** coverage resolves to 92 and a check contains `--test-coverage-lines={coverage}`
- **THEN** the executed argument is `--test-coverage-lines=92`
- **AND** the check record stores that expanded argument

#### Scenario: Multiple occurrences and existing placeholders

- **WHEN** check arguments contain repeated `{coverage}` occurrences and change, target or scope placeholders
- **THEN** all coverage occurrences are replaced with the resolved threshold
- **AND** existing placeholders continue to resolve to their established values

#### Scenario: Repeated check execution

- **WHEN** worker-requested checks, acceptance checks or final checks run for an invocation with coverage 90
- **THEN** each execution expands `{coverage}` to 90

### Requirement: State coverage in every worker prompt

Every worker prompt SHALL state the resolved coverage threshold as a percentage, for both harnesses and all worker purposes, including retries and resumed work.

#### Scenario: Worker purposes share the threshold

- **WHEN** investigation, planning, planning review, implementation or implementation review starts with resolved coverage 90
- **THEN** each worker prompt explicitly states `90%`

#### Scenario: Retry or recovery

- **WHEN** a worker is retried or work resumes under an unchanged frozen invocation
- **THEN** the worker prompt states the same frozen coverage percentage

### Requirement: Document and verify coverage configuration

README SHALL document JSON `coverage`, CLI `--coverage=<n>`, default 85, integer range 1–100, CLI precedence, frozen restart identity and mandatory `{coverage}` check arguments. Its invocation example SHALL contain an enforcing coverage check. Automated tests SHALL cover the preceding resolution, validation, substitution, missing-gate and changed-restart scenarios. `npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Usable invocation example

- **WHEN** a reader follows the README invocation example
- **THEN** project.checks includes a coverage-enforcing command such as `node --test --experimental-test-coverage --test-coverage-lines={coverage}`
- **AND** the documentation explains how to configure or override the threshold

#### Scenario: Implementation validation

- **WHEN** the bound change is implemented and verified
- **THEN** tests cover default 85, JSON coverage, CLI override, rejection of 0, 101, 85.5 and nonnumeric values, check substitution, missing-gate refusal and changed-threshold restart refusal
- **AND** npm run typecheck and npm test pass
