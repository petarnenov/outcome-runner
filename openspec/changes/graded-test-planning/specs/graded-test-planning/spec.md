## ADDED Requirements

### Requirement: Plan prompt requires graded tests listed from E to A

The plan session prompt SHALL require tasks.md to contain a test section in which every planned test has a
complexity grade from A (most complex) to E (easiest), and the tests are listed from E to A. The prompt SHALL require
each planned test to be marked `(required)` when a source criterion or spec scenario demands it, otherwise
`(coverage-only)`. The prompt SHALL state the resolved coverage threshold as a percentage.

#### Scenario: Plan prompt content

- **WHEN** a plan session starts with resolved coverage 90
- **THEN** its prompt requires a test section in tasks.md
- **AND** requires every planned test to have a grade from A (most complex) to E (easiest)
- **AND** requires the tests to be listed from E to A
- **AND** requires each test to be marked `(required)` or `(coverage-only)`
- **AND** states `90%`

#### Scenario: Replanning keeps the instructions

- **WHEN** a plan session is retried after planning review findings or a failed planning check
- **THEN** the retried prompt contains the same graded test instructions and the same percentage

### Requirement: Planning review enforces grades and order

The planning review prompt SHALL require the reviewer to report changes-required when a planned test lacks a grade,
the tests are not listed from E to A, or a test demanded by a source criterion or spec scenario is not marked
`(required)`. The prompt SHALL state the resolved coverage threshold as a percentage.

#### Scenario: Planning review prompt content

- **WHEN** the planning review session starts with resolved coverage 90
- **THEN** its prompt requires changes-required when a planned test lacks a grade
- **AND** requires changes-required when the tests are not listed from E to A
- **AND** requires changes-required when a criterion-demanded test is not marked `(required)`
- **AND** states `90%`

#### Scenario: Planning review does not receive implementation rules

- **WHEN** the planning review session starts
- **THEN** its prompt does not contain the implementation review coverage gate rule

### Requirement: Work prompt requires grade-by-grade tests up to the threshold

The work session prompt SHALL require writing tests grade by grade starting with E, calling run_checks after each
grade, and continuing with the next harder grade until the coverage gate passes at the resolved threshold, stated as
a percentage.

#### Scenario: Work prompt content

- **WHEN** a work session starts with resolved coverage 90
- **THEN** its prompt requires writing tests grade by grade starting with E
- **AND** requires calling run_checks after each grade
- **AND** requires continuing with the next harder grade until the coverage gate passes at `90%`

#### Scenario: Work retry keeps the instructions

- **WHEN** a work session is retried after failed checks or implementation review findings
- **THEN** the retried prompt contains the same graded test instructions and the same percentage

### Requirement: Work prompt keeps required tests mandatory

The work session prompt SHALL state that tests marked `(required)` are always written whatever the coverage, and
that only `(coverage-only)` tests stop at the threshold. It SHALL NOT contain an unqualified instruction to
implement all tests.

#### Scenario: Required tests precedence

- **WHEN** a work session starts
- **THEN** its prompt requires tests marked `(required)` to be written whatever the coverage
- **AND** limits the stop-at-threshold rule to `(coverage-only)` tests

#### Scenario: No unqualified all-tests instruction

- **WHEN** a work session starts
- **THEN** its prompt does not contain `Implement all approved OpenSpec scenarios and tests`
- **AND** it contains the instruction to implement all approved OpenSpec scenarios and every test marked `(required)`

### Requirement: Work prompt requires the not-needed note

The work session prompt SHALL require coverage-only grades left unwritten because the threshold was reached to stay
unchecked in tasks.md with the note `not needed: coverage reached`.

#### Scenario: Unwritten coverage-only grades

- **WHEN** a work session starts with resolved coverage 90
- **THEN** its prompt requires unwritten coverage-only grades to stay unchecked in tasks.md with the note
  `not needed: coverage reached`

### Requirement: Implementation review enforces the gate and grade order

The implementation review prompt SHALL require changes-required when the coverage gate did not pass at the resolved
threshold, when a harder grade was written while an easier planned grade is still unchecked without the note
`not needed: coverage reached`, or when a test marked `(required)` is unwritten or carries that note. The prompt
SHALL state the resolved coverage threshold as a percentage and SHALL keep the existing completion summary and
whole-task grade request.

#### Scenario: Implementation review prompt content

- **WHEN** the implementation review session starts with resolved coverage 90
- **THEN** its prompt requires changes-required when the coverage gate did not pass at `90%`
- **AND** requires changes-required when a harder grade was written while an easier planned grade is still
  unchecked without the note `not needed: coverage reached`
- **AND** requires changes-required when a `(required)` test is unwritten or marked `not needed: coverage reached`
- **AND** still requests completion.summary and completion.grade when reporting accepted

### Requirement: All prompts state the resolved threshold

Every worker prompt, including investigation and the four graded prompts, SHALL state the resolved coverage threshold
as a percentage taken from the frozen invocation.

#### Scenario: Default threshold

- **WHEN** coverage is not configured
- **THEN** every worker prompt states `85%`

#### Scenario: Non-default threshold

- **WHEN** coverage resolves to 90
- **THEN** every worker prompt states `90%` and none states `85%` as the threshold

### Requirement: README documents the graded workflow

README SHALL describe the graded test workflow: grades A (most complex) to E (easiest), the E-to-A test section in
tasks.md, the `(required)` and `(coverage-only)` marks, grade-by-grade writing with run_checks until the coverage
gate passes at the resolved threshold, the `not needed: coverage reached` note and the review rules.

#### Scenario: README content

- **WHEN** a reader opens README
- **THEN** it describes the A–E grades, the E-to-A order, the marks, grade-by-grade writing with run_checks, the
  `not needed: coverage reached` note and the planning and implementation review rules

### Requirement: Scripted tests verify the graded prompts

Tests SHALL assert the plan, planning review, work and implementation review prompts contain the graded instructions
and the resolved threshold using scripted adapters only. These tests are required and SHALL be written regardless of
coverage. `npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Scripted prompt verification

- **WHEN** the test suite runs
- **THEN** a scripted adapter captures the plan, planning review, work and implementation review prompts
- **AND** assertions cover each graded instruction and the resolved percentage
- **AND** no real harness is started

#### Scenario: Validation

- **WHEN** the bound change is implemented
- **THEN** npm run typecheck and npm test pass
