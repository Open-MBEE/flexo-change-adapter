import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isDeepStrictEqual as equal } from "node:util";
import {
  canonicalJson,
  checkedDigest,
  digest,
  ValidationRequest,
  checkResult,
} from "./contracts.ts";
import { Snapshot } from "./flexo.ts";
import { GitHub, GitHubError, bundleDigest, gitSha } from "./github-api.ts";
import { requireFields, type RecordData } from "./workspace.ts";
import { validateSnapshot } from "./validation.ts";
import { parse, subjects, objects, RDF, SH, XSD } from "./rdf.ts";
export const WORKFLOW = "flexo-validate.yml",
  INPUT_FILES = ["model.ttl", "rule.ttl", "snapshot.json"],
  RESULT_FILES = [...INPUT_FILES, "report.ttl", "report.txt", "result.json"];
const checkFiles = (files: Record<string, Buffer>, names: string[]) => {
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
export class GitHubRunner {
  readonly api: GitHub;
  constructor(api: GitHub, workflowRef = "main") {
    if (workflowRef !== "main")
      throw Error("Workflow must execute reviewed main");
    this.api = api;
  }
  get identity() {
    return `github:${this.api.owner}/${this.api.repository}:${WORKFLOW}:main`;
  }
  checkDelivery(d: RecordData) {
    requireFields(d, ["runner", "input_commit", "input_digest"]);
    if (d.runner !== this.identity) throw Error("Foreign runner delivery");
    gitSha(d.input_commit);
    checkedDigest(d.input_digest);
  }
  async prepare(s: Snapshot, rule: Buffer) {
    await this.api.requirePrivate();
    const files = inputBundle(s, rule),
      id = s.request.work_id;
    let commit = await this.api.ref("input", id);
    if (!commit) {
      const candidate = await this.api.createCommit(
        files,
        "ci: retain validation input " + id,
      );
      [commit] = await this.api.createRef("input", id, candidate);
    }
    if (!equal(await this.api.files(commit), files))
      throw Error("Existing input differs; cannot replace evidence");
    return {
      runner: this.identity,
      input_commit: commit,
      input_digest: bundleDigest(files),
    };
  }
  async dispatch(r: ValidationRequest, d: RecordData) {
    this.checkDelivery(d);
    const response = await this.api.call(
      "POST",
      this.api.path + "/actions/workflows/" + WORKFLOW + "/dispatches",
      {
        ref: "main",
        inputs: {
          work_id: r.work_id,
          input_commit: d.input_commit,
          input_digest: d.input_digest,
        },
      },
      [200, 204],
    );
    if (response.status === 204) return null;
    const v = await response.json();
    if (!Number.isInteger(v.workflow_run_id) || v.workflow_run_id < 1)
      throw new GitHubError("Invalid workflow run identity");
    return String(v.workflow_run_id);
  }
  externalId(w: RecordData) {
    requireFields(w, [
      "repository",
      "run_id",
      "run_attempt",
      "workflow_sha",
      "workflow_file",
    ]);
    if (
      w.repository !== `${this.api.owner}/${this.api.repository}` ||
      w.workflow_file !== WORKFLOW ||
      !Number.isInteger(w.run_id) ||
      w.run_id < 1 ||
      !Number.isInteger(w.run_attempt) ||
      w.run_attempt < 1
    )
      throw Error("Invalid workflow identity");
    gitSha(w.workflow_sha);
    return `github:${w.repository}:${w.run_id}:${w.run_attempt}`;
  }
  async claim(r: ValidationRequest, d: RecordData) {
    this.checkDelivery(d);
    const commit = await this.api.ref("claim", r.work_id);
    if (!commit) return null;
    const files = await this.api.files(commit);
    checkFiles(files, ["claim.json"]);
    const v = JSON.parse(files["claim.json"].toString());
    requireFields(v, [
      "schema_version",
      "work_id",
      "input_commit",
      "input_digest",
      "workflow",
      "external_id",
    ]);
    if (
      v.schema_version !== 1 ||
      v.work_id !== r.work_id ||
      v.input_commit !== d.input_commit ||
      v.input_digest !== d.input_digest ||
      v.external_id !== this.externalId(v.workflow)
    )
      throw Error("Worker claim differs");
    return v as RecordData;
  }
  async inspect(r: ValidationRequest, d: RecordData) {
    const claim = await this.claim(r, d);
    if (!claim) {
      if (await this.api.ref("result", r.work_id))
        throw Error("Result lacks claim");
      return null;
    }
    const w = claim.workflow,
      run = await (
        await this.api.call(
          "GET",
          `${this.api.path}/actions/runs/${w.run_id}/attempts/${w.run_attempt}`,
        )
      ).json();
    if (
      run.id !== w.run_id ||
      run.run_attempt !== w.run_attempt ||
      run.head_sha !== w.workflow_sha ||
      run.event !== "workflow_dispatch" ||
      run.path !== ".github/workflows/" + WORKFLOW
    )
      throw Error("Run differs from claim");
    if (
      ![
        "queued",
        "in_progress",
        "completed",
        "waiting",
        "pending",
        "requested",
      ].includes(run.status)
    )
      throw Error("Unknown workflow state");
    const observation: RecordData = {
        external_id: claim.external_id,
        running: run.status === "in_progress",
        result: null,
      },
      commit = await this.api.ref("result", r.work_id);
    if (!commit) {
      if (run.status === "completed") {
        const s = checkInput(await this.api.files(d.input_commit), r);
        observation.result = {
          schema_version: 1,
          work_id: r.work_id,
          commit_uri: r.commit_uri,
          rule_version: r.rule_version,
          rule_sha256: r.rule_sha256,
          validator_sha256: r.validator_sha256,
          input_sha256: s.input_sha256,
          report_sha256: null,
          report_url: `${this.api.html}/actions/runs/${w.run_id}/attempts/${w.run_attempt}`,
          outcome: "execution-error",
          error_code: "worker-terminated-without-result",
          external_id: claim.external_id,
          workflow: w,
        };
      }
      return observation;
    }
    const files = await this.api.files(commit);
    checkFiles(files, RESULT_FILES);
    const inputs = await this.api.files(d.input_commit),
      s = checkInput(inputs, r);
    for (const name of INPUT_FILES)
      if (!files[name].equals(inputs[name]))
        throw Error("Result input differs");
    const result = JSON.parse(files["result.json"].toString());
    checkResult(r, result);
    if (
      result.external_id !== claim.external_id ||
      !equal(result.workflow, w) ||
      result.input_sha256 !== s.input_sha256 ||
      result.report_sha256 !== digest(files["report.ttl"]) ||
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
    const outcome = ["true", "1"].includes(values[0].value)
      ? "conforming"
      : "nonconforming";
    if (result.outcome !== outcome) throw Error("Report outcome differs");
    const reportCommit = gitSha(result.report_commit);
    if (
      result.report_url !==
      this.api.html + "/blob/" + reportCommit + "/report.txt"
    )
      throw Error("Report URL differs");
    if (
      !equal(
        await this.api.files(reportCommit),
        Object.fromEntries(
          Object.entries(files).filter(([k]) => k !== "result.json"),
        ),
      )
    )
      throw Error("Linked report differs");
    if (run.status !== "completed") return observation;
    if (run.conclusion !== (outcome === "conforming" ? "success" : "failure"))
      throw Error("Workflow conclusion differs");
    observation.result = result;
    return observation;
  }
  async execute(
    id: string,
    inputCommit: string,
    inputDigest: string,
    workflow: RecordData,
  ) {
    checkedDigest(id);
    gitSha(inputCommit);
    checkedDigest(inputDigest);
    await this.api.requirePrivate();
    const files = await this.api.files(inputCommit),
      s = Snapshot.fromFiles(files),
      r = s.request;
    checkInput(files, r);
    if (
      r.work_id !== id ||
      bundleDigest(files) !== inputDigest ||
      (await this.api.ref("input", id)) !== inputCommit
    )
      throw Error("Dispatch input differs");
    const delivery = {
        runner: this.identity,
        input_commit: inputCommit,
        input_digest: inputDigest,
      },
      external = this.externalId(workflow),
      claim = {
        schema_version: 1,
        work_id: id,
        input_commit: inputCommit,
        input_digest: inputDigest,
        workflow,
        external_id: external,
      };
    const existing = await this.claim(r, delivery);
    if (existing)
      return {
        event: "validation-skipped-existing-claim",
        owner: existing.external_id,
        work_id: id,
      };
    const candidate = await this.api.createCommit(
        { "claim.json": Buffer.from(canonicalJson(claim)) },
        "ci: claim validation " + id,
      ),
      [, created] = await this.api.createRef("claim", id, candidate),
      owner = await this.claim(r, delivery);
    if (!owner) throw new GitHubError("Worker claim not visible");
    if (!created)
      return {
        event: "validation-skipped-existing-claim",
        owner: owner.external_id,
        work_id: id,
      };
    if (!equal(owner, claim)) throw Error("Claim differs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flexo-ci-"));
    try {
      const out = path.join(tmp, "report"),
        result = await validateSnapshot(s, files["rule.ttl"], out, external),
        evidence = {
          ...files,
          "report.ttl": fs.readFileSync(path.join(out, "report.ttl")),
          "report.txt": fs.readFileSync(path.join(out, "report.txt")),
        },
        reportCommit = await this.api.createCommit(
          evidence,
          "ci: retain SHACL report " + id,
        );
      Object.assign(result, {
        workflow,
        report_commit: reportCommit,
        report_url: this.api.html + "/blob/" + reportCommit + "/report.txt",
        limits: [],
      });
      const finalFiles = {
          ...evidence,
          "result.json": Buffer.from(canonicalJson(result)),
        },
        final = await this.api.createCommit(
          finalFiles,
          "ci: retain validation result " + id,
          [reportCommit],
        );
      let retained: string;
      try {
        [retained] = await this.api.createRef("result", id, final);
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        const found = await this.api.ref("result", id);
        if (!found) throw e;
        retained = found;
      }
      if (!equal(await this.api.files(retained), finalFiles))
        throw Error("Existing result differs");
      return {
        event: "validation-completed",
        work_id: id,
        outcome: result.outcome,
        external_id: external,
        report_url: result.report_url,
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
