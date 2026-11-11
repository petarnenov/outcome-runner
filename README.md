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
The target is the branch you start the runner from; see
[Target branch](#target-branch).

```sh
cd /path/to/project
mkdir -p openspec/changes planning evidence/results
touch openspec/changes/.gitkeep evidence/results/.gitkeep
echo 'schema: spec-driven' > openspec/config.yaml
```

Started from a terminal, the runner offers to create the missing OpenSpec files
for you in a setup worktree outside your checkout; you still commit, push and
merge them yourself.

Every technology in the project also needs a test framework that enforces line,
branch and function coverage at the resolved threshold. The runner checks this
at startup and, from a terminal, offers to set one up; see
[Test framework preflight](#test-framework-preflight).

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
- `authority.target` and `project.target` may be left out: the target is the
  branch checked out where you start the runner. When given, each must equal
  that branch; see [Target branch](#target-branch).
- Replace `checks` with the project's real checks, including a coverage gate
  with `{coverage}` in an argument.
- If a fresh worktree needs dependencies, add
  `"setup": [{ "command": "npm", "args": ["ci"] }]` to `project`.
- The OpenSpec change is archived before the Pull Request with
  `openspec archive {change} --yes`; set `project.archive` to use another
  command. See [Documentation and archive](#documentation-and-archive).
- Without `leaves`, every task in `authority.tasks` runs.
- Leave out `coverage` (and `harness`, `model`, `effort`) to be asked for it
  when the run starts from a terminal; see [Harness selection](#harness-selection).

**7. Run it from the repository, on the target branch**

```sh
cd /path/to/project
git switch main
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
- From a terminal, a small mascot on stderr shows how each task and the run
  ended. Add `--no-mascot` (or set `OUTCOME_RUNNER_MASCOT=0`) to turn it off;
  see [Mascot](#mascot).
- While it works, the runner writes one short line to stderr before each step,
  for example `[outcome-runner] 09:05:03 TASK-1 claim: claiming the task`; see
  [Step lines](#step-lines).

**8. Read the result**

| Exit code | Meaning |
|---|---|
| 0 | Success: `exhausted` or `limit-reached` |
| 3 | Incomplete, for example blocked dependencies or a protected merge |
| 4 | Did not run; the printed `reason` and the `diagnostics` file explain why, for example `detached-head`, `target-differs-from-current-branch`, `target-missing-on-origin`, `unsupported-target-name`, `invocation-running`, `openspec-missing`, `harness-unavailable` or `test-framework-missing` |

After an interruption, run the **same command with the same file** from the same
branch to resume. Do not delete the state under `~/.local/state/outcome-runner/`.
The runner also creates a `work-queue-claims-<target>` branch. It is never
merged; keep it while work is unfinished.

## Target branch

The run target is the branch checked out where the runner starts. Resolving it
is the first startup step, before the [OpenSpec preflight](#openspec-preflight):

1. `git symbolic-ref --quiet --short HEAD` names the current branch. A detached
   HEAD is refused.
2. `git check-ref-format --branch` and the runner's branch name rule check the
   name. Every valid Git branch name works, for example `main`, `feature/x` or
   `release/1.2`.
3. `project.target` and `authority.target` may be omitted; both then resolve to
   the current branch. When either is given and differs from it, the run is
   refused.
4. `git ls-remote origin refs/heads/<branch>` checks that the branch exists on
   origin; push a new branch before starting the runner on it.

| Reason | Meaning |
|---|---|
| `detached-head` | HEAD is detached; check out the branch to work on |
| `target-differs-from-current-branch` | A given `project.target` or `authority.target` names another branch |
| `target-missing-on-origin` | The current branch does not exist on origin |
| `unsupported-target-name` | `git check-ref-format --branch` or the runner's branch name rule rejects the name |

Each refusal exits with code 4 before anything is allocated: no lock, claim or
worktree is created. The reason is printed in the stdout line and repeated in
the private diagnostics file.

The resolved target is part of the frozen invocation identity, and every
receipt records it as `target` (receipts written before this field stay valid).
Pull Requests are opened and merged against it, and its claims branch is
`work-queue-claims-<target>` with `/` replaced by `-`. A run started from a
feature branch therefore opens its Pull Requests against that feature branch. A
resumed invocation must start from the branch it started from before; starting
it from another branch changes its identity and is refused as an incompatible
state.

## OpenSpec preflight

Right after [target resolution](#target-branch), and before the harness checks,
any selection prompt, the lock, claims and worktrees, the runner checks two
things:

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

On yes it runs exactly that command (as an argument array, without a shell, in
the operating system's temporary directory rather than your checkout, with npm's
output on stderr) and checks again. On no, a failing install, or a check that
still fails afterwards, it exits with code 4 and reason `openspec-missing`.

Interactive, missing `openspec/config.yaml` at `origin/<target>`: the runner asks
whether to create the project layout in a setup worktree outside your checkout:

- `openspec/config.yaml` containing `schema: spec-driven`;
- `<changes>/.gitkeep` and `<receipts>/.gitkeep`, using the invocation's
  `project.changes` and `project.receipts` directories.

On yes it creates the setup worktree `<primary>-outcomes/setup-<operation>` on
branch `outcome/setup-<operation[0..12]>` from `origin/<target>` (or reuses it
when it already exists), writes only the files that are missing there (existing
files are never overwritten) and **never commits or pushes**. The runner never
changes the checkout you started it from. It then exits with code 4 and reason
`openspec-layout-created`; the message names the setup worktree path and branch
and tells you to commit the files there, push the branch and merge it into
`<target>`, then run again. On no it creates nothing and exits with code 4 and
reason `openspec-not-initialized`.

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

1. **Target resolution**: see [Target branch](#target-branch).
2. **OpenSpec preflight**: see [OpenSpec preflight](#openspec-preflight).
3. **Harness availability**: both harnesses are checked with their version
   probes, Claude Code (`claude --version`, 2.1.321 or newer) and Codex CLI
   (`codex --version`, 0.167.0 or newer). A harness is unavailable with reason
   `not-installed` when its executable is missing,
   `uncertified-claude-version` or `uncertified-codex-version` when it is older
   (the found version is shown), or `probe-failed` when the version check fails
   in another way. An unavailable harness never fails the run by itself.
4. **Harness**: only the available harnesses can be chosen; `claude` is
   preselected when available, otherwise the only available one.
5. **Model**: the models the chosen harness offers. `claude-opus-5-5` is
   preselected for Claude. For Codex the Codex default model is preselected: the
   model from the local Codex configuration when Codex lists it, otherwise the
   model that Codex `model/list` marks with `isDefault`, otherwise the first
   listed model.
6. **Effort**: only the efforts the chosen model supports. `medium` is
   preselected when supported, otherwise the model's default effort (for Codex
   its `defaultReasoningEffort` from `model/list`).
7. **Coverage**: the coverage threshold, with 85 preselected. Only an integer
   from 1 to 100 is accepted; anything else is asked again.
8. **Test framework analysis**: see
   [Test framework preflight](#test-framework-preflight).

Steps 4 to 7 are questions only when the start is interactive (both stdin and
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

## Test framework preflight

After the OpenSpec preflight and the harness, model, effort and coverage
selection, and before the lock or any claim, the runner checks that every
technology in the repository has a test framework that enforces the resolved
coverage threshold (85 by default).

**Analysis.** The runner fetches `origin <target>` and creates a temporary
detached worktree of `origin/<target>` in a new directory outside the
repository. It runs exactly one **read-only** session there with the selected
harness, model and effort. The session can only read tracked files through the
usual file broker (`read_file`, and `context` for the tracked file list); it has
no `write_file`, no `run_checks`, no shell and no approval tools. It reports
privately through the `test_framework_report` tool. The temporary worktree is
removed after the session in every case (success, failure, invalid report or
cancellation), before anything is asked or changed.

The report must list:

- every detected technology (kind `language`, `runtime`, `framework` or
  `build-tool`) with the tracked repository paths that prove it;
- for each technology, the test frameworks already present, with their evidence
  paths and the line, branch and function coverage thresholds they enforce (a
  number, or `null` when not enforced);
- for each technology without a prepared test framework, one to three
  recommended test frameworks, each with a one-sentence rationale, the install
  commands as command and argument arrays, and the exact file changes (path and
  full content) that run the tests with line, branch and function thresholds
  equal to the resolved coverage threshold.

The runner refuses a report that misses any of these parts, names an untracked
evidence path, or recommends thresholds other than the resolved coverage
threshold. A technology is **prepared** when one of its frameworks enforces
line, branch and function thresholds of at least the resolved threshold. When
every technology is prepared, startup continues without any test framework
prompt.

**Choosing and confirming.** Interactive starts (both stdin and stderr are
terminals, as in the OpenSpec preflight; all output on stderr) print the
detected technologies with their evidence and existing frameworks. For each
technology that is not prepared the runner lists the recommendations and asks
`Choose 1-n or s to skip [1]: `; Enter selects the first recommendation, a
number selects that recommendation and anything else skips the technology.
Before running anything it shows the exact install commands (as JSON argument
arrays) and file changes of the chosen recommendation and asks
`Run these commands and apply these changes? [y/N] `; only `y` or `yes`
confirms. The setup happens in the setup worktree
`<primary>-outcomes/setup-<operation>` on branch
`outcome/setup-<operation[0..12]>`, created from `origin/<target>` when the first
recommendation is chosen and reused by later setups; the checkout you started
the runner from is never changed. After a yes it runs the install commands in
order in the setup worktree, as argument arrays and never through a shell (their
output goes to stderr), and then writes the file changes there. A failing install
command stops that recommendation: later commands and its file changes are not
applied. A file change outside the repository, under `.git`, or inside the queue,
the receipts or the OpenSpec changes directory refuses the whole recommendation
without asking for confirmation.

The runner **never commits or pushes** these changes. After a successful setup
it prints on stderr the files the setup changed (compared with a snapshot of the
setup worktree taken before it, so changes already there are not listed), names
the setup worktree path and branch, asks you to commit the files there, push the
branch and merge it into `<target>`, then run again, and exits with code 4 and
reason `test-framework-prepared`. When you skip or decline a technology, or an
install command fails, it prints the unprepared technologies on stderr and exits
with code 4 and reason `test-framework-missing`.

**Non-interactive** starts still run the analysis, but nothing is asked,
installed or changed. When any technology is not prepared, the run exits with
code 4 and reason `test-framework-missing`; the private diagnostics file
contains the analysis report.

When the analysis session fails (for example the harness is unavailable, the
session throws, the temporary worktree cannot be created or removed) or ends
without a valid report, the run exits with code 4 and reason
`test-framework-analysis-failed`; no lock, claim or task worktree is created.
The last validation message is kept in the private diagnostics file.

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

Run it on one or more machines, and with several runners in one clone, over the
tasks of one repository. Each invocation has its own local SQLite lock, held for
the whole run: a second process of the same invocation is refused at once with
exit code 4 and reason `invocation-running`, while different invocations of one
clone run concurrently. Each invocation also has its own ownership record, so a
different invocation never inherits or overrides another invocation's unfinished
work. Git operations on the shared repository (fetch, worktree add and remove,
branch creation and deletion, task branch pushes, claims ledger commits and
pushes) are serialized between the runners of one clone by a per-clone Git lock.
It is held only for one group of Git operations, never while a worker session, a
check, a prompt or an install command runs; a runner waits for it up to 60
seconds, and the operating system releases it when its holder exits or crashes.
A longer wait fails with `Git lock wait exceeded 60 seconds`. During a task
stage (worktree add, task branch push) this blocks the task. During the
post-merge cleanup or the leftover sweep on start it is recorded as a cleanup
failure: every cleanup step is reported as failed, in `cleanupFailed` of the
`accepted` event after a merge and in the run state for the sweep, and neither
the task nor the run fails. Elsewhere (startup preflights, the target refresh
before each task selection, claims ledger pull or claim) it ends the run with
exit code 4 and reason `startup-or-run-failed`. Runner Git commands run with
`-c gc.auto=0`: automatic garbage collection is turned off for them, so it
cannot take ref lock files while another runner works. Run `git gc` or
`git maintenance run` yourself, for example while no runner is active.

Across runners and machines the repository is the allocator: before taking a
task the runner pulls the target and the `work-queue-claims-<target>` branch,
selects a task, records it there as `<id>.json`, commits and pushes without
force. A rejected push means another runner won, so the runner pulls and selects
again. Any other push failure stops the run before work starts.

### Many runners on one branch

To run several runners on one branch, start each one from the same checkout on
that branch with its own invocation file and invocation name, for example
`my-project-1.json` and `my-project-2.json`. Every invocation has its own state,
its own claimant in the claims ledger and its own task worktrees and branches, so
two runners never work on the same task or on tasks with overlapping scopes at
the same time, and each merges its results into the branch they started from.
Runners on other machines can join with their own clones in the same way.

The repository is the Git top level of the current directory. State is kept per
clone and invocation under `$XDG_STATE_HOME/outcome-runner` (default
`~/.local/state/outcome-runner`). The invocation file must not set `root` or
`stateDirectory`, so one file serves every machine and every repository. Tasks
claimed by another run, or overlapping its scopes, are skipped until accepted. A
run with only claimed work left returns incomplete; restart it later with the
same configuration. Claims are never taken over automatically. After confirming
that a runner stopped and will not resume, delete its claim file on the claims
branch in a normal commit and push.

### Worktrees and cleanup

Every task is worked in its own worktree `<primary>-outcomes/<operation>` next
to the checkout, on branch `outcome/<id>-<operation[0..12]>`, and reaches the
target only through a Pull Request into the target branch, merged by the runner.
The runner never changes the working tree, index or local branch of the checkout
it was started from.

After a task's Pull Request is merged and its receipt is confirmed on the target,
the runner removes the task worktree (`git worktree remove` and
`git worktree prune`), deletes the local task branch and deletes the remote task
branch on origin. Each step is tried on its own. A failed step is listed in the
`accepted` event as `cleanupFailed` (`worktree`, `local-branch` or
`remote-branch`) and recorded in the run state; the result status, the accepted
and remaining lists and the exit code stay the same.

On start, before selecting a task, the runner removes leftover worktrees and
local branches of tasks its invocation has already accepted. Worktrees and
branches of blocked or unfinished tasks are kept, so a later run of the same
invocation resumes them there. Worktrees of other invocations and the setup
worktree of the interactive preflights are never touched.

Each task goes through these stages, and every stage is saved in the run state
before its next step starts: claim, investigation, planning and planning review,
implementation and implementation review, then documentation, documentation
review, project checks, archive, receipt, publish, Pull Request and merge. See
[Documentation and archive](#documentation-and-archive) for the stages after the
implementation review.

## Project and authority

Commit a version 1 queue containing `tasks`. Each task has `id`, `title`,
`change`, integer `priority`, string-array `criteria`, product `scopes` and
`dependencies`. Smaller priority values run first. Each result has one OpenSpec
change and one PR. Scopes cannot overlap queue, receipt or OpenSpec roots.

Keep the invocation JSON outside the checkout. Supply a stable `invocation` name
(letters, digits, `.`, `_`, `-`), optional selected `leaves` and optional
positive `maxAccepted`. Omitted mode is OFF. `authority` contains the actual
instruction `reference`, `instruction`, the optional `target` (the branch the
runner starts from) and a `tasks` object
mapping IDs to canonical SHA256 hashes printed by `outcome-runner hash <queue>`.
Hashing a task is not permission: the configuration must reference an actual
covering owner instruction. Do not transfer grants between projects.

The `project` object supplies repository-relative `queue`, `changes`, `receipts`,
the optional Git `target` (see [Target branch](#target-branch)), explicit PR
`repository`, mandatory `planningCheck`, nonempty
`checks` and optional `setup`, `archive`, `commitScope` and `commitSuffix`. Commands have fixed `command` and `args` fields.
Arguments may contain `{coverage}`, `{change}`, `{target}` and `{scope}` (the first authorized product scope). They run as argument arrays,
not worker-supplied shell strings. The owner must review these commands and
include every project-required gate. A check exiting successfully is evidence
only for what that check actually validates. The `archive` command accepts only
the `{change}` placeholder; see [Documentation and archive](#documentation-and-archive).

Normal branch protection applies. A suitable planning check is
`openspec validate {change} --strict`. Fresh package worktrees need the project's
noninteractive setup command. The runner does not invent missing compliance or
security decisions.

## Start and resume

```sh
cd /path/to/repository
outcome-runner hash path/to/queue.json
outcome-runner /path/to/invocation.json [--harness=<claude|codex>] [--model=<id>] [--effort=<level>] [--coverage=<n>] [--no-mascot]
```

Every start first resolves the [target branch](#target-branch), then runs the
[OpenSpec preflight](#openspec-preflight), then the
[harness availability check and selection](#harness-selection), then the
[test framework preflight](#test-framework-preflight).

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
once; any other argument is refused with exit code 4. The valueless
`--no-mascot` (see [Mascot](#mascot)) may also appear once, in any position
among them; a repeated `--no-mascot` or a valued form such as `--no-mascot=1` is
refused with exit code 4 like any other invalid flag, and the mascot stays off
for that refusal. A model not offered by the
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

The resolved target, harness, model, effort and coverage are frozen in invocation identity.
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
completion. A target that advanced without touching the task scopes, the change
directory, the archived change directory or the `openspec/specs` files written by
the archive is merged into the result and all final checks run again. A target
change inside any of them is reported incomplete.

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
`durationSeconds` and `grade`, and `cleanupFailed` only when a cleanup step
failed (see [Worktrees and cleanup](#worktrees-and-cleanup)), for example:

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

## Documentation and archive

After the implementation review is accepted, a task runs these stages, in this
order, before its receipt, publish, Pull Request and merge:

| Stage | What happens |
|---|---|
| `document` | A worker session with the selected harness, model and effort updates the documentation inside the task scopes |
| `document-review` | An independent review session checks the documentation changes |
| `final-checks` | The project checks run again and must pass |
| `archive` | The OpenSpec change is archived and its spec deltas are applied |

Each stage is saved in the run state before the next step starts. A restart
continues at the saved stage without repeating a completed step: a restart in
`document-review` reviews the recorded documentation without another
documentation session, a restart in `final-checks` does not review the
documentation again, and the archive never runs twice.

**Documentation.** Documentation files are README files, Markdown files (`.md`
and `.mdx`) and files under `docs` or `doc` directories. The documentation
session may write only documentation files inside the task scopes; every other
write or delete is refused. It updates them so that they match the implemented
behaviour and the task criteria. Documentation outside the scopes that needs
changes is reported as findings and listed in the Pull Request body under
`Documentation outside scope`. The documentation commit contains only
documentation files inside the scopes.

**Documentation review.** A fresh review session checks the documentation
changes against the implementation, the criteria and the scopes, and accepts
only with zero findings. Findings go back to a new documentation session. Like
planning and implementation it allows at most 4 rounds; after that the task is
blocked with `Documentation review remains unresolved`. After acceptance the
project `checks` run again (`final-checks`); a failure blocks the task before
the archive.

**Archive.** The runner archives the change with the project command
`archive`, run as an argument array (never through a shell) in the task
worktree, with `{change}` replaced by the task change name. When `project.archive`
is not set the command is `openspec archive {change} --yes`:

```json
"archive": { "command": "openspec", "args": ["archive", "{change}", "--yes"] }
```

The archive moves the change directory to
`<changes>/archive/<YYYY-MM-DD>-<change>` (for example
`openspec/changes/archive/2026-11-11-implement-finite-counter`) and applies the
spec deltas to `openspec/specs` (the `specs` directory next to `<changes>`). The
runner commits both on the task branch. A failing archive command blocks the
task with its bounded failure output.

After the archive, the specification binding follows the files: every bound
path is re-keyed to the same file in the archived change directory, and each
file must exist there with the same hash. Otherwise the task is blocked with
`Archived specification differs from binding`. Later integrity checks (receipt,
publish and merge) use the archived paths.

**Receipt and Pull Request.** The result manifest accepts paths inside the task
scopes, the archived change directory and the `openspec/specs` files written by
the archive; any other path blocks the task. The receipt records the archived
specification paths and the resolved `target`. Receipts written before this
stage, with unarchived specification paths, stay valid. The Pull Request body lists the updated
documentation files under `Documentation updated`, the archived change directory
under `Archived change`, and, when there are any, the findings under
`Documentation outside scope`.

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
| lastStage | string or null; claim, investigate, plan, work, document, document-review, final-checks, archive, receipt, publish, pr or merge |
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
Documentation sessions and documentation reviews are not counted there, but
their token usage is part of `tokenUsage`.
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
`openspec-layout-created`, `harness-unavailable`, `test-framework-missing`,
`test-framework-analysis-failed`, `test-framework-prepared` or
`startup-or-run-failed` (target refusals and `invocation-running` are recorded
as `startup-or-run-failed`). Blocked tasks use safe `blockingReason` codes
`operation-incomplete` or `cancelled`. SIGINT and SIGTERM are handled
during startup and work through one guarded finalizer; SIGKILL, power loss and
crashes preventing cleanup cannot produce a termination record.

The ledger contains allowlisted metadata only. Authority instruction text,
worker prompts, private worker output and reports, findings text, check output,
file contents, environment variables and raw errors are excluded. Origin URL
userinfo credentials are removed. The approved completion summary is the
intentional public summary, not a private worker report.

## Step lines

While it works, the runner writes one short line to **stderr** immediately
before each logical step, before the step has any effect, so a person watching
the console always sees what the runner is about to do:

```text
[outcome-runner] HH:MM:SS <task id or run> <step>: <message>
```

For example:

```text
[outcome-runner] 09:05:01 run start: invocation=my-project-1 harness=claude model=claude-opus-5-5 effort=medium
[outcome-runner] 09:05:01 run preflight: checking OpenSpec
[outcome-runner] 09:05:03 TASK-1 claim: claiming the task
[outcome-runner] 09:05:04 TASK-1 worktree: preparing the worktree
[outcome-runner] 09:12:40 TASK-1 check: running 1/1: node (attempt 2)
[outcome-runner] 09:31:12 TASK-1 wait: waiting for mergeability and checks of #12
[outcome-runner] 09:33:02 run end: outcome exhausted
```

- `HH:MM:SS` is the local 24-hour time. The subject is `run` for run-level
  steps and the task id for task steps.
- Every line is a single English line of at most 120 characters. Control
  characters become spaces, and a longer line has its message cut so the line
  ends with `...` at exactly 120 characters. In the run start line the
  invocation and model are shortened to 16 characters and the harness and
  effort to 8 (ending with `...` when cut), so all four always appear; a value
  not chosen yet is shown as `auto`.
- Lines contain only fixed text and safe values: task ids, the invocation,
  harness, model and effort, a check or setup program name with its index, the
  Pull Request number, attempt numbers and the run outcome. They never contain
  secrets, worker output, file contents, check output, error messages, block
  reasons or other private diagnostics.

The run steps are `start`, one `preflight` line for each preflight (OpenSpec,
harness version, test framework), `cleanup` for each leftover worktree swept on
start, and `end` with the run outcome (`unavailable` when the run fails). The
task steps are `claim`, `worktree`, `setup` (each setup command),
`investigation`, `planning`, `planning check`, `planning review`,
`implementation`, `commit`, `check` (each product check), `review`,
`documentation`, `documentation review`, `final checks`, `archive`, `receipt`,
`integrate` (only when the target advanced), `push`, `pull request`, `wait`,
`merge`, `acceptance`, `cleanup`, and `blocked` (`stopped at <step>`, naming the
last step and never the reason).

- **Waits** log once when the wait starts, never on every poll: one `wait` line
  for mergeability and checks, one more when the pull request head is stale,
  and one `git lock: waiting for the Git lock` line when another runner holds
  the per-clone Git lock (nothing is written when the lock is free).
- **Retries** log again with ` (attempt N)`: planning and implementation
  attempts, documentation rounds, and the integrate, check, push, pull request,
  wait and merge steps repeated after the target advanced during the merge.
- **Resume**: steps already completed in the run state are not logged again.
  The first step line of work continued from the run state starts its message
  with `resuming`; later lines do not.

The JSON lines on stdout, the exit codes, the diagnostics file, receipts, the
run state and the statistics ledger are the same with and without step lines;
a failing stderr never changes the run. Tests inject the output through
`RunOptions.steps`.

## Mascot

When a task or a run ends, the runner plays a short animation of the terminal
mascot from `mascot/mascot.ts`, with a one-line caption. The previews of every
mood are in [mascot/README.md](mascot/README.md).

| When | Mood | Caption |
|---|---|---|
| A task is accepted and its Pull Request merged | `happy` | `<id> merged`, for example `OR-1 merged` |
| A task is blocked | `angry` | `<id> blocked: <reason>`, for example `OR-1 blocked: Worker plan incomplete` |
| The run ends `exhausted` | `celebrating` | `exhausted: <n> accepted, <m> remaining` |
| The run ends `limit-reached` | `content` | `limit-reached: <n> accepted, <m> remaining` |
| The run ends `incomplete` without blockers, only waiting for claimed or dependent work | `sleepy` | `incomplete: <n> accepted, <m> remaining` |
| The run ends `incomplete` with blockers | `sad` | `incomplete: <n> accepted, <m> remaining` |
| The run is cancelled by SIGINT or SIGTERM | `startled` | `cancelled: <n> accepted, <m> remaining` |
| The runner exits with code 4 (`unavailable`) | `dizzy` | `unavailable: 0 accepted, 0 remaining` |

- The blocked reason has its whitespace (including newlines) collapsed to single
  spaces and is cut to at most 60 characters, ending in `…` when it was longer.
  Without a reason the caption is `<id> blocked`. The reason is shown only in
  the caption on stderr; it is never added to stdout.
- The run mood and the status in its caption come from the final status and
  exit code, the same values the [run statistics ledger](#run-statistics-ledger)
  records. A SIGINT or SIGTERM that arrives after the terminal line was written
  therefore plays `startled` with `cancelled: ...`, while the stdout line keeps
  its status. `<n>` and `<m>` count the `accepted` and `remaining` arrays of the
  terminal line; a missing array counts as 0.
- The mascot is written to **stderr only**, and only when stderr is a terminal;
  nothing is drawn for a pipe, a file or CI. The JSON lines on stdout are
  byte-for-byte the same with and without the mascot. Animations never overlap,
  and the terminal line waits for a task animation that is still playing.
- SIGINT or SIGTERM stops a playing animation, and the cursor is shown again
  before the cancelled result is written.
- A failing mascot never changes the result line, the exit code, the run state
  or the statistics ledger.
- The `hash` command shows no mascot.

Turn the mascot off with the flag `--no-mascot`, which may appear once in any
order with the other flags:

```sh
outcome-runner ~/invocations/my-project-1.json --model=claude-sonnet-5-5 --no-mascot --effort=high
```

or with the environment variable `OUTCOME_RUNNER_MASCOT=0`:

```sh
OUTCOME_RUNNER_MASCOT=0 outcome-runner ~/invocations/my-project-1.json
```

Any argument that asks for the off switch keeps the mascot off, even a refused
one such as `--no-mascot=1`, so that refusal (exit code 4) plays no `dizzy`.

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
`claude` or `codex`. The test framework preflight is scripted the same way: a
scripted analysis session, answers, install executor, snapshots and in-memory
file writes, so no test starts a real harness, runs a package manager or uses a
real TTY. The archive command runs through an injectable command runner, so
tests archive with a scripted command and never run `openspec archive`. The
mascot tests inject a recording player through `main`, so they
need no real terminal or timers. Concurrent runners, the per-clone Git lock and
worktree cleanup are tested with Git fixtures (a bare origin and clones),
scripted pull request hosts and child processes. The `live:*` scripts exercise a real
harness; set `OUTCOME_TEST_HARNESS` to `claude` or `codex` (default `codex`).
Step lines are captured through `RunOptions.steps`.

## License

MIT
