# interactive-harness-selection Specification

## Purpose
Let a person in a terminal pick an installed, certified harness, model, effort and coverage, while non-interactive runs keep explicit defaults.

## Requirements

### Requirement: Harness availability check

After the OpenSpec preflight passes and before harness resolution, lock, claim
or worktree, the runner SHALL check both harnesses with their existing probes:
Claude Code 2.1.321 or newer and Codex CLI 0.167.0 or newer. A missing
executable SHALL count as unavailable with reason `not-installed` and SHALL NOT
fail the run by itself.

#### Scenario: Both harnesses probed after the preflight

- **WHEN** the OpenSpec preflight passes
- **THEN** the `claude` and `codex` probes are each called once before any
  selection prompt, lock, claim or worktree

#### Scenario: Preflight refusal skips probes

- **WHEN** the OpenSpec preflight refuses
- **THEN** no harness probe is called

#### Scenario: Missing executable

- **WHEN** the `codex` executable does not exist and Claude Code 2.1.321 is
  installed
- **THEN** `codex` is reported unavailable with reason `not-installed`
- **AND** `claude` is reported available with its version
- **AND** the run continues with `claude`

#### Scenario: Uncertified version

- **WHEN** the Codex probe reports a version older than 0.167.0
- **THEN** `codex` is unavailable with reason `uncertified-codex-version` and
  its version

### Requirement: Interactive harness choice

When interactive (stdin and stderr are TTYs, as in the OpenSpec preflight),
the runner SHALL write each harness with its status and version or reason to
stderr and SHALL ask the user to choose among the available harnesses only.
`claude` SHALL be preselected when available. When only one harness is
available it SHALL be shown and preselected. Prompts SHALL be written to stderr
only.

#### Scenario: Both available, default answers

- **WHEN** both harnesses are available and the user presses Enter at every
  prompt
- **THEN** both harnesses are shown with status and version on stderr
- **AND** the run uses harness `claude`, model `claude-opus-5-5`, effort
  `medium` and coverage 85
- **AND** stdout carries only the JSON result lines

#### Scenario: Only one harness available

- **WHEN** `claude` is unavailable with reason `not-installed` and `codex` is
  available
- **THEN** both are shown with their status, `codex` is the only choice and is
  preselected
- **AND** pressing Enter selects `codex`

#### Scenario: Unavailable harness cannot be chosen

- **WHEN** the user answers with the name of an unavailable harness or an
  unknown value
- **THEN** the harness question is asked again

### Requirement: Interactive model choice

After the harness is chosen, the runner SHALL list the models the harness
offers from the OR-1 catalog and ask for one. `claude-opus-5-5` SHALL be
preselected for Claude. For Codex the Codex default model SHALL be
preselected: the Codex configured model (`config/read`) when it is in the
catalog, otherwise the model that Codex `model/list` marks as default
(`isDefault`) when it is in the catalog, otherwise the first catalog model.

#### Scenario: Claude models

- **WHEN** harness `claude` is chosen interactively
- **THEN** the models `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` and `claude-fable-5-2` are listed with `claude-opus-5-5`
  preselected

#### Scenario: Choosing Codex, a model and an effort

- **WHEN** the Codex catalog offers models `gpt-a` (efforts `low`, `high`) and
  `gpt-b` (efforts `low`, `medium`, `high`), the Codex configured model is
  `gpt-b`, and the user chooses `codex`, then `gpt-a`, then `high`
- **THEN** `gpt-b` was preselected at the model prompt
- **AND** the effort prompt lists exactly `low` and `high`
- **AND** the run uses harness `codex`, model `gpt-a` and effort `high`

#### Scenario: Codex default model from model/list

- **WHEN** Codex `config/read` returns no model, or a model not in the
  catalog, and `model/list` marks `gpt-b` as default while `gpt-a` is listed
  first
- **THEN** `gpt-b` is preselected at the model prompt

#### Scenario: Codex without any default model

- **WHEN** Codex `config/read` returns no model and no `model/list` entry is
  marked as default
- **THEN** the first catalog model is preselected

### Requirement: Interactive effort choice

After the model is chosen, the runner SHALL list only the efforts the chosen
harness and model support and ask for one. `medium` SHALL be preselected when
supported, otherwise the model's default effort (for Codex, the model's
`defaultReasoningEffort` from `model/list`).

#### Scenario: Medium unsupported

- **WHEN** the chosen Codex model supports `low` and `high` and `model/list`
  reports its default reasoning effort as `high`
- **THEN** `medium` is not listed and `high` is preselected

### Requirement: Interactive coverage choice

Last, the runner SHALL ask for the coverage threshold with 85 preselected,
accepting only an integer from 1 to 100 and asking again on invalid input.

#### Scenario: Invalid then valid coverage

- **WHEN** the user answers the coverage prompt with `abc`, then `0`, then `90`
- **THEN** the coverage prompt is asked three times
- **AND** the run uses coverage 90

### Requirement: Enter and given values

Pressing Enter (an empty answer) SHALL accept the preselected answer. A value
given by a CLI flag or the invocation JSON SHALL be used without asking for it.

