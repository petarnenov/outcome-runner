# outcome-runner

Unattended OpenSpec outcome runner. It takes tasks from a queue committed in a
Git repository, implements each through its own OpenSpec change and Pull Request,
and records accepted results in the repository.

```sh
npm i -g --allow-git=root github:petarnenov/outcome-runner
```

npm 12 refuses Git installs unless `--allow-git=root` is given.

To run it without a global install, replace `outcome-runner` in any command below:

```sh
npx --allow-git=root github:petarnenov/outcome-runner hash planning/outcomes.json
```

Run it from any directory inside the repository to work on. The project needs
Git, Node 24 or newer, the selected harness CLI, OpenSpec CLI, the configured
build tools and (for GitHub hosting) authenticated `gh`. The package has no
runtime dependencies beyond Node built-ins; TypeScript is used only to build it
during installation.

## Quick start

**Before the first run:** the runner works unattended and **merges each accepted
Pull Request into the target branch itself**. If the target requires human
approval, the run ends incomplete and the Pull Request waits.

**1. Install once per machine, or use npx**

```sh
npm i -g --allow-git=root github:petarnenov/outcome-runner
```

With npx nothing needs installing. Wherever a step below says `outcome-runner`,
write `npx --allow-git=root github:petarnenov/outcome-runner` instead, and run it
from inside the repository in the same way.

