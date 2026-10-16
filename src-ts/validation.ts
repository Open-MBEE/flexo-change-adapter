import { runtimeIdentity } from "./runtime-identity.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, digest } from "./contracts.ts";
import { writeJson, type RecordData } from "./workspace.ts";
import { Snapshot } from "./flexo.ts";
import { parse, subjects, RDF, SH, validateGraph } from "./rdf.ts";
export function validatorIdentity() {
  return { ...runtimeIdentity(), engine: "shacl-engine" };
}
export const validatorDigest = () => digest(canonicalJson(validatorIdentity()));
export async function validateSnapshot(
  snapshot: Snapshot,
  rule: Buffer,
  output: string,
  externalId: string,
) {
  const r = snapshot.request;
  if (digest(rule) !== r.rule_sha256)
    throw Error("Rule differs from pinned request");
  if (validatorDigest() !== r.validator_sha256)
    throw Error("Executing validator differs from pinned request");
  if (fs.existsSync(output)) throw Error("Report output exists");
  const data = parse(snapshot.model),
    shapes = parse(rule);
  if (subjects(shapes, RDF + "type", SH + "NodeShape").length !== 1)
    throw Error("Exactly one explicit NodeShape required");
  const report = await validateGraph(data, shapes, { meta: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "model.ttl"), snapshot.model);
  fs.writeFileSync(path.join(output, "rule.ttl"), rule);
  writeJson(path.join(output, "snapshot.json"), snapshot.metadata());
  fs.writeFileSync(path.join(output, "report.ttl"), report.bytes);
  fs.writeFileSync(path.join(output, "report.txt"), report.report);
  const result: RecordData = {
    schema_version: 1,
    work_id: r.work_id,
    commit_uri: r.commit_uri,
    rule_version: r.rule_version,
    rule_sha256: r.rule_sha256,
    validator_sha256: r.validator_sha256,
    validator_identity: validatorIdentity(),
    input_sha256: snapshot.input_sha256,
    report_sha256: digest(report.bytes),
    outcome: report.conforms ? "conforming" : "nonconforming",
    external_id: externalId,
    report_url: null,
    limits: ["Local validation; no Actions run or hosted report URL implied"],
  };
  writeJson(path.join(output, "result.json"), result);
  return result;
}
