import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const cli = path.resolve("src-ts/cli.ts");
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "configured-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "adapter.json"),
    preload = path.join(root, "transport.mjs");
  const configuration = {
    schema_version: 1,
    id: "research",
    state_directory: "state",
    source: {
      type: "flexo",
      endpoint: "https://flexo.test",
      organization: "research",
      repository: "model",
      branch: "main",
    },
    observation: { mode: "poll", interval_seconds: 30 },
    feed: { type: "json-feed", path: "feed/activity.json" },
    actions: [] as unknown[],
  };
  const write = () => fs.writeFileSync(file, JSON.stringify(configuration));
  write();
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
    if (process.env.TEST_NO_NETWORK) throw Error('Network forbidden');
    if (init?.method !== 'GET' || !String(url).includes('/branches/')) throw Error('Unexpected operation');
    if (process.env.TEST_FAILURE) return new Response('unavailable',{status:503});
    return new Response('<'+url+'> <https://mms.openmbee.org/rdf/ontology/commit> <'+String(url).split('/branches/')[0]+'/commits/'+process.env.TEST_HEAD+'> .');
  };`,
  );
  const run = (
    command: string,
    head = "a",
    extra: string[] = [],
    env: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      ["--import", preload, cli, command, "--config", file, ...extra],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLEXO_TOKEN: "synthetic-token",
          TEST_HEAD: head,
          ...env,
        },
      },
    );
  const check = (
    command: string,
    head = "a",
    env: Record<string, string> = {},
  ) => {
    const p = run(command, head, command === "run" ? ["--once"] : [], env);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    return p;
  };
  return {
    root,
    file,
    preload,
    configuration,
    write,
    run,
    check,
    feed: () =>
      JSON.parse(
        fs.readFileSync(path.join(root, "feed/activity.json"), "utf8"),
      ),
    status: () => JSON.parse(check("status").stdout),
  };
}

test("configuration check/status are offline and do not initialize state; paths are relative to config", (t) => {
  const f = fixture(t);
  f.check("check", "a", { TEST_NO_NETWORK: "yes" });
  assert.equal(f.status().initialized, false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [
    "adapter.json",
    "transport.mjs",
  ]);
  for (const change of [
    () => {
      f.configuration.source.type = "unsupported";
    },
    () => {
      f.configuration.feed.path = "state/events.sqlite-wal";
    },
    () => {
      f.configuration.observation.mode = "listener";
    },
  ]) {
    const saved = structuredClone(f.configuration);
    change();
    f.write();
    assert.equal(f.run("check").status, 2);
    Object.assign(f.configuration, saved);
  }
});

test("configuration rejects outputs that replace configuration or internal state paths", (t) => {
  const f = fixture(t);
  for (const output of [
    "adapter.json",
    "adapter.json-wal",
    "adapter.json/child",
    "state/targets",
    "state/targets/child",
    "state/ownership.json",
    "state/ownership.json/child",
    "state/.owner.watch.lock/child",
  ]) {
    f.configuration.feed.path = output;
    f.write();
    const before = fs.readFileSync(f.file);
    const result = f.run("check", "a", [], { TEST_NO_NETWORK: "yes" });
    assert.equal(result.status, 2, output + result.stdout + result.stderr);
    assert.ok(fs.readFileSync(f.file).equals(before));
    assert.equal(fs.existsSync(path.join(f.root, "state")), false);
  }
});

test("configured feed preserves retained history, failures, A-B-A and source isolation", (t) => {
  const f = fixture(t);
  f.check("run");
  const baseline = f.feed();
  assert.equal(baseline.events[0].kind, "baseline");
  f.check("run", "b");
  const changed = f.feed();
  f.check("run", "b");
  assert.deepEqual(f.feed().events, changed.events);
  const lastSuccess = f.feed().last_success_at;
  assert.equal(
    f.run("run", "c", ["--once"], { TEST_FAILURE: "yes" }).status,
    2,
  );
  assert.deepEqual(f.feed().events, changed.events);
  assert.equal(f.feed().last_success_at, lastSuccess);
  f.check("run", "a");
  assert.equal(f.feed().events.length, 3);
  assert.deepEqual(f.feed().events[2], baseline.events[0]);
  const event = f.feed().events[0];
  const data = {
    sequence: event.sequence,
    kind: event.kind,
    branch_uri: event.branch_uri,
    previous_commit_uri: event.previous_commit_uri,
    commit_uri: event.commit_uri,
    observed_at: event.observed_at,
  };
  assert.equal(
    event.id,
    createHash("sha256").update(JSON.stringify(data)).digest("hex"),
  );
  f.configuration.source.branch = "different";
  f.write();
  assert.equal(f.run("run", "c", ["--once"]).status, 2);
  f.configuration.state_directory = "other-state";
  f.configuration.feed.path = "other-feed.json";
  f.write();
  f.check("run", "z");
  assert.equal(f.status().events.length, 1);
});

test("unsupported journals fail without upgrading or changing their data", (t) => {
  for (const version of [0, 2]) {
    const f = fixture(t),
      dir = path.join(f.root, "state");
    fs.mkdirSync(dir);
    const file = path.join(dir, "events.sqlite"),
      db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('retained'); PRAGMA user_version=${version};`,
    );
    db.close();
    const before = fs.readFileSync(file);
    assert.equal(f.run("status").status, 2);
    assert.equal(f.run("run", "a", ["--once"]).status, 2);
    assert.ok(fs.readFileSync(file).equals(before));
  }
});

