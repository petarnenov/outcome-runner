# Design: Refuse incomplete task sets and explain every unfinished result

## Context

`runSteps` (src/runner.ts) resolves `ids = config.leaves ?? Object.keys(config.authority.tasks)`, checks authority,
creates the `RunStore`, then loops: refresh, record acceptance, pick the next task whose dependencies are done and
whose scopes do not overlap a foreign claim or a blocked task of this invocation. When no task can be picked it
returns `incomplete` with `blockers` built only from `state.blocked`. When recording the acceptance of a merged task
fails (the catch around `recoverClaimTime`/`buildCompletion` inside `if (current && done.has(current.id))`) it
returns `incomplete` at once, even if other tasks could still be selected. `RunStore` initialises
`status: 'starting'` and nothing updates it. `main` (src/cli.ts) maps `exhausted`/`limit-reached` to exit 0, other
results to 3 and thrown errors to 4 through `reportFailure`, which prints the error `reason` and writes `details` to
the diagnostics file.

## Decisions

### 1. Dependency check before run state

Right after the authority checks on the initial refresh and before `new RunStore(...)`, the ownership write, the
claims ledger and any worktree, the runner computes for each id in `ids` (in `ids` order) the dependencies of its
queue task that are not in `ids` and have no valid receipt at the initial `origin/<target>` (the same
`receiptAt(root, target, receiptPath(dep), hash(depTask), null)` used for acceptance; a dependency id that is not in
the queue is missing). When any task has missing dependencies the runner throws an error with
`reason: 'dependencies-outside-invocation'`, a message naming each task and its missing dependencies, and
`details: { missing: { [taskId]: [dependencyIds...] } }`. `reportFailure` already prints the reason and stores
`details`, so `main` exits 4 and the diagnostics file lists every task. Direct dependencies suffice: a dependency
inside the set is itself checked. Because of this check the runner never returns exit 3 for a dependency outside
the invocation. `receiptPath` and the acceptance helper are hoisted above `RunStore` creation for this.

Alternative rejected: checking inside the loop would already have created state and possibly claimed tasks.

### 2. Accepted count of the invocation

One exported pure helper `acceptedThisRun({ ids, completed, blocked, done, baselineDone })` (src/runner.ts) gives
the ids counted against `maxAccepted`: the ids of `ids` that were accepted during this run (in `completed`, in
`done`, not in `baselineDone`) plus the ids of `ids` that are keys of `blocked` (`state.blocked`) whose merge is
done on the target (in `done`) but not in `baselineDone` (merged, acceptance recording failed). Ids outside `ids`
are never counted, even when they are newly in `done` (receipts of tasks accepted by other runners). The runner
calls it with its own state (`ids`, `state.completed`, `state.blocked`, the current `done` set and the
`baselineDone` set of the start of the run).

The existing limit check (`config.maxAccepted && count >= config.maxAccepted`) uses
`acceptedThisRun(...).length` instead of `newlyAccepted.length`, so a merged task whose acceptance recording failed
counts toward the limit on every path. The `accepted` list of the result stays `newlyAccepted` (only recorded
acceptances).

`explainUnfinished` (decision 4) does not receive a precomputed count: it receives the same inputs (`ids`,
`completed`, `blocked`, `done`, `baselineDone`) and calls `acceptedThisRun` itself for its `max-accepted` rule. The
counting rule therefore lives in exactly one place and a unit test of `explainUnfinished` exercises the real count,
including the exclusion of a newly done task outside `ids`.

### 3. Acceptance-recording failure continues the loop

When recording the acceptance of a merged task fails, the runner records it in `state.blocked` (as today), writes the
blocked step and then:

- if `config.maxAccepted` is set and `acceptedThisRun(...).length >= config.maxAccepted`, it returns `incomplete`
  (exit 3) at once, with `blockers` from `explainUnfinished`; the failed task is `blocked` and every remaining task
  that is not blocked is `max-accepted`;
- otherwise it does not return: it skips the cleanup and the `accepted` report of that task and falls through to the
  normal remaining computation, limit check and selection of the same iteration. Every remaining task is therefore
  either worked or explained by the normal return paths, and no task is left unstarted without a rule.

Because the merged task is done, it is not in `remaining`; its `blocked` entry stays in `blockers`. To keep the
existing guarantee that a failed acceptance recording ends with exit 3 and is retried by the next run, the
`!remaining.length` path does not release the ownership and returns `incomplete` with `blockers` from the blocked
entries when `state.blocked` holds a task of the invocation; without such a task it behaves as today (release;
`exhausted`, or `incomplete` when `maxAccepted` is set). Alternative rejected: a separate kind for tasks left
unstarted after a blocked acceptance would report work as unfinished that the run could have done.

### 4. Blocker classification

