# Project status

Flexo Change Adapter is an initial alpha. Its configuration, CLI and state format may change before 1.0. The active runtime is TypeScript on Node 24.16.0.

| Capability          | Implementation                                                                | Limits                                                                                  |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Flexo observation   | Poll one repository branch, retain a baseline and observed changes            | Intermediate commits between polls can be missed; one source per process                |
| State and feed      | Atomic SQLite journal with optional JSON feed                                 | Local persistent storage; unsupported databases are refused                             |
| Independent actions | Freeze selected tasks, destinations, rules and validator identities           | Current configuration changes affect future events                                      |
| GitHub validation   | Verified snapshots, SHACL results, durable worker claims and retained reports | Requires a private execution repository with matching reviewed source/runtime           |
| GitLab and Jenkins  | Metadata-based triggering and native outcome reconciliation                   | Uncertain submissions are not automatically resent; CI success is not model conformance |
| Local Jenkins       | Pinned Compose service, reviewed smoke job and CLI acceptance helper          | Local development only                                                                  |

## Verification

The native suite covers transaction rollback, process crashes/restarts, frozen configurations, moving revisions, slow/failing destinations, lost responses, competing worker claims, SHACL violations and RDF graph comparison. Lightweight-command tests block validation dependencies to verify that feed-only and generic CI operation do not load them.

Development testing exercised private GitHub validation, local Jenkins jobs and GitLab.com pipelines on designated installations. Those runs do not establish deployment or live acceptance of every subsequent source revision. This alpha requires installation-specific verification before operational use. No production watcher is provisioned by the project.

Passing a project-specific SHACL rule is distinct from complete SysML/SHACL standards conformance and human research-case acceptance. Read [installation](installation.md), [configuration](configuration.md), [architecture](architecture.md) and [execution/recovery](github-execution.md).
