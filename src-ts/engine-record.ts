import { canonicalJson, digest } from "./contracts.ts";
import {
  EngineRequest,
  checkEngineReport,
  checkEngineResult,
} from "./engine-contracts.ts";
import { checkModelBundle, type ModelBundle } from "./model-input.ts";
import {
  executeEngine,
  decodeEngine,
  unavailable,
} from "./engine-execution.ts";
import { requireFields, timestamp, type RecordData } from "./workspace.ts";
export const ENGINE_INPUT_FILES = ["engine-request.json", "model-bundle.json"];
export const ENGINE_RESULT_FILES = [
  ...ENGINE_INPUT_FILES,
  "report.json",
  "report.txt",
  "result.json",
];
export function engineInputBundle(r: EngineRequest, b: ModelBundle) {
  checkModelBundle(b, r.source, r.commit_uri);
  if (digest(canonicalJson(b)) !== r.input_sha256)
    throw Error("Engine bundle differs");
  return {
    "engine-request.json": Buffer.from(canonicalJson(r.toDict())),
    "model-bundle.json": Buffer.from(canonicalJson(b)),
  };
}
export function checkEngineInput(
  files: Record<string, Buffer>,
  request: EngineRequest,
) {
  requireFields(files, ENGINE_INPUT_FILES);
  const r = EngineRequest.fromDict(
      JSON.parse(files["engine-request.json"].toString("utf8")),
    ),
    bundle = JSON.parse(files["model-bundle.json"].toString("utf8"));
  if (
    canonicalJson(r.toDict()) !== canonicalJson(request.toDict()) ||
    digest(files["model-bundle.json"]) !== r.input_sha256 ||
    canonicalJson(bundle) !== files["model-bundle.json"].toString()
  )
    throw Error("Engine input does not bind request");
  checkModelBundle(bundle, r.source, r.commit_uri);
  return { request: r, input_sha256: r.input_sha256, bundle };
}
export async function runEngineRecord(
  files: Record<string, Buffer>,
  r: EngineRequest,
  external: string,
) {
  const { bundle } = checkEngineInput(files, r),
    native = await executeEngine(
      r,
      bundle,
      process.env.FLEXO_ENGINE_DIRECTORY ?? "/opt/flexo-engines",
    ),
    report = Buffer.from(canonicalJson(native));
  const result: RecordData = {
    schema_version: 2,
    work_id: r.work_id,
    commit_uri: r.commit_uri,
    input_sha256: r.input_sha256,
    validator_sha256: r.validator_sha256,
    profile: r.profile,
    report: native.report,
    outcome: native.report.verdict,
    report_sha256: digest(report),
    external_id: external,
  };
  const text = Buffer.from(
    `${r.profile.engine} ${r.profile.version}: ${native.report.verdict}\nExecution: ${native.report.execution}\n${native.report.diagnostics.map((d) => `${d.severity}: ${d.file ?? ""}:${d.line ?? ""}:${d.column ?? ""}: ${d.message}`).join("\n")}\n`,
  );
  return {
    result,
    evidence: { ...files, "report.json": report, "report.txt": text },
  };
}
export function checkEngineEvidence(
  files: Record<string, Buffer>,
  r: EngineRequest,
  result: RecordData,
) {
  checkEngineResult(r, result);
  const native = JSON.parse(files["report.json"].toString("utf8"));
  requireFields(native, [
    "schema_version",
    "request",
    "input_content_sha256",
    "profile",
    "process",
    "report",
  ]);
  if (
    native.schema_version !== 1 ||
    canonicalJson(native.request) !== canonicalJson(r.toDict()) ||
    canonicalJson(native.profile) !== canonicalJson(r.profile) ||
    digest(files["report.json"]) !== result.report_sha256
  )
    throw Error("Engine report binding mismatch");
  const { bundle } = checkEngineInput(
      Object.fromEntries(ENGINE_INPUT_FILES.map((n) => [n, files[n]])),
      r,
    ),
    input = checkModelBundle(bundle, r.source, r.commit_uri);
  if (native.input_content_sha256 !== input.content_sha256)
    throw Error("Engine content digest differs");
  checkEngineReport(native.report);
  if (canonicalJson(native.report) !== canonicalJson(result.report))
    throw Error("Engine result/report differs");
  if (native.process !== null) {
    const p = native.process;
    requireFields(p, [
      "exit",
      "signal",
      "timeout",
      "truncated",
      "stdout",
      "stderr",
      "stdout_base64",
      "stderr_base64",
      "started_at",
      "finished_at",
      "argv",
    ]);
    if (
      typeof p.stdout !== "string" ||
      typeof p.stderr !== "string" ||
      typeof p.timeout !== "boolean" ||
      typeof p.truncated !== "boolean" ||
      (p.exit !== null && !Number.isInteger(p.exit)) ||
      (p.signal !== null && typeof p.signal !== "string") ||
      !Array.isArray(p.argv) ||
      Buffer.byteLength(p.stdout) + Buffer.byteLength(p.stderr) >
        r.profile.max_output_bytes + 8
    )
      throw Error("Invalid process evidence");
    if (
      typeof p.started_at !== "string" ||
      typeof p.finished_at !== "string" ||
      timestamp(p.finished_at) < timestamp(p.started_at) ||
      p.argv.some((a: unknown) => typeof a !== "string")
    )
      throw Error("Invalid process timing/command");
    if (canonicalJson(decodeEngine(r, p)) !== canonicalJson(native.report))
      throw Error("Native report verdict differs");
  } else if (
    canonicalJson(native.report) !==
    canonicalJson(unavailable("engine-installation-or-execution-error"))
  )
    throw Error("Missing process evidence");
}