test("action configuration and rule bytes stay frozen after restart and configuration removal", (t) => {
  const f = fixture(t);
  const rule = path.resolve("examples/named-part-v1/rule.ttl");
  f.configuration.actions = ["first", "second"].map((id) => ({
    id,
    on: ["branch-change"],
    task: { type: "shacl-validation", rule, rule_version: "v1" },
    target: {
      type: "github",
      owner: "DSG",
      repository: id,
      token_env: "TEST_MISSING_TOKEN",
    },
  }));
  f.write();
  f.check("run");
  assert.equal(f.status().actions.length, 0);
  assert.equal(f.run("run", "b", ["--once"]).status, 2);
  const queued = f.status();
  assert.equal(queued.actions.length, 2);
  assert.ok(queued.actions.every((a: any) => a.error && a.state === "pending"));
  assert.equal(new Set(queued.actions.map((a: any) => a.id)).size, 2);
  f.configuration.actions = [];
  f.write();
  assert.equal(f.run("run", "c", ["--once"]).status, 2);
  const retained = f.status();
  assert.equal(retained.actions.length, 2);
  assert.deepEqual(
    retained.actions.map((a: any) => a.action),
    queued.actions.map((a: any) => a.action),
  );
  assert.equal(retained.events.length, 3);
  const db = new DatabaseSync(path.join(f.root, "state/events.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM action_rules").get()!.n,
    1,
  );
  db.close();
});

test("failed journal transaction cannot advance history/checkpoint or leave partial action intents", (t) => {
  const f = fixture(t);
  f.check("run");
  const db = new DatabaseSync(path.join(f.root, "state/events.sqlite"));
  db.exec(
    "CREATE TRIGGER fail_intent BEFORE INSERT ON action_intents BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;",
  );
  db.close();
  f.configuration.actions = [
    {
      id: "test",
      on: ["branch-change"],
      task: {
        type: "shacl-validation",
        rule: path.resolve("examples/named-part-v1/rule.ttl"),
        rule_version: "v1",
      },
      target: { type: "github", owner: "DSG", repository: "test" },
    },
  ];
  f.write();
  assert.equal(f.run("run", "b", ["--once"]).status, 2);
  assert.equal(f.status().events.length, 1);
  assert.equal(f.status().actions.length, 0);
});

test("feed publication failure retains journal and recovers without replay", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "feed/activity.json"), { recursive: true });
  assert.equal(f.run("run", "a", ["--once"]).status, 2);
  assert.equal(f.status().events.length, 1);
  fs.rmdirSync(path.join(f.root, "feed/activity.json"));
  f.check("run");
  assert.equal(f.feed().events.length, 1);
});

test("a running observer holds feed ownership across different databases", async (t) => {
  const f = fixture(t);
  const child = spawn(
    process.execPath,
    ["--import", f.preload, cli, "run", "--config", f.file],
    {
      env: { ...process.env, FLEXO_TOKEN: "synthetic-token", TEST_HEAD: "a" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (b) => (errors += b));
  const done = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(errors || "Observer did not publish")),
        10000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    f.configuration.state_directory = "different-state";
    f.write();
    const other = f.run("run", "b", ["--once"]);
    assert.equal(other.status, 1, other.stdout + other.stderr);
  } finally {
    child.kill("SIGTERM");
    await done;
  }
});

