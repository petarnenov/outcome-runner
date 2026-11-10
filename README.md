# outcome-runner

Unattended OpenSpec outcome runner. It takes tasks from a queue committed in a
Git repository, implements each through its own OpenSpec change and Pull Request,
and records accepted results in the repository.

```sh
npm i -g github:petarnenov/outcome-runner
```

Run it from any directory inside the repository to work on. The project needs
Git, Node 24 or newer, the selected harness CLI, OpenSpec CLI, the configured
build tools and (for GitHub hosting) authenticated `gh`. The package has no
dependencies beyond Node built-ins.

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

Claude is the default: authenticated Claude Code **2.1.321**, exact model
`claude-opus-5-5`, effort `medium`. No fallback is permitted. Select Codex with
`outcome-runner /path/to/invocation.json --harness=codex` or JSON
`"harness": "codex"`. Codex requires certified CLI **0.167.0**; omitted Codex
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

`npm test` runs the suite with scripted adapters. The `live:*` scripts exercise a
real harness; set `OUTCOME_TEST_HARNESS` to `claude` or `codex` (default `codex`).

## License

MIT
