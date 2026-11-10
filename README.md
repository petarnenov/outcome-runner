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
authenticated Claude Code 2.1.321 or newer (or Codex 0.167.0 or newer).

**2. Prepare the project**

The project needs a GitHub `origin` and a target branch, `main` in this example.

```sh
cd /path/to/project
mkdir -p openspec/changes planning evidence/results
touch openspec/changes/.gitkeep evidence/results/.gitkeep
echo 'schema: spec-driven' > openspec/config.yaml
```

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
    "checks": [{ "command": "node", "args": ["--test", "{scope}/*.test.mjs"] }]
  }
}
```

- Do not set `root` or `stateDirectory`; the run is refused if you do.
- Replace `checks` with the project's real checks, for example `make verify`.
- If a fresh worktree needs dependencies, add
  `"setup": [{ "command": "npm", "args": ["ci"] }]` to `project`.
- Without `leaves`, every task in `authority.tasks` runs.

**7. Run it from the repository**

```sh
cd /path/to/project
outcome-runner ~/invocations/my-project-1.json
```

Add `--harness=codex` to use Codex.

**8. Read the result**

| Exit code | Meaning |
|---|---|
| 0 | Success: `exhausted` or `limit-reached` |
| 3 | Incomplete, for example blocked dependencies or a protected merge |
| 4 | Did not run; the reason is in the `diagnostics` file it prints |

After an interruption, run the **same command with the same file** to resume. Do
not delete the state under `~/.local/state/outcome-runner/`. The runner also
creates a `work-queue-claims-<target>` branch. It is never merged; keep it while
work is unfinished.

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
Arguments may contain `{change}`, `{target}` and `{scope}` (the first authorized product scope). They run as argument arrays,
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
outcome-runner /path/to/invocation.json
```

Claude is the default: authenticated Claude Code **2.1.321 or newer**, exact model
`claude-opus-5-5`, effort `medium`. No fallback is permitted. Select Codex with
`outcome-runner /path/to/invocation.json --harness=codex` or JSON
`"harness": "codex"`. Codex requires CLI **0.167.0 or newer**; omitted Codex
`model` and `effort` are resolved from its local configuration before allocation.
The CLI flag overrides the JSON harness only; explicit model/effort values remain.
Leave those optional fields unset for a shared template, or use values consistent
with the selected harness. Claude is selected when both CLI and JSON harness
are omitted. Explicit `--harness=claude` also selects Claude.

The resolved harness, model and effort are frozen in invocation identity. A
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

`npm test` runs the suite with scripted adapters. The `live:*` scripts exercise a
real harness; set `OUTCOME_TEST_HARNESS` to `claude` or `codex` (default `codex`).

## License

MIT