You also need Git with a commit identity, OpenSpec CLI, authenticated `gh`, and
authenticated Claude Code 2.1.321 or newer (or Codex 0.167.0 or newer). Started
from a terminal, the runner offers to install a missing OpenSpec CLI; see
[OpenSpec preflight](#openspec-preflight).

**2. Prepare the project**

The project needs a GitHub `origin` and a target branch, `main` in this example.

```sh
cd /path/to/project
mkdir -p openspec/changes planning evidence/results
touch openspec/changes/.gitkeep evidence/results/.gitkeep
echo 'schema: spec-driven' > openspec/config.yaml
```

Started from a terminal, the runner offers to create the missing OpenSpec files
for you; you still commit and push them yourself.

**3. Describe the tasks in `planning/outcomes.json`**

Write it by hand or generate it from Jira, text or a file; see
[Creating the queue file](#creating-the-queue-file).

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "TASK-1",
      "title": "Implement finite counter",
      "change": "implement-finite-counter",
      "priority": 1,
      "scopes": ["src/counter"],
      "dependencies": [],
      "criteria": [
        "Create src/counter/result.mjs exporting next(n).",
        "Include tests within your scope."
      ]
    }
  ]
}
```

`scopes` are the only product paths a task may change. They cannot overlap the
queue, receipts or OpenSpec changes. Smaller `priority` values run first.

**4. Commit and push to the target branch**

The runner reads the queue from `origin/<target>`, not from your working tree.

```sh
git add -A
git commit -m "chore: define outcomes"
git push origin main
```

**5. Print the task hashes**

```sh
outcome-runner hash planning/outcomes.json
```

If you change a task later, its hash changes and step 6 must be updated.

**6. Create an invocation file outside the repository**

Save it as, for example, `~/invocations/my-project-1.json`:

```json
{
  "invocation": "my-project-1",
  "leaves": ["TASK-1"],
  "maxAccepted": 1,
  "coverage": 85,
  "authority": {
    "reference": "owner-2026-01-31",
    "instruction": "The actual instruction authorizing this work",
    "target": "main",
    "tasks": { "TASK-1": "HASH_FROM_STEP_5" }
  },
  "project": {
    "queue": "planning/outcomes.json",
    "changes": "openspec/changes",
    "receipts": "evidence/results",
    "target": "main",
    "repository": "OWNER/REPOSITORY",
    "planningCheck": { "command": "openspec", "args": ["validate", "{change}", "--strict"] },
    "checks": [{ "command": "node", "args": ["--test", "--experimental-test-coverage", "--test-coverage-lines={coverage}", "{scope}/*.test.mjs"] }]
  }
}
```

- Do not set `root` or `stateDirectory`; the run is refused if you do.
- Replace `checks` with the project's real checks, including a coverage gate
  with `{coverage}` in an argument.
- If a fresh worktree needs dependencies, add
  `"setup": [{ "command": "npm", "args": ["ci"] }]` to `project`.
- Without `leaves`, every task in `authority.tasks` runs.
- Leave out `coverage` (and `harness`, `model`, `effort`) to be asked for it
  when the run starts from a terminal; see [Harness selection](#harness-selection).

**7. Run it from the repository**

```sh
cd /path/to/project
outcome-runner ~/invocations/my-project-1.json
```

Started from a terminal, the runner shows which harnesses are installed and
asks for the harness, model, effort and coverage that neither a flag nor the
invocation file sets; pressing Enter at every question gives harness `claude`,
model `claude-opus-5-5`, effort `medium` and coverage 85. See
[Harness selection](#harness-selection). Without a terminal the run uses those
same defaults. Choose them with `--harness=<claude|codex>`, `--model=<id>`,
`--effort=<level>` and `--coverage=<n>`, in any order and each at most once:

```sh
outcome-runner ~/invocations/my-project-1.json --model=claude-sonnet-5-5 --effort=high
outcome-runner ~/invocations/my-project-1.json --harness=codex --model=<codex-model> --effort=<level>
```

- Claude models: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and
  `claude-fable-5-2`, each with effort `low`, `medium`, `high`, `xhigh` or `max`.
- Codex models and their efforts are the ones the Codex app-server lists through
  `model/list`. With `--harness=codex`, an omitted model or effort is taken from
  the local Codex configuration.
- Defaults stay `claude` / `claude-opus-5-5` / `medium`.
- A model or effort the selected harness does not offer stops the run with exit
  code 4 before any work starts.

**8. Read the result**

| Exit code | Meaning |
|---|---|
| 0 | Success: `exhausted` or `limit-reached` |
| 3 | Incomplete, for example blocked dependencies or a protected merge |
| 4 | Did not run; the printed `reason` (for example `openspec-missing` or `harness-unavailable`) and the `diagnostics` file explain why |

After an interruption, run the **same command with the same file** to resume. Do
not delete the state under `~/.local/state/outcome-runner/`. The runner also
creates a `work-queue-claims-<target>` branch. It is never merged; keep it while
work is unfinished.

## OpenSpec preflight

Before anything else (harness checks, any selection prompt, the lock, claims and
worktrees) the runner checks two things:

1. The OpenSpec CLI is available: `openspec --version` exits 0. Its output is
   discarded, so a passing check prints nothing.
2. `openspec/config.yaml` exists at `origin/<target>`. The runner fetches
   `origin <target>` and looks there; a config that exists only in your working
   tree counts as missing.

When both hold, startup continues without any OpenSpec prompt or output.

The startup is **interactive only when both stdin and stderr are terminals
(TTYs)**. All questions and explanations are written to stderr; stdout keeps only
the JSON lines. An empty answer means no; only `y` or `yes` means yes.

Interactive, missing CLI: the runner asks whether to install it with

```sh
npm install -g @fission-ai/openspec@latest
```

On yes it runs exactly that command (as an argument array, without a shell, with
npm's output on stderr) and checks again. On no, a failing install, or a check
that still fails afterwards, it exits with code 4 and reason `openspec-missing`.

Interactive, missing `openspec/config.yaml` at `origin/<target>`: the runner asks
whether to create the project layout in the working tree:

- `openspec/config.yaml` containing `schema: spec-driven`;
- `<changes>/.gitkeep` and `<receipts>/.gitkeep`, using the invocation's
  `project.changes` and `project.receipts` directories.

On yes it creates only the files that are missing (existing files are never
overwritten) and **never commits or pushes**. It then exits with code 4 and
reason `openspec-layout-created`, telling you to commit and push the created
files to `origin/<target>` and run again. On no it exits with code 4 and reason
`openspec-not-initialized`.

Non-interactive (for example CI, a pipe, or stderr redirected to a file): nothing
is asked, installed or created. A missing CLI exits with code 4 and reason
`openspec-missing`; a missing config exits with code 4 and reason
`openspec-not-initialized`.

If Git cannot read `origin/<target>` during the config check (no network, no
`origin` remote, an unknown target branch), the run exits with code 4 and reason
`startup-or-run-failed`; nothing is asked or created, because the runner cannot
tell whether the config exists.

The reason is printed in the stdout line
`{"status":"unavailable","reason":"...","diagnostics":"..."}` and repeated in
the private diagnostics file.

## Harness selection

Every start goes through these steps in this order, before the lock, claims and
worktrees:

1. **OpenSpec preflight**: see [OpenSpec preflight](#openspec-preflight).
2. **Harness availability**: both harnesses are checked with their version
   probes, Claude Code (`claude --version`, 2.1.321 or newer) and Codex CLI
   (`codex --version`, 0.167.0 or newer). A harness is unavailable with reason
   `not-installed` when its executable is missing,
   `uncertified-claude-version` or `uncertified-codex-version` when it is older
   (the found version is shown), or `probe-failed` when the version check fails
   in another way. An unavailable harness never fails the run by itself.
3. **Harness**: only the available harnesses can be chosen; `claude` is
   preselected when available, otherwise the only available one.
4. **Model**: the models the chosen harness offers. `claude-opus-5-5` is
   preselected for Claude. For Codex the Codex default model is preselected: the
   model from the local Codex configuration when Codex lists it, otherwise the
   model that Codex `model/list` marks with `isDefault`, otherwise the first
   listed model.
5. **Effort**: only the efforts the chosen model supports. `medium` is
   preselected when supported, otherwise the model's default effort (for Codex
   its `defaultReasoningEffort` from `model/list`).
6. **Coverage**: the coverage threshold, with 85 preselected. Only an integer
   from 1 to 100 is accepted; anything else is asked again.

Steps 3 to 6 are questions only when the start is interactive (both stdin and
stderr are terminals, as in the OpenSpec preflight). The harness statuses, the
options and the questions are written to stderr; stdout keeps only the JSON
lines. Pressing Enter accepts the preselected answer shown in brackets, for
example `Harness [claude]: `. You may also type the number of an option or its
exact name. A value given by a flag (`--harness=`, `--model=`, `--effort=`,
`--coverage=`) or in the invocation file is used without asking for it.

Non-interactive starts (CI, a pipe, stderr redirected) ask and print nothing
here: flags, the invocation file and the defaults `claude`, `claude-opus-5-5`,
`medium` and 85 apply (with `--harness=codex`, an omitted model or effort comes
from the local Codex configuration). The selected harness must still be
available.

On a restart of an invocation whose state already records a harness, model,
effort and coverage, no question is asked and the recorded selection is reused.
A flag or invocation value that differs from the record is refused as an
incompatible run state, leaving the state unchanged.

When no harness is available, or the harness set by flag, invocation file,
record or default is unavailable, the run exits with code 4 and reason
`harness-unavailable` before anything is allocated. The diagnostics message
lists each harness with its reason, for example
`No available harness: claude: not-installed; codex: uncertified-codex-version (codex-cli 0.100.0)`.

The chosen values are frozen in the invocation identity exactly like flag
values. With Codex, its configuration and model list are read once per start
and reused to validate the selection.

## Creating the queue file

`outcome-runner` has no command that writes `planning/outcomes.json`. Write it by
hand or with a harness; the runner only validates and executes it. The source
(Jira, text or a file) changes only the last line of the prompt.

**1. Open a harness in the repository**

```sh
cd /path/to/project
claude    # or codex
```

**2. Give it this prompt and fill in `SOURCE`**

```text
Create planning/outcomes.json from the source below. Read the repository first
so scopes and criteria match the real code. Write only that file.

