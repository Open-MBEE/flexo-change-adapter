import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  FileEvidence,
  encodeFiles,
  decodeFiles,
} from "../src-ts/file-evidence.ts";
import {
  SharedValidationRunner,
  executeSharedValidation,
} from "../src-ts/shared-validation.ts";
import {
  destination,
  workerIdentity,
  workParameters,
  type NativeWorker,
} from "../src-ts/native-ci.ts";
import { nativeWorker } from "../src-ts/ci-validation-job.ts";
import {
  Branch,
  ValidationRequest,
  digest,
  canonicalJson,
} from "../src-ts/contracts.ts";
import { Snapshot } from "../src-ts/flexo.ts";
import { validatorDigest } from "../src-ts/validation.ts";
import {
  EngineRequest,
  engineProfile,
  engineRuntimeDigest,
} from "../src-ts/engine-contracts.ts";
import { decodeEngine } from "../src-ts/engine-execution.ts";
import { checkModelBundle } from "../src-ts/model-input.ts";
import { State } from "../src-ts/state.ts";
import { advance } from "../src-ts/service.ts";
import {
  parseConfiguration,
  type SharedValidationTarget,
} from "../src-ts/configuration.ts";
const branch = new Branch("https://flexo.test", "test", "model", "main");
function root(t: { after(fn: () => void): void }) {
  const p = fs.mkdtempSync(path.join(tmpdir(), "shared-validation-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
function target(
  kind: "gitlab" | "jenkins",
  directory: string,
): SharedValidationTarget {
  return kind === "gitlab"
    ? {
        type: "gitlab",
        endpoint: "https://gitlab.test",
        project: "team/worker",
        ref: "main",
        trigger_token_env: "TEST_TRIGGER",
        read_token_env: "TEST_READ",
        evidence_directory: directory,
      }
    : {
        type: "jenkins",
        endpoint: "https://jenkins.test",
        job: "adapter-validate",
        username_env: "TEST_USER",
        token_env: "TEST_TOKEN",
        evidence_directory: directory,
      };
}
function worker(kind: "gitlab" | "jenkins"): NativeWorker {
  return kind === "gitlab"
    ? {
        type: "gitlab",
        endpoint: "https://gitlab.test",
        project_id: 9,
        project_path: "team/worker",
        ref: "main",
        code_sha: "a".repeat(40),
        pipeline_id: 10,
        job_id: 11,
        job_name: "adapter-validate",
      }
    : {
        type: "jenkins",
        endpoint: "https://jenkins.test",
        job: "adapter-validate",
        build_number: 12,
      };
}
function shacl() {
  const rule = fs.readFileSync("examples/named-part-v1/rule.ttl"),
    r = new ValidationRequest(
      branch,
      branch.repository_uri + "/commits/invalid",
      "v1",
      digest(rule),
      validatorDigest(),
    ),
    snapshot = new Snapshot(
      r,
      branch.repository_uri + "/locks/one",
      '"one"',
      fs.readFileSync("examples/named-part-v1/invalid.ttl"),
    );
  return { r, snapshot, rule };
}
function text(engine: string) {
  const model = Buffer.from("package Demo { part def Vehicle; }"),
    manifest = Buffer.from(
      JSON.stringify({
        format: "local-sysml-text-bundle-v1",
        entrypoints: ["models/main.sysml"],
        files: [
          {
            path: "models/main.sysml",
            role: "model",
            size: model.length,
            sha256: digest(model),
            artifact: branch.repository_uri + "/artifacts/source",
          },
        ],
      }),
    );
  const graph = `<urn:bundle> a <urn:flexo-change-adapter:source:TextBundle>; <urn:flexo-change-adapter:source:manifest> <${branch.repository_uri}/artifacts/manifest>; <urn:flexo-change-adapter:source:sha256> "${digest(manifest)}" .`;
  const b = {
    schema_version: 1 as const,
    source: branch.toDict(),
    commit_uri: branch.repository_uri + "/commits/text",
    lock_uri: branch.repository_uri + "/locks/text",
    lock_etag: '"text"',
    graph_base64: Buffer.from(graph).toString("base64"),
    manifest_base64: manifest.toString("base64"),
    files: { "models/main.sysml": model.toString("base64") },
  };
  return {
    b,
    r: new EngineRequest(
      branch,
      b.commit_uri,
      digest(canonicalJson(b)),
      engineProfile(engine),
      engineRuntimeDigest(),
    ),
  };
}
function engineWorker(counter: { n: number }) {
  return async (
    files: Record<string, Buffer>,
    r: EngineRequest,
    external: string,
  ) => {
    counter.n++;
    const b = JSON.parse(files["model-bundle.json"].toString()),
      content = checkModelBundle(b, r.source, r.commit_uri).content_sha256;
    const stdout = JSON.stringify(
      r.profile.engine === "opensysml"
        ? {
            status: "holds",
            exit: 0,
            checks: null,
            diagnostics: null,
            output: [],
            errors: null,
          }
        : {
            findings: [],
            summary: { errors: 0, warnings: 0, infos: 0, hints: 0 },
          },
    );
    const process = {
      exit: 0,
      signal: null,
      timeout: false,
      truncated: false,
      stdout,
      stderr: "",
      stdout_base64: Buffer.from(stdout).toString("base64"),
      stderr_base64: "",
      started_at: "2026-10-16T12:00:00Z",
      finished_at: "2026-10-16T12:00:01Z",
      argv: ["reviewed-fixture"],
    };
    const report = decodeEngine(r, process),
      raw = Buffer.from(
        canonicalJson({
          schema_version: 1,
          request: r.toDict(),
          input_content_sha256: content,
          profile: r.profile,
          process,
          report,
        }),
      );
    return {
      result: {
        schema_version: 2,
        work_id: r.work_id,
        commit_uri: r.commit_uri,
        input_sha256: r.input_sha256,
        validator_sha256: r.validator_sha256,
        profile: r.profile,
        report,
        outcome: report.verdict,
        report_sha256: digest(raw),
        external_id: external,
      },
      evidence: {
        ...files,
        "report.json": raw,
        "report.txt": Buffer.from("verified"),
      },
    };
  };
}
function api(
  t: any,
  kind: "gitlab" | "jenkins",
  r: any,
  d: any,
  success: boolean,
) {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  const vars = workParameters(
    r.work_id,
    d.input_digest,
    d.runner.split(":")[1],
    r.commit_uri,
  );
  let wrong = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST") throw Error("Lost dispatch response");
    if (kind === "gitlab") {
      if (u.endsWith("/jobs/11"))
        return Response.json({
          id: 11,
          name: "adapter-validate",
          ref: "main",
          pipeline: { id: 10 },
          commit: { id: "a".repeat(40) },
          web_url: "https://gitlab.test/team/worker/-/jobs/11",
          status: success ? "success" : "failed",
        });
      if (u.endsWith("/variables"))
        return Response.json(
          Object.entries(vars).map(([key, value]) => ({
            key,
            value: wrong ? "tampered" : value,
          })),
        );
      return Response.json({
        id: 10,
        project_id: 9,
        ref: "main",
        sha: "a".repeat(40),
        source: "trigger",
      });
    }
    return Response.json({
      number: 12,
      url: "https://jenkins.test/job/adapter-validate/12/",
      queueId: 23,
      building: false,
      result: success ? "SUCCESS" : "FAILURE",
      actions: [
        {
          parameters: Object.entries(vars).map(([name, value]) => ({
            name,
            value: wrong ? "tampered" : value,
          })),
        },
      ],
    });
  };
  process.env.TEST_READ = "synthetic";
  process.env.TEST_TRIGGER = "synthetic";
  process.env.TEST_USER = "synthetic";
  process.env.TEST_TOKEN = "synthetic";
  return () => {
    wrong = true;
  };
}
test("both native platforms accept SHACL or either text engine with explicit shared storage", (t) => {
  const directory = root(t),
    raw: any = {
      schema_version: 1,
      id: "test",
      state_directory: "state",
      source: {
        type: "flexo",
        endpoint: branch.base_url,
        organization: "test",
        repository: "model",
        branch: "main",
      },
      observation: { mode: "poll" },
      actions: [],
    };
  for (const kind of ["gitlab", "jenkins"] as const)
    for (const engine of ["opensysml", "sysml-toolkit", "shacl"]) {
      raw.actions = [
        {
          id: engine,
          on: ["baseline"],
          task:
            engine === "shacl"
              ? {
                  type: "shacl-validation",
                  rule: path.resolve("examples/named-part-v1/rule.ttl"),
                  rule_version: "v1",
                }
              : {
                  type: "engine-validation",
                  engine,
                  profile: "syntax-semantic-v1",
                },
          target: target(kind, path.join(directory, "evidence")),
        },
      ];
      assert.equal(
        parseConfiguration(raw, directory).actions[0].target.type,
        kind,
      );
    }
  raw.actions[0].target.evidence_directory = path.join(directory, "state");
  assert.throws(() => parseConfiguration(raw, directory), /overlap/);
});
test("file records are create-only, reject changed content and ignore unpublished temporary files", (t) => {
  const directory = root(t),
    store = new FileEvidence(directory, digest("scope")),
    id = digest("work");
  assert.equal(store.create("claim", id, { owner: 1 }).created, true);
  assert.equal(store.create("claim", id, { owner: 2 }).created, false);
  assert.equal(store.read("claim", id)!.owner, 1);
  const absent = digest("absent");
  fs.mkdirSync(path.join(store.root, "claim", ".pending-abandoned"));
  assert.equal(store.read("claim", absent), null);
  assert.throws(() =>
    decodeFiles({ "../secret": Buffer.from("x").toString("base64") }),
  );
  assert.throws(() => decodeFiles({ "report.txt": "bad padding" }));
  assert.throws(() =>
    encodeFiles({ "report.txt": Buffer.alloc(4 * 1024 * 1024 + 1) }),
  );
});
for (const kind of ["gitlab", "jenkins"] as const) {
  test(`${kind}: SHACL failures are retained model results and native inputs must match`, async (t) => {
    const directory = root(t),
      runner = new SharedValidationRunner(target(kind, directory)),
      f = shacl(),
      d = await runner.prepare(f.snapshot, f.rule),
      tamper = api(t, kind, f.r, d, false);
    const result = await executeSharedValidation(
      runner.store,
      f.r.work_id,
      d.input_digest,
      worker(kind),
    );
    assert.equal(result.outcome, "nonconforming");
    const observed = await runner.inspect(f.r, d);
    assert.equal(observed!.result.outcome, "nonconforming");
    tamper();
    await assert.rejects(runner.inspect(f.r, d), /input differs/);
  });
  test(`${kind}: text work reconciles a lost response after restart and independent claims prevent duplicates`, async (t) => {
    const directory = root(t),
      runner = new SharedValidationRunner(
        target(kind, path.join(directory, "evidence")),
      ),
      f = text("opensysml"),
      d = await runner.prepareEngine(f.r, f.b),
      counter = { n: 0 };
    api(t, kind, f.r, d, true);
    let state = new State(path.join(directory, "work.sqlite"));
    state.observe(f.r);
    state.bindDelivery(f.r.work_id, d);
    assert.equal(
      (await advance(state, runner, f.r.work_id)).event,
      "delivery-uncertain",
    );
    state.close();
    const first = await executeSharedValidation(
      runner.store,
      f.r.work_id,
      d.input_digest,
      worker(kind),
      engineWorker(counter),
    );
    assert.equal(first.outcome, "pass");
    const duplicate = await executeSharedValidation(
      runner.store,
      f.r.work_id,
      d.input_digest,
      worker(kind),
      engineWorker(counter),
    );
    assert.equal(duplicate.event, "validation-skipped-existing-claim");
    assert.equal(counter.n, 1);
    state = new State(path.join(directory, "work.sqlite"));
    await advance(
      state,
      new SharedValidationRunner(
        target(kind, path.join(directory, "evidence")),
      ),
      f.r.work_id,
    );
    assert.equal(state.get(f.r.work_id).state, "completed");
    state.close();
    const resultPath = runner.store.file("result", f.r.work_id),
      record = runner.store.read("result", f.r.work_id)!;
    record.files["report.json"] = Buffer.from("{}").toString("base64");
    fs.writeFileSync(resultPath, canonicalJson(record));
    await assert.rejects(runner.inspect(f.r, d), /binding/);
  });
  test(`${kind}: a claimed crashed worker is inconclusive and cannot be run automatically again`, async (t) => {
    const directory = root(t),
      runner = new SharedValidationRunner(target(kind, directory)),
      f = text("sysml-toolkit"),
      d = await runner.prepareEngine(f.r, f.b),
      counter = { n: 0 };
    api(t, kind, f.r, d, false);
    await executeSharedValidation(
      runner.store,
      f.r.work_id,
      d.input_digest,
      worker(kind),
      engineWorker(counter),
    );
    fs.unlinkSync(runner.store.file("result", f.r.work_id));
    const observed = await runner.inspect(f.r, d);
    assert.equal(observed!.result.outcome, "inconclusive");
    assert.equal(
      observed!.result.report.error_code,
      "worker-terminated-without-result",
    );
    assert.equal(
      (
        await executeSharedValidation(
          runner.store,
          f.r.work_id,
          d.input_digest,
          worker(kind),
          engineWorker(counter),
        )
      ).event,
      "validation-skipped-existing-claim",
    );
    assert.equal(counter.n, 1);
  });
}
test("native worker rejects another project, another job, unreviewed pipeline source and foreign scope", () => {
  const gitlab = destination(target("gitlab", "/unused")),
    jenkins = destination(target("jenkins", "/unused"));
  assert.throws(
    () =>
      nativeWorker(gitlab, {
        GITLAB_CI: "true",
        CI_PIPELINE_SOURCE: "merge_request_event",
      }),
    /reviewed/,
  );
  assert.throws(
    () =>
      workerIdentity(gitlab, {
        ...worker("gitlab"),
        project_id: 8,
        project_path: "other/project",
      }),
    /Foreign/,
  );
  assert.throws(
    () =>
      nativeWorker(jenkins, {
        JENKINS_URL: "https://other.test/",
        JOB_NAME: "adapter-validate",
        BUILD_NUMBER: "12",
      }),
    /configured/,
  );
});

test("missing native credentials cannot consume dispatch attempts", async (t) => {
  const directory = root(t),
    selected = {
      ...target("gitlab", directory),
      read_token_env: "TEST_NEVER_PRESENT",
    } as SharedValidationTarget;
  const runner = new SharedValidationRunner(selected),
    f = shacl(),
    d = await runner.prepare(f.snapshot, f.rule),
    state = new State(path.join(directory, "work.sqlite"));
  try {
    state.observe(f.r);
    state.bindDelivery(f.r.work_id, d);
    await assert.rejects(advance(state, runner, f.r.work_id), /credential/);
    assert.equal(state.get(f.r.work_id).attempts, 0);
  } finally {
    state.close();
  }
});