test("configured GitHub deliveries reconcile lost responses, isolate targets, reuse computations and preserve destinations", (t) => {
  const f = fixture(t);
  const rule = path.join(f.root, "rule.ttl");
  fs.copyFileSync("examples/named-part-v1/rule.ttl", rule);
  f.configuration.actions = ["first", "second"].map((id) => ({
    id,
    on: ["branch-change"],
    allow_lock_creation: true,
    task: { type: "shacl-validation", rule: "rule.ttl", rule_version: "v1" },
    target: { type: "github", owner: "DSG", repository: id },
  }));
  f.write();
  const remoteFile = path.join(f.root, "remote.json");
  const execute = (head: string, env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("tests-ts/fixtures-configured-github.mjs"),
        cli,
        "run",
        "--config",
        f.file,
        "--once",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLEXO_TOKEN: "synthetic",
          GITHUB_TOKEN: "synthetic",
          TEST_HEAD: head,
          TEST_REMOTE_STATE: remoteFile,
          ...env,
        },
      },
    );
  let p = execute("a");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  p = execute("b", { TEST_LOSE_RESPONSE: "yes", TEST_FAIL_TARGETS: "second" });
  assert.equal(p.status, 2, p.stdout + p.stderr);
  let remote = JSON.parse(fs.readFileSync(remoteFile, "utf8"));
  assert.equal(remote.executions.length, 1);
  // The already queued second action must keep its destination and original rule.
  f.configuration.actions = [
    {
      id: "replacement",
      on: ["branch-change"],
      allow_lock_creation: true,
      task: { type: "shacl-validation", rule: "rule.ttl", rule_version: "v2" },
      target: { type: "github", owner: "DSG", repository: "new-target" },
    },
  ];
  fs.appendFileSync(rule, "\n# changed configuration\n");
  f.write();
  p = execute("b");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  p = execute("b");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  let status = f.status();
  assert.equal(status.actions.length, 2);
  assert.ok(status.actions.every((a: any) => a.state === "completed"));
  assert.deepEqual(
    new Set(status.actions.map((a: any) => a.action.target.repository)),
    new Set(["first", "second"]),
  );
  assert.ok(
    status.actions.every(
      (a: any) =>
        a.result.outcome === "nonconforming" &&
        a.result.commit_uri.endsWith("/b"),
    ),
  );
  remote = JSON.parse(fs.readFileSync(remoteFile, "utf8"));
  assert.equal(remote.executions.length, 2);
  assert.equal(remote.dispatches.length, 2);
  // A new event selects the replacement, while a repeated head does not.
  p = execute("a");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  p = execute("a");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  status = f.status();
  assert.equal(status.actions.length, 3);
  assert.equal(status.actions.at(-1).action.target.repository, "new-target");
  assert.equal(status.events.length, 3);
  // Return to b with the original configuration: action records are new; computations reuse results.
  fs.copyFileSync("examples/named-part-v1/rule.ttl", rule);
  f.configuration.actions = ["first", "second"].map((id) => ({
    id,
    on: ["branch-change"],
    allow_lock_creation: true,
    task: { type: "shacl-validation", rule: "rule.ttl", rule_version: "v1" },
    target: { type: "github", owner: "DSG", repository: id },
  }));
  f.write();
  p = execute("b");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  status = f.status();
  assert.equal(status.actions.length, 5);
  assert.ok(
    status.actions.slice(-2).every((a: any) => a.state === "completed"),
  );
  remote = JSON.parse(fs.readFileSync(remoteFile, "utf8"));
  assert.equal(remote.executions.length, 3);
  assert.equal(remote.dispatches.length, 3);
});

test("SIGKILL before journal commit rolls back event, rule and action intents together", (t) => {
  const f = fixture(t);
  f.check("run");
  f.configuration.actions = [
    {
      id: "validation",
      on: ["branch-change"],
      task: {
        type: "shacl-validation",
        rule: path.resolve("examples/named-part-v1/rule.ttl"),
        rule_version: "v1",
      },
      target: {
        type: "github",
        owner: "DSG",
        repository: "adapter",
        token_env: "TEST_MISSING_TOKEN",
      },
    },
  ];
  f.write();
  const marker = path.join(f.root, "interrupted");
  fs.appendFileSync(
    f.preload,
    `\nimport {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(process.env.TEST_KILL_COMMIT&&sql==='COMMIT'&&this.prepare("SELECT 1 FROM sqlite_master WHERE name='action_intents'").get()&&this.prepare('SELECT count(*) AS n FROM action_intents').get().n){writeFileSync(${JSON.stringify(marker)},'before commit');process.kill(process.pid,'SIGKILL');}return original.call(this,sql);};`,
  );
  const killed = f.run("run", "b", ["--once"], { TEST_KILL_COMMIT: "yes" });
  assert.notEqual(killed.status, 0);
  assert.ok(fs.existsSync(marker));
  const after = f.status();
  assert.equal(after.events.length, 1);
  assert.equal(after.actions.length, 0);
  assert.ok(after.latest_commit_uri.endsWith("/a"));
  assert.equal(f.run("run", "b", ["--once"]).status, 2);
  assert.equal(f.status().actions.length, 1);
  assert.equal(f.status().events.length, 2);
});

function ciFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t),
    remoteFile = path.join(f.root, "ci-remote.json");
  f.configuration.actions = [
    {
      id: "pipeline",
      on: ["branch-change"],
      task: { type: "ci-trigger" },
      target: {
        type: "gitlab",
        endpoint: "https://gitlab.test",
        project: "research/model",
        ref: "main",
      },
    },
    {
      id: "build",
      on: ["branch-change"],
      task: { type: "ci-trigger" },
      target: {
        type: "jenkins",
        endpoint: "https://jenkins.test",
        job: "research/check",
      },
    },
  ];
  f.write();
  const execute = (head: string, env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("tests-ts/fixtures-load-guard.mjs"),
        "--import",
        path.resolve("tests-ts/fixtures-ci-targets.mjs"),
        cli,
        "run",
        "--config",
        f.file,
        "--once",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLEXO_TOKEN: "synthetic-source",
          GITLAB_TRIGGER_TOKEN: "synthetic-trigger",
          GITLAB_READ_TOKEN: "synthetic-read",
          JENKINS_USERNAME: "synthetic-user",
          JENKINS_TOKEN: "synthetic-jenkins",
          TEST_HEAD: head,
          TEST_REMOTE_STATE: remoteFile,
          ...env,
        },
      },
    );
  return {
    ...f,
    execute,
    remote: () => JSON.parse(fs.readFileSync(remoteFile, "utf8")),
  };
}