#### Scenario: Flag-supplied values skip their prompts

- **WHEN** the run is interactive with `--harness=claude` and
  `--coverage=70` given and the user presses Enter at every prompt
- **THEN** no harness or coverage question is asked
- **AND** only the model and effort questions are asked
- **AND** the run uses harness `claude`, coverage 70 and the preselected model
  and effort

#### Scenario: JSON-supplied value skips its prompt

- **WHEN** the invocation JSON sets `model` and the run is interactive
- **THEN** no model question is asked and the JSON model is used

### Requirement: Unavailable harness refusal

When no harness is available, or a harness set by flag or JSON is unavailable,
the runner SHALL exit with code 4 and diagnostics reason `harness-unavailable`
whose message lists each harness and its reason, in interactive and
non-interactive mode alike, without asking and before lock, claim or worktree.

#### Scenario: None available

- **WHEN** `claude` is `not-installed` and `codex` is
  `uncertified-codex-version`
- **THEN** nothing is asked
- **AND** the run exits with code 4, reason `harness-unavailable`, and a
  message containing `claude`, `not-installed`, `codex` and
  `uncertified-codex-version`

#### Scenario: Flag harness unavailable

- **WHEN** `--harness=codex` is given and `codex` is unavailable
- **THEN** the run exits with code 4 and reason `harness-unavailable` listing
  each harness and its reason

### Requirement: Non-interactive selection

When non-interactive, nothing SHALL be asked or written to stderr by the
selection; flags, JSON and defaults (`claude`, `claude-opus-5-5`, `medium`,
85) apply, and the selected harness SHALL be available.

#### Scenario: Non-interactive defaults

- **WHEN** startup is non-interactive, nothing is given and both harnesses are
  available
- **THEN** no question is asked
- **AND** the run uses `claude`, `claude-opus-5-5`, `medium` and 85

#### Scenario: Non-interactive default harness unavailable

- **WHEN** startup is non-interactive, no harness is given and `claude` is
  unavailable
- **THEN** the run exits with code 4 and reason `harness-unavailable`

### Requirement: Restart reuses the recorded selection

On a restart of an invocation whose state already records a harness, model,
effort and coverage, the runner SHALL NOT show any selection prompt and SHALL
reuse the recorded selection. A flag or JSON value that differs SHALL be
refused as today, as an incompatible run state, leaving the state unchanged.

#### Scenario: Restart reusing the recorded selection

- **WHEN** an interactive invocation recorded `codex`, `gpt-a`, `high` and 90
  and is restarted interactively with no flags, with a scripted Codex reader
- **THEN** no question is asked
- **AND** the scripted Codex reader is called exactly once and no `codex`
  process is started
- **AND** the run continues with `codex`, `gpt-a`, `high` and 90

#### Scenario: Restart with a differing flag

- **WHEN** the recorded model is `claude-opus-5-5` and the restart passes
  `--model=claude-sonnet-5-5`
- **THEN** the restart is refused as incompatible and the saved state is
  unchanged

### Requirement: Chosen values are frozen

The chosen harness, model, effort and coverage SHALL be used by the run and
frozen in its invocation identity exactly like values given by flags.

#### Scenario: Interactive choice equals flag identity

- **WHEN** one run chooses `claude`, `claude-sonnet-5-5`, `high` and 90
  interactively and another passes the same values as flags
- **THEN** both runs record the same identity hash
- **AND** worker sessions use model `claude-sonnet-5-5`, effort `high` and
  coverage 90

### Requirement: Single Codex catalog read

When the selected harness is `codex`, the runner SHALL read the Codex
configuration and catalog once per start, through the injectable Codex reader
used by the selection, and SHALL reuse that result for harness resolution
instead of opening a second Codex app-server session. When the selected
harness is `claude` or the run is refused, the Codex reader SHALL NOT be
called.

#### Scenario: Codex read reused by resolution

- **WHEN** the run selects `codex` (interactively, by flag or JSON, or from a
  recorded selection) with a scripted Codex reader
- **THEN** the scripted reader is called exactly once
- **AND** model and effort validation use the catalog it returned

#### Scenario: Claude does not read Codex

- **WHEN** the run selects `claude`
- **THEN** the Codex reader is not called

### Requirement: Injectable prompts and probes

Prompt input, the interactive decision, harness probes and the Codex reader
SHALL be injectable; tests SHALL script answers, probe results and the Codex
catalog and SHALL NOT start a real harness or use a real TTY.

#### Scenario: Scripted selection

- **WHEN** tests supply scripted answers, scripted probe results and a scripted
  Codex reader
- **THEN** every selection path, including runner paths that end on `codex`,
  runs without spawning `claude` or `codex`

### Requirement: Documentation

The README SHALL document the interactive startup order: OpenSpec, harness
availability, harness, model, effort, coverage.

#### Scenario: README startup order

- **WHEN** a reader consults the README
- **THEN** it lists the startup steps in that order, the preselected answers,
  the non-interactive defaults, restart reuse and the `harness-unavailable`
  refusal with reasons such as `not-installed`
