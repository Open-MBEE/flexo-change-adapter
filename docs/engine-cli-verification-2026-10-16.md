# Local engine verification on 2026-10-16

OpenSysML v0.10.1 and SysML Toolkit v0.10.2 both accepted the two original multi-file bundles captured from local Flexo. This verifies the first common textual input path. These were manual CLI runs, not durable adapter actions or GitHub jobs.

[Retained evidence](engine-cli-captures-2026-10-16.json) includes exact synthetic source files, revision/manifest bindings, executable and archive digests, library identities, commands, native stdout/stderr, process outcomes and durations. The original captures passed their manifest and file SHA-256 checks before and after execution.

## Inputs and execution

The [local Flexo spike](local-engine-input-spike.md) captured revisions `739685fc-034c-4474-8ed4-d4a12d477e86` and `96025951-edff-42ec-a2c6-009fa36ed1ed`. Both contain `types.sysml` and `main.sysml`; the second changes mass from 350 to 550. The model contains no explicit mass-limit constraint. Both passing syntax/semantic runs therefore say nothing about whether 550 exceeds an allowed budget.

Release archives were downloaded from the official GitHub release assets and checked against both their previously recorded GitHub SHA-256 digests and release checksum manifests. OpenSysML's version output identifies source commit `1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2`; Toolkit reports `sysmlv2 0.10.2`.

Each model run used an isolated, nonroot Docker container with no network, read-only root and input mounts, dropped capabilities, a 64 MiB temporary filesystem, 2 GiB memory, two CPUs, a 128-process limit and a 60-second host timeout. All 14 runs finished without hitting the timeout. The container image digest is retained in the evidence. No production dependency was added.

OpenSysML used its embedded library, identified through the executable digest. Its separate content-derived library version was not captured. Toolkit used `sysml.library` from SysML-v2-Release commit `de1070ae8e79c21532b8004fc663d47b35d0e9fa`, with a retained 117-file hash manifest. These are distinct library profiles; no equivalence between them is claimed.

Commands, with each captured bundle mounted at `/models`:

```sh
OPENSYSML_RECORD_CACHE=0 sysml -validate -strict -json \
  -no-record-cache -jobs 1 /models/types.sysml /models/main.sysml

SYSMLV2_AMBIENT=off SYSMLV2_LIB_CACHE=off \
  sysmlv2 check --strict --format json --lib /pinned/sysml.library \
  /models/types.sysml /models/main.sysml
```

The evidence records the actual executable/library paths. Defect probes used separate copies, preserving the captured files.

## Observed outcomes

| Case                      | OpenSysML                        | Toolkit                                              |
| ------------------------- | -------------------------------- | ---------------------------------------------------- |
| Initial revision          | Exit 0; no diagnostics           | Exit 0; no findings                                  |
| Changed revision          | Exit 0; no diagnostics           | Exit 0; no findings                                  |
| Unclosed package          | Exit 2; syntax error in JSON     | Exit 1; parse error in JSON                          |
| Unknown Vehicle type      | Exit 2; three resolution errors  | Exit 1; three referential warnings under strict mode |
| Omitted types file        | Exit 2; four resolution errors   | Exit 1; four referential warnings under strict mode  |
| Missing library directory | Exit 2; five diagnostics in JSON | Exit 1; stderr library-load error, no JSON           |
| Unknown CLI option        | Exit 2; stderr, no JSON          | Exit 2; stderr, no JSON                              |

Toolkit check findings retained `rule: null`; OpenSysML retained its native diagnostic codes. JSON report shapes and process/report exit consistency were checked where reports were emitted. Every negative probe exited nonzero. An unknown argument probes CLI rejection only; it does not establish a capability-aware unsupported-check result contract.

## Implementation implications and remaining work

Toolkit needs strict warnings for this initial gating profile. OpenSysML's strict mode has a different meaning and does not generally promote warnings. Missing-library checks should happen before execution: OpenSysML's missing directory appeared as unresolved model symbols, while Toolkit emitted no structured report. A missing or malformed report must never yield a passing engine result.

The [engine plan](selectable-validation-engines-plan.md) remains unimplemented. Next work is to turn these verified invocations into separately registered durable actions, retain their native evidence and bind results to exact input/profile identities. GitHub execution, restart/queue recovery, gate policies, semantic type-error coverage, forced timeout/crash handling, malformed reports, engine disagreement and constraint execution still need acceptance tests. Existing GitLab/Jenkins generic triggers were unchanged.

The ignored local runner and full downloads remain under `.local/engine-input-spike/`; the shareable evidence above is self-contained for the observed inputs and reports. This is bounded acceptance of these fixtures and versions, not a claim of complete SysML conformance.
