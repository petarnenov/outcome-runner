## MODIFIED Requirements

### Requirement: Waits log once

Task-level waits and polling loops (mergeability and checks, stale pull request head, Git lock) SHALL log once when
the wait starts and SHALL NOT log on every poll. The run-level wait for free work (capability `wait-for-free-work`)
is not such a wait: it SHALL write one `run wait` step line per poll, where a poll is one sleep of the poll interval,
immediately before each sleep, naming the tasks it waits for and the hosts recorded in their claims.

#### Scenario: Mergeability and stale head polling

- **WHEN** the merge stage reads several stale pull request views before the head matches
- **THEN** one mergeability wait line and one head wait line are written, whatever the number of views

#### Scenario: Contended Git lock

- **WHEN** another process holds the Git lock while the runner needs it
- **THEN** exactly one `<subject> git lock: waiting for the Git lock` line is written before the runner waits
- **AND** no such line is written when the lock is free

#### Scenario: Wait for free work logs every poll

- **WHEN** the run waits for free work and polls twice (two sleeps: the first returns, the run is aborted during the
  second)
- **THEN** exactly two `run wait` step lines are written, one before each sleep
