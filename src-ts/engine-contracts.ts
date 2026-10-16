import { Branch, canonicalJson, checkedDigest, digest } from "./contracts.ts";
import { requireFields, type RecordData } from "./workspace.ts";
import { runtimeIdentity } from "./runtime-identity.ts";
export const engineIds = ["opensysml", "sysml-toolkit"] as const;
export type EngineId = (typeof engineIds)[number];
export const inputProvider = {
  type: "flexo-text-manifest" as const,
  version: 1,
};
export type EngineProfile = {
  engine: EngineId;
  version: string;
  binary_sha256: string;
  library: string;
  library_sha256: string;
  checks: ["syntax", "semantic"];
  warning_policy: "native" | "fail";
  timeout_seconds: number;
  max_output_bytes: number;
};
// Reviewed profiles, never commands or URLs supplied by a model/configuration.
export const profiles: Record<EngineId, EngineProfile> = {
  opensysml: {
    engine: "opensysml",
    version: "0.10.1",
    binary_sha256:
      "c3cc160b16f3e035033617017209f3c740c6881dac2bc0af78240d4306d83a50",
    library: "embedded",
    library_sha256:
      "c3cc160b16f3e035033617017209f3c740c6881dac2bc0af78240d4306d83a50",
    checks: ["syntax", "semantic"],
    warning_policy: "native",
    timeout_seconds: 60,
    max_output_bytes: 262144,
  },
  "sysml-toolkit": {
    engine: "sysml-toolkit",
    version: "0.10.2",
    binary_sha256:
      "4257d166199af934069802b6348f7393463a711478464600b4f9e48e2f7b08f1",
    library: "SysML-v2-Release@de1070ae8e79c21532b8004fc663d47b35d0e9fa",
    library_sha256:
      "cc48b7e0dfc9ab69a880797e89ae5e5ae469f4b3a10370d20660b8870ca71740",
    checks: ["syntax", "semantic"],
    warning_policy: "fail",
    timeout_seconds: 60,
    max_output_bytes: 262144,
  },
};
export function engineProfile(id: string): EngineProfile {
  if (!Object.hasOwn(profiles, id)) throw Error("Unsupported engine profile");
  return structuredClone(profiles[id as EngineId]);
}
export const engineRuntimeDigest = () =>
  digest(canonicalJson(runtimeIdentity()));
