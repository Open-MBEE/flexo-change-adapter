# Installation and first run

Run the adapter beside an existing Flexo MMS Layer 1 deployment. One configuration
observes one branch. Start with a feed-only source, then add CI actions after
checking their destinations and permissions. See [project status](status.md) for
verification evidence and outstanding live acceptance.

## Prerequisites

- Node.js **24.16.0** and npm for native operation. The reviewed GitHub worker
  uses the same pinned runtime; matching source, assets and dependencies are part
  of its validator identity.
- Linux `flock` for configured `run`, including `--once`.
  Offline `check` and `status` do not acquire writer locks.
- An existing host-only HTTPS Flexo endpoint, organization, repository and branch,
  with authorized model/branch reads and trusted certificates.
- Docker Engine and Docker Compose for container operation instead of native Node.
  `just` is optional for the JSON configuration path.

Use the committed lockfile and your machine's existing package-manager policy.
Maintainers should follow their repository context checks before installing
packages or contacting remote services.

## Native setup

From the repository root:

```bash
npm ci
npm run adapter -- --help
npm run adapter -- check --config examples/configuration/feed.json
mkdir -p .local
```

The check is offline: it neither resolves credentials nor creates state. Expected
output includes `"configuration": "valid"`, `"offline": true` and
`"schema_version": 1`.

Create the ignored `.local/adapter.json`:

```json
{
  "schema_version": 1,
  "id": "my-model",
  "state_directory": "./my-model",
  "source": {
    "type": "flexo",
    "endpoint": "https://flexo.example",
    "organization": "YOUR-ORGANIZATION",
    "repository": "YOUR-REPOSITORY",
    "branch": "YOUR-BRANCH"
  },
  "observation": { "mode": "poll", "interval_seconds": 30 },
  "feed": { "type": "json-feed", "path": "./my-model/output/activity.json" },
  "actions": []
}
```

Replace the endpoint and source identifiers. All relative paths resolve from the
JSON file, not the shell's working directory. This example writes state and feed
under `.local/my-model/`; its default database is `events.sqlite`. Use distinct
state/output paths for each source. Copying an example to another directory
requires reviewing its state, feed and rule paths.

Load authorized credentials into the process environment through your approved
secret workflow. Flexo accepts `FLEXO_TOKEN`, or `FLEXO_PASSWORD` with an explicit
`FLEXO_USERNAME` (the implementation defaults to `rohan` if omitted). Keep secret
values out of JSON, command arguments and committed files. JSON credential fields
name environment variables; they do not resolve `op://` references. Existing
1Password/direnv users should retain their approved helpers and approve directory
trust themselves.

```bash
npm run adapter -- check --config .local/adapter.json
npm run adapter -- status --config .local/adapter.json
npm run adapter -- run --config .local/adapter.json --once
npm run adapter -- status --config .local/adapter.json
```

Before the first run, status reports `initialized: false` and an empty `actions`
array. A successful first observation records a baseline and publishes the feed.
An unchanged head does not create another event. Inspect retained poll/event
status and `.local/my-model/output/activity.json`; do not infer remote success
from offline checking alone.

To keep observing:

```bash
npm run adapter -- run --config .local/adapter.json
```

Stop with Ctrl-C and allow in-flight operations to finish. Run only one writer
for each state/feed location. Back up the closed database, any remaining SQLite
sidecars, target state/spool and configuration together while stopped. See
[state and backups](configuration.md#state-and-backups).

Optional recipes use the same JSON interface:

```bash
just configured-check .local/adapter.json
just configured-once .local/adapter.json
just configured-status .local/adapter.json
just configured-run .local/adapter.json
```

## Add CI actions

Choose a recipe from the [examples index](../examples/README.md). Actions selecting
`branch-change` run for later observed changes; include `baseline` explicitly if
first-observation execution is wanted. Historical events are not replayed when
an action is added. `run --once` performs one observation/delivery round; repeat
it or use continuous operation to collect asynchronous CI results.

For GitHub SHACL validation, prepare a **private** target repository containing
the matching reviewed `src-ts/`, `package.json`, `package-lock.json` and
`.github/workflows/flexo-validate.yml` on `main`. The worker accepts only manual dispatches of the reviewed workflow on `main` and verifies the target repository is private before reading model inputs. The public source repository and private validation target can be separate. Configure GitHub Contents write and Actions
write/read permissions, and load `GITHUB_TOKEN`. Full model snapshots are
transferred to that private repository; the worker receives no Flexo credential.

Validation requires model/branch/lock reads. Set `allow_lock_creation: true` only
when named commit-pinned Flexo lock creation is authorized; otherwise the
required matching lock must already exist. Rebuild/publish matching reviewed
worker code when validator source or locked dependencies change, preserving the
original runtime for pending work. See [GitHub execution](github-execution.md).

GitLab and Jenkins send revision metadata rather than SHACL snapshots. Their
permissions, credential variables and required pipeline/job parameters are in
[configuration](configuration.md#gitlab-and-jenkins-triggers).

## Docker setup

Prepare a host directory containing `adapter.json` and any rule files. Use
`state_directory: "/data"` and, if enabled, feed path
`"/data/output/activity.json"`. Relative rule paths resolve inside the mounted
`/configuration` directory, so copy the rule files there and adjust their paths.
Set the directory for the current shell:

```bash
export ADAPTER_CONFIG_DIR=/absolute/path/to/configuration
# Load authorized credentials separately through your approved helper.
docker compose -f compose.configured.yaml config --quiet
docker compose -f compose.configured.yaml build adapter
docker compose -f compose.configured.yaml run --rm --no-deps adapter check --config /configuration/adapter.json
docker compose -f compose.configured.yaml run --rm --no-deps adapter run --config /configuration/adapter.json --once
docker compose -f compose.configured.yaml run --rm --no-deps adapter status --config /configuration/adapter.json
```

After reviewing the first run, run continuously in the foreground or start a
background service:

```bash
docker compose -f compose.configured.yaml up -d --no-build adapter
docker compose -f compose.configured.yaml logs --follow adapter
# Stop and remove the service, retaining its state volume:
docker compose -f compose.configured.yaml down
```

The Compose project is `flexo-configured-adapter`; persistent state is in
`flexo-configured-adapter_configured-state`. Native and container state are
separate. Do not delete the volume or use `down -v` for routine cleanup. Avoid
running a second writer while the service is active; `status` can inspect it.

The process runs as the non-root `node` user with a read-only root filesystem and
writable temporary storage. Mounted configuration/rules must be readable by that
user. Compose passes the default credential variables; custom environment names
require explicit pass-through entries. Recreate the service after credentials
change. No port is published. Outbound access to configured services is required;
on an existing Linux Tailscale host, `ADAPTER_NETWORK_MODE=host` can be selected
when bridge networking cannot reach the private endpoint. Retain trusted TLS.
Packaging does not provision network access, publish images or deploy remotely.

For failures, start with [troubleshooting](troubleshooting.md).
