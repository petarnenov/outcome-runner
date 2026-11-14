## ADDED Requirements

### Requirement: Exhaustive review instruction

Every planning review, implementation review and documentation review prompt SHALL tell the reviewer to report every
finding it can find in this round, not only the first ones, and to report accepted only with zero findings. The
implementation and documentation reviews of an integration SHALL carry the same instruction.

#### Scenario: Instruction in the three review prompts

- **WHEN** a task runs through one planning review, one implementation review and one documentation review with
  scripted adapters
- **THEN** each of the three review prompts contains `Report every finding you can find in this round, not only the
  first ones` and `report accepted only with zero findings`

#### Scenario: Instruction in the prompt builders

- **WHEN** the planning, implementation and documentation review prompts are built without earlier reviews
- **THEN** each contains the exhaustive review instruction

### Requirement: Earlier findings in later review rounds

From the second review round of the planning, implementation or documentation stage, the review prompt SHALL list the
findings of the earlier recorded review rounds of that stage for the task, in recorded order with their round
numbers, and SHALL tell the reviewer to check first that each of them was resolved. The prompt SHALL allow the
reviewer to report new findings. The first review round of a stage SHALL NOT list earlier findings.

#### Scenario: First round has no earlier findings

- **WHEN** the first planning review of a task starts
- **THEN** its prompt does not contain `Findings reported by the earlier review rounds of this stage`

#### Scenario: Second round lists the earlier findings

- **WHEN** the first planning review, the first implementation review and the first documentation review each
  return changes-required with one finding, and the second review of each stage starts
- **THEN** each second review prompt contains `Findings reported by the earlier review rounds of this stage`, the
  finding of the first review of the same stage with round 1, the instruction to check first that each of them was
  resolved and the permission to report new findings, and contains no finding of another stage

#### Scenario: Earlier findings text

- **WHEN** the earlier findings text is built from two reviews with findings `["a"]` and `["b", "c"]`
- **THEN** it lists `[{"round":1,"findings":["a"]},{"round":2,"findings":["b","c"]}]`, and built from no review it
  is empty
