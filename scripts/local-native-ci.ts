import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { localCredentials, localApi } from "./local-jenkins.ts";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  local = path.join(root, ".local/native-validation"),
  recordFile = path.join(local, "workers.json");
const names = {
  jenkins: "flexo-native-jenkins-agent",
  gitlab: "flexo-native-gitlab-runner",
};
class SetupError extends Error {}
const project = "87709578",
  gitlab = "https://gitlab.com";
function docker(args: string[], input?: string) {
  return execFileSync("docker", args, {
    cwd: root,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.DOCKER_HOST
        ? { DOCKER_HOST: process.env.DOCKER_HOST }
        : {}),
    },
  });
}
async function localPost(route: string, body: string) {
  const c = localCredentials();
  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      "https://localhost:18443" + route,
      {
        method: "POST",
        ca: c.certificate,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from("adapter-local:" + c.token).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 30000,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (b) => parts.push(b));
        res.on("end", () =>
          res.statusCode === 200
            ? resolve(Buffer.concat(parts).toString())
            : reject(new SetupError("Local Jenkins setup failed")),
        );
      },
    );
    req.on("error", () => reject(new SetupError("Local Jenkins setup failed")));
    req.on("timeout", () => req.destroy());
    req.end(body);
  });
}
async function call(route: string, method = "GET", body?: unknown) {
  const token = process.env.GITLAB_READ_TOKEN;
  if (!token || token.startsWith("op://"))
    throw new SetupError("Load approved GitLab project API credential");
  const r = await fetch(gitlab + "/api/v4" + route, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok)
    throw new SetupError("GitLab worker setup failed: HTTP " + r.status);
  return r.status === 204 ? null : r.json();
}
function inspect(name: string) {
  try {
    return JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
  } catch {
    return null;
  }
}
async function up(engines: string) {
  fs.mkdirSync(local, { recursive: true });
  if (inspect(names.jenkins) || inspect(names.gitlab))
    throw new SetupError(
      "Local worker containers already exist; inspect status or stop them first",
    );
  const host =
    process.env.DOCKER_HOST ??
    docker([
      "context",
      "inspect",
      "--format",
      '{{(index .Endpoints "docker").Host}}',
    ]).trim();
  if (!host.startsWith("unix:///"))
    throw new SetupError("Local Unix Docker socket required");
  process.env.DOCKER_HOST = host;
  const evidence = path.join(local, "evidence"),
    tmp = path.join(local, "engine-tmp");
  for (const dir of [evidence, tmp])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = localCredentials();
  const common = [
    "--label",
    "org.openmbee.flexo.native-ci=local",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--pids-limit",
    "512",
    "--network",
    "flexo-jenkins-local_local-test",
    "--tmpfs",
    "/run/native-ci:rw,mode=700",
    "--tmpfs",
    "/work:rw,mode=700",
    "-e",
    "FLEXO_EVIDENCE_DIRECTORY=" + evidence,
    "-e",
    "FLEXO_ENGINE_DIRECTORY=" + engines,
    "-e",
    "TMPDIR=" + tmp,
    "-e",
    "DOCKER_HOST=" + host,
  ];
  for (const dir of [evidence, tmp, engines])
    common.push("-v", dir + ":" + dir + (dir === engines ? ":ro" : ":rw"));
  common.push(
    "-v",
    host.slice("unix://".length) + ":" + host.slice("unix://".length),
  );
  for (const dir of ["src-ts", "scripts"])
    common.push(
      "-v",
      path.join(root, dir) + ":/opt/flexo-worker/" + dir + ":ro",
    );
  for (const file of ["package.json", "package-lock.json"])
    common.push(
      "-v",
      path.join(root, file) + ":/opt/flexo-worker/" + file + ":ro",
    );
  common.push(
    "-v",
    path.join(root, ".local/jenkins-local/certificate.pem") +
      ":/opt/controller-certificate.pem:ro",
  );
  let runnerId: number | undefined;
  try {
    const response = await localPost(
      "/scriptText",
      new URLSearchParams({
        script: fs.readFileSync(
          path.join(root, "dev/native-ci/jenkins-validation.groovy"),
          "utf8",
        ),
      }).toString(),
    );
    const parsed = JSON.parse(response.trim());
    if (typeof parsed.secret !== "string" || !/^[a-f0-9]+$/.test(parsed.secret))
      throw new SetupError("Local agent bootstrap failed");
    docker([
      "run",
      "-d",
      "--name",
      names.jenkins,
      ...common,
      "flexo-native-ci:local",
    ]);
    docker([
      "exec",
      names.jenkins,
      "mkfifo",
      "-m",
      "600",
      "/run/native-ci/agent-secret",
    ]);
    docker([
      "exec",
      "-d",
      names.jenkins,
      "java",
      "-cp",
      "/opt/agent.jar",
      "/opt/AgentLauncher.java",
    ]);
    docker(
      [
        "exec",
        "-i",
        names.jenkins,
        "sh",
        "-c",
        "cat > /run/native-ci/agent-secret",
      ],
      parsed.secret + "\n",
    );
    // Registration credentials exist only in this process and the runner's tmpfs.
    const runner = await call("/user/runners", "POST", {
      runner_type: "project_type",
      project_id: Number(project),
      description: "Flexo local validation",
      tag_list: ["flexo-validation-local"],
      run_untagged: false,
      locked: true,
      access_level: "ref_protected",
    });
    runnerId = runner.id;
    if (typeof runner.token !== "string")
      throw new SetupError("Missing local runner credential");
    docker([
      "run",
      "-d",
      "--name",
      names.gitlab,
      ...common,
      "flexo-native-ci:local",
    ]);
    const environment = [
      "FLEXO_EVIDENCE_DIRECTORY=" + evidence,
      "FLEXO_ENGINE_DIRECTORY=" + engines,
      "TMPDIR=" + tmp,
      "DOCKER_HOST=" + host,
    ];
    const config = `concurrent = 2\ncheck_interval = 3\n[[runners]]\nname = "flexo-validation-local"\nurl = "https://gitlab.com"\ntoken = ${JSON.stringify(runner.token)}\nexecutor = "shell"\nshell = "bash"\nlimit = 2\nenvironment = ${JSON.stringify(environment)}\n`;
    docker(
      [
        "exec",
        "-i",
        names.gitlab,
        "node",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';let value='';for await(const b of process.stdin)value+=b;fs.writeFileSync('/run/native-ci/config.toml',value,{mode:0o600});",
      ],
      config,
    );
    docker([
      "exec",
      "-d",
      names.gitlab,
      "gitlab-runner",
      "run",
      "--config",
      "/run/native-ci/config.toml",
      "--working-directory",
      "/work",
    ]);
    const record = {
      project: "e4rohan/test-project",
      runner_id: runnerId,
      evidence_directory: evidence,
      engine_directory: engines,
      containers: names,
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = await call("/runners/" + runnerId);
      const agent = (
        await localApi(
          "/computer/flexo-validation-local-v2/api/json?tree=offline",
          c,
        )
      ).data;
      if (r.status === "online" && agent.offline === false) {
        console.log(JSON.stringify({ ...record, runner_online: true }));
        return;
      }
      await delay(1000);
    }
    throw new SetupError("Local runner did not become online");
  } catch (e) {
    for (const name of Object.values(names))
      if (inspect(name)) docker(["rm", "-f", name]);
    if (runnerId) await call("/runners/" + runnerId, "DELETE");
    throw e;
  }
}
export async function main() {
  const command = process.argv[2];
  if (command === "up") {
    execFileSync("ctxcheck", { cwd: root, stdio: "inherit" });
    execFileSync("git", ["status", "--short"], { cwd: root, stdio: "inherit" });
    const index = process.argv.indexOf("--engines"),
      engines = path.resolve(
        index >= 0 ? process.argv[index + 1] : path.join(local, "engines"),
      );
    if (!fs.existsSync(engines))
      throw new SetupError(
        "Provision reviewed engine directory first with scripts/install-engines.ts",
      );
    await up(engines);
  } else if (command === "status") {
    const record = fs.existsSync(recordFile)
      ? JSON.parse(fs.readFileSync(recordFile, "utf8"))
      : null;
    console.log(
      JSON.stringify(
        {
          record,
          jenkins: inspect(names.jenkins)?.Running ?? false,
          gitlab: inspect(names.gitlab)?.Running ?? false,
        },
        null,
        2,
      ),
    );
  } else if (command === "down") {
    const record = fs.existsSync(recordFile)
      ? JSON.parse(fs.readFileSync(recordFile, "utf8"))
      : null;
    for (const name of Object.values(names))
      if (inspect(name)) docker(["rm", "-f", name]);
    if (record?.runner_id) await call("/runners/" + record.runner_id, "DELETE");
    if (record)
      fs.writeFileSync(
        recordFile,
        JSON.stringify(
          { ...record, stopped_at: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      );
    console.log(
      "Local validation workers stopped; durable inputs, claims and results retained.",
    );
  } else
    throw new SetupError(
      "Usage: node scripts/local-native-ci.ts up [--engines DIRECTORY]|status|down",
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(
      e instanceof SetupError
        ? e.message
        : "Local validation setup failed (" +
            (e instanceof Error ? e.name : "unknown") +
            ")",
    );
    process.exitCode = 2;
  });
