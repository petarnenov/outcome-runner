## ADDED Requirements

### Requirement: Persisted stage order after implementation review

After the implementation review is accepted, the runner SHALL execute the stages documentation, documentation review, project checks, archive, receipt, publish, pull request and merge in that order. Each stage SHALL be saved in the run state and SHALL resume after a restart without repeating a completed step. The archive command SHALL never run twice for a task.

#### Scenario: Stage order

- **WHEN** the implementation review of a task is accepted
- **THEN** the run state advances through document, document-review, final checks, archive, receipt, publish, pr and merge in that order

#### Scenario: Restart between archive and receipt

- **WHEN** the runner stops after the archive completed and before the receipt was written, and is restarted
- **THEN** it resumes at the receipt stage
- **AND** the archive command is not invoked again

### Requirement: Documentation stage limited to documentation in scope

A worker session with the selected harness SHALL update documentation files inside the task scopes (README files, Markdown files, documentation directories such as docs) to match the implemented behaviour and criteria. It SHALL be able to write only documentation files inside the task scopes. Documentation outside the scopes that needs changes SHALL be reported as findings and listed in the pull request body under `Documentation outside scope`.

#### Scenario: Documentation written inside scope

- **WHEN** the documentation worker updates `README.md` in scope and attempts to write a non-documentation source file or a file outside the scopes
- **THEN** the README change is kept
- **AND** the other writes are refused

#### Scenario: Documentation outside scope reported

- **WHEN** the documentation worker reports that `docs/guide.md` outside the task scopes needs updating
- **THEN** the pull request body contains a `Documentation outside scope` section listing `docs/guide.md`

### Requirement: Independent documentation review

An independent review session SHALL check documentation changes against the implementation, criteria and scope and SHALL accept only with zero findings. At most 4 rounds SHALL be allowed; when unresolved the task SHALL be blocked with `Documentation review remains unresolved`. After acceptance the project checks SHALL run again and must pass.

#### Scenario: Second round accepted

- **WHEN** the first documentation review returns findings and the second returns accepted with zero findings
- **THEN** the documentation worker runs a second round with the findings and the task proceeds to project checks

#### Scenario: Unresolved review

- **WHEN** four documentation review rounds end without acceptance
- **THEN** the task is blocked with `Documentation review remains unresolved`

#### Scenario: Checks re-run after documentation

- **WHEN** the documentation review is accepted
- **THEN** the project checks run again before the archive
- **AND** a failing check blocks the task without archiving

### Requirement: Archive the OpenSpec change

The runner SHALL archive the change with the optional project command `archive`, run as an argument array in the worktree with the `{change}` placeholder substituted, defaulting to `openspec archive {change} --yes`. The archive SHALL move the change directory to `<changes>/archive/<YYYY-MM-DD>-<change>` and apply spec deltas to `openspec/specs`. A failing archive command SHALL block the task with its bounded failure output.

#### Scenario: Archive relocation and spec update

- **WHEN** the scripted archive command succeeds
- **THEN** the change directory exists at `<changes>/archive/<YYYY-MM-DD>-<change>` and not at its original path
- **AND** the updated `openspec/specs` files are recorded and committed

#### Scenario: Default archive command

- **WHEN** the project defines no `archive` command
- **THEN** the runner executes `openspec archive <change> --yes` in the worktree

#### Scenario: Failing archive

- **WHEN** the archive command exits non-zero
- **THEN** the task is blocked with its bounded failure output

### Requirement: Re-keyed specification binding

After the archive each bound path SHALL be re-keyed to its archived path and the runner SHALL verify every bound file exists there with the same hash; otherwise the task SHALL be blocked with `Archived specification differs from binding`. Later integrity checks SHALL use the archived paths.

#### Scenario: Binding re-keyed

- **WHEN** the archive relocates unchanged bound files
- **THEN** the binding contains only archived paths with the original hashes

#### Scenario: Hash mismatch after archive

- **WHEN** the archive alters or omits a bound file
- **THEN** the task is blocked with `Archived specification differs from binding`

### Requirement: Manifest and receipt accept archive outputs

The result manifest SHALL accept paths inside the task scopes, the archived change directory and the `openspec/specs` files written by the archive; any other path SHALL still block the task. The receipt SHALL record archived specification paths and receipt validation SHALL accept them. Existing receipts referencing unarchived paths SHALL stay valid.

#### Scenario: Manifest acceptance and rejection

- **WHEN** the result contains scope files, archived change files and archive-written spec files
- **THEN** the manifest is accepted
- **AND** a result that also contains any other path blocks the task

#### Scenario: Receipt validation

- **WHEN** a receipt references archived specification paths, or an existing receipt references unarchived paths
- **THEN** both receipts validate

### Requirement: Target changes to archive outputs block

When the target advances, a change of the target to the same `openspec/specs` files or to the archived change directory SHALL block the task like a change inside its scope.

#### Scenario: Target changes the same spec file

- **WHEN** the target advances with a change to an `openspec/specs` file the task's archive wrote
- **THEN** the task is blocked as for an in-scope target change

### Requirement: Pull request body and README

The pull request body SHALL list the updated documentation files and the archived change directory. README SHALL document the new stages, the archive command and its default, and where archived changes and updated specs end up.

#### Scenario: Pull request body

- **WHEN** the pull request is created
- **THEN** its body lists the updated documentation files and the archived change directory

### Requirement: Verification

Tests SHALL use scripted adapters, Git fixtures and a scripted archive command. `npm run typecheck` and `npm test` SHALL pass.

#### Scenario: Suite passes

- **WHEN** the implementation is verified
- **THEN** npm run typecheck and npm test pass
