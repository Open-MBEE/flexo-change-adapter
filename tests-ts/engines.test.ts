import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Branch, canonicalJson, digest } from "../src-ts/contracts.ts";
import {
  EngineRequest,
  engineProfile,
  engineRuntimeDigest,
  checkEngineReport,
} from "../src-ts/engine-contracts.ts";
import {
  captureModelBundle,
  retainedModelBundle,
  checkModelBundle,
  modelPath,
  type ModelBundle,
} from "../src-ts/model-input.ts";
import {
  decodeEngine,
  runProcess,
  type ProcessEvidence,
  unavailable,
} from "../src-ts/engine-execution.ts";
import {
  engineInputBundle,
  checkEngineInput,
} from "../src-ts/engine-record.ts";
import { GitHub, bundleDigest, GitHubError } from "../src-ts/github-api.ts";
import { GitHubRunner } from "../src-ts/github-runner.ts";
import { Flexo, MMS } from "../src-ts/flexo.ts";
import { State } from "../src-ts/state.ts";
import { advance } from "../src-ts/service.ts";
import { parseConfiguration } from "../src-ts/configuration.ts";
import { freezeEngineAction } from "../src-ts/engine-action.ts";
import { Journal } from "../src-ts/journal.ts";
const source = new Branch("https://flexo.test", "test", "model", "main"),
  commit = source.repository_uri + "/commits/one";
