# Secret scanning false positives

The root `.gitguardian.yaml` records reviewed false-positive exceptions alongside the code. Its sole exception is the literal `/etc/passwd` used by a test fixture: it is a filesystem path, not a secret credential. The descriptive name explains why that value is ignored.

The version-2 configuration permits exactly one `secret.ignored_matches` entry, with only `name` and `match`. The match is the literal `/etc/passwd`, not a glob or regular expression. This exception applies wherever that literal occurs; it is not limited to the fixture file. There are no `paths-ignore` rules or other exclusions, so all product and test paths remain scanned.

The complete root configuration is:

```yaml
version: 2
secret:
  ignored_matches:
    - name: /etc/passwd test fixture
      match: /etc/passwd
```

## Proposing another false positive

1. Inspect the finding and confirm the value is not a real secret. Record the fixture context and rationale for treating it as a false positive. Do not suppress real credentials as fixture exceptions.
2. Propose the smallest literal match in `.gitguardian.yaml`, with a descriptive name, through a pull request. Include the rationale so reviewers can assess every occurrence affected by the exception.
3. The current specification and contract test allow exactly one entry. Before expanding that contract, propose coordinated specification and `scripts/secret-scan-config.test.ts` updates for review alongside the configuration change.
4. Run the local project checks and obtain review before merging the exception. Keep the decision in the repository rather than marking the finding by hand only in the dashboard. Do not exclude entire files or paths.

## Local verification

`scripts/secret-scan-config.test.ts` reads the actual root configuration relative to its own location and compares the complete document with an independent canonical expectation. It verifies version, nesting, the single descriptive fixture entry, the literal match, and the absence of extra keys or exclusions. Only CRLF line endings and an optional final newline are normalized; other formatting changes require deliberate test review.

Run the focused contract test from the repository root with Node 24 or newer:

```sh
node --test scripts/secret-scan-config.test.ts
```

The test also runs with `npm test` through existing script-test discovery. That full suite enforces aggregate line, branch, and function coverage of at least 85%. The supplied configuration shape is the whole local acceptance contract: external documentation, network access, and hosted GitGuardian scanner execution are not required evidence. This check verifies the repository contract and does not claim to validate hosted scanner behavior.
