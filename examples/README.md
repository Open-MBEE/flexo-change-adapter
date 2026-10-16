# Examples

Start with a feed-only configuration to verify observation before adding CI.
These examples contain placeholder services and destinations. Offline checks
validate configuration, not network access or permission. See
[installation](../docs/installation.md) for runtime setup and
[project status](../docs/status.md) for verification limits.

| Recipe            | Starting configuration                                                         | Result                                                                                  |
| ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Activity feed     | [feed.json](configuration/feed.json)                                           | Baseline and later observed head changes in SQLite and JSON; no CI action               |
| GitHub SHACL      | [github-validation.json](configuration/github-validation.json)                 | Revision-bound validation with the synthetic named-part rule                            |
| Native validation | [gitlab-jenkins-validation.json](configuration/gitlab-jenkins-validation.json) | Independent text engines on self-hosted GitLab/Jenkins with shared evidence             |
| Generic CI        | [gitlab-jenkins.json](configuration/gitlab-jenkins.json)                       | Independent GitLab pipeline and Jenkins job triggers with exact event/revision metadata |

All commands below run from the repository root with installed dependencies.
Before editing anything, check the committed examples offline:

```bash
npm run adapter -- check --config examples/configuration/github-engines.json
npm run adapter -- check --config examples/configuration/gitlab-jenkins-validation.json
npm run adapter -- check --config examples/configuration/feed.json
npm run adapter -- check --config examples/configuration/github-validation.json
npm run adapter -- check --config examples/configuration/gitlab-jenkins.json
```

Each successful check emits `configuration: "valid"`, `offline: true` and
`schema_version: 1`. It creates no state and needs no credentials.

## 1. Observe an activity feed

Create an ignored `.local/adapter.json` using the complete feed configuration in
[installation](../docs/installation.md#native-setup). Replace the Flexo endpoint,
organization, repository and branch; load authorized Flexo credentials separately.
Choose persistent writable state and output paths.

```bash
npm run adapter -- check --config .local/adapter.json
npm run adapter -- run --config .local/adapter.json --once
npm run adapter -- status --config .local/adapter.json
```

The first successful observation retains a baseline and writes the configured
feed. Later observed head changes append events; unchanged polls do not. A read
failure preserves existing history. See [feed format](../docs/event-feed.md).

## 2. Validate with GitHub Actions

Adapt [github-validation.json](configuration/github-validation.json) into a
separate local configuration and state directory. Replace the source and private
GitHub owner/repository. If saving under `.local/`, change its demonstration rule
path to `../examples/named-part-v1/rule.ttl`; the committed example's
`../named-part-v1/rule.ttl` is relative to `examples/configuration/`.

Prepare the matching reviewed GitHub workflow and permissions described in
[installation](../docs/installation.md#add-ci-actions), then load Flexo credentials
and `GITHUB_TOKEN`. Review model snapshot transfer and the Flexo lock requirement
before enabling delivery. `allow_lock_creation` defaults to false.

The action selects `branch-change`: first observation records a baseline without
validation. After an authorized model change, a later observation queues work.
Use continuous `run` or repeated `run --once` rounds to collect the result;
one round does not wait for CI completion. Inspect `status` for delivery state
and the completed result. A SHACL violation is a completed validation outcome,
not a transport failure.

The [named-part fixtures](named-part-v1/README.md) provide a failing model and its
correction. Their rule is specific to the fixed demonstration element. Replace
it with a reviewed model-specific rule for another model; a CI success does not
establish full SysML conformance.

## 3. Trigger GitLab and Jenkins

Adapt [gitlab-jenkins.json](configuration/gitlab-jenkins.json), replacing the Flexo
source, GitLab endpoint/project/ref and Jenkins endpoint/job. Give the new source
its own state/feed paths. Load the credential variables named in the example.
GitLab trigger and read credentials are separate; Jenkins uses username/API token.

Prepare reviewed destination jobs to accept `ADAPTER_DELIVERY_ID`,
`ADAPTER_EVENT_ID`, `ADAPTER_SOURCE_REVISION` and `ADAPTER_SOURCE_BRANCH` as
variables or string parameters. Both actions select `branch-change`; later
observations create independent delivery records. Repeated rounds reconcile
pipeline/build status into retained results.

These actions transfer metadata, not verified model snapshots. Destination code
must fetch the exact model revision if needed. Generic CI success is not a SHACL
result. Lost submission responses may remain `uncertain`; do not manually replay
or delete state to force a resend. See
[platform contracts and reconciliation limits](../docs/configuration.md#gitlab-and-jenkins-triggers).

## Model fixtures

- [Named part v1](named-part-v1/README.md): synthetic integration fixtures.
- [Satellite mass budget v1](satellite-mass-budget-v1/README.md): a domain-specific SPARQL rule exercised with synthetic mass-budget fixtures.

For path and credential conventions, see the
[configuration example notes](configuration/README.md). For failed runs or missing
results, see [troubleshooting](../docs/troubleshooting.md).

[github-engines.json](configuration/github-engines.json) selects independent OpenSysML and Toolkit syntax/semantic actions. Remove either action to select one. These require a producer-owned text manifest; see [engine configuration](../docs/validation-engines.md).

For verified model validation on GitLab/Jenkins, use [gitlab-jenkins-validation.json](configuration/gitlab-jenkins-validation.json) instead of the generic trigger recipe. Follow the [native worker guide](../docs/gitlab-jenkins-validation.md); the reviewed [GitLab pipeline](gitlab/verified-validation.yml) expects preinstalled matching source and shared evidence storage.
