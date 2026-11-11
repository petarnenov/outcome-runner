# Design

## Context
OR-26 defines the entire configuration contract. The repository uses Node's built-in test runner with TypeScript and discovers scripts/*.test.ts. No YAML parser dependency is currently declared. Applicable AGENTS.md files were checked along the planning-artifact ancestry; none were present.

## Configuration
Use this small canonical YAML document:

```yaml
version: 2
secret:
  ignored_matches:
    - name: /etc/passwd test fixture
      match: /etc/passwd
```

The only root keys are version and secret; secret contains only ignored_matches; that sequence has exactly one mapping with only name and match. The name describes the fixture, and match is the literal string /etc/passwd, not a glob or regular expression. No paths-ignore, additional ignore list, or other key is permitted. No product or test path is excluded.

## Local Verification
Add scripts/secret-scan-config.test.ts using node:test, node:assert/strict and node:fs. Resolve the root configuration relative to import.meta.url so reading does not depend on the working directory.

For this fixed five-line configuration, compare the complete file against the canonical document after normalizing CRLF to LF and an optional final newline. This deliberately strict local representation avoids a new parser or a partial YAML parser and catches any extra key, exclusion, duplicate entry, wrong version, wrong match, or loss of the descriptive name. The test checks the actual repository file, not a separate fixture. The canonical expected document must be defined independently inside the test. Formatting changes beyond these normalizations require deliberate test review; that is an acceptable tradeoff for this tiny contract.

The test proves the supplied local configuration contract only. Hosted scanner behavior and external schema documentation are outside the evidence required by OR-26.

## Documentation
Create docs/secret-scanning.md explaining why /etc/passwd is a fixture false positive, where the exception lives, and how to propose a future reviewed exception: establish that the value is not a real secret, describe the fixture and rationale, propose the smallest literal match in a pull request, and obtain review together with corresponding specification and contract-test updates. The current contract permits exactly one entry; documentation must not suggest silently adding entries without updating that contract. Do not use dashboard-only dismissal or path-wide exclusions as the repository workflow.

## Scope and Verification
This planning session writes only the four requested OpenSpec artifacts. The later implementation remains within .gitguardian.yaml, scripts, and docs. Existing package test discovery needs no modification. After binding, run the frozen project checks and inspect their output. The resolved coverage gate is 85%; all required tests are implemented regardless of current coverage.

## Risks
A literal match exception applies wherever that literal appears; the task explicitly selects that contract. Exact document comparison is intentionally more formatting-sensitive than semantic YAML parsing, but ensures no unexamined configuration survives. No claim is made that arbitrary YAML representations are accepted.