A single exported pure helper `explainUnfinished({ remaining, ids, tasks, completed, blocked, done, baselineDone,
maxAccepted, foreignClaims, statePath })` returns a blocker for every remaining id (plus the entries of blocked
tasks of the invocation), using the first matching rule:

1. `blocked` - the task is in `blocked`:
   `{ kind: 'blocked', stage, reason: 'operation-incomplete', diagnostics: <state.json path> }`. The private failure
   message stays in `state.json` (the existing rule that the blocked reason is never serialized to output is kept);
   `reason` is the public reason code and `stage` the stage it stopped at.
2. `max-accepted` - `maxAccepted` is set and
   `acceptedThisRun({ ids, completed, blocked, done, baselineDone }).length >= maxAccepted`, computed inside
   `explainUnfinished` (decision 2): `{ kind: 'max-accepted', reason: 'max-accepted', limit: maxAccepted }`.
3. `waiting-for-dependency` - some dependency is not done:
   `{ kind, reason: 'waiting-for-dependency', dependencies: [ids not done] }`.
4. `waiting-for-claim` - a foreign claim (other claimant, not done) has the same id or overlapping scopes:
   `{ kind, reason: 'waiting-for-claim', claim: { id, host } }` naming the first such claim by id.
5. `waiting-for-blocked-scope` - a blocked task of this invocation has overlapping scopes:
   `{ kind, reason: 'waiting-for-blocked-scope', task: <blocked id> }`. This fifth kind is needed so that every
   remaining task has a reason; the selection filter already skips such tasks.

The foreign claims passed to the helper come from one helper `foreignClaimsOf(snapshot, done)` (claims of another
claimant whose id is not done). Every return path that calls `explainUnfinished` has a snapshot of the claims ledger
before calling it: the no-selectable-task path passes the `ledger.pull()` snapshot it already used for selection; the
`limit-reached` path and the acceptance-failure return of decision 3 each call `ledger.pull()` themselves. So the
`waiting-for-claim` rule works the same on every return path.

The return paths are covered completely: after the acceptance failure return and in `limit-reached` the limit is
reached, so every non-blocked remaining task matches rule 2; on the no-selectable-task path every non-blocked
remaining task failed one selection filter, which matches rule 3, 4 or 5. If no rule matches anyway, the helper
throws `Unexplained unfinished task`, so an incomplete result with an unnamed task cannot be produced silently.

Blocked entries that are not in `remaining` (for example a merged task whose acceptance recording failed) keep their
entry, so `blockers` keys are a superset of `remaining`. The helper is used by both `incomplete` returns with
remaining tasks and by the `limit-reached` return; `claimedElsewhere` is kept unchanged for compatibility. The
`cancelled` result is unchanged.

The `RunResult.blockers` type becomes `Record<string, Blocker>` with `kind` required and the kind-specific optional
fields above; the existing fields `stage`, `reason` and `diagnostics` keep their meaning for `blocked`.

### 5. Invocation status in state.json

In-progress work means the current task of this run or recovered work of an earlier run that is claimed but neither
accepted nor blocked and is held for a later run (the `current`/recovered work that today prevents `release()` on
the `limit-reached` path). Unstarted remaining tasks explained with `kind` `max-accepted` are not in-progress work.

`store.update({ status })` is written at these points, each before `runQueue` returns:

- `running` after the leftover sweep, before the first loop iteration.
- `released` whenever `release()` marks the ownership released: all leaves accepted with no blocked task, or the
  limit reached with no blocked task and no in-progress work, even when unstarted `max-accepted` tasks remain (the
  most common `limit-reached` case). A run that accepts every leaf therefore ends at `released`.
- `blocked` for any `limit-reached`, `incomplete` or `cancelled` result whose state holds a blocked task of this
  invocation (equivalently, whose blockers contain a `blocked` kind), including a failed acceptance recording. A
  `limit-reached` run that keeps a blocked task is therefore `blocked`, not `completed`, so `state.json` never hides
  a block.
- `completed` for a `limit-reached` result that keeps in-progress work and has no blocked task.
- `incomplete` for any other `incomplete` or `cancelled` result.

Thrown errors after store creation leave the last reached status (normally `running`). `RunStore` keeps `starting`
as its initial value. A small `finish(result)` wrapper writes the status and returns the result so every return
path is covered.

## Risks / Trade-offs

- Existing tests asserting exact `blockers` objects need the new `kind` field; behaviour otherwise unchanged.
- Runs that previously exited 3 because of an outside dependency now exit 4 before creating state; this is the
  intended behaviour.
- A failed acceptance recording without a reached limit no longer stops the run at once: other tasks are still
  worked in the same run, and the run still ends with exit 3 and a `blocked` entry for the failed task.
- `limit-reached` still exits 0 even when its status is `blocked`; the exit code mapping is unchanged and the
  `blocked` status plus the `blocked` blocker entry make the block visible.
