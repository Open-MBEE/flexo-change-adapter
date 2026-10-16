import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const compose = ["compose", "-f", "compose.jenkins-local.yaml"];
export const localEndpoint = "https://localhost:18443";
export const localCertificate = path.join(
  repository,
  ".local/jenkins-local/certificate.pem",
);
function docker(args: string[]) {
  return execFileSync("docker", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function localCredentials() {
  const certificate = docker([
    ...compose,
    "exec",
    "-T",
    "jenkins",
    "cat",
    "/run/local-jenkins/certificate.pem",
  ]);
  fs.mkdirSync(path.dirname(localCertificate), { recursive: true });
  fs.writeFileSync(localCertificate, certificate, { mode: 0o600 });
  // Capture only in memory: do not print or persist this API token.
  const token = docker([
    ...compose,
    "exec",
    "-T",
    "jenkins",
    "cat",
    "/run/local-jenkins/api-token",
  ]).trim();
  if (!token) throw Error("Local Jenkins API token is not ready");
  return {
    certificate,
    token,
    environment: {
      ...process.env,
      JENKINS_USERNAME: "adapter-local",
      JENKINS_TOKEN: token,
      NODE_EXTRA_CA_CERTS: localCertificate,
    },
  };
}
export async function localApi(
  route: string,
  credentials: ReturnType<typeof localCredentials>,
) {
  if (!route.startsWith("/") || route.startsWith("//"))
    throw Error("Expected a local Jenkins route");
  return await new Promise<{ version: string; data: any }>(
    (resolve, reject) => {
      const request = https.get(
        localEndpoint + route,
        {
          ca: credentials.certificate,
          headers: {
            Authorization:
              "Basic " +
              Buffer.from("adapter-local:" + credentials.token).toString(
                "base64",
              ),
            Accept: "application/json",
          },
          timeout: 10000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (b: Buffer) => {
            length += b.length;
            if (length > 4 * 1024 * 1024) request.destroy();
            else chunks.push(b);
          });
          response.on("end", () => {
            try {
              if (response.statusCode !== 200)
                throw Error("Local Jenkins HTTP " + response.statusCode);
              resolve({
                version: String(response.headers["x-jenkins"] ?? "unknown"),
                data: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch {
              reject(Error("Local Jenkins API response failed validation"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () =>
        reject(Error("Local Jenkins connection failed")),
      );
    },
  );
}
export function runLocalAdapter(config: string) {
  const credentials = localCredentials();
  const result = spawnSync(
    process.execPath,
    ["src-ts/cli.ts", "run", "--config", path.resolve(config), "--once"],
    { cwd: repository, env: credentials.environment, stdio: "inherit" },
  );
  if (result.error) throw Error("Could not start the adapter");
  return result.status ?? 2;
}
async function main() {
  const command = process.argv[2];
  if (command === "up") {
    execFileSync("ctxcheck", { cwd: repository, stdio: "inherit" });
    execFileSync("git", ["status", "--short"], {
      cwd: repository,
      stdio: "inherit",
    });
    execFileSync("docker", [...compose, "up", "-d"], {
      cwd: repository,
      stdio: "inherit",
    });
    const until = Date.now() + 120000;
    while (true) {
      try {
        await localApi("/whoAmI/api/json", localCredentials());
        break;
      } catch {
        if (Date.now() > until)
          throw Error(
            "Jenkins startup timed out; inspect the local service logs",
          );
        await delay(1000);
      }
    }
  } else if (command === "down") {
    execFileSync("docker", [...compose, "down"], {
      cwd: repository,
      stdio: "inherit",
    });
    console.log("Local Jenkins stopped; its named state volume is retained.");
    return;
  } else if (command === "run" && process.argv[3]) {
    process.exitCode = runLocalAdapter(process.argv[3]);
    return;
  } else if (command !== "status") {
    console.log(
      "Usage: node scripts/local-jenkins.ts up|status|down|run CONFIG",
    );
    process.exitCode = 2;
    return;
  }
  const credentials = localCredentials();
  const user = await localApi("/whoAmI/api/json", credentials);
  const job = await localApi("/job/adapter-smoke/api/json", credentials);
  console.log(
    JSON.stringify(
      {
        endpoint: localEndpoint,
        version: user.version,
        authenticated: user.data.authenticated,
        user: user.data.name,
        job: job.data.url,
        last_build: job.data.lastBuild,
        credential_storage: "container tmpfs; passed to adapter in memory",
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "Local Jenkins operation failed; check Docker service status and logs. Credentials were not printed.",
    );
    process.exitCode = 2;
  });
