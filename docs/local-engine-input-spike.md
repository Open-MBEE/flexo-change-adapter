# Local Flexo text-input spike

Observed on 16 October 2026. This is an isolated local development setup requested while planning selectable validation engines. It is not a released engine adapter, a SysML-to-RDF converter, or an engine execution report.

## Running service and files

- API: `https://localhost:18444` (self-signed local certificate).
- Docker Compose project: `flexo-engine-local`; Layer 1, Fuseki and a local HTTPS proxy.
- Repository: `https://localhost:18444/orgs/engine-demo/repos/text-fixture`; branch `master`.
- Source files, manifest captures, one-off helpers and non-secret evidence: ignored `.local/engine-input-spike/`.
- Model files: `models/types.sysml` declares a Vehicle with Real-valued mass/limit; `models/main.sysml` imports it and supplies 350/500. A second source version changes mass to 550.

The local data volume is `flexo-engine-local_quad-data`. Only the HTTPS proxy publishes a port, bound to loopback. Existing Jenkins and remote research infrastructure are outside this project. Root JWT credentials and TLS private keys are generated locally and held in container runtime memory; helpers pass JWTs in memory and never print them. Only the public TLS certificate is retained on the host. No 1Password items were created or changed.

Pinned images:

- Layer 1: `openmbee/flexo-mms-layer1-service@sha256:5e40dbf9318135f9e8097b4268f40f3cbcc1cf0d97c0eea04c4424749467325f`.
- Fuseki: `atomgraph/fuseki@sha256:9eb7a16dbddd35d9e293eed32a4e5b27ab04b6bd8ba4ef827ed00119d6e45bea`.
- HTTPS proxy: the existing local `flexo-change-adapter:alpha1-20261016` Node image, running a small development proxy.

## Observed provenance behavior

| Version | Flexo commit                           | Manifest SHA-256                                                   |
| ------- | -------------------------------------- | ------------------------------------------------------------------ |
| Initial | `739685fc-034c-4474-8ed4-d4a12d477e86` | `4910a347f9882481336b229a96d7ae460cec4b0745297fab223e1892c611492e` |
| Changed | `96025951-edff-42ec-a2c6-009fa36ed1ed` | `ab4f71e93587c8e8c32286bf263b8787db4bb79a20db5311fc7e4f915cdc6578` |

Each source file and the content manifest was uploaded as a repository artifact and downloaded again to verify its bytes. A committed RDF provenance index names the manifest artifact and digest. A named lock pins that index to its exact commit. After advancing the branch, the original lock still resolves to the original manifest and both original source files. Captures are under `captured/COMMIT/models/`.

The content manifest does not contain the commit that will later reference its hash. A separate receipt binds the resulting commit to the manifest, avoiding a circular hash dependency.

The released adapter's feed-only CLI observed a baseline and the later branch change against this real local API, retaining two events. The entire local Compose stack was stopped and recreated, then both retained source bundles were verified again with refreshed runtime credentials/TLS. No engine action, GitHub dispatch or remote model mutation was performed.

## Limits and next acceptance gate

The committed RDF is a **provenance index**, not a claim that the complete SysML semantic model has been translated into Flexo RDF. The original text is the test input. The subsequent [pinned CLI verification](engine-cli-verification-2026-10-16.md) accepted both captured bundles with both engines.

A bootstrap request with a specific `If-Match` value received HTTP 412 after the pinned Layer 1 image advanced the branch. The bounded fixture load therefore uses `If-Match: *` with one producer. Its evidence establishes source capture and retained-revision reads, not acceptance of optimistic concurrent writes. Preserve this observation when selecting a service version for broader acceptance.

The subsequent [CLI verification](engine-cli-verification-2026-10-16.md) records successful syntax/semantic runs and negative probes. Durable engine actions are the next implementation step.

## Local lifecycle

The following one-off files exist on this workstation under ignored `.local/`; they are not part of the alpha release:

```bash
docker compose -f .local/engine-input-spike/compose.yaml up -d
node .local/engine-input-spike/control.mjs setup
# Reverify the retained fixture without making another revision:
node .local/engine-input-spike/seed.mjs
# Stop this local stack and retain its data:
docker compose -f .local/engine-input-spike/compose.yaml down
```

`setup` refreshes the public certificate and in-memory authentication context after recreation. `down` retains the named quad-store volume; no automatic restart policy is installed. The stack is intentionally left running for further local development.
