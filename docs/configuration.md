# Configuring sources, storage and actions

For a first run, follow [installation](installation.md). Use the
[examples guide](../examples/README.md) to select a recipe and
[troubleshooting](troubleshooting.md) to diagnose failures. Current evidence and
live acceptance limits are summarized in [project status](status.md).

The local TypeScript CLI accepts one versioned JSON configuration selecting a Flexo source, polling, SQLite state, an optional JSON feed and independent GitHub validation actions. GitLab/Jenkins generic `ci-trigger` tasks are also implemented. A [local Jenkins setup](local-jenkins.md) is included; both generic CI adapters have transport/recovery regression coverage. Unknown adapters fail offline checking. No additional dependencies are required.

```bash
npm run adapter -- check --config examples/configuration/feed.json
# Edit/copy the example to select the existing source and writable local paths.
# Load resolved credentials through the approved environment workflow.
npm run adapter -- run --config /path/to/adapter.json --once
npm run adapter -- run --config /path/to/adapter.json
npm run adapter -- status --config /path/to/adapter.json
```

The corresponding recipes are `just configured-check FILE`, `just configured-once FILE`, `just configured-run FILE` and `just configured-status FILE`.

## Configuration contract

Start with [feed.json](../examples/configuration/feed.json) or [github-validation.json](../examples/configuration/github-validation.json). These contain placeholder sources/destinations; the validation example's rule is specific to its demonstration model. `schema_version` must be 1. Unknown fields are rejected. Paths resolve relative to the configuration file, including `state_directory`, optional `database`, feed path and rule paths. Copying a JSON example to another directory requires reviewing all those paths; for example, the GitHub example copied to `.local/adapter.json` needs rule path `../examples/named-part-v1/rule.ttl`. Default database: `STATE_DIRECTORY/events.sqlite`. Configuration files, SQLite sidecars, writer locks and internal target-storage paths cannot overlap configured outputs.

`source.type` is `flexo`; endpoint, organization, repository and branch select the watched source. The endpoint is host-only HTTPS. Optional `source.credentials` contains environment variable names: `token_env`, `password_env`, `username_env`, defaulting to `FLEXO_TOKEN`, `FLEXO_PASSWORD`, `FLEXO_USERNAME`. Runtime reads either the token or password/login combination without changing global environment variables. Credentials are refreshed on reads. Keep secret values in the existing approved environment-loading workflow; the JSON accepts neither raw secret values nor an automatic `op://` resolver.

`observation.mode` is `poll`, with an integer `interval_seconds` from 30–60 (default 45). One source per process; separate configurations need separate state/output paths. Linux `flock` is required for every configured `run`, including `--once`. It excludes competing writers by database, state directory and feed path; offline `check` and `status` do not acquire writer locks. State ownership is bound to the source and journal path. Source changes require a separate state directory; moving retained state needs deliberate review of its ownership record.

`feed` is optional, with `type: json-feed` and `path`. It preserves the research frontend's schema 1 and newest 100 events. Retained history stays in SQLite. An unchanged head only updates poll health; failed reads preserve history. A feed write failure leaves observations intact, and the next successful publication regenerates the feed. Mount the **feed directory**, not the individual file, read-only into downstream applications.

`actions` may be empty or contain multiple independent records. Each needs a unique `id`, explicit `on` event kinds, a task and a target. Use `on: ["branch-change"]` to avoid triggering on the first baseline. `baseline` is available explicitly. No action is triggered by an unchanged poll, read failure or configuration change alone.

The SHACL task/target pair is `task.type: shacl-validation` with readable `rule` and `rule_version`, and `target.type: github` with owner/repository. The reviewed workflow and ref are `flexo-validate.yml` and `main`; these cannot be overridden. Optional `target.token_env` defaults to `GITHUB_TOKEN`. `allow_lock_creation` defaults to false. Set it true only when creating named Flexo locks is authorized. A prepared private snapshot is transferred to the selected private repository; hosted CI receives no Flexo credential.

For text validation, select `task: {"type":"engine-validation","engine":"opensysml","profile":"syntax-semantic-v1"}` or `engine: "sysml-toolkit"`, with the same GitHub target. Use two actions for both engines. The default input provider is `flexo-text-manifest-v1`, which requires a producer-authored manifest in the exact revision. Engine actions do not require a SHACL rule. Settings and pinned profiles are reviewed code, not shell commands. See [github-engines.json](../examples/configuration/github-engines.json) and [validation engines](validation-engines.md).

Offline `check` performs no network requests, credential resolution or state initialization. It validates readable rule files, path conflicts and installed adapters. `status` reads retained state without contacting Flexo/GitHub, even if a currently configured rule file has disappeared. An uninitialized status is explicit. Exit codes: 0 for a successful command/round (terminal job failures or rejections are represented in retained results), 2 for configuration or unresolved operation failure, 130 for interrupted continuous operation; a competing process lock exits 1. A nonconforming SHACL result is a completed action result, not a failed delivery.

`run --once` performs one observation and delivery/reconciliation round, not an indefinite wait for CI completion. Repeat it or use continuous operation to collect results. Continuous polling and delivery operate independently; transport calls have timeouts and at most four target groups advance concurrently. Each request times out after 30 seconds; reconciliation of many candidates can take multiple requests. A new queued action may wait until the next delivery round. Shutdown waits for in-flight operations to finish.

## GitLab and Jenkins triggers

[gitlab-jenkins.json](../examples/configuration/gitlab-jenkins.json) demonstrates two independent generic CI actions. These send exact source/event metadata; they do not transfer snapshots, run the portable SHACL validator or interpret CI success as model conformance.