test("GitLab and Jenkins recover lost submissions and retain independent native outcomes without claiming SHACL validation", (t) => {
  const f = ciFixture(t);
  let p = f.execute("a");
  assert.equal(p.status, 0, p.stdout + p.stderr);
  p = f.execute("b", { TEST_LOSE_RESPONSE: "yes" });
  assert.equal(p.status, 2, p.stdout + p.stderr);
  let status = f.status();
  assert.equal(status.actions.length, 2);
  assert.ok(
    status.actions.every(
      (a: any) => a.delivery.state === "uncertain" && a.delivery.attempts === 1,
    ),
  );
  assert.equal(f.remote().submissions.length, 2);
  // No matching job is not proof of absence: the bridge must not resubmit.
  p = f.execute("b", { TEST_HIDE: "yes" });
  assert.equal(p.status, 2);
  assert.equal(f.remote().submissions.length, 2);
  f.configuration.actions = [];
  f.write();
  p = f.execute("b", { TEST_STAGE: "running" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  status = f.status();
  assert.ok(status.actions.every((a: any) => a.delivery.state === "running"));
  p = f.execute("c", { TEST_STAGE: "success" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  status = f.status();
  assert.ok(
    status.actions.every(
      (a: any) =>
        a.state === "completed" &&
        a.result.task_type === "ci-trigger" &&
        a.result.outcome === "succeeded" &&
        a.result.source_revision.endsWith("/b"),
    ),
  );
  assert.equal(f.remote().submissions.length, 2);
  assert.equal(status.events.length, 3);
  assert.ok(status.actions.every((a: any) => !("conforms" in a.result)));
  assert.ok(
    !fs
      .readFileSync(path.join(f.root, "ci-remote.json"), "utf8")
      .includes("synthetic-trigger"),
  );
});

test("native CI failures and rejected submissions are terminal execution outcomes, independent of source observation", (t) => {
  const f = ciFixture(t);
  assert.equal(f.execute("a").status, 0);
  let p = f.execute("b", { TEST_REJECT: "gitlab" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  p = f.execute("b", { TEST_STAGE: "failed" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const status = f.status();
  const pipeline = status.actions.find(
      (a: any) => a.action.target.type === "gitlab",
    ),
    build = status.actions.find((a: any) => a.action.target.type === "jenkins");
  assert.equal(pipeline.result.outcome, "execution-error");
  assert.equal(build.result.outcome, "failed");
  assert.equal(f.remote().submissions.length, 1);
});

test("native CI input-binding mismatches remain unresolved and expired Jenkins queues recover through builds", (t) => {
  const f = ciFixture(t);
  assert.equal(f.execute("a").status, 0);
  assert.equal(f.execute("b").status, 0);
  let p = f.execute("b", {
    TEST_STAGE: "success",
    TEST_FOREIGN_BINDING: "yes",
  });
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.ok(f.status().actions.every((a: any) => a.state === "pending"));
  p = f.execute("b", { TEST_STAGE: "success", TEST_EXPIRE_QUEUE: "yes" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.ok(f.status().actions.every((a: any) => a.state === "completed"));
  assert.equal(f.remote().submissions.length, 2);
});

test("continuous delivery advances later healthy-target work while another target is still submitting", async (t) => {
  const f = ciFixture(t),
    preload = path.join(f.root, "fast-clock.mjs");
  fs.writeFileSync(
    preload,
    `import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';const delay=timers.setTimeout;timers.setTimeout=(ms,...args)=>delay(ms===30000?100:ms,...args);syncBuiltinESMExports();`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      preload,
      "--import",
      path.resolve("tests-ts/fixtures-ci-targets.mjs"),
      cli,
      "run",
      "--config",
      f.file,
    ],
    {
      env: {
        ...process.env,
        FLEXO_TOKEN: "synthetic-source",
        GITLAB_TRIGGER_TOKEN: "synthetic-trigger",
        GITLAB_READ_TOKEN: "synthetic-read",
        JENKINS_USERNAME: "synthetic-user",
        JENKINS_TOKEN: "synthetic-jenkins",
        TEST_HEAD: "a",
        TEST_ADVANCING_SOURCE: "yes",
        TEST_SLOW_GITLAB: "yes",
        TEST_REMOTE_STATE: path.join(f.root, "ci-remote.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const done = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  let output = "";
  child.stderr.on("data", (b) => (output += b));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(Error(output || "Healthy target was blocked by slow target")),
        8000,
      );
      child.stdout.on("data", () => {
        try {
          const remote = f.remote();
          if (
            !remote.slow_done &&
            remote.builds.some((b: any) =>
              b.parameters.ADAPTER_SOURCE_REVISION.endsWith("/c"),
            )
          ) {
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(output || "Observer exited early"));
      });
    });
  } finally {
    child.kill("SIGTERM");
    await done;
  }
});

test("configured engine actions share one verified input, reconcile after removal and keep their original revision", (t) => {
  const f = fixture(t),
    preload = path.resolve("tests-ts/fixtures-configured-github.mjs"),
    remote = path.join(f.root, "remote.json");
  f.configuration.actions = ["opensysml", "sysml-toolkit"].map((engine) => ({
    id: engine,
    on: ["baseline"],
    task: { type: "engine-validation", engine, profile: "syntax-semantic-v1" },
    target: { type: "github", owner: "DSG", repository: "engines" },
    allow_lock_creation: true,
  }));
  f.write();
  const env = {
    ...process.env,
    FLEXO_TOKEN: "synthetic",
    GITHUB_TOKEN: "synthetic",
    TEST_REMOTE_STATE: remote,
    TEST_HEAD: "one",
    TEST_ENGINE_INPUTS: "yes",
    TEST_LOSE_RESPONSE: "yes",
  };
  const run = () =>
    spawnSync(
      process.execPath,
      ["--import", preload, cli, "run", "--config", f.file, "--once"],
      { encoding: "utf8", env },
    );
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  let remoteState = JSON.parse(fs.readFileSync(remote, "utf8"));
  assert.equal(remoteState.artifact_reads.length, 2);
  assert.equal(remoteState.executions.length, 2);
  const pending = f.status();
  assert.equal(pending.inputs.length, 1);
  assert.equal(pending.inputs[0].status, "ready");
  assert.equal(pending.actions.length, 2);
  f.configuration.actions = [];
  f.write();
  env.TEST_HEAD = "two";
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const status = f.status();
  assert.ok(
    status.actions.every(
      (a: any) =>
        a.state === "completed" &&
        a.result.outcome === "pass" &&
        a.result.commit_uri.endsWith("/one"),
    ),
  );
  assert.equal(
    new Set(status.actions.map((a: any) => a.result.work_id)).size,
    2,
  );
  assert.equal(
    new Set(status.actions.map((a: any) => a.result.input_sha256)).size,
    1,
  );
  remoteState = JSON.parse(fs.readFileSync(remote, "utf8"));
  assert.equal(remoteState.artifact_reads.length, 2);
  assert.equal(remoteState.executions.length, 2);
  assert.equal(status.latest_commit_uri.endsWith("/two"), true);
});
