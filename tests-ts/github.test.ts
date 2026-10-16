import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { GitHub, GitHubError, bundleDigest } from "../src-ts/github-api.ts";
import { GitHubRunner } from "../src-ts/github-runner.ts";
import { Snapshot } from "../src-ts/flexo.ts";
import { Branch, ValidationRequest, digest } from "../src-ts/contracts.ts";
import { validatorDigest } from "../src-ts/validation.ts";
class MemoryGitHub extends GitHub {
  refs = new Map<string, string>();
  records = new Map<string, Record<string, Buffer>>();
  messages: string[] = [];
  runs: any = {};
  loseResultResponse = false;
  publicRepo = false;
  constructor() {
    super("DSG", "adapter", "fake-test-token");
  }
  override async requirePrivate() {
    if (this.publicRepo) throw new GitHubError("public");
  }
  override async ref(kind: string, id: string) {
    return this.refs.get(kind + id) ?? null;
  }
  override async files(commit: string) {
    const files = this.records.get(commit);
    if (!files) throw Error("Unknown commit");
    return files;
  }
  override async createCommit(
    files: Record<string, Buffer>,
    message: string,
    parents: string[] = [],
  ) {
    const sha = createHash("sha1")
      .update(bundleDigest(files) + parents.join(""))
      .digest("hex");
    this.records.set(
      sha,
      Object.fromEntries(
        Object.entries(files).map(([k, b]) => [k, Buffer.from(b)]),
      ),
    );
    this.messages.push(message);
    return sha;
  }
  override async createRef(
    kind: string,
    id: string,
    commit: string,
  ): Promise<[string, boolean]> {
    const key = kind + id;
    if (this.refs.has(key)) return [this.refs.get(key)!, false];
    this.refs.set(key, commit);
    if (kind === "result" && this.loseResultResponse) {
      this.loseResultResponse = false;
      throw new GitHubError("lost result response");
    }
    return [commit, true];
  }
  override async call(
    method: string,
    p: string,
    body?: unknown,
    statuses?: number[],
  ) {
    if (method === "GET" && p.includes("/actions/runs/"))
      return new Response(JSON.stringify(this.runs), {
        headers: { "content-type": "application/json" },
      });
    if (p.endsWith("/dispatches")) return new Response(null, { status: 204 });
    throw Error("Unexpected fake call");
  }
}
function fixture(api: MemoryGitHub) {
  const b = new Branch("https://flexo.example", "research", "model", "main"),
    rule = fs.readFileSync(
      new URL("../examples/named-part-v1/rule.ttl", import.meta.url),
    ),
    r = new ValidationRequest(
      b,
      b.repository_uri + "/commits/invalid",
      "named-part-v1",
      digest(rule),
      validatorDigest(),
    ),
    s = new Snapshot(
      r,
      b.repository_uri + "/locks/test",
      '"invalid"',
      fs.readFileSync(
        new URL("../examples/named-part-v1/invalid.ttl", import.meta.url),
      ),
    ),
    workflow = {
      repository: "DSG/adapter",
      run_id: 42,
      run_attempt: 1,
      workflow_sha: "a".repeat(40),
      workflow_file: "flexo-validate.yml",
    };
  return { r, s, rule, workflow, runner: new GitHubRunner(api) };
}
test("durable worker claim deduplicates retry and lost result publication is recovered", async () => {
  const api = new MemoryGitHub(),
    f = fixture(api),
    delivery = await f.runner.prepare(f.s, f.rule);
  api.loseResultResponse = true;
  const first = await f.runner.execute(
    f.r.work_id,
    delivery.input_commit,
    delivery.input_digest,
    f.workflow,
  );
  assert.equal(first.outcome, "nonconforming");
  const count = api.messages.filter((m) => m.includes("SHACL report")).length,
    duplicate = await f.runner.execute(
      f.r.work_id,
      delivery.input_commit,
      delivery.input_digest,
      { ...f.workflow, run_id: 43 },
    );
  assert.equal(duplicate.event, "validation-skipped-existing-claim");
  assert.equal(
    api.messages.filter((m) => m.includes("SHACL report")).length,
    count,
  );
  api.runs = {
    id: 42,
    run_attempt: 1,
    head_sha: f.workflow.workflow_sha,
    event: "workflow_dispatch",
    path: ".github/workflows/flexo-validate.yml",
    status: "completed",
    conclusion: "failure",
  };
  const inspected = await f.runner.inspect(f.r, delivery);
  assert.equal(inspected!.result.commit_uri, f.r.commit_uri);
  assert.equal(inspected!.result.outcome, "nonconforming");
  const stored = await api.ref("result", f.r.work_id),
    files = await api.files(stored!);
  files["report.ttl"] = Buffer.from("<urn:tampered> <urn:p> <urn:o>.");
  await assert.rejects(f.runner.inspect(f.r, delivery), /binding/);
});
test("claimed worker termination yields infrastructure error, never a rerun", async () => {
  const api = new MemoryGitHub(),
    f = fixture(api),
    delivery = await f.runner.prepare(f.s, f.rule);
  await f.runner.execute(
    f.r.work_id,
    delivery.input_commit,
    delivery.input_digest,
    f.workflow,
  );
  api.refs.delete("result" + f.r.work_id);
  api.runs = {
    id: 42,
    run_attempt: 1,
    head_sha: f.workflow.workflow_sha,
    event: "workflow_dispatch",
    path: ".github/workflows/flexo-validate.yml",
    status: "completed",
    conclusion: "failure",
  };
  const r = await f.runner.inspect(f.r, delivery);
  assert.equal(r!.result.outcome, "execution-error");
  assert.equal(r!.result.error_code, "worker-terminated-without-result");
  assert.equal(
    (
      await f.runner.execute(
        f.r.work_id,
        delivery.input_commit,
        delivery.input_digest,
        f.workflow,
      )
    ).event,
    "validation-skipped-existing-claim",
  );
});
test("public repository and altered delivered input refused before validation", async () => {
  const api = new MemoryGitHub(),
    f = fixture(api);
  api.publicRepo = true;
  await assert.rejects(f.runner.prepare(f.s, f.rule));
  api.publicRepo = false;
  const d = await f.runner.prepare(f.s, f.rule);
  await assert.rejects(
    f.runner.execute(f.r.work_id, d.input_commit, "b".repeat(64), f.workflow),
    /differs/,
  );
  assert.equal(await api.ref("claim", f.r.work_id), null);
  assert.throws(() => new GitHubRunner(api, "unreviewed-branch"));
});
test("Git transport stays in configured repository and validates blob SHA", async () => {
  const api = new GitHub(
    "DSG",
    "adapter",
    "fake-test-token",
    async () =>
      new Response(
        JSON.stringify({ private: false, full_name: "DSG/adapter" }),
      ),
  );
  await assert.rejects(api.call("GET", "/repos/other/repo/git/refs"));
  await assert.rejects(api.requirePrivate());
});