Format: { "version": 1, "tasks": [ ... ] }
Each task has:
- id: unique, letters, digits, ".", "_", "-"
- title: short and nonempty
- change: unique lowercase kebab-case OpenSpec change name
- priority: integer, smaller runs first
- scopes: repository-relative directories this task may change; no "..",
  no absolute paths, no wildcards; never planning/, evidence/results or
  openspec/changes
- dependencies: ids of tasks that must be accepted first; no cycles
- criteria: nonempty list of concrete, verifiable requirements

One task must fit one OpenSpec change and one Pull Request. Split larger work.
Include tests in the criteria. Do not invent requirements missing from the
source; list open questions in your reply instead.

SOURCE: <see the table below>
```

Adjust the paths in `scopes` if your invocation uses different `queue`,
`receipts` or `changes` locations.

**3. Choose the source**

| Source | What to write after `SOURCE:` |
|---|---|
| Jira | `Jira ticket PROJ-123 and its subtasks. Read them with the Atlassian tools.` |
| Text | Paste the description directly |
| File | `The file docs/spec.md` |
| Several | List them, for example a ticket and a file |

Jira needs a harness with Atlassian access, such as an Atlassian MCP server.
Without it, paste the ticket text and use the Text source.

**4. Review the file yourself**

- `scopes`: do they cover everything the task must change? A task cannot write
  outside them.
- `criteria`: they are the contract the worker follows and the reviewer checks.
  Vague criteria produce vague results.
- Open questions: resolve any the harness reported before the run. The run asks
  nothing.

**5. Validate the file**

```sh
outcome-runner hash planning/outcomes.json
```

A printed ID-to-hash map means the format is valid. On `unavailable`, the reason
is in the `diagnostics` file. Scope overlap with the queue, receipts or changes
is only detected when a run starts.

**6. Continue from Quick start step 4**

Commit and push, then create the invocation file. A hash is not permission: put
your actual instruction in `authority.instruction`.

## How it works

Run it on one or more machines over the tasks of one repository. A local SQLite
lock prevents simultaneous invocations in one clone. Across machines the
repository is the allocator: before taking a task the runner pulls the target and
the `work-queue-claims-<target>` branch, selects a task, records it there as
`<id>.json`, commits and pushes without force. A rejected push means another
machine won, so the runner pulls and selects again. Any other push failure stops
the run before work starts.

Give each machine its own clone. The repository is the Git top level of the
current directory. State is kept per clone and invocation under
`$XDG_STATE_HOME/outcome-runner` (default `~/.local/state/outcome-runner`). The
invocation file must not set `root` or `stateDirectory`, so one file serves every
machine and every repository. Tasks claimed by
another run, or overlapping its scopes, are skipped until accepted. A run with
only claimed work left returns incomplete; restart it later with the same
configuration. Claims are never taken over automatically. After confirming that
a machine stopped and will not resume, delete its claim file on the claims branch
in a normal commit and push.

## Project and authority

Commit a version 1 queue containing `tasks`. Each task has `id`, `title`,
`change`, integer `priority`, string-array `criteria`, product `scopes` and
`dependencies`. Smaller priority values run first. Each result has one OpenSpec
change and one PR. Scopes cannot overlap queue, receipt or OpenSpec roots.

Keep the invocation JSON outside the checkout. Supply a stable `invocation` name
(letters, digits, `.`, `_`, `-`), optional selected `leaves` and optional
positive `maxAccepted`. Omitted mode is OFF. `authority` contains the actual
instruction `reference`, `instruction`, selected `target` and a `tasks` object
mapping IDs to canonical SHA256 hashes printed by `outcome-runner hash <queue>`.
Hashing a task is not permission: the configuration must reference an actual
covering owner instruction. Do not transfer grants between projects.

The `project` object supplies repository-relative `queue`, `changes`, `receipts`,
Git `target`, explicit PR `repository`, mandatory `planningCheck`, nonempty
`checks` and optional `setup`, `commitScope` and `commitSuffix`. Commands have fixed `command` and `args` fields.
Arguments may contain `{coverage}`, `{change}`, `{target}` and `{scope}` (the first authorized product scope). They run as argument arrays,
not worker-supplied shell strings. The owner must review these commands and
include every project-required gate. A check exiting successfully is evidence
only for what that check actually validates.

Normal branch protection applies. A suitable planning check is
`openspec validate {change} --strict`. Fresh package worktrees need the project's
noninteractive setup command. The runner does not invent missing compliance or
security decisions.

## Start and resume

```sh
cd /path/to/repository
outcome-runner hash path/to/queue.json
outcome-runner /path/to/invocation.json [--harness=<claude|codex>] [--model=<id>] [--effort=<level>] [--coverage=<n>]
```

Every start first runs the [OpenSpec preflight](#openspec-preflight), then the
[harness availability check and selection](#harness-selection).

Claude is used when both the CLI and JSON harness are omitted (and, from a
terminal, chosen or accepted with Enter), or when
`--harness=claude` or JSON `"harness": "claude"` is given. It requires
authenticated Claude Code **2.1.321 or newer**. Its model and effort are then
selectable independently through flags or the JSON `model` and `effort` fields.
The Claude catalog is a static list of exact model IDs, `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-2`, each supporting
effort `low`, `medium`, `high`, `xhigh` and `max`; it is updated with the runner
when Claude Code accepts new IDs. Omitted Claude model and effort default to
`claude-opus-5-5` and `medium`. The selection is passed as
`claude --model <id> --effort <level>`, and the init, assistant and result
messages must all report the selected model; no fallback model is permitted.

Select Codex with `--harness=codex` or JSON `"harness": "codex"`. Codex requires
CLI **0.167.0 or newer**. Its catalog is read from the app-server RPC
`model/list` (all pages, hidden models excluded), and each model supports the
efforts it lists in `supportedReasoningEfforts`. Omitted Codex `model` and
`effort` are resolved from its local configuration. Defaults and catalog are read
in one short app-server session that is closed before allocation.

`--harness=`, `--model=` and `--effort=` each override the JSON `harness`,
`model` and `effort` respectively. They may appear in any order, each at most
once; any other argument is refused with exit code 4. A model not offered by the
selected harness's catalog, or an effort the selected model does not support, is
refused before allocation with exit code 4 and a diagnostics message naming the
rejected value. Omitted fields still fall back to the defaults above.

JSON `coverage` is optional; when neither it nor `--coverage` is given, a
terminal start asks for it and any other start uses 85. It must be a numeric
integer from 1 through 100; `--coverage=<n>` overrides it. This flag can appear in any
order with the selection flags, once and with a nonempty value. Invalid coverage
is refused with exit code 4 and private diagnostics before allocation.

At least one `project.checks` argument must contain literal `{coverage}`, or
startup is refused with exit code 4 and diagnostics saying
`A coverage gate check is required`. A placeholder only in setup, planning checks
or an executable does not qualify. Every occurrence in check arguments expands
to the resolved decimal threshold, for example `--test-coverage-lines=90` for
coverage 90. Choose a command that enforces that gate, such as the Node coverage
check in the invocation example. Every worker prompt states the percentage.

The resolved harness, model, effort and coverage are frozen in invocation identity.
Omitted coverage and explicit 85 are equivalent; a changed threshold is refused
on restart without changing saved state or ownership. A
restart with changed settings or legacy state without this identity is refused;
finish that invocation using its original runner and configuration. Do not erase
state or ownership to migrate active work. Start a new invocation only once the
previous work is reconciled and accepted or explicitly disposed under authority.
Claude uses only a loopback private MCP broker, with native tools, ambient MCP,
custom plugins, skills and hooks disabled. CLI output and bounded failure details
remain private. Bundled infrastructure plugin metadata is allowlisted and does
not grant tools. Global harness settings are never rewritten.

Restart with the same configuration and state directory. Do not delete ownership
or state files to evade unfinished work. Private worker output and reports stay
in state. A worker session ending does not stop the controller.

`maxAccepted` counts newly accepted results in the durable invocation. It does
not count prior completion, proposals, attempts or worker sessions. A reached
bound is successful with remaining task IDs reported. Too few accepted results,
blocked dependencies or protected merges return incomplete without asking a
person anything. Independent work may proceed only without overlapping held
scopes. Receipts validate outputs at their first accepted target commit; later ordinary
changes preserve historical acceptance. Removed or altered receipts do not prove
completion. A target that advanced without touching the task scopes or change
directory is merged into the result and all final checks run again. A target
change inside that scope is reported incomplete.

## Completion summaries

Each newly accepted task includes the final implementation reviewer's two or three
English sentences describing the change, followed by one sentence stating elapsed
time and complexity grade. The grade describes the complexity of the whole task:
A is most complex, then B, C, D, and E is easiest. It does not rate correctness,
quality or execution speed.

The wall-clock duration runs from the original durable claim to the controller's
first observation of valid acceptance on the target, including downtime and
restarts. It is rounded down to whole seconds, clamped at zero, and displayed as
`Hh Mm Ss` with all three units (hours can exceed 24). Completion is saved before
the accepted event is emitted and reused on a same-invocation restart.

The stdout accepted JSON event contains `status`, `id`, `summary`,
`durationSeconds` and `grade`, for example:

```json
{"status":"accepted","id":"OR-5","summary":"The runner now reports completion details. Claim timing survives restarts. The task took 1h 12m 5s from claim to acceptance and has complexity grade B.","durationSeconds":4325,"grade":"B"}
```

The final result keeps its `accepted` ID array and adds `completions`, an object
keyed by each newly accepted task ID. Each entry contains the identical
`summary`, `durationSeconds` and `grade` from the event, including when the
invocation later returns incomplete, cancelled or limit-reached. Saved entries
survive a restart; existing baseline receipts are excluded. With no newly
accepted tasks, `completions` is `{}`. Historical receipts need no migration.
Other private reports, findings, session text and check output remain private.

## Graded test planning

Workers plan and write tests by complexity, on the same scale as the completion
grade: A (most complex), B, C, D, E (easiest). Every prompt states the resolved
coverage threshold as a percentage, for example `90%`, and the graded
instructions name that same percentage.

- **Plan.** `tasks.md` must contain a test section in which every planned test
  has a grade, and the tests are listed from E to A (easiest first). Each test is
  marked `(required)` when a source criterion or spec scenario demands it,
  otherwise `(coverage-only)`.
- **Planning review.** The reviewer reports changes-required when a planned test
  lacks a grade, the tests are not listed from E to A, or a test demanded by a
  criterion or scenario is not marked `(required)`.
- **Work.** The worker writes tests grade by grade starting with E, calls
  `run_checks` after each grade and continues with the next harder grade until
  the coverage gate passes at the resolved coverage threshold. Tests marked
  `(required)` are always written, whatever the coverage; only `(coverage-only)`
  tests stop at the threshold. Coverage-only grades left unwritten because the
  threshold was reached stay unchecked in `tasks.md` with the note
  `not needed: coverage reached`.
- **Implementation review.** The reviewer reports changes-required when the
  coverage gate did not pass at the resolved threshold, when a harder grade was
  written while an easier planned grade is still unchecked without that note, or
  when a `(required)` test is unwritten or carries the note.

The controller does not parse `tasks.md`; the planning review and the
implementation review enforce these rules before specification binding and
acceptance. Retried and resumed sessions receive the same instructions and
percentage from the frozen threshold.

## Run statistics ledger

Each runner execution appends one compact JSON object and newline to
`$XDG_STATE_HOME/outcome-runner/runs.jsonl`. The default is
`~/.local/state/outcome-runner/runs.jsonl`; unset, empty or relative
`XDG_STATE_HOME` uses that default. The hash command never creates a ledger,
even when hashing fails. A resumed invocation is a new execution with a new
`runId`.

Missing directories are created with mode 0700 and the ledger is created or
secured with mode 0600. Prior bytes are preserved. Each complete record uses
one write on an O_APPEND descriptor, including concurrent local executions.
Persistence is best effort: path, open, permissions, serialization, short-write,
append and close failures produce a safe stderr warning and preserve stdout,
the task result and the original exit code. Short writes are never retried.

Schema version 1 includes all the following fields. Null means unavailable or
not reached; arrays are empty when no entries exist.

| Field | Type and meaning |
| --- | --- |
| schemaVersion | integer literal 1 |
| runId | string, fresh UUID per execution |
| runnerVersion | string, executing package version, not a hardcoded release |
| hostname | string, machine hostname |
| repositoryTopLevel | string or null, canonical Git top-level path once discovered |
| originUrl | string or null, origin remote once discovered; omit embedded credentials from URL userinfo |
| targetBranch | string or null, resolved project target |
| invocation | string or null, invocation name |
| authorityReference | string or null, reference only |
| startedAt | string, ISO 8601 UTC execution start |
| endedAt | string, ISO 8601 UTC finalization time |
| durationSeconds | number, nonnegative elapsed run seconds from a monotonic clock |
| exitCode | integer, actual returned code (0, 3 or 4) |
| status | exhausted, limit-reached, incomplete, cancelled or unavailable |
| failureReason | string or null, safe failure reason code for unavailable, null otherwise |
| settings | object described below |
| tasks | array of task statistics described below |
| tokenUsage | token usage object or null, described below |

Every `settings` field is a `{value, source}` object. The source is
`cli-flag`, `invocation-json`, `interactive-answer`, `default`, or null
when unresolved. Flags override invocation JSON. An explicit nonempty answer
is interactive; Enter accepting the suggestion is default. Harness configuration
and catalog defaults also count as default.

| Setting | Value type |
| --- | --- |
| harness | string (`claude` or `codex`) or null |
| harnessCliVersion | string or null, observed from an existing probe; inherits harness source |
| model | string or null |
| effort | string or null |
| coverage | integer 1–100 or null |
| maxAccepted | positive integer or null; null/default means unbounded, null/null means unresolved |
| leaves | string[] or null; effective selected task IDs, null/null before expansion |

Saved provenance survives restart without changing frozen configuration or
authority identity. Legacy state lacking provenance uses default attribution.
Task statistics include only work or decisions of this execution, with one entry
per task ID. Historical baseline acceptances and unrelated queue tasks are excluded.
Acceptance supersedes earlier decisions. Owned unfinished work is blocked;
foreign task/scope claims are claimed-elsewhere; pending dependencies, limits
and cancellation leave selected unowned tasks not-started.

Each `tasks` entry contains:

| Field | Type and meaning |
| --- | --- |
| id | string, task ID |
| change | string, task change name |
| outcome | accepted, blocked, claimed-elsewhere or not-started |
| lastStage | string or null; claim, investigate, plan, work, receipt, publish, pr or merge |
| blockingReason | string or null; safe controller reason code when blocked |
| durationSeconds | nonnegative number or null; OR-5 persisted claim-to-acceptance duration for accepted tasks |
| complexityGrade | A, B, C, D, E or null |
| completionSummary | string or null; OR-5 approved completion summary |
| workerSessions | object with integer investigate, plan, work and review counts |
| planningReviewRounds | integer |
| implementationReviewRounds | integer |
| planningFindingsPerRound | integer[] in review order |
| implementationFindingsPerRound | integer[] in review order |
| finalChecks | array of {command: string, args: string[], outcome: string} |
| pr | {number: integer, url: string} or null |
| tokenUsage | token usage object or null |

`workerSessions.investigate`, `.plan`, `.work` and `.review` are
nonnegative integer start counts, including sessions interrupted before reply.
Review counts and ordered findings arrays describe known durable history once,
including recovered history. `finalChecks[].command` is a string,
`.args` is string[] and `.outcome` is a string (`passed` or `failed`);
failed/thrown final gates retain actual failure outcomes without their output.
`pr.number` is an integer and `pr.url` is a string when known; `pr` is
null otherwise. Only accepted tasks have nonnull `durationSeconds`,
`complexityGrade` and `completionSummary`, reused from the persisted approved
completion.

Run and task `tokenUsage` are null when no usage is reported, otherwise
`{inputTokens: integer|null, outputTokens: integer|null, totalTokens: integer|null}`.
All numeric components are nonnegative. These totals contain only sessions of
this execution, with cumulative updates deduplicated per session. A component
is null unless every relevant session reports it; missing usage is never
estimated or counted as zero. Durable session/review counts can include older
history, whereas token totals never include resumed historical usage.

Statuses `exhausted` and `limit-reached` use exit 0; `incomplete` and
`cancelled` use 3; `unavailable` uses 4. Only unavailable has a nonnull
`failureReason`: `openspec-missing`, `openspec-not-initialized`,
`openspec-layout-created`, `harness-unavailable` or
`startup-or-run-failed`. Blocked tasks use safe `blockingReason` codes
`operation-incomplete` or `cancelled`. SIGINT and SIGTERM are handled
during startup and work through one guarded finalizer; SIGKILL, power loss and
crashes preventing cleanup cannot produce a termination record.

The ledger contains allowlisted metadata only. Authority instruction text,
worker prompts, private worker output and reports, findings text, check output,
file contents, environment variables and raw errors are excluded. Origin URL
userinfo credentials are removed. The approved completion summary is the
intentional public summary, not a private worker report.

## Acceptance limits

Git-host fixtures exercise real repository merges and receipt validation;
they do not establish hosted protection behavior. Scripted adapters test the
controller, not model execution. Real selected-harness one-task, three-task, review repair
and fresh-process recovery evidence must be recorded before rollout.

## Development

Run `npm install` once after cloning; it also builds `dist/`.

Sources are TypeScript using only erasable syntax, so Node runs them and the
tests directly, without a build. `npm run typecheck` checks types and
`npm run build` emits the installed package to `dist/`.

`npm test` runs the suite with scripted adapters and fails when line, branch or
function coverage of the sources falls below 85%. Tests script the OpenSpec
preflight's prompts, processes and files, so the preflight never runs npm,
`openspec` or a real TTY under test. Tests likewise script the harness
selection's answers, harness probes and Codex reader, so no test starts a real
`claude` or `codex`. The `live:*` scripts exercise a real
harness; set `OUTCOME_TEST_HARNESS` to `claude` or `codex` (default `codex`).

## License

MIT
