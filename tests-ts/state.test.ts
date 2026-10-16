import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
  Branch,
  ValidationRequest,
  DeliveryError,
  digest,
  canonicalJson,
} from "../src-ts/contracts.ts";
import { State } from "../src-ts/state.ts";
import { advance } from "../src-ts/service.ts";
import { Flexo, Snapshot, commitBinding } from "../src-ts/flexo.ts";
import { validatorDigest, validateSnapshot } from "../src-ts/validation.ts";
const branch = new Branch("https://flexo.example", "research", "model", "main");
const request = (id = "a") =>
  new ValidationRequest(
    branch,
    branch.repository_uri + "/commits/" + id,
    "rule-v1",
    "1".repeat(64),
    "2".repeat(64),
  );
function temp(t: any) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "flexo-ts-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
test("atomic checkpoint rollback and repeated revisions", (t) => {
  const p = temp(t),
    s = new State(path.join(p, "state.sqlite"));
  t.after(() => s.close());
  s.db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoint BEGIN SELECT RAISE(ABORT,'injected');END;",
  );
  assert.throws(() => s.observe(request()));
  assert.deepEqual(s.list(), []);
  s.db.exec("DROP TRIGGER fail_checkpoint");
  assert.equal(s.observe(request()), true);
  assert.equal(s.observe(request()), false);
  assert.equal(s.observe(request("b")), true);
  assert.equal(s.observe(request()), false);
  assert.equal(s.list().length, 2);
});
test("dispatch claim survives SIGKILL and restart without a second initial dispatch", async (t) => {
  const p = temp(t),
    file = path.join(p, "state.sqlite"),
    script = path.join(p, "crash.ts");
  const s = new State(file),
    r = request();
  s.observe(r);
  s.close();
  fs.writeFileSync(
    script,
    `import {State} from ${JSON.stringify(new URL("../src-ts/state.ts", import.meta.url).pathname)};const s=new State(${JSON.stringify(file)});s.beginDispatch(${JSON.stringify(r.work_id)});console.log('committed');setInterval(()=>{},1000);`,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("No commit marker")), 3000);
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  const restarted = new State(file);
  t.after(() => restarted.close());
  assert.equal(restarted.get(r.work_id).state, "dispatching");
  assert.equal(restarted.beginDispatch(r.work_id), false);
  assert.equal(restarted.get(r.work_id).attempts, 1);
});
test("lost dispatch response reconciles authoritative worker before retry", async (t) => {
  const p = temp(t),
    s = new State(path.join(p, "state.sqlite"));
  t.after(() => s.close());
  const r = request();
  s.observe(r);
  s.bindDelivery(r.work_id, { runner: "fake" });
  let executions = 0,
    owner: any = null;
  const runner = {
    prepare: async () => ({}),
    inspect: async () => owner,
    dispatch: async () => {
      executions++;
      owner = { external_id: "github:run:1", running: true, result: null };
      throw new DeliveryError("lost response");
    },
  };
  assert.equal(
    (await advance(s, runner, r.work_id, 100)).event,
    "delivery-uncertain",
  );
  assert.equal(
    (await advance(s, runner, r.work_id, 200)).event,
    "work-reconciled",
  );
  assert.equal(executions, 1);
  assert.equal(s.get(r.work_id).state, "running");
});
test("retry bounds, immutable delivery and final result binding", (t) => {
  const p = temp(t),
    s = new State(path.join(p, "state.sqlite"));
  t.after(() => s.close());
  const r = request();
  s.observe(r);
  s.bindDelivery(r.work_id, { runner: "fake" });
  assert.throws(() => s.bindDelivery(r.work_id, { runner: "other" }));
  assert.equal(s.claimDeliveryAttempt(r.work_id, 100), true);
  assert.equal(s.claimDeliveryAttempt(r.work_id, 120), false);
  assert.equal(s.claimDeliveryAttempt(r.work_id, 160), true);
  assert.equal(s.claimDeliveryAttempt(r.work_id, 220), true);
  assert.equal(s.claimDeliveryAttempt(r.work_id, 280), false);
  s.attachRun(r.work_id, "owner", true);
  const result = {
    schema_version: 1,
    work_id: r.work_id,
    commit_uri: r.commit_uri,
    rule_version: r.rule_version,
    rule_sha256: r.rule_sha256,
    validator_sha256: r.validator_sha256,
    input_sha256: "3".repeat(64),
    report_sha256: "4".repeat(64),
    outcome: "nonconforming",
    external_id: "owner",
    report_url: "https://github.com/example/report",
  };
  assert.throws(() =>
    s.complete(r.work_id, { ...result, commit_uri: request("b").commit_uri }),
  );
  s.complete(r.work_id, result);
  s.complete(r.work_id, result);
  assert.throws(() =>
    s.complete(r.work_id, { ...result, outcome: "conforming" }),
  );
});
test("pinned lock read refuses branch substitution and moved lock", async () => {
  const r = request(),
    lock = branch.repository_uri + "/locks/ci-" + r.work_id;
  let reads = 0;
  const send = async (uri: string, init?: RequestInit) => {
    if (uri === lock) {
      reads++;
      return new Response(
        `<${lock}> <https://mms.openmbee.org/rdf/ontology/commit> <${reads === 1 ? r.commit_uri : request("b").commit_uri}> .`,
        { headers: { etag: '"a"' } },
      );
    }
    assert.equal(new Headers(init?.headers).get("if-match"), '"a"');
    return new Response("<urn:x> <urn:p> <urn:y>.");
  };
  await assert.rejects(new Flexo("test", send).snapshot(r), /changed/);
  assert.throws(
    () =>
      commitBinding(
        Buffer.from(
          `<${lock}> <https://mms.openmbee.org/rdf/ontology/commit> <https://other.example/commits/x>.`,
        ),
        lock,
        branch,
      ),
    /foreign/,
  );
});
test("invalid then corrected snapshot validates exact retained revision", async (t) => {
  const p = temp(t),
    rule = fs.readFileSync(
      new URL("../examples/named-part-v1/rule.ttl", import.meta.url),
    );
  for (const [name, outcome] of [
    ["invalid", "nonconforming"],
    ["corrected", "conforming"],
  ]) {
    const r = new ValidationRequest(
        branch,
        branch.repository_uri + "/commits/" + name,
        "named-part-v1",
        digest(rule),
        validatorDigest(),
      ),
      s = new Snapshot(
        r,
        branch.repository_uri + "/locks/" + name,
        '"' + name + '"',
        fs.readFileSync(
          new URL(
            "../examples/named-part-v1/" + name + ".ttl",
            import.meta.url,
          ),
        ),
      ),
      result = await validateSnapshot(
        s,
        rule,
        path.join(p, name),
        "local-test",
      );
    assert.equal(result.outcome, outcome);
    assert.equal(result.commit_uri, r.commit_uri);
    assert.equal(result.input_sha256, digest(s.model));
    assert.equal(
      result.report_sha256,
      digest(fs.readFileSync(path.join(p, name, "report.ttl"))),
    );
  }
});
