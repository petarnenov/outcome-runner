## ADDED Requirements

### Requirement: OpenSpec preflight runs first

The runner SHALL, before any harness check, selection prompt, lock, claim or
worktree, check that the OpenSpec CLI is available (`openspec --version` exits
0) and that `openspec/config.yaml` exists at `origin/<target>` of the
repository. The output of `openspec --version` SHALL be discarded and SHALL NOT
be written to stdout or stderr.

#### Scenario: Available and initialized

- **WHEN** `openspec --version` exits 0 and `openspec/config.yaml` exists at
  `origin/<target>`
- **THEN** startup continues without any OpenSpec prompt or stderr output
- **AND** the version string printed by `openspec --version` is discarded
- **AND** nothing is installed or created

#### Scenario: Preflight precedes harness and allocation

- **WHEN** the preflight refuses
- **THEN** no harness probe or adapter is created, no lock is taken and no claim
  or worktree is created

#### Scenario: Config is read from origin

- **WHEN** `openspec/config.yaml` exists in the working tree but not at
  `origin/<target>`
- **THEN** the config is treated as missing

### Requirement: Config check distinguishes missing from git failure

The config SHALL be treated as missing only when fetching `origin <target>`
succeeds and listing `openspec/config.yaml` at `origin/<target>` succeeds with
empty output. Any git failure during the config check SHALL be a startup error
with exit code 4 and diagnostics reason `startup-or-run-failed`; the runner
SHALL NOT ask anything, create any file, or report `openspec-not-initialized`
for it.

#### Scenario: Git failure during config check

- **WHEN** the fetch of `origin <target>` or the listing at `origin/<target>`
  fails, for example without network, without an `origin` remote or for a
  nonexistent target branch
- **THEN** nothing is asked and no layout file is created, in interactive and
  non-interactive mode alike
- **AND** the run exits with code 4 and diagnostics reason
  `startup-or-run-failed`, not `openspec-not-initialized`

#### Scenario: Successful empty listing

- **WHEN** the fetch succeeds and the listing of `openspec/config.yaml` at
  `origin/<target>` succeeds with empty output
- **THEN** the config is treated as missing

### Requirement: Interactive detection and stderr output

Startup SHALL be interactive only when both `process.stdin` and
`process.stderr` are TTYs. All prompts and explanations SHALL be written to
stderr; stdout SHALL carry only the existing JSON lines.

#### Scenario: Prompts on stderr

- **WHEN** an interactive preflight asks a question
- **THEN** the question and explanation are written to stderr
- **AND** nothing other than the JSON result lines is written to stdout

#### Scenario: Install output on stderr

- **WHEN** the user accepts the install offer and `npm` prints output
- **THEN** that output is forwarded to stderr, never to stdout

#### Scenario: One stream not a TTY

- **WHEN** stdin is a TTY and stderr is not, or stderr is a TTY and stdin is not
- **THEN** startup is non-interactive

### Requirement: Install offer for a missing CLI

When interactive and the CLI is missing, the runner SHALL ask whether to install
it with `npm install -g @fission-ai/openspec@latest`. On yes it SHALL run
exactly the program `npm` with arguments `install`, `-g`,
`@fission-ai/openspec@latest` without a shell, then repeat the check. On no, or
when the install or the repeated check fails, it SHALL exit with code 4 and
diagnostics reason `openspec-missing`.

#### Scenario: Yes and successful install

- **WHEN** the CLI check fails, the user answers yes, the install exits 0 and
  the repeated check exits 0
- **THEN** the install was run as `npm` with arguments
  `["install", "-g", "@fission-ai/openspec@latest"]`
- **AND** startup continues to the config check

#### Scenario: Yes and failing install

- **WHEN** the user answers yes and the install exits nonzero
- **THEN** the run exits with code 4 and diagnostics reason `openspec-missing`

#### Scenario: Install succeeds but CLI still missing

- **WHEN** the install exits 0 and the repeated `openspec --version` fails
- **THEN** the run exits with code 4 and diagnostics reason `openspec-missing`

#### Scenario: No

- **WHEN** the user answers no or an empty line
- **THEN** nothing is installed
- **AND** the run exits with code 4 and diagnostics reason `openspec-missing`

### Requirement: Layout offer for a missing config

When interactive and `openspec/config.yaml` is missing at `origin/<target>`, the
runner SHALL ask whether to create the project layout in the working tree:
`openspec/config.yaml` containing `schema: spec-driven`, `<changes>/.gitkeep`
and `<receipts>/.gitkeep`. On yes it SHALL create only the missing files, SHALL
NOT commit or push, and SHALL exit with code 4 and a message to commit and push
them. On no it SHALL exit with code 4 and diagnostics reason
`openspec-not-initialized`.

#### Scenario: Yes creates only missing files

- **WHEN** the config is missing at `origin/<target>`, the user answers yes and
  `<changes>/.gitkeep` already exists in the working tree
- **THEN** `openspec/config.yaml` with `schema: spec-driven` and
  `<receipts>/.gitkeep` are created and the existing file is unchanged
- **AND** no git add, commit or push is run
- **AND** the run exits with code 4 and a diagnostics message telling the user
  to commit and push the created files

#### Scenario: No

- **WHEN** the config is missing and the user answers no
- **THEN** no file is created
- **AND** the run exits with code 4 and diagnostics reason
  `openspec-not-initialized`

### Requirement: Non-interactive refusal

When non-interactive, the runner SHALL NOT ask, install or create anything; a
missing CLI or config SHALL exit with code 4 and the matching diagnostics
reason.

#### Scenario: Non-interactive missing CLI

- **WHEN** startup is non-interactive and `openspec --version` fails
- **THEN** nothing is asked or installed
- **AND** the run exits with code 4 and diagnostics reason `openspec-missing`

#### Scenario: Non-interactive missing config

- **WHEN** startup is non-interactive and the config is missing at
  `origin/<target>`
- **THEN** nothing is asked or created
- **AND** the run exits with code 4 and diagnostics reason
  `openspec-not-initialized`

### Requirement: Injectable effects

Prompt input, process execution, file creation and the interactive decision
SHALL be injectable so tests script answers and commands; no test SHALL run
`npm`, `openspec` or a real TTY.

#### Scenario: Scripted preflight

- **WHEN** tests supply scripted answers, a recording executor and in-memory
  file creation
- **THEN** every preflight path is exercised without spawning `npm` or
  `openspec`

#### Scenario: Silent version check is testable

- **WHEN** a test runs the default version-check executor against a `node`
  script that prints to stdout and stderr
- **THEN** nothing reaches the caller's stdout or stderr and the exit status is
  reported

### Requirement: Documentation

The README SHALL describe the OpenSpec preflight, the install offer and the
non-interactive behaviour.

#### Scenario: README content

- **WHEN** a reader consults the README
- **THEN** it explains the two checks, the install command offered, the layout
  creation that is never committed or pushed, the TTY rule and the diagnostics
  reasons `openspec-missing` and `openspec-not-initialized`
