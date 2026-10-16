# Troubleshooting

Start from the configuration and retained status, using the same JSON file and
runtime as the watcher. Commands below run from the repository root:

```bash
node --version
command -v flock
npm run adapter -- check --config .local/adapter.json
npm run adapter -- status --config .local/adapter.json
```

`check` is offline and does not establish remote connectivity or credentials.
`status` makes no remote calls; `initialized: false` means the selected database
has not been created. Review configuration paths before assuming state was lost.
Do not paste resolved secrets, complete environments, model snapshots or private
reports into an issue. Inspect and redact status output before sharing it: it
can contain source identifiers, destinations and result metadata.

## Setup and observation

| Symptom                                           | Check                                                                                        | Next step                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node cannot run TypeScript or SQLite              | Compare `node --version` with the reviewed 24.16.0 runtime                                   | Select the supported runtime and install committed dependencies with `npm ci`; do not update dependencies as a diagnostic shortcut                                 |
| `flock` cannot be started, or the command exits 1 | Check `command -v flock`; determine whether another writer uses the same state/feed          | Use the Linux runtime/container; stop the other writer cleanly before retrying. Do not delete lock files or bypass locking                                         |
| Unknown field/adapter or unreadable rule          | Run offline `check`; inspect the JSON and its rule path                                      | Use schema version 1 and supported fields. Resolve paths from the JSON directory, including after copying examples                                                 |
| State/path conflict or ownership error            | Compare source, database, state and feed paths with the previous configuration               | Use separate state for another source; initialize a separate state directory for another source                                                                    |
| Flexo login/HTTP failure                          | Check the configured HTTPS host, source IDs and authorized credential variable names locally | Load authorized credentials through the approved helper. Set `FLEXO_USERNAME` explicitly for password login. Request the necessary source access through its owner |
| Flexo transport failure                           | Check whether this host/container can reach the existing endpoint and trusts its certificate | Restore approved network/Tailscale connectivity and trusted TLS; do not disable certificate verification                                                           |
| No new event                                      | Inspect retained poll health and the observed head                                           | An unchanged head creates no event; intermediate revisions between polls can be skipped. A failed read preserves history                                           |
| Feed missing or stale                             | Inspect retained observations and configured feed directory permissions                      | Correct the writable output path; a later successful publication regenerates the feed. Mount the directory, not the individual file, for consumers                 |

## CI actions and results

| Symptom                                                             | Check                                                                                           | Next step                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline exists but no action was queued                            | Inspect the action's `on` selection                                                             | `branch-change` excludes first observation. Add `baseline` only deliberately; changing configuration does not replay history                      |
| `run --once` returns before a result appears                        | Inspect action/delivery state through `status`                                                  | Repeat rounds or run continuously. One round does not wait indefinitely for asynchronous CI                                                       |
| Pending action with missing credentials                             | Check configured environment variable names without printing values                             | Load the required credentials, including original variable names for retained actions. Custom Compose names need explicit pass-through            |
| GitHub delivery rejected or worker absent                           | Check private repository, reviewed `main` workflow, repository allowlist and token permissions  | Align the selected destination with the reviewed workflow; Contents write and Actions write/read are required                                     |
| `Pinned lock absent; explicit creation required`                    | Inspect the work's requested revision and authorized Flexo lock setup                           | Arrange the matching commit-pinned lock, or enable `allow_lock_creation` only when authorized. Do not validate the current branch as a substitute |
| Lock references another commit or changes during read               | Compare the intended immutable revision with the lock binding                                   | Investigate the mismatched/retargeted lock with its owner; retain the failed work and exact revision                                              |
| `Queued validator runtime unavailable` or validator digest mismatch | Compare the original queued source/assets, lockfile and runtime with the current worker/watcher | Restore the original matching environment for reconciliation. Do not replace queued identities or rebuild retained work under a new digest        |
| SHACL reports nonconformance                                        | Inspect the retained result and authorized report                                               | Correct the model or review the rule as appropriate. Nonconformance is a completed validation outcome, not a delivery error                       |
| GitLab/Jenkins stays `uncertain`                                    | Inspect retained delivery/revision IDs and authorized native pipeline/queue/build history       | Follow the bounded correlation procedure; absent matches do not prove submission failed. Ambiguous submissions are never automatically resent     |
| GitLab/Jenkins succeeds but no SHACL report exists                  | Inspect the configured task type                                                                | Generic `ci-trigger` retains native CI outcomes and sends metadata; it does not run the SHACL validator                                           |
| Worker crashed after claiming validation                            | Inspect retained claim/result records and original runtime                                      | Follow operator-led recovery; worker-crash re-execution is deliberately disabled                                                                  |

See [GitHub recovery and retention](github-execution.md) and
[generic CI reconciliation](configuration.md#gitlab-and-jenkins-triggers) before
attempting recovery. Do not delete database/spool/claim/result records or manually
replay uncertain deliveries to force progress.

## Containers and persistent state

Use `docker compose -f compose.configured.yaml config --quiet` to check Compose
syntax without dumping the resolved environment. `ADAPTER_CONFIG_DIR` must name
an existing directory containing `adapter.json` and any rules. A non-root
container must be able to read the mounted files; configuration is mounted
read-only, and state/output should be under writable `/data`.

Inspect state with the same Compose project while the watcher runs:

```bash
docker compose -f compose.configured.yaml run --rm --no-deps adapter status --config /configuration/adapter.json
```

Compose retains state in `flexo-configured-adapter_configured-state`; native state is separate. `down` preserves the volume; `down -v` removes it.
Recreate the service after changing loaded credentials. If recovery requires a
restore, stop the writer and follow the complete stopped-state backup/restore
procedure in [configuration](configuration.md#state-and-backups).

## Reporting a reproducible issue

Include the command and runtime version, affected adapter revision, selected
integration, expected/observed behavior, redacted error and the relevant local
checks. State whether the behavior occurred offline, against transport fixtures
or in an authenticated live environment. Include only the minimum safe metadata;
follow [security reporting](../SECURITY.md) for vulnerabilities.
