## ADDED Requirements

### Requirement: Single harness catalog

The system SHALL provide one module under `src/` that answers which models each
harness offers and which efforts each model supports. `src/harness.ts`,
`src/claude-adapter.ts` and `src/codex-adapter.ts` SHALL use this module and SHALL
NOT contain their own hard-coded model or effort checks.

#### Scenario: Claude catalog lookup

- **WHEN** the Claude catalog is requested
- **THEN** it contains exactly the models `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` and `claude-fable-5-2`
- **AND** each model supports exactly the efforts `low`, `medium`, `high`,
  `xhigh` and `max`

#### Scenario: Codex catalog follows pagination

- **WHEN** the Codex catalog is requested and `model/list` returns a first page
  with a `nextCursor` and a second page without one
- **THEN** `model/list` is called again with that cursor
- **AND** the catalog contains the models of both pages

#### Scenario: Codex catalog excludes hidden models

- **WHEN** `model/list` returns a model with `hidden: true`
- **THEN** that model is absent from the Codex catalog

#### Scenario: Codex efforts per model

- **WHEN** a Codex model lists `supportedReasoningEfforts` with `reasoningEffort`
  values `low` and `high`
- **THEN** the catalog reports exactly `low` and `high` for that model

#### Scenario: One Codex session for defaults and catalog

- **WHEN** a Codex run resolves its selection
- **THEN** exactly one app-server process is spawned
- **AND** both `config/read` and `model/list` are sent over that process
- **AND** that process is closed before allocation

### Requirement: Selection validated before allocation

The system SHALL refuse, before any lock, claim or worktree is taken, a model the
selected harness does not offer or an effort the selected model does not support.
The run SHALL exit with code 4 and the diagnostics message SHALL name the rejected
value.

#### Scenario: Unknown model

- **WHEN** a Claude run is started with model `claude-opus-4`
- **THEN** the run exits with code 4 without allocation
- **AND** the diagnostics message contains `claude-opus-4`

#### Scenario: Unsupported effort for model

- **WHEN** a Codex run selects a catalog model whose supported efforts do not
  include `xhigh` and effort `xhigh`
- **THEN** the run exits with code 4 without allocation
- **AND** the diagnostics message contains `xhigh`

#### Scenario: Unknown harness

- **WHEN** the harness is neither `claude` nor `codex`
- **THEN** the run exits with code 4 without allocation

### Requirement: Claude runs any catalog model and effort

The system SHALL accept any model and effort pair present in the Claude catalog,
SHALL pass it as `claude --model <id> --effort <level>`, and SHALL keep verifying
that the init, assistant and result messages report the selected model. The
restriction `Claude requires Opus 5.5 medium` and the ClaudeAdapter constructor
check `Unsupported Claude model or effort` SHALL NOT exist.

#### Scenario: Non-Opus Claude model

- **WHEN** a ClaudeAdapter is created with model `claude-sonnet-5-5` and effort
  `high`
- **THEN** construction succeeds
- **AND** its arguments contain `--model claude-sonnet-5-5` and `--effort high`

#### Scenario: Selected model is verified

- **WHEN** a ClaudeAdapter selected `claude-sonnet-5-5` receives an init, assistant
  or result message reporting `claude-opus-5-5`
- **THEN** the action is rejected as it is today for a model mismatch

#### Scenario: Non-catalog Claude adapter values

- **WHEN** a ClaudeAdapter is created with a model or effort not in the Claude
  catalog
- **THEN** construction throws a message naming the rejected value

### Requirement: Unchanged defaults

The system SHALL resolve omitted harness, model and effort to `claude`,
`claude-opus-5-5` and `medium`. Omitted Codex model and effort SHALL be resolved
from the local Codex configuration.

#### Scenario: All omitted

- **WHEN** harness, model and effort are all omitted
- **THEN** the resolved values are `claude`, `claude-opus-5-5` and `medium`

#### Scenario: Codex defaults from configuration

- **WHEN** harness is `codex` and model and effort are omitted
- **THEN** model and effort are taken from the Codex `config/read` result
- **AND** they are validated against the Codex catalog

#### Scenario: Partial Codex selection

- **WHEN** harness is `codex`, model is given and effort is omitted
- **THEN** the given model is kept and only the effort comes from configuration

### Requirement: CLI model and effort flags

The CLI SHALL accept `--harness=<claude|codex>`, `--model=<id>` and
`--effort=<level>` in any order, each at most once, and SHALL refuse any other
argument with exit code 4. CLI values SHALL override the invocation JSON fields
`harness`, `model` and `effort`.

#### Scenario: Flags in any order

- **WHEN** the CLI is run with `--effort=high --model=claude-haiku-5-5 --harness=claude`
- **THEN** the runner receives harness `claude`, model `claude-haiku-5-5` and
  effort `high`

#### Scenario: CLI overrides JSON

- **WHEN** the invocation JSON sets `model` `claude-opus-5-5` and `effort` `low`
  and the CLI passes `--model=claude-sonnet-5-5 --effort=max`
- **THEN** the runner receives model `claude-sonnet-5-5` and effort `max`

#### Scenario: Repeated or unknown argument

- **WHEN** the CLI receives `--model=a --model=b`, `--model=` or `--verbose`
- **THEN** it exits with code 4 and prints only the private diagnostics report

### Requirement: Frozen invocation identity

The resolved harness, model and effort SHALL remain part of the frozen invocation
identity, and a restart resolving a different value SHALL be refused.

#### Scenario: Restart with a different model

- **WHEN** an invocation started with `claude-opus-5-5` is restarted with
  `--model=claude-sonnet-5-5` and the same state
- **THEN** the restart is refused as incompatible and the saved state is unchanged
