# SysML engine contracts investigated on 2026-10-16

This is release-pinned source/documentation research, not an execution report. No engine was installed or executed during this source investigation. Subsequent runs are recorded in the [local execution report](engine-cli-verification-2026-10-16.md). Release selection came from GitHub's latest non-prerelease release API, followed by resolution of each release tag to its commit. These are candidates for acceptance testing, not a claim of complete SysML conformance.

## Candidate pins

| Engine        | Release                                                                    | Resolved source commit                     |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| OpenSysML     | [v0.10.1](https://github.com/Open-MBEE/OpenSysML/releases/tag/v0.10.1)     | `1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2` |
| SysML Toolkit | [v0.10.2](https://github.com/Open-MBEE/sysml-toolkit/releases/tag/v0.10.2) | `821221767c3c56cb1ebe7da22666197a47c9c645` |

Sources: [OpenSysML tag commit](https://github.com/Open-MBEE/OpenSysML/commit/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2), [Toolkit tag commit](https://github.com/Open-MBEE/sysml-toolkit/commit/821221767c3c56cb1ebe7da22666197a47c9c645). Both releases offer native Linux binaries and checksum manifests. Before execution, pin the selected platform asset's digest, not just its release name.

## Syntax and semantic checks

Proposed invocations, to verify against downloaded pinned binaries:

```sh
OPENSYSML_LIBRARY_PATH=/bundle/libraries/standard \
  sysml -validate -strict -json /bundle/models/types.sysml /bundle/models/main.sysml

SYSMLV2_AMBIENT=off SYSMLV2_LIB_CACHE=off \
  sysmlv2 check --strict --format json --lib /bundle/libraries/standard \
  /bundle/models/types.sysml /bundle/models/main.sysml
```

Use an explicit ordered argument list from the verified bundle manifest, without shell interpolation. Add all project dependency files; namespace imports do not prove that omitted files have been fetched. Preserve relative file paths in the manifest and diagnostics.

OpenSysML's bare `-validate` loads and analyzes the model and exits; it does **not** evaluate its constraints. `-strict` promotes unsupported extension notation to errors; it is not a general warnings-as-errors setting. Multiple files, directories, globs, KerML, notebooks and API element JSON are documented inputs. Prefer an explicit text file list initially. Sources: [CLI reference](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/reference/cli.md), [strict-mode boundary](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/guide/03-command-line.md).

Toolkit `check` parses and checks body context, then resolves all cleanly parsed files as one model and runs referential and semantic checks. **The implementation runs the model stages even without `--lib`**, contrary to some help text that describes those stages as requiring it. An explicit library enriches resolution. Unresolved-reference findings can be warnings; `--strict` fails on warnings as well as errors. Library-loading failures return failure on stderr and can precede JSON report emission. Sources: [pinned CLI implementation, especially run_check and verdict](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/crates/sysmlv2-cli/src/lib.rs), [capability inventory and boundaries](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/README.md).

Neither tool's advertised checks establish complete language conformance. Toolkit explicitly describes its normative rule registry as incomplete, with remaining negative-fixture gaps and conservative dimensional analysis. Record actual requested/completed check categories, not a blanket “SysML valid” verdict.

## Structured results and exit interpretation

### OpenSysML

`-validate -json` uses this top-level report shape:

```json
{
  "status": "holds",
  "exit": 0,
  "checks": null,
  "diagnostics": null,
  "output": null,
  "errors": null
}
```

This illustrates the schema, not captured engine output. Arrays may be null when empty. Diagnostic fields are `severity`, `message`, `file`, `line`, `column`, `pass`, `code`. Verdicts can include native analysis plans and per-engine results. Preserve native codes and report bytes. Source: [checkReport, diagnostic, reporter.diags and reporter.finish](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/cmd/sysml/report.go).

Documented statuses: 0 requested work completed (warnings allowed), 1 model-decided false constraint/requirement verdict, 2 request could not be completed, including malformed/unresolved models and undecidable checks. Status 3 is a partial document-rendering outcome outside this proposed check mode. Thus syntax findings may produce process exit 2: classify explicit model diagnostics as model findings rather than treating every 2 as infrastructure failure. Missing input/library, malformed report or absent requested analysis must not become a pass. Source: [CLI exit-status contract](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/reference/cli.md#exit-status).

### Toolkit

`check --format json` emits `{findings: [...], summary: {errors, warnings, infos, hints}}`. Findings retain `stage` (parse/context/referential/semantic), `severity` (error/warn/info/hint), `message`, `unit`, `unitName`, byte `start/end` and 1-based `line/col/endLine/endCol`, plus lint-compatible fields. Check diagnostics have `rule: null`; do not invent native check IDs. Missing locations remain null. Source: [JSON projection and its tests](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/crates/sysmlv2-lint/src/json.rs).

The check implementation returns 0 when the requested check completes without failing findings, 1 for errors or strict warnings; file/library/output errors can also return 1. Argument-parser failures and killed processes need separate handling. Exit status alone cannot distinguish a model failure from an execution failure. Source: [run_check, read, verdict and CLI dispatcher](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/crates/sysmlv2-cli/src/lib.rs).

For both engines retain stdout, stderr, exit/signal, timeout, decoded report, executable digest and arguments. Only a complete, schema-valid report for the requested check with acceptable diagnostics can yield a pass.

## Libraries and reproducibility

OpenSysML embeds a standard library and applies its declared errata to the bundled copy. `OPENSYSML_LIBRARY_PATH` overrides it with an on-disk directory as supplied; `libs.Version()` is a content-derived library identity. Sources: [library selection and errata](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/internal/workspace/libs/source.go), [library version](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/internal/workspace/libs/load.go).

Toolkit takes `--lib` / `SYSMLV2_LIB_DIR`; its standard-library submodule is pinned to [SysML-v2-Release commit de1070ae8e79c21532b8004fc663d47b35d0e9fa](https://github.com/Systems-Modeling/SysML-v2-Release/tree/de1070ae8e79c21532b8004fc663d47b35d0e9fa/sysml.library). Its release README documents cache identity and `SYSMLV2_LIB_CACHE=off`, plus implicit TransformMeta loading disabled by `SYSMLV2_AMBIENT=off`. Sources: [pinned submodule tree](https://github.com/Open-MBEE/sysml-toolkit/tree/821221767c3c56cb1ebe7da22666197a47c9c645/spec-refs), [README](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/README.md).

Use identical project source/dependency bytes, but begin with engine-specific, pinned standard-library profiles. OpenSysML's corrected bundle and Toolkit's corpus pin are distinct baselines; do not assume their effective libraries, dialects or check coverage are equivalent. Record those differences, disable ambient additions and isolate caches/settings. A shared-library comparison is a separate experiment that first has to establish compatibility with both binaries. Toolkit's reference baseline includes the February 2025 metamodel/schema, documented in its [pinned specification references](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/spec-refs/README.md).

## Constraint verification is a separate capability

OpenSysML offers explicit constraint, requirement/satisfaction, object assertion and analysis/verification-case modes. Bare `-validate` does not run them. Its native engine plans, unsupported/bounded statuses and requested subjects must be retained for any later execution profile. Source: [check-mode flags and analysis-engine contracts](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/reference/cli.md).

Toolkit `verify` reports satisfied/violated/undecided constraints and satisfaction claims; `--ranges` enables interval propagation and `--solve` adds a Z3 subprocess for supported undecided fragments. **This pinned CLI has no verify JSON-format flag, and returns failure only when a constraint is violated; an all-undecided run can exit successfully.** Do not map verify exit 0 to pass. Source: [Verify arguments, verify_and_report and run_verify](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/crates/sysmlv2-cli/src/lib.rs).

Recommendation: deliver structured syntax/semantic profiles first; add constraint execution after selecting explicit subjects, solver pins, coverage requirements and a reliable structured verdict interface.

## RDF and JSON input investigation

OpenSysML supports Turtle and API element JSON, but its RDF/API mapping is explicitly experimental, refuses unsupported constructs and can require source-reconstruction metadata. That does not establish compatibility with an arbitrary Flexo RDF snapshot. Reading a live branch URL fetches its head, so it must not replace an adapter's already-pinned commit snapshot. Sources: [RDF mapping status](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/reference/rdf-mapping.md#status-experimental), [branch conversion semantics](https://github.com/Open-MBEE/OpenSysML/blob/1c45b6e1749fc8adc9b82d4af22fbe180b56a0e2/docs/reference/cli.md#reading-and-pushing-a-repository-branch).

Toolkit documents compact/full JSON interchange, JSON-to-text conversion and Flexo change-record payload support. Its pinned `run_check` reads text / expanded textual .kpar units and constructs ParsedSource objects; it does not directly use the JSON lift path used by conversion. Therefore JSON support elsewhere in the toolkit is not proof that `check model.json` is a supported common validation path. Sources: [README](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/README.md), [read_inputs, run_convert and run_check](https://github.com/Open-MBEE/sysml-toolkit/blob/821221767c3c56cb1ebe7da22666197a47c9c645/crates/sysmlv2-cli/src/lib.rs).

Keep original source text as the first common-input candidate. A separate, engine-neutral RDF/JSON-to-text converter remains an investigation, not an implemented or proven-lossless solution. If it becomes necessary, retain original snapshot, converter digest/settings, diagnostics and generated files. Do not convert through OpenSysML before evaluating Toolkit and call the resulting comparison independent.

## Remaining bounded acceptance work

1. Download and verify pinned executable assets; capture actual help/version outputs and platform digests.
2. Confirm both commands on identical multi-file models and libraries: valid, malformed, unresolved reference/type issue and missing dependency.
3. Capture real JSON for every outcome, including unreadable libraries and unsupported options; verify missing reports cannot pass.
4. Establish how exact-revision textual artifacts and dependencies are obtained from Flexo; repository artifact existence alone does not establish commit binding.
5. Verify timeout/crash behavior under worker resource limits and no network access.
6. Only then finalize engine profiles and add durable integration actions.
