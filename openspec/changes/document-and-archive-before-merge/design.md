# Design: Documentation and archive stages before merge

## Stage machine

`Stage` gains `document`, `document-review`, `final-checks` and `archive`. After the implementation review is accepted, the runner sets `stage = 'document'` instead of `receipt`. Order:

`work` (review accepted) -> `document` -> `document-review` -> `final-checks` -> `archive` -> `receipt` -> `publish` -> `pr` -> `merge`.

Each transition is written to the run store before the next side effect starts, and each stage records its completion data on the `Work` record:

- `documentation?: { files: string[]; outsideScope: string[] }` after the document session.
- `documentationReviews?: ReviewRecord[]` (bounded at 4).
- `finalChecks` reused/extended for checks after documentation (`documentationChecks?: CheckRecord[]`).
- `archive?: { directory: string; specs: string[]; head: string }` recorded atomically with re-keyed `specification` and `stage = 'receipt'`.

Resume rules: a run resumed in `archive` first inspects the worktree; if `<changes>/<change>` is gone and the archived directory exists with matching binding hashes, the archive is treated as done (no second command run). A run resumed in `receipt` or later never invokes the archive command because `work.archive` is present.

## Documentation stage

New `Purpose` value `document` (and review purpose reused with a documentation prompt, e.g. `document-review`). The worker session uses the selected harness/model/effort. Its write scope is the intersection of task scopes and documentation files: a path is documentation when its basename matches `README*`, ends with `.md`/`.mdx`, or lies under a `docs` / `doc` directory segment. Writes outside that set are refused by the tool layer. The report's findings that name out-of-scope documentation are captured into `documentation.outsideScope` and rendered in the PR body under `Documentation outside scope`.

## Documentation review

An independent review session (fresh thread) receives the documentation diff, the implementation diff, criteria and scopes. Accepted only with outcome `accepted` and zero findings. Non-accepted rounds return findings to a new document round; after 4 rounds without acceptance the task blocks with `Documentation review remains unresolved`. After acceptance the frozen project checks run again; any failure blocks as existing check failures do.

## Archive

`Project.archive?: CommandSpec`, validated like other commands. Default `{ command: 'openspec', args: ['archive', '{change}', '--yes'] }`. `{change}` substituted per argument; executed with no shell in the worktree; output bounded with the existing page/limit helper. Non-zero exit blocks with the bounded output. After success the runner verifies `<changes>/archive/<YYYY-MM-DD>-<change>` exists and the original directory is gone, collects changed `openspec/specs/**` files from the Git status, and commits them with the documentation.

## Binding re-key

For each bound path `<changes>/<change>/<rest>` compute `<changes>/archive/<date>-<change>/<rest>`; read and hash it; any missing file or hash difference blocks with `Archived specification differs from binding`. The re-keyed map replaces `work.specification`, so all later integrity checks (receipt, publish, merge) use archived paths.

## Manifest, receipt, target conflicts

Manifest allow-list = task scopes ∪ archived change directory ∪ the recorded `archive.specs` files. Anything else blocks as today. Receipts carry archived specification paths; validation accepts a specification path under either `<changes>/<change>/` or `<changes>/archive/<date>-<change>/`, so older receipts remain valid. When the target advances, the conflict set is task scopes ∪ `archive.specs` ∪ archived directory; overlap blocks the task as an in-scope change does.

## PR body

Adds `Documentation updated` (list of files), `Archived change` (directory) and, when non-empty, `Documentation outside scope`.

## Risks

- Date in the archive path: read the directory actually created matching `*-<change>` rather than recomputing, and record it.
- Harness write-scope enforcement differs per adapter; both Claude and Codex adapters must receive the documentation-only scope.
