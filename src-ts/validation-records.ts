import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isDeepStrictEqual as equal } from "node:util";
import { EngineRequest } from "./engine-contracts.ts";
import { type WorkRequest, checkWorkResult } from "./requests.ts";
import {
  ENGINE_INPUT_FILES,
  ENGINE_RESULT_FILES,
  checkEngineInput,
  runEngineRecord,
  checkEngineEvidence,
} from "./engine-record.ts";
import { ValidationRequest, canonicalJson, digest } from "./contracts.ts";
import { Snapshot } from "./flexo.ts";
import { validateSnapshot } from "./validation.ts";
import { parse, subjects, objects, RDF, SH, XSD } from "./rdf.ts";
import type { RecordData } from "./workspace.ts";
export const INPUT_FILES = ["model.ttl", "rule.ttl", "snapshot.json"],
  RESULT_FILES = [...INPUT_FILES, "report.ttl", "report.txt", "result.json"];
export const checkFiles = (files: Record<string, Buffer>, names: string[]) => {
  if (!equal(Object.keys(files).sort(), [...names].sort()))
    throw Error("Unexpected record files");
};
export function inputBundle(s: Snapshot, rule: Buffer) {
  if (digest(rule) !== s.request.rule_sha256)
    throw Error("Rule differs from request");
  return {
    "model.ttl": s.model,
    "rule.ttl": rule,
    "snapshot.json": Buffer.from(canonicalJson(s.metadata())),
  };
}
export function checkInput(
  files: Record<string, Buffer>,
  request: ValidationRequest,
) {
  checkFiles(files, INPUT_FILES);
  const s = Snapshot.fromFiles(files);
  if (
    !equal(s.request.toDict(), request.toDict()) ||
    digest(files["rule.ttl"]) !== request.rule_sha256
  )
    throw Error("Input does not bind queued request");
  return s;
}
export function recordRequest(files: Record<string, Buffer>): WorkRequest {
  return files["engine-request.json"]
    ? EngineRequest.fromDict(
        JSON.parse(files["engine-request.json"].toString()),
      )
    : Snapshot.fromFiles(files).request;
}
export function verifyInput(files: Record<string, Buffer>, r: WorkRequest) {
  return r instanceof EngineRequest
    ? checkEngineInput(files, r)
    : checkInput(files, r);
}
export const inputNames = (r: WorkRequest) =>
  r instanceof EngineRequest ? ENGINE_INPUT_FILES : INPUT_FILES;
export const resultNames = (r: WorkRequest) =>
  r instanceof EngineRequest ? ENGINE_RESULT_FILES : RESULT_FILES;
export const reportName = (r: WorkRequest) =>
  r instanceof EngineRequest ? "report.json" : "report.ttl";

export const bundleDigest = (files: Record<string, Buffer>) =>
  digest(
    canonicalJson(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])),
    ),
  );
export async function runValidationRecord(
  files: Record<string, Buffer>,
  r: WorkRequest,
  external: string,
  engineWorker = runEngineRecord,
) {
  if (r instanceof EngineRequest) return engineWorker(files, r, external);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flexo-record-"));
  try {
    const out = path.join(tmp, "report"),
      result = await validateSnapshot(
        checkInput(files, r),
        files["rule.ttl"],
        out,
        external,
      );
    return {
      result,
      evidence: {
        ...files,
        "report.ttl": fs.readFileSync(path.join(out, "report.ttl")),
        "report.txt": fs.readFileSync(path.join(out, "report.txt")),
      },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export function verifyResultRecord(
  files: Record<string, Buffer>,
  inputs: Record<string, Buffer>,
  r: WorkRequest,
) {
  checkFiles(files, resultNames(r));
  const s = verifyInput(inputs, r);
  for (const name of inputNames(r))
    if (!files[name].equals(inputs[name])) throw Error("Result input differs");
  const result = JSON.parse(files["result.json"].toString());
  checkWorkResult(r, result);
  if (
    result.input_sha256 !== s.input_sha256 ||
    result.report_sha256 !== digest(files[reportName(r)])
  )
    throw Error("Result evidence binding mismatch");
  if (r instanceof EngineRequest) checkEngineEvidence(files, r, result);
  else {
    if (
      result.rule_sha256 !== digest(files["rule.ttl"]) ||
      digest(canonicalJson(result.validator_identity)) !== r.validator_sha256
    )
      throw Error("Result evidence binding mismatch");
    const graph = parse(files["report.ttl"]),
      roots = subjects(graph, RDF + "type", SH + "ValidationReport"),
      values =
        roots.length === 1 ? objects(graph, roots[0], SH + "conforms") : [];
    if (
      values.length !== 1 ||
      values[0].termType !== "Literal" ||
      values[0].datatype.value !== XSD + "boolean" ||
      !["true", "false", "1", "0"].includes(values[0].value)
    )
      throw Error("Invalid SHACL report");
    if (
      result.outcome !==
      (["true", "1"].includes(values[0].value) ? "conforming" : "nonconforming")
    )
      throw Error("Report outcome differs");
  }
  return result as RecordData;
}