export class EngineRequest {
  readonly source: Branch;
  readonly commit_uri: string;
  readonly input_sha256: string;
  readonly profile: EngineProfile;
  readonly validator_sha256: string;
  constructor(
    source: Branch,
    commit: string,
    input: string,
    profile: EngineProfile,
    validator: string,
  ) {
    this.source = source;
    this.commit_uri = source.checkCommit(commit);
    this.input_sha256 = checkedDigest(input);
    if (canonicalJson(profile) !== canonicalJson(engineProfile(profile.engine)))
      throw Error("Unsupported engine profile");
    this.profile = structuredClone(profile);
    this.validator_sha256 = checkedDigest(validator);
  }
  get work_id() {
    return digest(
      canonicalJson({
        schema_version: 2,
        commit_uri: this.commit_uri,
        input_sha256: this.input_sha256,
        profile: this.profile,
        validator_sha256: this.validator_sha256,
      }),
    );
  }
  toDict() {
    return {
      schema_version: 2,
      source: this.source.toDict(),
      commit_uri: this.commit_uri,
      input_sha256: this.input_sha256,
      profile: this.profile,
      validator_sha256: this.validator_sha256,
      work_id: this.work_id,
    };
  }
  static fromDict(v: RecordData) {
    requireFields(v, [
      "schema_version",
      "source",
      "commit_uri",
      "input_sha256",
      "profile",
      "validator_sha256",
      "work_id",
    ]);
    requireFields(v.source, [
      "base_url",
      "organization",
      "repository",
      "branch",
    ]);
    if (v.schema_version !== 2) throw Error("Invalid engine request schema");
    const s = v.source,
      r = new EngineRequest(
        new Branch(s.base_url, s.organization, s.repository, s.branch),
        v.commit_uri,
        v.input_sha256,
        v.profile,
        v.validator_sha256,
      );
    if (r.work_id !== v.work_id) throw Error("Engine request identity differs");
    return r;
  }
}
export type Diagnostic = {
  severity: "error" | "warning" | "info" | "hint";
  native_severity: string;
  code: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  position_encoding: string;
  message: string;
  stage: string;
};
export type EngineReport = {
  execution: "completed" | "error" | "timeout" | "unsupported";
  verdict: "pass" | "fail" | "inconclusive";
  checks: {
    check: "syntax" | "semantic";
    completed: boolean;
    reason: string | null;
  }[];
  diagnostics: Diagnostic[];
  error_code: string | null;
};
export function checkEngineReport(r: RecordData) {
  requireFields(r, [
    "execution",
    "verdict",
    "checks",
    "diagnostics",
    "error_code",
  ]);
  if (
    !["completed", "error", "timeout", "unsupported"].includes(r.execution) ||
    !["pass", "fail", "inconclusive"].includes(r.verdict) ||
    !Array.isArray(r.checks) ||
    !Array.isArray(r.diagnostics)
  )
    throw Error("Invalid engine report");
  if (
    r.checks.length !== 2 ||
    [...r.checks.map((c: RecordData) => c.check)].sort().join() !==
      "semantic,syntax"
  )
    throw Error("Requested checks differ");
  for (const c of r.checks) {
    requireFields(c, ["check", "completed", "reason"]);
    if (
      typeof c.completed !== "boolean" ||
      (c.reason !== null && typeof c.reason !== "string")
    )
      throw Error("Invalid check coverage");
  }
  for (const d of r.diagnostics) {
    requireFields(d, [
      "severity",
      "native_severity",
      "code",
      "file",
      "line",
      "column",
      "position_encoding",
      "message",
      "stage",
    ]);
    if (
      !["error", "warning", "info", "hint"].includes(d.severity) ||
      typeof d.message !== "string" ||
      typeof d.stage !== "string" ||
      typeof d.native_severity !== "string" ||
      typeof d.position_encoding !== "string" ||
      (d.code !== null && typeof d.code !== "string") ||
      (d.file !== null && typeof d.file !== "string")
    )
      throw Error("Invalid normalized diagnostic");
    for (const n of [d.line, d.column])
      if (n !== null && (!Number.isSafeInteger(n) || n < 1))
        throw Error("Invalid diagnostic location");
  }
  if (
    r.verdict === "pass" &&
    (r.execution !== "completed" ||
      r.error_code !== null ||
      r.checks.some((c: RecordData) => !c.completed) ||
      r.diagnostics.some((d: Diagnostic) => d.severity === "error"))
  )
    throw Error("Incomplete engine report cannot pass");
  if (
    r.execution !== "completed" &&
    (r.verdict !== "inconclusive" ||
      typeof r.error_code !== "string" ||
      !r.error_code)
  )
    throw Error("Execution failure cannot pass");
}
export function checkEngineResult(request: EngineRequest, r: RecordData) {
  if (!r || r.schema_version !== 2) throw Error("Invalid engine result schema");
  for (const k of [
    "work_id",
    "commit_uri",
    "input_sha256",
    "validator_sha256",
  ] as const)
    if (r[k] !== request[k]) throw Error("Result differs from queued input");
  if (canonicalJson(r.profile) !== canonicalJson(request.profile))
    throw Error("Result profile differs");
  checkEngineReport(r.report);
  if (r.outcome !== r.report.verdict) throw Error("Result verdict differs");
  if (typeof r.external_id !== "string" || !r.external_id.trim())
    throw Error("External identity required");
  const url = new URL(r.report_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /\s/.test(r.report_url)
  )
    throw Error("Invalid report URL");
  if (r.report_sha256 !== null) checkedDigest(r.report_sha256);
  else if (r.report.execution === "completed")
    throw Error("Completed result requires report");
}