function bundle(): ModelBundle {
  const files = {
    "models/types.sysml": "package Types { part def Thing; }",
    "models/main.sysml":
      "package Main { private import Types::*; part thing : Thing; }",
  };
  const manifest = {
      format: "local-sysml-text-bundle-v1",
      entrypoints: Object.keys(files),
      files: Object.entries(files).map(([p, raw], i) => ({
        path: p,
        role: "model",
        size: Buffer.byteLength(raw),
        sha256: digest(raw),
        artifact: source.repository_uri + "/artifacts/file" + i,
      })),
    },
    raw = Buffer.from(JSON.stringify(manifest));
  const graph = `<urn:bundle> a <urn:flexo-change-adapter:source:TextBundle>; <urn:flexo-change-adapter:source:manifest> <${source.repository_uri}/artifacts/manifest>; <urn:flexo-change-adapter:source:sha256> "${digest(raw)}" .`;
  return {
    schema_version: 1,
    source: source.toDict(),
    commit_uri: commit,
    lock_uri: source.repository_uri + "/locks/text",
    lock_etag: '"one"',
    graph_base64: Buffer.from(graph).toString("base64"),
    manifest_base64: raw.toString("base64"),
    files: Object.fromEntries(
      Object.entries(files).map(([p, v]) => [
        p,
        Buffer.from(v).toString("base64"),
      ]),
    ),
  };
}
function request(id = "opensysml", b = bundle()) {
  return new EngineRequest(
    source,
    commit,
    digest(canonicalJson(b)),
    engineProfile(id),
    engineRuntimeDigest(),
  );
}
const processEvidence = (stdout: string, exit = 0): ProcessEvidence => ({
  stdout,
  stderr: "",
  stdout_base64: Buffer.from(stdout).toString("base64"),
  stderr_base64: "",
  exit,
  signal: null,
  timeout: false,
  truncated: false,
  started_at: "2026-10-16T12:00:00Z",
  finished_at: "2026-10-16T12:00:01Z",
  argv: ["reviewed-engine"],
});
const captures = JSON.parse(
  fs.readFileSync(
    new URL("../docs/engine-cli-captures-2026-10-16.json", import.meta.url),
    "utf8",
  ),
);
function native(engine: string, kind: string) {
  const r = captures.results.find(
    (r: any) =>
      r.engine === (engine === "sysml-toolkit" ? "toolkit" : engine) &&
      r.case === kind,
  );
  return {
    ...processEvidence(
      r.stdout.replaceAll("/models/", "/bundle/models/"),
      r.exit,
    ),
    stderr: r.stderr,
    stderr_base64: Buffer.from(r.stderr).toString("base64"),
  };
}
function temporary(t: { after(fn: () => void): void }) {
  const p = fs.mkdtempSync(path.join(tmpdir(), "engines-test-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
test("registered engines independently select pinned profiles; frozen intents survive removal", (t) => {
  const root = temporary(t),
    raw = {
      schema_version: 1,
      id: "test",
      state_directory: "state",
      source: {
        type: "flexo",
        endpoint: source.base_url,
        organization: source.organization,
        repository: source.repository,
        branch: source.branch,
      },
      observation: { mode: "poll" },
      actions: ["opensysml", "sysml-toolkit"].map((engine) => ({
        id: engine,
        on: ["baseline"],
        task: {
          type: "engine-validation",
          engine,
          profile: "syntax-semantic-v1",
        },
        target: { type: "github", owner: "test", repository: "private" },
      })),
    };
  const c = parseConfiguration(raw, root),
    prepared = c.actions.map((a) => freezeEngineAction(a as any));
  let j = new Journal(c.database, source);
  j.observe(c.source, source, commit, prepared);
  const before = j.intents().map((i) => i.action_json);
  j.close();
  c.actions = [];
  j = new Journal(c.database, source);
  assert.deepEqual(
    j.intents().map((i) => i.action_json),
    before,
  );
  assert.equal(j.intents().length, 2);
  j.close();
  assert.notEqual(request().work_id, request("sysml-toolkit").work_id);
  assert.throws(
    () =>
      parseConfiguration(
        {
          ...raw,
          actions: [
            {
              ...raw.actions[0],
              task: { ...raw.actions[0].task, command: "sh" },
            },
          ],
        },
        root,
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      new EngineRequest(
        source,
        commit,
        digest("input"),
        { ...engineProfile("opensysml"), version: "unreviewed" },
        engineRuntimeDigest(),
      ),
    /Unsupported/,
  );
});
test("text bundle checks reject changed revisions, content, foreign URLs and escaping or duplicate paths", () => {
  const b = bundle();
  checkModelBundle(b, source, commit);
  assert.throws(
    () => checkModelBundle(b, source, source.repository_uri + "/commits/two"),
    /revision/,
  );
  for (const p of [
    "../secret",
    "models/../bad.sysml",
    "/models/a.sysml",
    "models/a\\b.sysml",
    "models/.hidden.sysml",
  ])
    assert.throws(() => modelPath(p));
  const changed = structuredClone(b);
  changed.files["models/main.sysml"] =
    Buffer.from("changed").toString("base64");
  assert.throws(() => checkModelBundle(changed, source, commit), /digest/);
  assert.throws(
    () =>
      checkModelBundle(
        { ...b, files: { ...b.files, "models/extra.sysml": "" } },
        source,
        commit,
      ),
    /fields/,
  );
  for (const mode of ["foreign", "duplicate"]) {
    const modified = structuredClone(b),
      m = JSON.parse(Buffer.from(b.manifest_base64, "base64").toString());
    if (mode === "foreign")
      m.files[0].artifact = "https://attacker.test/artifacts/token";
    else m.files.push(m.files[0]);
    const raw = Buffer.from(JSON.stringify(m));
    modified.manifest_base64 = raw.toString("base64");
    modified.graph_base64 = Buffer.from(
      Buffer.from(b.graph_base64, "base64")
        .toString()
        .replace(digest(Buffer.from(b.manifest_base64, "base64")), digest(raw)),
    ).toString("base64");
    assert.throws(() => checkModelBundle(modified, source, commit));
  }
});
test("retained shared source survives restart without another read and corrupted captures are refused", async (t) => {
  const root = temporary(t),
    b = bundle();
  let reads = 0;
  const a = await retainedModelBundle(root, source, commit, async () => {
    reads++;
    return b;
  });
  const again = await retainedModelBundle(root, source, commit, async () => {
    throw Error("moving branch/offline");
  });
  assert.equal(reads, 1);
  assert.equal(digest(canonicalJson(a)), digest(canonicalJson(again)));
  const file = path.join(
    root,
    fs.readdirSync(root).find((n) => n.endsWith(".json"))!,
  );
  fs.writeFileSync(file, canonicalJson({ ...b, files: {} }));
  await assert.rejects(
    retainedModelBundle(root, source, commit, async () => b),
  );
});
test("exact revision capture verifies lock before/after, producer manifest and every artifact", async () => {
  const b = bundle(),
    manifest = Buffer.from(b.manifest_base64, "base64"),
    graph = Buffer.from(b.graph_base64, "base64"),
    files = Object.values(b.files).map((v) => Buffer.from(v, "base64"));
  let calls = 0,
    move = false;
  const flexo = new Flexo("synthetic", async (url, init) => {
    if (url.endsWith("/graph")) return new Response(graph);
    if (url.includes("/locks/")) {
      calls++;
      const c =
        move && calls > 1 ? source.repository_uri + "/commits/two" : commit;
      return new Response(`<${url}> <${MMS}commit> <${c}> .`, {
        headers: { etag: '"one"' },
      });
    }
    if (url.endsWith("/artifacts/manifest")) return new Response(manifest);
    if (url.includes("/artifacts/file"))
      return new Response(files[Number(url.at(-1))]);
    throw Error("unexpected");
  });
  const captured = await captureModelBundle(flexo, source, commit);
  checkModelBundle(captured, source, commit);
  calls = 0;
  move = true;
  await assert.rejects(captureModelBundle(flexo, source, commit), /changed/);
});
test("both real native report contracts distinguish model findings, missing reports and unsupported/incomplete execution", () => {
  for (const engine of ["opensysml", "sysml-toolkit"]) {
    const r = request(engine);
    for (const c of ["initial", "changed"])
      assert.equal(decodeEngine(r, native(engine, c)).verdict, "pass");
    for (const c of [
      "syntax-error",
      "unresolved-reference",
      "missing-project-file",
    ])
      assert.equal(decodeEngine(r, native(engine, c)).verdict, "fail");
    assert.equal(
      decodeEngine(r, native(engine, "syntax-error")).checks.find(
        (c) => c.check === "semantic",
      )!.completed,
      false,
    );
    for (const p of [
      processEvidence(""),
      processEvidence("{}"),
      { ...native(engine, "initial"), timeout: true },
      { ...native(engine, "initial"), truncated: true },
      { ...native(engine, "initial"), signal: "SIGKILL" },
    ])
      assert.equal(decodeEngine(r, p).verdict, "inconclusive");
    assert.notEqual(
      decodeEngine(r, native(engine, "missing-library")).verdict,
      "pass",
    );
    assert.equal(
      decodeEngine(r, native(engine, "unsupported-option")).verdict,
      "inconclusive",
    );
  }
  const p = native("sysml-toolkit", "unresolved-reference"),
    r = decodeEngine(request("sysml-toolkit"), p);
  assert.equal(r.diagnostics[0].native_severity, "warn");
  assert.equal(r.diagnostics[0].code, null);
  const fake = JSON.parse(native("sysml-toolkit", "initial").stdout);
  fake.summary.errors = 1;
  assert.equal(
    decodeEngine(
      request("sysml-toolkit"),
      processEvidence(JSON.stringify(fake)),
    ).verdict,
    "inconclusive",
  );
  assert.throws(
    () => checkEngineReport({ ...unavailable("missing"), verdict: "pass" }),
    /cannot pass/,
  );
});
test("native diagnostic byte positions remain native with Unicode and CRLF", () => {
  const n = JSON.parse(native("sysml-toolkit", "unresolved-reference").stdout);
  n.findings[0].message = "unresolved reference `Δ`\r\n";
  n.findings[0].col = 25;
  const r = decodeEngine(
    request("sysml-toolkit"),
    processEvidence(JSON.stringify(n), 1),
  );
  assert.equal(r.diagnostics[0].column, 25);
  assert.equal(r.diagnostics[0].position_encoding, "utf8-byte-column");
  assert.match(r.diagnostics[0].message, /Δ/);
});
test("bounded process execution retains failures, kills deadlines and caps output without inherited secrets", async () => {
  const opts = {
    timeout_ms: 1000,
    max_output_bytes: 128,
    env: { PATH: process.env.PATH },
  };
  const ok = await runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write(String(process.env.GITHUB_TOKEN));process.exitCode=7",
    ],
    opts,
  );
  assert.equal(ok.exit, 7);
  assert.equal(ok.stdout, "undefined");
  const timeout = await runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { ...opts, timeout_ms: 50 },
  );
  assert.equal(timeout.timeout, true);
  const huge = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100000))"],
    opts,
  );
  assert.equal(huge.truncated, true);
  assert.equal(Buffer.byteLength(huge.stdout), 128);
  const missing = await runProcess("/nonexistent-engine", [], opts);
  assert.equal(missing.signal, "spawn-error");
});
class MemoryGitHub extends GitHub {
  refs = new Map<string, string>();
  records = new Map<string, Record<string, Buffer>>();
  runs: any = {};
  lose = false;
  constructor() {
    super("test", "private", "synthetic");
  }
  override async requirePrivate() {}
  override async ref(kind: string, id: string) {
    return this.refs.get(kind + id) ?? null;
  }
  override async files(sha: string) {
    return this.records.get(sha)!;
  }
  override async createCommit(
    f: Record<string, Buffer>,
    m: string,
    parents: string[] = [],
  ) {
    const sha = createHash("sha1")
      .update(bundleDigest(f) + parents.join())
      .digest("hex");
    this.records.set(
      sha,
      Object.fromEntries(
        Object.entries(f).map(([k, v]) => [k, Buffer.from(v)]),
      ),
    );
    return sha;
  }
  override async createRef(
    kind: string,
    id: string,
    sha: string,
  ): Promise<[string, boolean]> {
    const key = kind + id;
    if (this.refs.has(key)) return [this.refs.get(key)!, false];
    this.refs.set(key, sha);
    if (kind === "result" && this.lose) {
      this.lose = false;
      throw new GitHubError("lost");
    }
    return [sha, true];
  }
  override async call(
    method: string,
    p: string,
    body?: unknown,
    statuses?: number[],
  ) {
    if (p.includes("/actions/runs/"))
      return new Response(JSON.stringify(this.runs));
    if (p.endsWith("/dispatches"))
      throw new GitHubError("accepted but response lost");
    throw Error("unexpected");
  }
}
function worker(counter: { n: number }) {
  return async (
    files: Record<string, Buffer>,
    r: EngineRequest,
    external: string,
  ) => {
    counter.n++;
    checkEngineInput(files, r);
    const p = native(r.profile.engine, "initial"),
      report = decodeEngine(r, p),
      content = checkModelBundle(bundle(), source, commit).content_sha256;
    const raw = Buffer.from(
      canonicalJson({
        schema_version: 1,
        request: r.toDict(),
        input_content_sha256: content,
        profile: r.profile,
        process: p,
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
test("engine work uses durable claims and exact run attempts; lost responses reconcile after restart without rerunning", async (t) => {
  const root = temporary(t),
    r = request(),
    api = new MemoryGitHub(),
    count = { n: 0 },
    runner = new GitHubRunner(api, "main", worker(count)),
    delivery = await runner.prepareEngine(r, bundle()),
    workflow = {
      repository: "test/private",
      run_id: 5,
      run_attempt: 1,
      workflow_sha: "a".repeat(40),
      workflow_file: "flexo-validate.yml",
    };
  let state = new State(path.join(root, "work.sqlite"));
  state.observe(r);
  state.bindDelivery(r.work_id, delivery);
  assert.equal(
    (await advance(state, runner, r.work_id)).event,
    "delivery-uncertain",
  );
  state.close();
  api.lose = true;
  await Promise.all([
    runner.execute(
      r.work_id,
      delivery.input_commit,
      delivery.input_digest,
      workflow,
    ),
    runner.execute(r.work_id, delivery.input_commit, delivery.input_digest, {
      ...workflow,
      run_id: 6,
    }),
  ]);
  assert.equal(count.n, 1);
  api.runs = {
    id: 5,
    run_attempt: 1,
    head_sha: workflow.workflow_sha,
    event: "workflow_dispatch",
    path: ".github/workflows/flexo-validate.yml",
    status: "completed",
    conclusion: "success",
  };
  state = new State(path.join(root, "work.sqlite"));
  await advance(state, new GitHubRunner(api, "main", worker(count)), r.work_id);
  assert.equal(state.get(r.work_id).state, "completed");
  state.close();
  const skip = await runner.execute(
    r.work_id,
    delivery.input_commit,
    delivery.input_digest,
    { ...workflow, run_attempt: 2 },
  );
  assert.equal(skip.event, "validation-skipped-existing-claim");
  assert.equal(count.n, 1);
  const final = await api.files((await api.ref("result", r.work_id))!);
  final["report.json"] = Buffer.from("{}");
  await assert.rejects(runner.inspect(r, delivery), /binding/);
});
test("one engine termination retains an inconclusive result and cannot discard another engine result", async () => {
  const api = new MemoryGitHub(),
    counter = { n: 0 },
    runner = new GitHubRunner(api, "main", worker(counter)),
    r = request(),
    other = request("sysml-toolkit"),
    workflow = {
      repository: "test/private",
      run_id: 5,
      run_attempt: 1,
      workflow_sha: "a".repeat(40),
      workflow_file: "flexo-validate.yml",
    },
    a = await runner.prepareEngine(r, bundle()),
    b = await runner.prepareEngine(other, bundle());
  await runner.execute(r.work_id, a.input_commit, a.input_digest, workflow);
  await runner.execute(other.work_id, b.input_commit, b.input_digest, workflow);
  api.refs.delete("result" + r.work_id);
  api.runs = {
    id: 5,
    run_attempt: 1,
    head_sha: workflow.workflow_sha,
    event: "workflow_dispatch",
    path: ".github/workflows/flexo-validate.yml",
    status: "completed",
    conclusion: "success",
  };
  assert.equal((await runner.inspect(r, a))!.result.outcome, "inconclusive");
  assert.equal((await runner.inspect(other, b))!.result.outcome, "pass");
  assert.equal(
    (await runner.execute(r.work_id, a.input_commit, a.input_digest, workflow))
      .event,
    "validation-skipped-existing-claim",
  );
  assert.equal(counter.n, 2);
});