Each action uses `task: {"type":"ci-trigger"}`. A GitLab target specifies HTTPS `endpoint`, a project ID/path, `ref`, and separate `trigger_token_env` / `read_token_env` names (defaults `GITLAB_TRIGGER_TOKEN`, `GITLAB_READ_TOKEN`). A Jenkins target specifies HTTPS `endpoint` (optionally including a context path), slash-separated folder/job names, and `username_env` / `token_env` (defaults `JENKINS_USERNAME`, `JENKINS_TOKEN`). Jenkins uses a username plus API token, not a password/crumb flow; job path segments use the adapter's safe identifier characters.

The destination must accept `ADAPTER_DELIVERY_ID`, `ADAPTER_EVENT_ID`, `ADAPTER_SOURCE_REVISION`, and `ADAPTER_SOURCE_BRANCH` as pipeline variables or Jenkins string parameters. Configure those parameters in the reviewed job/pipeline first. The code revision/ref belongs to CI; `ADAPTER_SOURCE_REVISION` identifies the model. Destination code is responsible for fetching and using that exact revision if it needs content.

Before submission, a durable `uncertain` record is written with one attempt. An accepted response retains its pipeline/queue identity. Later rounds inspect native state and retain a terminal generic result (`succeeded`, `failed`, `cancelled`, `execution-error`). Known submission rejections become execution errors. Missing credentials before submission leave the action pending with no attempt.

A lost response is reconciled using the delivery ID **and source revision**. GitLab scans at most 100 pipelines of the selected ref/trigger source and verifies variables. Jenkins checks the queue and up to 100 recent builds of the selected job; expired queue identities can recover through their build records. Conflicting matches or mismatched inputs remain unresolved. Limited history, API access or queue retention may prevent correlation. An absent match is not proof that submission failed: **uncertain generic submissions are never automatically resent**. Investigate native history and retained IDs; there is no automatic replay/retry control for ambiguous generic work. These adapters do not implement a destination-side worker claim or promise exactly-once execution.

GitLab read access to pipeline metadata/variables is separate from trigger permission. Jenkins must expose the selected job's queue/build parameter data and use the configured external base URL. Server-supplied locations cannot redirect credentials to another destination. The implementation follows the official [GitLab trigger](https://docs.gitlab.com/api/pipeline_triggers/), [pipeline inspection](https://docs.gitlab.com/api/pipelines/), [Jenkins remote access](https://www.jenkins.io/doc/book/using/remote-access-api/) and [API-token CSRF](https://www.jenkins.io/doc/book/security/csrf-protection/) interfaces. Compatibility with a particular installation still requires a credentialed acceptance run.

## Retained identities and configuration changes

The journal commits events, frozen action intents, rule bytes and checkpoints together. Text-engine intents freeze their reviewed profile and wrapper identity; shared input preparations retain their own pending/ready/error status. See [validation engines](validation-engines.md) for original-text producer binding, independent engine selection and worker setup. Action intents keep their source/credential variable names, destination, rule digest/bytes and validator digest. Removing or changing an action affects future events; old intents remain visible and continue with their original configuration. Keep the required original credential variables available until old work finishes. Secrets never enter retained action records.

Event identity, action-delivery identity and validation computation identity are separate. Returning A → B → A creates distinct change events/action intents. Identical commit/rule/validator work may reuse a completed result at the same GitHub destination. GitHub validation destinations have separate local work databases/bindings under `STATE_DIRECTORY/targets/`; GitHub's private input/claim/result references use the shared claim protocol. Status exposes action outcomes plus native computation state, attempts and external identity.

The executing source/runtime must match queued validator identity. Source edits change that digest. Unavailable original runtimes leave pending work with an explicit error; the adapter does not replace its identity. Keep the original source/runtime and state backup for reconciliation. Lost dispatch responses use the existing bounded claim/reconciliation protocol. Worker termination never causes automatic duplicate validation. See [GitHub recovery](github-execution.md).

## State and backups

The adapter initializes an empty journal with schema version 2 and reopens its own state after restart. Unsupported or unversioned populated databases are refused; no import or automatic upgrade is provided. Use a separate state directory for each source.

For backup, stop the writer and save its complete state directory, configured journal/feed paths and configuration together. Preserve SQLite WAL/SHM sidecars if present. Never copy only a live main database file. Restore the complete stopped-state backup with its matching source/runtime before resuming. Keep queued work's original rule, destination and validator identity intact.

## Docker

`compose.configured.yaml` is the single adapter Compose entrypoint; its project and named volume isolate adapter state. The separate local Jenkins Compose file provisions only the optional test service. Prepare a directory containing `adapter.json` and any rules. In the container JSON, choose `state_directory: /data`, a feed such as `/data/output/activity.json`, and relative rule paths inside `/configuration`.

```bash
# Set this for the current shell; load credentials separately.
export ADAPTER_CONFIG_DIR=/absolute/path/to/configuration
docker compose -f compose.configured.yaml config --quiet
docker compose -f compose.configured.yaml build adapter
docker compose -f compose.configured.yaml run --rm --no-deps adapter check --config /configuration/adapter.json
docker compose -f compose.configured.yaml run --rm --no-deps adapter run --config /configuration/adapter.json --once
```

The config/rules mount is read-only; `/data` is a persistent volume. The process runs as the image's non-root user, so the mounted directory/files must be readable by it. This Compose example passes the default credential environment variables; explicitly add pass-through entries if your JSON uses different variable names. Review destinations/workflow compatibility before continuous operation. Packaging does not publish code, provision secrets or deploy a watcher.
