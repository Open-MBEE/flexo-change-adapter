# Selecting validation engines

Validation delivery is independent of the checker. GitHub's retained input, durable claim, dispatch and result reconciliation support both SHACL graph validation and registered SysML text engines. Feed-only operation requires neither. GitLab/Jenkins remain metadata triggers.

## Configure one or both text engines

Use [github-engines.json](../examples/configuration/github-engines.json). Keep one action to run one engine; retain both actions to run both. Each action selects `task.type: engine-validation`, `engine: opensysml` or `sysml-toolkit`, and `profile: syntax-semantic-v1`. Optional `input` defaults to `flexo-text-manifest-v1`. There are no configurable commands, engine URLs or executable plugins.

The reviewed profiles pin OpenSysML 0.10.1 and Toolkit 0.10.2, executable digests, distinct standard libraries, syntax/semantic checks, warning policy, a 60-second deadline and a 256 KiB combined stdout/stderr limit. Toolkit warnings fail this profile; OpenSysML uses its native error policy. Constraint evaluation is not requested. Unsupported profile selections fail offline checking.

An optional `shacl-validation` action continues to select a rule and rule version with its existing RDF snapshot contract. It can run alongside either text engine. Their result formats retain their distinct meanings: SHACL uses conforming/nonconforming; text engines use pass/fail/inconclusive for the requested checks.

## Producer-owned source binding

The model producer must author one binding in the RDF graph of the exact Flexo revision:

```turtle
@prefix src: <urn:flexo-change-adapter:source:> .
<urn:my-project:source> a src:TextBundle ;
    src:manifest <https://flexo.example/orgs/ORG/repos/REPO/artifacts/MANIFEST-ID> ;
    src:sha256 "SHA256-OF-EXACT-MANIFEST-BYTES" .
```

The named manifest is JSON:

```json
{
  "format": "local-sysml-text-bundle-v1",
  "entrypoints": ["models/main.sysml"],
  "files": [
    {
      "path": "models/main.sysml",
      "role": "model",
      "size": 123,
      "sha256": "SHA256-OF-FILE-BYTES",
      "artifact": "https://flexo.example/orgs/ORG/repos/REPO/artifacts/SOURCE-ID"
    }
  ]
}
```

The sizes and digests above are placeholders. Include every project model and dependency file, preserving import paths under `models/`. `role` is `model` or `dependency`; extensions are `.sysml` or `.kerml`. Entry points must name included files. The worker supplies all included files to the engine as one model. There is no implicit filesystem/network import discovery.

The adapter reads a named `text-DIGEST` lock, verifies its exact commit and strong ETag before/after the graph read, then checks the producer manifest and every file digest. Artifacts must belong to the same Flexo repository. Inputs must be UTF-8, contain at most 128 files and total at most 1 MiB of source bytes; manifest/provenance bodies have bounded sizes. Invalid paths, duplicates, foreign URLs, mismatched hashes and missing files prevent execution. RDF-to-text conversion is not implemented.

The content manifest precedes the commit that references it and excludes that eventual commit ID. The retained binding envelope contains the revision, lock, graph, original manifest and files. This avoids a circular digest. Shared captures live under `STATE_DIRECTORY/inputs/`, published atomically and never replaced; status exposes their pending/ready/error state. Both engines reuse one capture. Source contents stay fixed after branch movement or restart, even if artifacts later change or disappear.

`allow_lock_creation: false` requires that the deterministic lock already exists. Set it true only when creating named locks for the selected repository is authorized. The [local input spike](local-engine-input-spike.md) demonstrates producer-owned artifact binding. That synthetic graph is a provenance index, not a semantic RDF conversion.

## Worker installation and isolation

Install matching source, lockfile, `scripts/install-engines.ts` and the reviewed workflow on the private execution repository's `main`. After winning an engine claim, the worker provisions checksum-pinned Linux x64 binaries and Toolkit library, plus a digest-pinned Alpine execution image. SHACL-only jobs skip engine provisioning. No package dependency or persistent engine service is added.

For a separately provisioned Linux worker:

```sh
node scripts/install-engines.ts --directory /writable/engine-directory
export FLEXO_ENGINE_DIRECTORY=/writable/engine-directory
```

Docker must be available on that worker. `FLEXO_ENGINE_DIRECTORY` defaults to `/opt/flexo-engines`. Binaries and the complete Toolkit library inventory are verified again before each execution. For rootless Docker, explicitly set `DOCKER_HOST` to its local `unix:///.../docker.sock`; the worker's clean environment does not read personal Docker contexts. Remote Docker endpoints are refused. The watcher itself needs no Docker socket or engine installation.

Each engine runs without network in a nonroot container, with read-only model and engine mounts, dropped capabilities, 2 GiB memory, two CPUs, a 128-process limit and a small temporary filesystem. Only reviewed flags and source paths are passed as argument arrays. Source and GitHub credentials are excluded from the process/container environment. The runner kills its process group and removes the container on timeout or excess output.

## Retained evidence and recovery

An engine computation binds the exact revision, prepared bundle digest, binary/library profile and wrapper/runtime identity. Event delivery remains separate. Removing an action or changing current configuration cannot retarget queued work. The shared SQLite delivery machinery reconciles the original run attempt and uses create-only claims to prevent duplicate engine execution.

GitHub input records contain `engine-request.json` and `model-bundle.json`, with base64 source bytes inside the verified bundle. Result records also retain `report.json`, a readable `report.txt`, and `result.json`. The 4 MiB Git record limit remains in force. The native report retains original stdout/stderr bytes as base64, display text, exit/signal, timeout/truncation flags, timestamps, command and normalized diagnostics. Reconciliation decodes the native result again and checks it against the recorded verdict and immutable bindings.

A pass requires a complete verified report for syntax and semantics. Syntax errors remain model failures even when they prevent semantic checking. Missing libraries/binaries, signals, timeouts, invalid output and incomplete analysis cannot pass. Unknown CLI options produce inconclusive execution evidence. Native codes, warning severity and position encoding are retained without asserting cross-engine equivalence.

One engine failure does not remove the other result. A claimed worker that ends without a retained result becomes inconclusive and is not automatically executed again. Already prepared remote work can reconcile without Flexo or the original local input files. Project gate policies and constraint/requirement execution remain planned; results are reported independently.

## Verification scope

The regression suite exercises configuration/removal, shared capture, exact revision reads, path/hash rejection, native report decoding, process limits, competing claims, lost responses and independent results. The new worker also ran both real pinned engines on both local Flexo revisions successfully; details are in [implementation acceptance](engine-implementation-acceptance.md). Hosted GitHub execution of this source revision has not been performed. Jenkins/GitLab generic adapters were unchanged.
