import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localCredentials, localApi, localEndpoint } from "./local-jenkins.ts";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = fs.mkdtempSync(
  path.join(repository, ".local/jenkins-local/check-"),
);
const file = path.join(run, "adapter.json");
const credentials = localCredentials();
const config = {
  schema_version: 1,
  id: "jenkins-local-check",
  state_directory: "state",
  source: {
    type: "flexo",
    endpoint: "https://adapter-source.invalid",
    organization: "local",
    repository: "adapter-check",
    branch: path.basename(run),
  },
  observation: { mode: "poll", interval_seconds: 30 },
  feed: { type: "json-feed", path: "feed/activity.json" },
  actions: [
    {
      id: "metadata-check",
      on: ["baseline", "branch-change"],
      task: { type: "ci-trigger" },
      target: {
        type: "jenkins",
        endpoint: localEndpoint,
        job: "adapter-smoke",
      },
    },
  ],
};
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
function command(
  verb: string,
  head = "adapter-ok",
  lost = false,
  selectedFile = file,
) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repository, "dev/jenkins-local/transport.mjs"),
      "src-ts/cli.ts",
      verb,
      "--config",
      selectedFile,
      ...(verb === "run" ? ["--once"] : []),
    ],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...credentials.environment,
        FLEXO_TOKEN: "synthetic-local-source-only",
        FLEXO_PASSWORD: "",
        GITHUB_TOKEN: "",
        LOCAL_TEST_HEAD: head,
        LOCAL_TEST_LOST_RESPONSE: lost
          ? path.join(run, "lost-response.json")
          : "",
      },
      timeout: 60000,
    },
  );
  fs.appendFileSync(
    path.join(run, "cli.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      command: verb,
      head,
      code: result.status,
      stdout: result.stdout,
    }) + "\n",
  );
  assert.equal(result.status, lost ? 2 : 0, "Local adapter CLI round failed");
  return verb === "status" ? JSON.parse(result.stdout) : result.stdout;
}
async function complete(head: string, count: number) {
  const until = Date.now() + 90000;
  while (true) {
    const status = command("status", head);
    if (
      status.actions.length === count &&
      status.actions.every((a: any) => a.state === "completed")
    )
      return status;
    assert(Date.now() < until, "Jenkins result timed out");
    await delay(1000);
    command("run", head);
  }
}
try {
  const initial = await localApi("/job/adapter-smoke/api/json", credentials);
  const before = initial.data.nextBuildNumber;
  command("check");
  command("run", "adapter-ok", true);
  const uncertain = command("status");
  assert.equal(uncertain.actions[0].delivery.state, "uncertain");
  assert.equal(uncertain.actions[0].delivery.attempts, 1);
  assert(fs.existsSync(path.join(run, "lost-response.json")));
  fs.writeFileSync(
    path.join(run, "before-restart.json"),
    JSON.stringify(uncertain, null, 2) + "\n",
  );
  // Every CLI round is a fresh process reading retained state.
  command("run");
  const restarted = command("status");
  assert.equal(restarted.actions[0].delivery.attempts, 1);
  assert(
    ["queued", "running", "completed"].includes(
      restarted.actions[0].delivery.state,
    ),
  );
  fs.writeFileSync(
    path.join(run, "after-restart.json"),
    JSON.stringify(restarted, null, 2) + "\n",
  );
  const success = await complete("adapter-ok", 1);
  assert.equal(success.actions[0].result.outcome, "succeeded");
  command("run");
  const afterRepeat = await localApi(
    "/job/adapter-smoke/api/json",
    credentials,
  );
  assert.equal(afterRepeat.data.nextBuildNumber, before + 1);
  command("run", "adapter-fail");
  const final = await complete("adapter-fail", 2);
  assert.deepEqual(
    final.actions.map((a: any) => a.result.outcome),
    ["succeeded", "failed"],
  );
  assert(final.actions.every((a: any) => a.delivery.attempts === 1));
  assert.equal(final.events.length, 2);
  const after = await localApi("/job/adapter-smoke/api/json", credentials);
  assert.equal(after.data.nextBuildNumber, before + 2);
  const builds = [];
  for (const action of final.actions) {
    const build = await localApi(
      `/job/adapter-smoke/${JSON.parse(action.delivery.external_json).build_number}/api/json`,
      credentials,
    );
    const parameters = build.data.actions.flatMap(
      (a: any) => a.parameters ?? [],
    );
    assert(
      parameters.some(
        (p: any) => p.name === "ADAPTER_DELIVERY_ID" && p.value === action.id,
      ),
    );
    assert(
      parameters.some(
        (p: any) =>
          p.name === "ADAPTER_SOURCE_REVISION" && p.value === action.commit_uri,
      ),
    );
    builds.push({
      number: build.data.number,
      queue_id: build.data.queueId,
      result: build.data.result,
      url: build.data.url,
      parameters,
    });
  }
  const rejectedFile = path.join(run, "rejected.json");
  const rejected = structuredClone(config);
  rejected.state_directory = "rejected-state";
  rejected.feed.path = "rejected-feed/activity.json";
  rejected.actions[0].target.job = "adapter-missing-job";
  fs.writeFileSync(rejectedFile, JSON.stringify(rejected, null, 2));
  command("run", "adapter-ok", false, rejectedFile);
  const rejection = command("status", "adapter-ok", false, rejectedFile);
  assert.equal(rejection.actions[0].result.outcome, "execution-error");
  const evidence = {
    checked_at: new Date().toISOString(),
    jenkins_version: initial.version,
    endpoint: localEndpoint,
    lost_response: JSON.parse(
      fs.readFileSync(path.join(run, "lost-response.json"), "utf8"),
    ),
    recovered_state: restarted.actions[0].delivery.state,
    status: final,
    builds,
    rejected_result: rejection.actions[0].result,
    limits: [
      "Real local Jenkins with controlled Flexo metadata transport",
      "Does not establish SysML or SHACL validation",
      "Only this dedicated job/version tested; no production deployment",
    ],
  };
  fs.writeFileSync(
    path.join(run, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      verified: true,
      evidence: path.join(run, "evidence.json"),
      recovered_state: evidence.recovered_state,
      builds: builds.map((b) => ({ number: b.number, result: b.result })),
      rejected_job: "execution-error",
      duplicate_submissions: 0,
    }),
  );
} catch {
  console.error(
    "Local Jenkins check failed; inspect retained CLI evidence:",
    run,
  );
  process.exitCode = 2;
}
