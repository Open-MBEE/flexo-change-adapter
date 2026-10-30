# Security design

This document describes the controls that protect the adapter, the models it observes and the CI credentials it holds. It is kept current with the code: a change to any control below changes this document in the same pull request (registry policy "security-design"). Vulnerability reporting and response deadlines are in [SECURITY.md](../SECURITY.md).

## What the adapter touches

The adapter polls one Flexo MMS repository branch over host-only HTTPS, retains observed revisions and frozen action intents in local SQLite journals and a spool, and dispatches work to a CI target: a private GitHub execution repository, or GitLab/Jenkins jobs on dedicated self-hosted workers. Validation results, claims and reports are retained with the exact revision, rule, destination and validator identities they belong to. See [architecture](architecture.md) and [execution and recovery](github-execution.md).

## Identity and credentials

- No credential is stored in configuration, retained records or the feed. Configuration names environment variables (`username_env` / `password_env` / `token_env` for the source and targets, GitLab `trigger_token_env` / `read_token_env`; defaults `FLEXO_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TRIGGER_TOKEN`, `GITLAB_READ_TOKEN`, `JENKINS_TOKEN`, see [configuration](configuration.md)); the process reads them at start and never writes them out.
- Each destination credential is scoped to one purpose: trigger permission is separate from pipeline-metadata read permission on GitLab; the GitHub execution repository is private, and its validation workflow runs only on `main` by manual dispatch with `permissions: {}` at the workflow level and `contents: write` on the single job that records results.
- Flexo lock creation is disabled unless `allow_lock_creation: true` is configured; the default uses an existing commit-pinned lock.
- The container runs as the image's non-root user with the configuration and rules mounted read-only.

## Protecting state and retained data

- Journals use SQLite in WAL mode with `synchronous=FULL`; events, frozen intents, rule bytes and checkpoints commit together, so a crash never leaves a half-recorded action.
- Files are written through a temporary file created with mode `0600` and renamed into place (`workspace.ts`), so no reader sees a partial file.
- Known gap (tracked in [#1](https://github.com/Open-MBEE/flexo-change-adapter/issues/1)): not every private output and state path is created with owner-only permissions yet. Until that closes, operators restrict the data directory with the file system (`umask 077` or an owner-only volume).
- Operators are responsible for backups and access to the data volume according to the sensitivity of the model (see [configuration § State and backups](configuration.md#state-and-backups)).

## Checking input

- Flexo responses are bound to the exact observed revision: the before/after commit and ETag are checked around each graph fetch, and a branch that moves during capture cannot change the captured bytes.
- Input bundles, rules and engine results carry SHA-256 identities; a worker refuses a bundle whose digest does not match the claim, and a result from another revision or profile cannot satisfy an action.
- Generic CI outcomes are kept distinct from SHACL and engine verdicts; a malformed or missing report is recorded as inconclusive, never as a pass.
- Known gap (tracked in [#2](https://github.com/Open-MBEE/flexo-change-adapter/issues/2)): remote graph reads are not yet size-bounded before buffering and parsing. Until that closes, the adapter should observe only repositories whose graph size is known to fit the host.

## Isolating execution

- The adapter never runs code from the observed model or from a pull request. Validation engines run in the CI target as pinned, reviewed profiles with bounded offline execution; their native output is decoded, not executed.
- Workflows in this repository run with `contents: read` (CI) or no permissions (validation), pin every action to a commit SHA, and never use text that outside contributors control as a command.

## Supply chain

- Dependencies are exact-pinned through the committed `package-lock.json` and installed with `npm ci`; production dependencies are added only after review ([CONTRIBUTING § Dependencies](../CONTRIBUTING.md#dependencies)).
- Dependabot watches npm, GitHub Actions and the Docker base image weekly ([`.github/dependabot.yml`](../.github/dependabot.yml)); CodeQL code scanning runs through GitHub's default setup on every pull request and push to the default branch (a repository setting, Settings → Advanced Security). Both are remediated on the deadlines in SECURITY.md.
- Releases are built by the release workflow on GitHub-hosted runners; each asset ships with a SHA-256 manifest, an SPDX SBOM and a GitHub artifact attestation (SLSA build provenance). See [releasing](releasing.md).
- The repository holds no built executables; `bin/adapter.js` is source.

## Logging

Logs record identities (revision, digest, action and claim IDs) and never credentials or graph content. Reports written for issues must be sanitized the same way (see SECURITY.md).
