# outcome-runner

Unattended OpenSpec outcome runner. It takes tasks from a queue committed in a
Git repository, implements each through its own OpenSpec change and Pull Request,
and records accepted results in the repository.

```sh
npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner
```

npm 12 refuses Git installs unless `--allow-git=root` is given. The package is
built from its TypeScript sources during the Git install;
`--allow-scripts=outcome-runner` lets npm run that build script of this package
(and of no other package).

To run it without a global install, replace `outcome-runner` in any command below:

```sh
npx --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner hash planning/outcomes.json
```

Run it from any directory inside the repository to work on. The project needs
Git, Node 24 or newer, the selected harness CLI, OpenSpec CLI, the configured
build tools and (for GitHub hosting) authenticated `gh`. The package has no
runtime dependencies beyond Node built-ins; TypeScript is used only to build it
during installation.

## Updating the runner

The install command also updates a global runner to the latest version:

```sh
npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner
outcome-runner --version
```

`outcome-runner --version` prints the version of the runner that is actually
installed, so an outdated global install is visible at once. Every run state,
ownership file, diagnostics file and statistics record also names the runner
version that wrote it (`runnerVersion`; see
[Runner version in run files](#runner-version-in-run-files)).

**Update the global runner only while no invocation is unfinished, or after
checking that the unfinished invocation can resume with the new runner.** Never
update it while a run is in progress. An invocation is unfinished while the
`status` in its `state.json` (under `~/.local/state/outcome-runner/`) is not
`released`. Before updating with an unfinished invocation, read
[Upgrading the runner or adding tasks during an invocation](#upgrading-the-runner-or-adding-tasks-during-an-invocation)
and the changelog of the new version: a newer runner resumes the same
invocation, but it may require a setting the invocation file lacks. Otherwise
finish the invocation first, or end it with
[`outcome-runner dispose`](#disposing-of-an-invocation).

## Quick start

**Before the first run:** the runner works unattended and **merges each accepted
Pull Request into the target branch itself**. If the target requires human
approval, the run ends incomplete and the Pull Request waits.

**1. Install once per machine, or use npx**

```sh
npm i -g --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner
outcome-runner --version
```

With npx nothing needs installing. Wherever a step below says `outcome-runner`,
write `npx --allow-git=root --allow-scripts=outcome-runner github:petarnenov/outcome-runner`
instead, and run it from inside the repository in the same way.
`outcome-runner --help` lists every command with its arguments.

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
queue, receipts or OpenSpec changes. Tasks may share scopes: a scope never
keeps another task from running. Smaller `priority` values run first.

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
outcome-runner hash planning/outcomes.json TASK-1
```

Without task ids every task is printed; with task ids only those. If you change
a task later, its hash changes and step 6 must be updated. See
[Version, help and task hashes](#version-help-and-task-hashes).

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
- Every dependency of a task the run will work must be in that set or already
  accepted on the target; otherwise the run is refused. See
  [Dependency check](#dependency-check).
- Leave out `coverage` (and `harness`, `model`, `effort`) to be asked for it
  when the run starts from a terminal; see [Harness selection](#harness-selection).
- The optional `pollSeconds` (an integer from 5 through 3600, default 60) sets
  how often a run polls while it waits for work held by other runners; see
  [Waiting for free work](#waiting-for-free-work).
- The optional `budgets` sets the review rounds and check attempts of the
  planning, implementation and documentation stages, each an integer from 1
  through 12, for example `"budgets": { "plan": { "reviews": 8 } }`; see
  [Review and check budgets](#review-and-check-budgets).

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
| 3 | Incomplete, for example a blocked task, a dependency inside the run that is blocked or a protected merge; `blockers` names every unfinished task and why (see [Unfinished results](#unfinished-results)). Work only claimed by other runners is waited for instead (see [Waiting for free work](#waiting-for-free-work)). A run cancelled by SIGINT or SIGTERM (`cancelled`) also exits 3 |
| 4 | Did not run; the printed `reason` and the `diagnostics` file explain why, for example `detached-head`, `target-differs-from-current-branch`, `target-missing-on-origin`, `unsupported-target-name`, `invocation-running`, `invocation-disposed`, `dependencies-outside-invocation`, `retry-not-blocked`, `missing-setting`, `invalid-poll-seconds`, `invalid-budget`, `openspec-missing` or `harness-unavailable` |

After an interruption, run the **same command with the same file** from the same
branch to resume. Do not delete the state under `~/.local/state/outcome-runner/`.
A task blocked because its review or check budget ran out stays blocked on such a
restart, unless the restart raises the exhausted limit above the used count with
`budgets`; otherwise give it a fresh budget with `--retry <task id>` (see
[Review and check budgets](#review-and-check-budgets)).
The runner also creates a `work-queue-claims-<target>` branch. It is never
merged; keep it while work is unfinished. When you no longer want an invocation,
end it with `outcome-runner dispose <invocation file>` instead of resuming it;
see [Disposing of an invocation](#disposing-of-an-invocation). Never edit the
claims branch or the ownership files by hand. Claims commits and task branch
deletions are pushed with `--no-verify`: they carry no product code and are
pushed from the start checkout while it has another commit checked out, so a
project pre-push hook that verifies the checked-out commit would refuse them.
Tested task heads are pushed from their worktree with the project's hooks, so a
refusing hook blocks the task. A newer runner resumes the same
invocation, and tasks can be added to it; see
[Upgrading the runner or adding tasks during an invocation](#upgrading-the-runner-or-adding-tasks-during-an-invocation).
Owners may keep merging Pull Requests into the target branch while a run is in
progress; see [When the target advances during a run](#when-the-target-advances-during-a-run).

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

When both hold, startup continues without any OpenSpec prompt or OpenSpec
output; only the step lines appear on stderr (see [Step lines](#step-lines)).

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

Steps 4 to 7 are questions only when the start is interactive (both stdin and
stderr are terminals, as in the OpenSpec preflight). The harness statuses, the
options and the questions are written to stderr; stdout keeps only the JSON
lines. Pressing Enter accepts the preselected answer shown in brackets, for
example `Harness [claude]: `. You may also type the number of an option or its
exact name. A value given by a flag (`--harness=`, `--model=`, `--effort=`,
`--coverage=`) or in the invocation file is used without asking for it.

Non-interactive starts (CI, a pipe, stderr redirected) ask nothing and print
nothing here apart from the step lines on stderr (see [Step lines](#step-lines)):
flags, the invocation file and the defaults `claude`, `claude-opus-5-5`,
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

A printed ID-to-hash map means the format is valid. A queue file that does not
exist is reported in one line on stderr, for example
`outcome-runner hash: queue file not found: planning/outcomes.json`, with exit
code 4. On `unavailable` (an invalid or malformed queue), the reason is in the
`diagnostics` file. Scope overlap with the queue, receipts or changes is only
detected when a run starts.

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
two runners never work on the same task at the same time, and each merges its
results into the branch they started from. Tasks with shared or overlapping
scopes run side by side; a runner whose task meets changes of another task in
the target merges them and resolves the conflicts (see
[When the target advances during a run](#when-the-target-advances-during-a-run)).
Runners on other machines can join with their own clones in the same way.

The repository is the Git top level of the current directory. State is kept per
clone and invocation under `$XDG_STATE_HOME/outcome-runner` (default
`~/.local/state/outcome-runner`). The invocation file must not set `root` or
`stateDirectory`, so one file serves every machine and every repository. Tasks
claimed by another run are skipped until accepted. A
run whose remaining work is only claimed by other runners, or waits for
dependencies they are still working, does not end: it waits for that work and
continues as soon as a task becomes free; see
[Waiting for free work](#waiting-for-free-work). Claims are never taken over
automatically. When the owner of an invocation no longer wants it, release its
claims with `outcome-runner dispose` on the machine and clone that ran it; see
[Disposing of an invocation](#disposing-of-an-invocation).

### Waiting for free work

When no remaining task can be picked, the runner looks at the blockers of every
remaining task and of every blocked task of the invocation (see
[Unfinished results](#unfinished-results)). When each of them is
`waiting-for-claim` (another runner holds a claim on the task) or
`waiting-for-dependency` (a dependency is not accepted yet), the work
becomes free without any action of this invocation: another runner merges its
task, or its owner releases the claim with `outcome-runner dispose`. The run
therefore does not end. It waits one poll interval, then fetches
`origin/<target>`, pulls the claims ledger again, recomputes which tasks are
accepted and picks the next free task, and repeats this until a task can be
picked or another ending applies (`exhausted`, `limit-reached`, `incomplete` or
`cancelled`). While it waits, `state.json` keeps `status` `running`, and the
invocation lock and the ownership stay held.

**Poll interval.** The optional invocation field `pollSeconds` sets the interval
in seconds: an integer from 5 through 3600, 60 when omitted. Any other value,
for example `4`, `3601`, `7.5` or `"60"`, is refused at startup, before any
preflight, lock, state, ownership file, claim or worktree, with exit code 4 and
reason `invalid-poll-seconds`; the private diagnostics file names the setting
`pollSeconds` and the refused value. `pollSeconds` is operational: it is not
part of the invocation identity, so a resumed invocation may use another
interval. Each poll costs one fetch and one claims ledger pull.

**Step line per poll.** Immediately before each sleep the runner writes one
`run wait` step line naming the tasks it waits for, sorted, each with the host
recorded in the claim that holds it (`unknown host` when the claim records no
host, `unclaimed` for a dependency no runner has claimed), for example:

```text
[outcome-runner] 10:02:00 run wait: waiting 60s for TASK-1 on build-host-1, TASK-3 on build-host-2
```

Unlike the task-level waits, which log once, this line is written on every poll;
see [Step lines](#step-lines).

**Cancel during the wait.** A SIGINT or SIGTERM during the wait ends the run at
once with `cancelled` (exit code 3); no further fetch, claims ledger pull, claim,
worktree or worker session follows. The `cancelled` result keeps the `blockers`
of the remaining tasks, `state.json` gets `status` `incomplete` and the ownership
stays held, so the same command resumes the invocation later.

**When a run still ends incomplete.** A run never waits for work nobody else can
finish. It ends at once with `incomplete` (exit code 3) and the existing
`blockers` when any remaining task or task of the invocation has a blocker of
another kind: a task `blocked` in this invocation's own state (including a
merged task whose acceptance recording failed) or a task that depends on such a
task. Other tasks of the invocation are worked first, whatever their scopes.
Repair or retry the blocked task
(see [Review and check budgets](#review-and-check-budgets)) and run the same
command again. The `exhausted` and `limit-reached` endings are unchanged: a
reached `maxAccepted` ends the run with `limit-reached` without waiting, also
while other tasks are claimed elsewhere.

**A claim that never frees.** A claim held by a runner that crashed and never
comes back makes the waiting run wait until it is cancelled. End that stale
invocation with `outcome-runner dispose` on the machine and clone that ran it
(see [Disposing of an invocation](#disposing-of-an-invocation)); the waiting run
claims the task at its next poll.

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
implementation review. The planning, implementation and documentation stages
are bounded by durable review and check budgets; see
[Review and check budgets](#review-and-check-budgets). When the target advances
into the task's scope, an `integrate` stage merges it and checks and reviews the
result again before the receipt is recorded anew; see
[When the target advances during a run](#when-the-target-advances-during-a-run).

Published work carries no temporary diagnostic files. Every implementation
session of the work stage is told to delete, with `delete_file`, each scratch or
diagnostic file it created before finishing, such as temporary debug tests,
captures or notes, and to keep only files the task needs; the conflict
resolution session after an integration does not get this instruction, while
the send-back session of a rejected clean integration does. The
implementation review, in the work stage and after an integration, reports
changes-required when the task changes still contain a file that only served
diagnosis, such as a temporary debug test, and names each such file by path in
its findings. In the work stage, like any other rejection, the findings go to
the next implementation session, which deletes the files, and the round counts
against the review budget. An integration review of a clean merge that names a
leftover file sends the merged result back once: the send-back session deletes
the file, and the task is blocked with the usual integration reason only when
the result is still rejected afterwards. A conflict integration blocks at once
(see [When the target advances during a run](#when-the-target-advances-during-a-run)).

## Project and authority

Commit a version 1 queue containing `tasks`. Each task has `id`, `title`,
`change`, integer `priority`, string-array `criteria`, product `scopes` and
`dependencies`. Smaller priority values run first. Each result has one OpenSpec
change and one PR. Scopes cannot overlap queue, receipt or OpenSpec roots.

Keep the invocation JSON outside the checkout. Supply a stable `invocation` name
(letters, digits, `.`, `_`, `-`), optional selected `leaves`, optional
positive `maxAccepted`, optional `pollSeconds` (see
[Waiting for free work](#waiting-for-free-work)) and optional `budgets` (see
[Review and check budgets](#review-and-check-budgets)). Omitted mode is OFF. `authority` contains the actual
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
outcome-runner hash path/to/queue.json [<task id>...]
outcome-runner /path/to/invocation.json [--harness=<claude|codex>] [--model=<id>] [--effort=<level>] [--coverage=<n>] [--no-mascot] [--retry <task id>]...
outcome-runner dispose /path/to/invocation.json [--remove-work]
outcome-runner --version
outcome-runner --help
```

Every start first resolves the [target branch](#target-branch), then runs the
[OpenSpec preflight](#openspec-preflight), then the
[harness availability check and selection](#harness-selection). After the invocation
lock, the authority check of the selected tasks and the
[dependency check](#dependency-check) follow, before any run state, ownership,
claim or worktree is created.

### Version, help and task hashes

- `outcome-runner --version` prints the version of the executing installation,
  read from its `package.json`, as one line on stdout (for example `0.20.1`) and
  exits with code 0.
- `outcome-runner --help` and `outcome-runner -h` print the commands and their
  arguments on stdout and exit with code 0.

Both must be the first argument; anything after them is ignored. They read no
queue, invocation or state file, play no mascot, append no
[run statistics](#run-statistics-ledger) record and create no diagnostics file.

`outcome-runner hash <queue file> [<task id>...]` prints one JSON line on stdout
that maps task ids to their hashes, in queue order, and exits with code 0.
Without task ids every task of the queue is printed; with task ids only those,
and an id given twice is printed once:

```sh
outcome-runner hash planning/outcomes.json TASK-2
{"TASK-2":"<hash of TASK-2>"}
```

A missing queue file argument, a queue file that does not exist (or is not a
regular file) and task ids the queue does not contain are reported as **one line
on stderr** naming the argument, without a stack trace, with exit code 4 and
nothing on stdout:

```text
outcome-runner hash: missing queue file argument
outcome-runner hash: queue file not found: planning/missing.json
outcome-runner hash: unknown task id: TASK-9
outcome-runner hash: unknown task ids: TASK-8, TASK-9
```

An argument containing a control character or a newline is shown quoted as JSON,
so the message stays one line. These errors create no diagnostics file. An
invalid or malformed queue still prints the `unavailable` line with a private
`diagnostics` file (exit code 4).

### Dependency check

The tasks a run works are its `leaves`, or every task in `authority.tasks` when
`leaves` is omitted. Before claiming anything, the runner checks every direct
dependency of each of these tasks (a dependency inside the set is itself checked
in the same way). A dependency is allowed when it is in the set, or when it is
already accepted: its receipt is valid at `origin/<target>` when the run starts.
A dependency that is neither, including an id the queue does not contain, is
missing.

When any task has a missing dependency, the run is refused with exit code 4 and
reason `dependencies-outside-invocation`. The stdout line is
`{"status":"unavailable","reason":"dependencies-outside-invocation","diagnostics":"..."}`,
and the private diagnostics file lists each task and its missing dependencies,
for example `"details": {"missing": {"B": ["A"], "C": ["A", "X"]}}`, with a
message such as `Dependencies outside the invocation are not accepted: B needs A; C needs A, X`.
No `state.json`, ownership record, claim or worktree is created. Add the missing
tasks to `leaves` (and `authority.tasks`), or accept them first in another run.
Because of this check a run never ends incomplete (exit 3) only because a
dependency outside the run can never be worked.

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
for that refusal. `--retry <task id>` takes the task id as the next argument and
may be given once per task id, in any position among the other flags (see
[Review and check budgets](#review-and-check-budgets)); `--retry` without an id,
with an id beginning with `-`, with the same id twice or as `--retry=<id>` is
refused with exit code 4 like any other invalid flag. A model not offered by the
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
on restart without changing saved state or ownership. A restart with another
changed authorised setting is refused the same way. A newer runner resumes the
invocation and migrates state written by an older runner, and tasks can be added
to an unfinished invocation; see
[Upgrading the runner or adding tasks during an invocation](#upgrading-the-runner-or-adding-tasks-during-an-invocation).
Do not erase
state or ownership to migrate active work. Start a new invocation only once the
previous work is reconciled and accepted or explicitly disposed under authority
with `outcome-runner dispose` (see
[Disposing of an invocation](#disposing-of-an-invocation)).
Claude uses only a loopback private MCP broker, with native tools, ambient MCP,
custom plugins, skills and hooks disabled. CLI output and bounded failure details
remain private. Bundled infrastructure plugin metadata is allowlisted and does
not grant tools. Global harness settings are never rewritten.

Restart with the same configuration and state directory. Do not delete ownership
or state files to evade unfinished work; dispose of the invocation instead.
Private worker output and reports stay in state. A worker session ending does not
stop the controller.

`maxAccepted` counts only tasks of the invocation that were newly accepted during
the durable invocation: tasks whose acceptance this invocation recorded, and
merged tasks of the invocation whose acceptance recording failed. It does not
count prior completion, tasks accepted by other runners, proposals, attempts or
worker sessions. A reached bound is successful (`limit-reached`, exit 0) with the
remaining task IDs reported and explained. Too few accepted results, blocked
tasks, dependencies inside the run that are blocked or protected merges return
incomplete without asking a person anything;
work that only waits for foreign claims or their dependencies is waited for (see
[Waiting for free work](#waiting-for-free-work)). Independent work
proceeds whatever scopes other tasks hold. Receipts validate outputs at their
first accepted target commit; later ordinary
changes preserve historical acceptance. Removed or altered receipts do not prove
completion. A target that advanced without touching the task scopes, the change
directory, the archived change directory or the `openspec/specs` files written by
the archive is merged into the result and all final checks run again. A target
change inside any of them is merged as well, and the merged result is checked
and reviewed again before it is published; see
[When the target advances during a run](#when-the-target-advances-during-a-run).

When a task is merged but recording its acceptance fails (for example its
original claim time cannot be recovered), the task is recorded as blocked and
the run keeps working the other tasks it can select, unless `maxAccepted` is set
and reached, in which case it stops at once. Either way the run still ends with
exit code 3 (`incomplete`) and a `blocked` entry for that task, keeps its
ownership, and the next run of the same invocation retries the acceptance.

### Lost network connection

When a Git or `gh` command fails because the connection cannot be made (the
host cannot be resolved, or the connection is refused or unreachable), the
runner waits and runs the same command again: after 5, 10, 20 and 40 seconds,
then every 60 seconds, about 15 minutes in total. The request never reached the
server, so repeating it is safe. Each wait is logged as a step line, for example
`run network: connection lost at git fetch origin; retrying in 5 s (attempt 2)`.
Other failures are not retried. When the connection is still lost after the last
wait, the run ends as before with `unavailable`; run the same invocation again
once the connection is back and it resumes the recorded work.

### Unfinished results

An `incomplete` result (exit code 3) and a `limit-reached` result carry
`blockers`, an object keyed by task id, whenever a task remains or a task of the
invocation is blocked. Every task in `remaining` has an entry, so `blockers` is
never empty while `remaining` is not; a blocked task that is no longer remaining
(a merged task whose acceptance recording failed) keeps its entry too. An
`incomplete` result with nothing remaining and nothing blocked (a run with
`maxAccepted` that accepted every task before reaching the limit) has no
`blockers`. Each entry has a `kind` and a public `reason` code; the first
matching kind is used, in this order:

| `kind` | Meaning | Other fields |
|---|---|---|
| `blocked` | The task stopped at a stage of this invocation | `reason` `operation-incomplete` (or `review-budget-exhausted` or `check-budget-exhausted` with the exhausted `budget`, see [Review and check budgets](#review-and-check-budgets); or `target-conflict-unresolved` with the conflicting `paths`, `target-integration-rejected` or `target-keeps-advancing`, see [When the target advances during a run](#when-the-target-advances-during-a-run)), `stage` and `diagnostics` (the private `state.json` path) |
| `max-accepted` | The task was not started because `maxAccepted` was reached | `reason` `max-accepted`, `limit` |
| `waiting-for-dependency` | A dependency is not accepted yet (for example blocked in this run) | `reason` `waiting-for-dependency`, `dependencies` (the ids not accepted) |
| `waiting-for-claim` | Another runner holds a claim on the task | `reason` `waiting-for-claim`, `claim` with the claimed task `id` and `host` |

For example:

```json
{"status":"incomplete","accepted":[],"remaining":["A","B"],"completions":{},"blockers":{"A":{"kind":"blocked","stage":"investigate","reason":"operation-incomplete","diagnostics":"/home/me/.local/state/outcome-runner/.../state.json"},"B":{"kind":"waiting-for-dependency","reason":"waiting-for-dependency","dependencies":["A"]}},"claimedElsewhere":{}}
```

The private failure message of a blocked task stays in `state.json`; it is never
written to stdout. `claimedElsewhere` still lists foreign claims by task id. A
run whose blockers are all `waiting-for-claim` or `waiting-for-dependency` does
not return `incomplete`; it waits (see
[Waiting for free work](#waiting-for-free-work)). A `cancelled` result carries
`blockers` only when it was cancelled during that wait; then they are the
blockers of its remaining tasks computed before the wait. Any other `cancelled`
result carries no `blockers`.

### Review and check budgets

Every task has a durable budget, saved in its work state in `state.json` as
`budget` (`plan`, `work` and `document`, each with the used `reviews` and
`checks`). It bounds the planning, implementation and documentation stages.
Without a `budgets` setting the limits are:

| Stage | Review rounds | Check attempts |
|---|---|---|
| `plan` (planning and planning review) | 6 | 4 failing planning check runs (the OpenSpec packet or `planningCheck`) |
| `work` (implementation and implementation review) | 4 | 4 failing product check runs (`checks`) |
| `document` (documentation and documentation review) | 4 | 0 (the stage runs no checks) |

- **Review budget.** A review round is counted when its review session is about
  to start, before the session runs, so a review session that fails or crashes
  still uses its round. A review that does not accept with zero findings sends
  its findings to a new worker session of the stage while rounds remain.
- **Check budget.** A failing planning check or product check run of the stage
  uses one check attempt and **never a review round**; the worker gets another
  session of the same stage to fix it while attempts remain, and no review
  starts for the failing run. The `run_checks` calls a worker makes inside its
  own session do not count. The integration checks and reviews of an
  [advanced target](#when-the-target-advances-during-a-run), the send-back
  session and the final checks have no budget. A clean integration gets one
  send-back session before it blocks; a conflict integration and the final
  checks block on their first failure.
- **Restarts keep the counts.** A restart of the invocation without `--retry`
  continues from the recorded counts and never resets them; it allows further
  rounds and attempts only up to the limits configured for that restart. A
  blocked task is still resumed (for example after a failed session). A task
  whose budget ran out is resumed as well when the restart sets the exhausted
  limit above its used count (see [Raising a limit](#raising-a-limit) below);
  otherwise it is blocked again at once, without any worker or review session.
  State written before budgets existed takes its used review rounds from the
  recorded planning, implementation and documentation reviews, with no check
  attempts used.

**Reviews that converge.** Every planning, implementation and documentation
review prompt, including the implementation and documentation reviews of an
[integration](#when-the-target-advances-during-a-run), tells the reviewer to
report every finding it can find in this round, not only the first ones, so
that the next round can address them all, and to report accepted only with zero
findings. From the second review round of the planning, implementation or
documentation stage, the review prompt also lists the findings of the earlier
review rounds of that stage for the task, in recorded order with their round
numbers, for example
`[{"round":1,"findings":["a"]},{"round":2,"findings":["b","c"]}]`, and tells
the reviewer to check first that each of them was resolved; the reviewer may
still report new findings. The first review round of a stage lists no earlier
findings, a review session that failed before reporting adds none, and the
findings of another stage are never listed. Reviews recorded before a `--retry`
stay earlier rounds of their stage. The integration reviews list no earlier
findings: their one send-back session already carries them.

**The `budgets` setting.** The optional invocation field `budgets` sets the
limits of a stage: `budgets.<stage>.reviews` (review rounds) and
`budgets.<stage>.checks` (check attempts) for the stages `plan`, `work` and
`document`, except `budgets.document.checks` (the documentation stage runs no
checks). Each value is an integer from 1 through 12. A given value replaces the
default of that stage and part; an omitted one keeps the default. For example,
8 planning review rounds and 2 failing product check runs, with every other
limit at its default:

```json
"budgets": { "plan": { "reviews": 8 }, "work": { "checks": 2 } }
```

Any other value or shape is refused at startup, before any preflight, lock,
state, ownership file, claim or worktree, with exit code 4 and reason
`invalid-budget`: a value that is not an integer from 1 through 12 (for example
`0`, `13`, `2.5` or `"4"`), `budgets.document.checks`, an unknown stage or
field (for example `budgets.review` or `budgets.work.rounds`), a stage that is
not an object (for example `"plan": 5`) or a `budgets` that is not an object
(for example an array). The private diagnostics file names the offending field
in `details.setting`, for example `budgets.plan.reviews` (`budgets` for the
whole value), and the refused value in `details.value`. `budgets` is
operational: it is not part of the invocation identity, so a restart with other
budgets resumes the same invocation and is never refused as incompatible.

When a budget runs out the task is blocked. Its private reason in `state.json`
names the stage, whether reviews or checks ran out, and the used and allowed
counts of both, for example
`Implementation review budget exhausted: 4 of 4 review rounds and 0 of 4 check attempts used`
or `Planning check budget exhausted: 1 of 6 review rounds and 4 of 4 check attempts used`.
The blocked entry also has `budget` with `stage`, `exhausted` (`reviews` or
`checks`), `reviews` and `checks`, each with `used` and `limit`. The public
blocker in the run result (see [Unfinished results](#unfinished-results)) has
`reason` `review-budget-exhausted` or `check-budget-exhausted` and the same
`budget`, for example
`{"kind":"blocked","stage":"work","reason":"review-budget-exhausted","diagnostics":"...","budget":{"stage":"work","exhausted":"reviews","reviews":{"used":4,"limit":4},"checks":{"used":0,"limit":4}}}`.
Each `limit`, in the private reason, the blocked entry and the public blocker,
is the limit in force for the run that blocked the task: the configured
`budgets` value of that run, or the default. Every other blocked task keeps its
reason, for example `operation-incomplete`.

#### Raising a limit

A task blocked by an exhausted budget resumes without `--retry` when the
invocation is restarted with a `budgets` limit above its used count, for example
`"budgets": { "work": { "reviews": 6 } }` after 4 of 4 implementation review
rounds. It continues at its recorded stage with its used counts and the
recorded findings (the next worker session of the stage starts first), so the
example allows two more implementation review rounds. No retry record is
written, and its receipt has no `retries`. A restart whose limit is not above
the used count blocks the task again at once, without any session, and reports
the limit of that restart; a limit lowered below the used count shows, for
example, `"reviews":{"used":4,"limit":3}`.

**`--retry <task id>`.** Only the owner grants a blocked task a fresh budget, by
restarting the invocation with `--retry <task id>` (once per task id, for
several tasks repeat it):

```sh
outcome-runner ~/invocations/my-project-1.json --retry TASK-1
```

The task's used review rounds and check attempts are reset to zero before it
resumes at its recorded stage, under the limits of that restart. Each retry is
recorded with the task id (`task`), the time (`at`), the `stage`, the
`previous` budget and the `exhausted` budget (with the limits in force when the
task was blocked), when there was one, both in the task's work state
(`retries`) and in `retries` of
`state.json`. The task's receipt lists its retries in `retries`; receipts of
tasks never retried have no such field. `--retry` is an operational option: it
is never part of the invocation identity. A `--retry` for a task that is not a
blocked task of the invocation (for example a task that was accepted after an
earlier retry) is refused with exit code 4 and reason `retry-not-blocked`, before
any ownership, claim or session and without changing any budget or retry record;
the private diagnostics file lists the ids in `details.tasks`.

### Invocation status

`state.json` in the invocation's state directory records in `status` the last
invocation status the runner reached, written before the process exits:

| `status` | When |
|---|---|
| `starting` | The state was just created; the run has not reached its first task selection |
| `running` | Written after the leftover sweep, before the first task is selected, and kept while the run [waits for free work](#waiting-for-free-work); a run that ends with an error after that keeps it |
| `released` | The ownership was released: every task accepted without a blocked task, or the limit reached with no blocked task and no in-progress work, even when unstarted `max-accepted` tasks remain, or the invocation was [disposed](#disposing-of-an-invocation) (then `state.json` also has a `disposed` record) |
| `blocked` | A `limit-reached`, `incomplete` or `cancelled` result keeps a blocked task of the invocation, including a merged task whose acceptance recording failed |
| `completed` | A `limit-reached` result keeps in-progress work and has no blocked task |
| `incomplete` | Any other `incomplete` or `cancelled` result, for example a run cancelled while it waited for a foreign claim |

In-progress work is the current task of the run or recovered work of an earlier
run that is claimed but neither accepted nor blocked and is kept for a later
run. Unstarted tasks explained as `max-accepted` are not in-progress work. A
`limit-reached` run therefore exits 0 with `status` `released` when nothing else
is held, `completed` when it keeps in-progress work, and `blocked` when it keeps
a blocked task, so `state.json` never hides a block.

## Upgrading the runner or adding tasks during an invocation

An unfinished invocation can be resumed by a newer runner, and its owner can add
tasks to it, without losing its claims, worktrees, reviews or accepted tasks.

**What is frozen.** The invocation identity (identity schema 2) contains only
what the owner authorised: the invocation name, the repository root, the
authority (`reference`, `instruction`, `target` and the task ids with their
hashes in `tasks`), the project `target`, `queue`, `changes` and `receipts`, the
harness, model, effort and coverage, the checks (`checks`, `planningCheck` and
`setup`; an omitted `setup` equals `[]`) and the leaves. Runner defaults such as
the `archive` command, operational settings such as `maxAccepted`, `pollSeconds`,
`budgets`, `commitScope`, `commitSuffix` and `repository`, the runner version, and settings
a newer runner introduces are not part of it, so they never make a resumed
invocation incompatible.

**Upgrading the runner.** Stop every run of the invocation, install the newer
runner (see [Updating the runner](#updating-the-runner)), check it with
`outcome-runner --version`, and run the same command with the same invocation
file from the same branch. The unfinished task resumes
at its recorded stage with the same claim, branch and worktree, and the
operations, reviews and accepted tasks recorded before are kept. A harness,
model, effort or coverage that neither a flag nor the invocation file sets is
taken from the frozen identity, never from a newer default. State written by an
older runner, whose identity was the whole resolved configuration, is migrated
in place when its recorded identity is intact and matches; the operation ids
recorded before stay the same, so no effect is repeated. A legacy state whose
recorded identity was edited by hand is refused with
`Run state is incompatible` and left unchanged.

**Missing required setting.** A newer runner may require a setting the
invocation file lacks. The run is then refused with exit code 4 before the
OpenSpec preflight and before any lock, state, ownership file, claim or worktree
is touched:

```json
{"status":"unavailable","reason":"missing-setting","setting":"project.example","example":"value","diagnostics":"..."}
```

`setting` is the dot path of the setting in the invocation file and `example` an
example value; the diagnostics message shows it nested, for example
`{"project":{"example":"value"}}`. Add exactly that setting to the invocation
file and run the same command again: the durable state is kept and the
unfinished work resumes at its recorded stage. Only the path of a required
setting and a hash of its value are stored, never the value. This release of
the runner requires no such setting.

**Adding tasks.** Add the new tasks to the queue on `origin/<target>`, print
their hashes with `outcome-runner hash <queue file> <task id>...`, add them to
`authority.tasks` of the
unfinished invocation (and to `leaves`, when the file sets `leaves`) and run the
same command again. The added tasks pass the same authority and
[dependency checks](#dependency-check) as the others. Existing claims,
worktrees, reviews and accepted tasks are kept: the current task resumes first
at its recorded stage, blocked tasks are recovered next, and only then are the
remaining tasks, existing and added, claimed in queue order (smaller `priority`
first, then id).

**Still refused.** Removing a task from `authority.tasks` or `leaves` and
changing a task hash are refused as before, and `state.json` stays unchanged. A
hash that no longer matches the queue is refused with
`Task source differs from frozen authority`; a removed task, or a task whose
definition changed in both the queue and `authority.tasks`, is refused with
`Run state is incompatible`. A changed harness, model, effort, coverage, check or
authority field is refused in the same way.

**Records.** Every such change is appended to `changes` in `state.json`:

| `kind` | Fields | When |
|---|---|---|
| `identity-upgraded` | `from` (1), `to` (2), `at` | State written by an older runner was migrated |
| `setting-added` | `setting`, `at` | A required setting was added to the invocation file |
| `tasks-added` | `tasks` (the sorted new ids), `at` | Tasks were added to `authority.tasks` or `leaves` |

Every receipt written afterwards lists the changes recorded so far in
`invocationChanges`. Receipts of invocations without changes have no such
field.

### Runner version in run files

Every file the runner writes for an invocation outside the repository history
names the version of the runner that wrote it in `runnerVersion`, the `version`
of the installed `package.json` (`unknown` only when no `package.json` of the
installation can be read):

| File | `runnerVersion` is |
|---|---|
| `state.json` in the invocation's state directory | the runner that last wrote the state; every write, also by `dispose`, sets it |
| the ownership file `.work-queue-locks/<hash>-<hash>-owner.json` beside the checkout | the runner that last wrote it, including when it is released at the end of a run or by `dispose` |
| every diagnostics file `error.json` named by an `unavailable` line | the runner that refused or failed |
| every [run statistics](#run-statistics-ledger) record | the executing runner |

A `state.json` or ownership file written by an older runner without
`runnerVersion` is still read and resumed as before; the next write adds the
field. The runner version is never part of the invocation identity and never
decides ownership, so updating the runner never makes a resume incompatible.
Receipts committed to the repository do not carry it.

## Disposing of an invocation

Dispose of an invocation when its owner no longer wants it: a task stays
blocked, an experiment is abandoned or the plan changed. Until then its claims
make other invocations wait (`waiting-for-claim`), its ownership stays held and
its `state.json` keeps saying `blocked` or `incomplete`. One command ends it:

```sh
cd /path/to/project
git switch main
outcome-runner dispose ~/invocations/my-project-1.json
outcome-runner dispose ~/invocations/my-project-1.json --remove-work
```

Run it like the run itself: on the machine and in the clone that ran the
invocation, from inside the repository, on the target branch, with the same
invocation file. It resolves the same repository root, target and state
directory as a run. `--remove-work` is its only flag and may appear once; any
other argument is refused with exit code 4. Dispose plays no mascot and appends
no [run statistics](#run-statistics-ledger) record.

Dispose first checks that the state of that invocation exists: a `state.json` of
the same invocation name, repository and target. Otherwise it is refused with
exit code 4 and reason `unknown-invocation`, before any file, directory or lock
is created. While a process of the invocation is running it is refused with exit
code 4 and reason `invocation-running` and changes nothing; stop the run first.
Then it:

1. records the unaccepted work of the invocation (its current and blocked
   tasks) in `state.json` under `disposed` and sets `status` to `released`;
2. removes the invocation's own claims of unaccepted tasks from
   `work-queue-claims-<target>` in **one commit** named
   `chore(<commitScope>): release claims of invocation <name>`, pushed without
   force (a moved claims branch is pulled again and retried);
3. with `--remove-work`, removes the worktrees, local branches and remote
   branches of the unaccepted tasks;
4. marks the invocation's ownership file released.

The `state.json` and ownership file it writes carry the `runnerVersion` of the
runner that disposed (see [Runner version in run files](#runner-version-in-run-files)).

**Untouched.** Accepted tasks, their claims, receipts and `completed` entries and
their merged Pull Requests are never changed. Claims of other invocations, the
ownership files and states of other invocations, and anything of another
repository are never touched.

**Work.** By default the worktrees (`<primary>-outcomes/<operation>`), local
branches and remote branches of the unaccepted tasks are **kept** and listed, so
finished work can still be inspected. With `--remove-work` they are removed; a
worktree is removed only when it lies below `<primary>-outcomes`. Each step is
tried on its own, and a step that fails is listed as `failed`.

**Pull Requests.** Open Pull Requests of the unaccepted tasks are listed and
**never merged**. Removing a remote branch with `--remove-work` may let the forge
close its open Pull Request. When the host cannot be asked, a Pull Request
recorded in the state is listed with `state` `unknown`.

Dispose prints one JSON line on stdout and exits with code 0:

```json
{"status":"disposed","invocation":"my-project-1","releasedClaims":["TASK-1"],"ownership":"released","work":[{"id":"TASK-1","worktree":{"path":"/path/to/project-outcomes/3f2a...","state":"kept"},"localBranch":{"name":"outcome/TASK-1-3f2a9c1b0d4e","state":"kept"},"remoteBranch":{"name":"outcome/TASK-1-3f2a9c1b0d4e","state":"kept"}}],"openPullRequests":[{"id":"TASK-1","number":12,"url":"https://github.com/OWNER/REPOSITORY/pull/12","branch":"outcome/TASK-1-3f2a9c1b0d4e","state":"OPEN"}]}
```

| Field | Meaning |
|---|---|
| `status` | `disposed`, or `nothing-to-release` when no claim was released, the ownership file was not changed and `state.json` was not written |
| `invocation` | The invocation name |
| `releasedClaims` | Ids of the claims removed from the claims branch |
| `ownership` | `released`, `already-released`, or `absent` when the invocation has no ownership file |
| `work` | Per unaccepted task, sorted by id: `worktree` (`path` and `state`; omitted when the path is unknown), `localBranch` and `remoteBranch` (`name` and `state`); `state` is `kept`, `removed`, `absent` or `failed` |
| `openPullRequests` | Per open Pull Request, sorted by id: `id`, `number`, `url` (when known), `branch` and `state` (`OPEN`, or `unknown` when the host could not be asked) |

| Exit code | Meaning |
|---|---|
| 0 | Disposed, or nothing was left to release |
| 4 | Refused or failed; the `reason` is `unknown-invocation`, `invocation-running`, a [target branch](#target-branch) refusal (`detached-head`, `target-differs-from-current-branch`, `target-missing-on-origin`, `unsupported-target-name`) or `startup-or-run-failed` (for example an invalid argument or an unreadable invocation file), with a private `diagnostics` file |

Running dispose twice is safe: the second run reports `nothing-to-release`,
leaves `state.json` and the claims branch unchanged, and lists the kept work
again (run it with `--remove-work` to remove that work later). A fully accepted
invocation has nothing to dispose; its `state.json` stays byte for byte
unchanged.

A disposed invocation is never resumed, so its kept work is never picked up
without a claim: running the same invocation file again is refused with exit
code 4 and reason `invocation-disposed` before any ownership, claim or worktree
is touched. Start further work with a **new invocation name**.

This command replaces every manual edit of ownership files beside the checkout
or of claim files on the claims branch; do not edit either by hand.

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
the implementation stage it allows at most 4 review rounds without a `budgets`
setting (`budgets.document.reviews` sets another limit), counted durably
in `budget.document.reviews` when each documentation review session starts (see
[Review and check budgets](#review-and-check-budgets)); after that the task is
blocked with
`Documentation review budget exhausted: 4 of 4 review rounds and 0 of 0 check attempts used`
and the public reason `review-budget-exhausted`. A restart in `document-review`
after the fourth review session failed blocks again without a fifth review.
After acceptance the project `checks` run again (`final-checks`); a failure
blocks the task before the archive.

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
specification paths and the resolved `target`, and the task's owner retries in
`retries` when it was retried with `--retry`. Receipts written before this
stage, with unarchived specification paths, stay valid. The Pull Request body lists the updated
documentation files under `Documentation updated`, the archived change directory
under `Archived change`, and, when there are any, the findings under
`Documentation outside scope`.

## When the target advances during a run

Owners may merge Pull Requests into the target branch while invocations run,
including changes inside a running task's scopes. A task is never blocked only
because the target advanced. The runner merges the advanced target into the
task branch in the task worktree (never in the checkout it was started from,
whose HEAD, branch, index and working tree stay untouched; that checkout only
sees `git fetch origin <target>`), runs the frozen product checks on the merged
result again and merges the Pull Request only while `origin/<target>` still
equals the target it merged and checked.

**Comparisons with origin.** The runner fetches `origin/<target>` and compares
it:

1. before it publishes the task branch, with the target the task branch was
   last integrated with; every publish pass starts with this comparison;
2. while it waits for the Pull Request, with the checked target (the target the
   tested head was merged with and checked);
3. immediately before merging: once in the Pull Request view that leads to the
   merge request, and again through a target guard that the Pull Request host
   calls after GitHub reports the Pull Request mergeable and right before
   `gh pr merge --merge --match-head-commit <tested head>`. A guard that finds a
   different target issues no merge command. The merge always uses the exact
   checked head with `--match-head-commit`, so no unchecked combination of task
   head and target reaches the target.

When the target differs, the runner compares the files the target changed since
the task's recorded base with the task's guarded paths: the files the task
itself changed, its change directory and, after the archive, the archived
change directory and the `openspec/specs` files written by the archive. A
change of the target elsewhere inside the task scopes is not guarded, so tasks
that share scopes do not repeat each other's reviews.

**Change outside the guarded paths.** The target is merged into the task branch
in the task worktree with a `chore(<commitScope>): integrate <target> into <id>`
commit, the `setup` commands and the product checks run again on the merged
result and the tested head is pushed. The recorded base stays the same and no
new implementation or documentation review session runs. When the product
checks fail on that merged result, the task is not blocked: it enters the
`integrate` stage below for the merged target, so the reviews run again and the
worker gets its send-back session.

**Change inside the guarded paths.** The task is not blocked. It enters the
durable `integrate` stage: the runner merges the advanced target into the task
branch in the task worktree (with the same commit subject) and records the
merged target as the task's new base in `state.json`, together with an
`integration` record holding the `target`, the `previousBase`, the conflicting
paths (`conflicts`), the `outcome` (`clean` or `conflict`) and the current
`step`. Then, before the Pull Request is published or updated:

1. a merge with conflicts gets one worker session to resolve them (see below);
2. the `setup` commands and the product checks run again;
3. a new implementation review session reviews the merged result;
4. a new documentation review session reviews it as well;
5. when the checks or a review do not accept the merged result, one
   send-back session repairs it and the checks and both reviews run again (see
   below).

Earlier acceptances are never reused for the new base: the accepted review, the
checks, the final checks, the tested head and the tested target are cleared
when the integration starts. After both reviews accept, the receipt is recorded
again with the new base, the new review and a manifest of the task's changes
relative to the new base; then the usual publish, Pull Request and merge
follow. An open Pull Request is reused and updated by the next push. Each
finished integration is appended to `integrations` in the run state.

**Repeats and the attempt limit.** When `origin/<target>` advanced again before
the merge, the runner repeats the worktree merge, the checks (and, for a change
inside the guarded paths, the reviews) and the comparison, then merges the new
checked head. Each comparison while waiting for or immediately before the merge
that finds a different target counts as one attempt, recorded in
`targetAttempts` in `state.json`. After 10 attempts without an unchanged target
the task is blocked with reason `target-keeps-advancing`: nothing is merged, the
worktree, the local branch and the remote task branch are kept, and the attempt
count is reset. A restart of the same invocation continues in that worktree
with the worktree merge of the current target and 10 fresh attempts.

**Conflicts.** When the merge conflicts, the worker gets exactly one worker
session (an implementation session) with the conflicting paths, to resolve them
while keeping the intent of both sides. The session may write the task scopes
and the conflicting paths, wherever they are, including the archived change and
`openspec/specs` files. The runner then
checks that no conflicting file still has a conflict marker (a line starting
with `<<<<<<< ` or `>>>>>>> `) and no path is left unmerged, and concludes the
merge; the checks and the reviews of the merged result follow. A merge of a
change outside the guarded paths that conflicts is aborted and handed to the
`integrate` stage, so it is handled the same way.

**Send-back after a rejected merge.** When the setup or product checks,
the implementation review or the documentation review do not accept the merged
result, with or without resolved conflicts, the task is not blocked at once. The worker gets
one send-back session: one worker session (an implementation session) given the
failed check output or the review findings, which may write only inside the
task scopes and the paths that conflicted. The OpenSpec change is already
archived at that point, so writes to its files, or to any other path outside
the task scopes and the conflicting paths, are refused, and only those paths are
committed after the session (as a
`fix(<commitScope>): address the integration findings of <id>` commit when
anything changed).
After the send-back session the checks and both reviews run again.
When all of them accept, the task continues to the receipt, publishing and
merging. Otherwise it is blocked with `target-integration-rejected`, and the
last findings or check output stay in `state.json`: in `findings` and in
`integration.sendBack`, which records the `cause` (`checks`, `review` or
`document-review`), the `findings` given to the session, the `session` state
(`pending`, `started` or `finished`), the `outcome` (`accepted` or `rejected`)
and, after a rejection, the last `rejection` with its cause and findings. A
finished integration keeps its `sendBack` record in `integrations`. The
send-back session uses no review or check budget. A restart never grants a
second send-back session for the same target commit; a later advance of the
target is a new integration with its own send-back.

**Blocking reasons.**

| Reason | When |
|---|---|
| `target-conflict-unresolved` | A merge with conflicts: the resolution session fails, or conflict markers or unmerged paths remain. The conflicting `paths` are recorded with it |
| `target-integration-rejected` | A merge, with or without resolved conflicts, whose checks or reviews are still rejected after the one send-back session |
| `target-keeps-advancing` | The target advanced before the merge in 10 consecutive attempts; the task keeps its worktree and branches and a restart continues |

The reason (and, for a conflict, the `paths`) is stored in the task's `blocked`
entry in `state.json` and appears in its `blocked` entry of `blockers` in the
run result (see [Unfinished results](#unfinished-results)), for example
`{"kind":"blocked","stage":"integrate","reason":"target-conflict-unresolved","diagnostics":"...","paths":["src/counter/result.mjs"]}`.
A task whose [review or check budget](#review-and-check-budgets) ran out has
`review-budget-exhausted` or `check-budget-exhausted`; every other blocked task
keeps the reason `operation-incomplete`.

**Restarts.** Every integration step is saved in `state.json` before the next
effect. `integratedTargets` lists every target commit merged into the task
branch, oldest first, and `targetAttempts` the current attempt count. After a
cancellation or a restart of the invocation, the run resumes from the last
integrated target at the recorded step with the recorded base and attempt
number: it never merges the target a second time, runs only the outstanding
resolution session, send-back session, checks and reviews, and never reuses an
acceptance from before the merge. A recorded send-back session that already
started is never started again: the restart commits what the session left in the
task worktree and runs the checks and both reviews, which decide the outcome. A
later run that recovers a blocked integration also resumes it at its recorded
step.

## Run statistics ledger

Each runner execution appends one compact JSON object and newline to
`$XDG_STATE_HOME/outcome-runner/runs.jsonl`. The default is
`~/.local/state/outcome-runner/runs.jsonl`; unset, empty or relative
`XDG_STATE_HOME` uses that default. The hash command never creates a ledger,
even when hashing fails, and neither do the dispose command, `--version` and
`--help`. A resumed invocation is a new execution with a new `runId`.

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
| runnerVersion | string, executing package version, not a hardcoded release (the same value `outcome-runner --version` prints) |
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
| lastStage | string or null; claim, investigate, plan, work, document, document-review, final-checks, archive, integrate, receipt, publish, pr or merge |
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
`openspec-layout-created`, `harness-unavailable`, `missing-setting`
or `startup-or-run-failed` (target refusals, `invocation-running`,
`invocation-disposed`, `retry-not-blocked`, `invalid-poll-seconds`,
`invalid-budget` and `dependencies-outside-invocation` are recorded as
`startup-or-run-failed`).
Blocked tasks use safe `blockingReason` codes
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
[outcome-runner] 09:31:15 TASK-1 compare: comparing origin/main with the checked target
[outcome-runner] 09:31:15 TASK-1 merge: merging #12
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
  harness, model and effort, the target branch name (in the `integrate`,
  `compare` and `retry` lines), a check or setup program name with its index,
  the Pull Request number, attempt numbers, the poll interval and the hosts
  recorded in claims (in the run `wait` line) and the run outcome. They never
  contain commits, secrets, worker output, file contents, check output, error
  messages, block reasons or other private diagnostics.

The run steps are `start`, one `preflight` line for each preflight (OpenSpec,
harness version), `cleanup` for each leftover worktree swept on
start, `wait` once per poll while the run
[waits for free work](#waiting-for-free-work), and `end` with the run outcome
(`unavailable` when the run fails). The
run start and run end lines cover the run from the OpenSpec preflight onward.
Refusals before the OpenSpec preflight, such as an invalid flag, an unreadable
invocation file or a [target branch](#target-branch) refusal, exit with code 4
without writing any step line. A `missing-setting` refusal (see
[Upgrading the runner or adding tasks during an invocation](#upgrading-the-runner-or-adding-tasks-during-an-invocation)),
an `invalid-poll-seconds` refusal (see
[Waiting for free work](#waiting-for-free-work)) and an `invalid-budget`
refusal (see [Review and check budgets](#review-and-check-budgets))
write only the run `start` line and the run `end` line with outcome
`unavailable`, and no `preflight` line. The task steps are `claim`, `worktree`, `setup`
(each setup command), `investigation`, `planning`, `planning check`,
`planning review`, `implementation`, `commit`, `check` (each product check),
`review`, `documentation`, `documentation review`, `final checks`, `archive`,
`receipt`, `compare` (each comparison with origin), `integrate` (only when the
target advanced), `send-back` (only when a rejected clean integration is sent
back), `push`, `pull request`, `wait`, `merge`, `retry` (only when
the target advanced before the merge), `acceptance`, `cleanup`, and `blocked`
(`stopped at <step>`, naming the last step and never the reason). An
integration of an in-scope target advance writes an `integrate` line before the
merge, an `implementation` line before the conflict resolution session, `setup`
and `check` lines for its checks, and `review` and `documentation review` lines
for its reviews. When a clean integration is sent back, it also writes a
`send-back` line
(`send-back: the <checks|implementation review|documentation review> did not accept the merged result; sending it back`),
an `implementation` line before the send-back session
(`implementation: starting the send-back session of the merged result`), a
`commit` line for its result (`commit: committing the send-back result`), the
`setup`, `check`, `review` and `documentation review` lines of the checks and
reviews that run again, and a `send-back` line with the outcome: either
`send-back: the merged result was accepted after the send-back session`, or
`send-back: the merged result is still rejected after the send-back session`
followed directly by `blocked: stopped at send-back`.

- **Comparisons** with `origin/<target>` are logged as `compare` lines. Every
  publish pass starts with `compare: comparing origin/<target> with the
  integrated target`, before its `integrate`, `setup` and `check` lines. While
  waiting to merge, `compare: comparing origin/<target> with the checked
  target` is written for the first Pull Request view of the wait, for the view
  that leads to the merge request (directly before `merge: merging #N`, which
  stays the last line before the merge request), for every view that finds a
  different target, and by the guard right before the merge command. Later
  views that find the target unchanged while polling stay quiet.
- **Target retries**: only the `compare: comparing origin/<target> with the
  checked target` comparisons, made while waiting to merge or by the guard,
  write a `retry` line. When such a comparison finds a different target, it is
  followed directly by `retry: origin/<target> advanced; integrating it again
  (attempt N)`, and the repeated publish pass follows. On the fifth consecutive
  such comparison that finds a different target, no `retry` line is written:
  the task is blocked with `target-keeps-advancing` and the compare line is
  followed by `blocked: stopped at compare` (the `blocked` line names the last
  step; the stage recorded in `state.json` stays `publish`). A publish-pass
  comparison with the integrated target that finds an advanced target writes no
  `retry` line; the `integrate` line (a change outside the guarded paths) or the
  lines of the `integrate` stage (a change inside them) follow it directly.
- **Waits** of a task log once when the wait starts, never on every poll: one
  `wait` line for mergeability and checks, one more when the pull request head
  is stale, and one `git lock: waiting for the Git lock` line when another
  runner holds the per-clone Git lock (nothing is written when the lock is
  free). The run-level wait for free work is different: it writes one
  `run wait` line per poll, immediately before each sleep, for example
  `run wait: waiting 60s for TASK-1 on build-host-1`, so a run that sleeps twice
  writes exactly two such lines (see
  [Waiting for free work](#waiting-for-free-work)).
- **Retries** log again with ` (attempt N)` from the second attempt or round
  on. Every line of a retried attempt or round carries the suffix: in a
  planning attempt the `planning`, `planning check` and `planning review`
  lines; in an implementation attempt the `implementation`, `commit`, `check`
  and `review` lines; in a documentation round the `documentation`, `commit`
  (committing the documentation) and `documentation review` lines; and in a
  publish pass repeated after the target advanced during the merge the
  `compare`, `integrate`, `setup`, `check`, `push`, `pull request`, `wait` and
  `merge` lines, and the `send-back` lines with their `implementation` and
  `commit` lines. The attempt number of a publish pass is durable, so a restart
  keeps it.
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
| The run ends `incomplete` without `blockers`: nothing remains and nothing is blocked (a `maxAccepted` run that accepted every task before reaching the limit) | `sleepy` | `incomplete: <n> accepted, <m> remaining` |
| The run ends `incomplete` with `blockers`, which includes every incomplete run with remaining tasks | `sad` | `incomplete: <n> accepted, <m> remaining` |
| The run is cancelled by SIGINT or SIGTERM, also during the wait for free work | `startled` | `cancelled: <n> accepted, <m> remaining` |
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
- The `hash` and `dispose` commands, `--version` and `--help` show no mascot.

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
`claude` or `codex`. The archive command runs through an injectable command runner, so
tests archive with a scripted command and never run `openspec archive`. The
mascot tests inject a recording player through `main`, so they
need no real terminal or timers. Concurrent runners, the per-clone Git lock and
worktree cleanup are tested with Git fixtures (a bare origin and clones),
scripted pull request hosts and child processes. The dependency check, the
unfinished reasons and the invocation status are tested with scripted adapters,
the scripted pull request host and Git fixtures with per-task dependencies and
scopes. The wait for free work is tested in `test/wait-for-free-work.test.ts`
with the same fixtures and a fake sleep injected through `RunOptions.sleep`:
another invocation merges the awaited task, a dependency is merged elsewhere, a
claim is released by `dispose`, or the sleep aborts the run. The runner fixture
gives every run a fake sleep that cancels it at its first poll, so a test whose
remaining work is held elsewhere never waits for real. The dispose command is tested with Git fixtures, scripted adapters and
scripted pull request hosts, through `disposeInvocation` and the exported
`dispose` entry point with a temporary `XDG_STATE_HOME`. Target advances during
a run (clean and conflicting merges, restarts and advances outside the scopes)
are tested with Git fixtures that push to the fixture origin, scripted adapters
and the scripted pull request host. The send-back session of a rejected clean
integration (rejections by a check, the implementation review and the
documentation review, results still rejected, the scope limit and restarts) is
tested in `test/integration-send-back.test.ts` with the same fixtures. The comparisons with origin before
publishing and merging, the merge guard, the attempt limit, conflicts while
waiting to merge and restarts from the recorded target commit are tested in
`test/merge-when-target-unchanged.test.ts` with the same fixtures and scripted
pull request hosts whose merge advances the target and then calls the guard, as
`GitHubHost.merge` does; the guard order of `GitHubHost.merge` is tested with a
stubbed `gh`. Runner upgrades, required settings and added
tasks are tested with the same fixtures: an interrupted invocation's `state.json`
is rewritten the way an older runner wrote it, and `RunOptions.requiredSettings`
declares a required setting. The review and check budgets and `--retry` are
tested in `test/review-budgets.test.ts` with the same fixtures and scripted
adapters that reject chosen reviews, write failing results or incomplete
planning artifacts, or fail chosen sessions, across restarts and retries. The
exhaustive review instruction, the earlier findings of later review rounds, the
`budgets` setting, its refusals and the resumption after a raised limit are
tested in `test/converging-reviews.test.ts` with the same fixtures and scripted
adapters, which read the review prompts they receive.
`--version`, `--help`, `hash` with task ids and its one-line errors, and
`runnerVersion` in the diagnostics, state and ownership files are tested in
`test/cli-usage.test.ts`, in-process through `run` with captured output and by
spawning `bin/outcome-runner.ts` with a temporary state home and temporary
directory. The
`live:*` scripts exercise a real harness; set `OUTCOME_TEST_HARNESS` to
`claude` or `codex` (default `codex`). Step lines are captured through
`RunOptions.steps`.

## License

MIT
