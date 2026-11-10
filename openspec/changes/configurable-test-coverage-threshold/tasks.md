# Implementation Tasks

All product work below is deferred until specification binding. Product scope: src/, test/ and README.md only. Dependency: OR-1.

- [ ] 1. Add optional invocation coverage and a required resolved numeric threshold; default to 85 and reject effective values outside integer 1–100 before allocation for CLI and direct runner callers.
- [ ] 2. Add --coverage=<n> parsing and CLI-over-JSON precedence; preserve existing flag order, duplicate/empty/unknown rejection and private exit-code-4 failures.
- [ ] 3. Require a literal {coverage} in at least one project.checks argument; diagnose that a coverage gate check is required before lock, claim or worktree allocation.
- [ ] 4. Include resolved coverage in ownership and durable invocation identity; reject changed-threshold restarts without changing saved state and retain existing legacy incompatibility handling.
- [ ] 5. Expand all {coverage} occurrences using the frozen threshold in the shared check argument helper; preserve existing placeholder substitution.
- [ ] 6. State the resolved percentage in the common prompt for all worker purposes and retry/recovery sessions.
- [ ] 7. Update valid test fixtures with coverage gates without weakening existing test intent.
- [ ] 8. Test default 85, JSON value, CLI override, boundaries 1 and 100, and invalid 0, 101, 85.5 and nonnumeric values for JSON/CLI; test JSON type validation and duplicate/empty flags.
- [ ] 9. Test actual check substitution and records, embedded/repeated placeholders, all-purpose prompt percentages, missing-gate exit code 4 and no allocation, including placeholders only outside project.checks arguments.
- [ ] 10. Test changed-threshold restart refusal and unchanged saved state, plus equivalent omitted/explicit-85 restart identity.
- [ ] 11. Document coverage, --coverage, {coverage}, default/range/precedence, mandatory gate and restart behavior; include an enforcing Node test coverage command in README invocation JSON.
- [ ] 12. Run npm run typecheck and npm test after binding; inspect controller frozen check output and resolve any failures within scope.
