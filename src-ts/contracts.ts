import {
  canonical,
  digest,
  safeId,
  requireFields,
  type RecordData,
} from "./workspace.ts";
export { digest };
export class DeliveryError extends Error {}
export const canonicalJson = (v: unknown) => canonical(v, 0, true).toString();
export const checkedId = safeId;
export function checkedDigest(v: string) {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw Error("Expected lowercase SHA-256");
  return v;
}
export class Branch {
  readonly base_url: string;
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  constructor(
    base: string,
    organization: string,
    repository: string,
    branch: string,
  ) {
    const u = new URL(base);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      base.endsWith("/") ||
      /\s/.test(base)
    )
      throw Error("Expected host-only HTTPS base URL");
    this.base_url = base;
    this.organization = safeId(organization);
    this.repository = safeId(repository);
    this.branch = safeId(branch);
  }
  get repository_uri() {
    return `${this.base_url}/orgs/${this.organization}/repos/${this.repository}`;
  }
  get uri() {
    return `${this.repository_uri}/branches/${this.branch}`;
  }
  checkCommit(uri: string) {
    const prefix = this.repository_uri + "/commits/";
    if (typeof uri !== "string" || !uri.startsWith(prefix))
      throw Error("Commit must belong to watched repository");
    safeId(uri.slice(prefix.length));
    return uri;
  }
  toDict() {
    return {
      base_url: this.base_url,
      organization: this.organization,
      repository: this.repository,
      branch: this.branch,
    };
  }
}
export class ValidationRequest {
  readonly source: Branch;
  readonly commit_uri: string;
  readonly rule_version: string;
  readonly rule_sha256: string;
  readonly validator_sha256: string;
  constructor(
    source: Branch,
    commit: string,
    ruleVersion: string,
    ruleSha: string,
    validatorSha: string,
  ) {
    this.source = source;
    this.commit_uri = source.checkCommit(commit);
    if (typeof ruleVersion !== "string" || !ruleVersion.trim())
      throw Error("Rule version required");
    this.rule_version = ruleVersion;
    this.rule_sha256 = checkedDigest(ruleSha);
    this.validator_sha256 = checkedDigest(validatorSha);
  }
  get work_id() {
    return digest(
      canonicalJson({
        schema_version: 1,
        commit_uri: this.commit_uri,
        rule_version: this.rule_version,
        rule_sha256: this.rule_sha256,
        validator_sha256: this.validator_sha256,
      }),
    );
  }
  toDict() {
    return {
      schema_version: 1,
      source: this.source.toDict(),
      commit_uri: this.commit_uri,
      rule_version: this.rule_version,
      rule_sha256: this.rule_sha256,
      validator_sha256: this.validator_sha256,
      work_id: this.work_id,
    };
  }
  static fromDict(v: RecordData) {
    requireFields(v, [
      "schema_version",
      "source",
      "commit_uri",
      "rule_version",
      "rule_sha256",
      "validator_sha256",
      "work_id",
    ]);
    requireFields(v.source, [
      "base_url",
      "organization",
      "repository",
      "branch",
    ]);
    if (v.schema_version !== 1) throw Error("Invalid request schema");
    const s = v.source,
      r = new ValidationRequest(
        new Branch(s.base_url, s.organization, s.repository, s.branch),
        v.commit_uri,
        v.rule_version,
        v.rule_sha256,
        v.validator_sha256,
      );
    if (r.work_id !== v.work_id)
      throw Error("Request identity differs from contents");
    return r;
  }
}
export function checkResult(request: ValidationRequest, r: RecordData) {
  if (!r || r.schema_version !== 1) throw Error("Invalid result schema");
  for (const field of [
    "work_id",
    "commit_uri",
    "rule_version",
    "rule_sha256",
    "validator_sha256",
  ] as const)
    if (r[field] !== request[field])
      throw Error("Result differs from queued input");
  checkedDigest(r.input_sha256);
  if (!["conforming", "nonconforming", "execution-error"].includes(r.outcome))
    throw Error("Invalid outcome");
  if (r.outcome !== "execution-error" || r.report_sha256 != null)
    checkedDigest(r.report_sha256);
  if (r.outcome === "execution-error" && !r.error_code)
    throw Error("Execution error requires reason");
  if (typeof r.external_id !== "string" || !r.external_id.trim())
    throw Error("External identity required");
  const url = new URL(r.report_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /\s/.test(r.report_url)
  )
    throw Error("Credential-free HTTPS report URL required");
}
