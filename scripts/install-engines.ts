// Provision only the two reviewed profiles; no global installation or model-supplied URLs.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Branch, digest } from "../src-ts/contracts.ts";
import {
  EngineRequest,
  engineProfile,
  engineRuntimeDigest,
} from "../src-ts/engine-contracts.ts";
import {
  verifyEngineInstallation,
  runProcess,
  ENGINE_IMAGE,
  dockerEnvironment,
} from "../src-ts/engine-execution.ts";
const assets = [
  {
    url: "https://github.com/Open-MBEE/OpenSysML/releases/download/v0.10.1/sysml-linux-amd64.tar.gz",
    sha: "922838f24c1857709bd8b563bb1f4290a81b7f5c7cae1ada22d1134cd8f61fc5",
    name: "open.tar.gz",
    member: "sysml-linux-amd64",
    binary: "sysml",
  },
  {
    url: "https://github.com/Open-MBEE/sysml-toolkit/releases/download/v0.10.2/sysmlv2-0.10.2-x86_64-unknown-linux-musl.tar.gz",
    sha: "9fb70d287b8c1c604f226f66d16995d06b7f34b1f6a8a0658512ac7ca9f93501",
    name: "toolkit.tar.gz",
    member: "sysmlv2-0.10.2-x86_64-unknown-linux-musl/sysmlv2",
    binary: "sysmlv2",
  },
  {
    url: "https://codeload.github.com/Systems-Modeling/SysML-v2-Release/tar.gz/de1070ae8e79c21532b8004fc663d47b35d0e9fa",
    sha: "f9936644cbe15f93ed6204d5bcaf33103bc4c57592e1e3841e961583e1efdb5c",
    name: "library.tar.gz",
    member:
      "SysML-v2-Release-de1070ae8e79c21532b8004fc663d47b35d0e9fa/sysml.library",
    binary: null,
  },
];
function verify(directory: string) {
  const source = new Branch("https://fixture.example", "test", "test", "main");
  for (const id of ["opensysml", "sysml-toolkit"])
    verifyEngineInstallation(
      new EngineRequest(
        source,
        source.repository_uri + "/commits/check",
        digest("input"),
        engineProfile(id),
        engineRuntimeDigest(),
      ),
      directory,
    );
}
export async function installEngines(directory: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw Error("Reviewed profiles require Linux x64 and Docker");
  const dest = path.resolve(directory);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(dest), ".engine-install-"));
  const env = dockerEnvironment(os.tmpdir());
  const command = async (cmd: string, args: string[]) => {
    const r = await runProcess(cmd, args, {
      timeout_ms: 180000,
      max_output_bytes: 65536,
      env,
    });
    if (r.exit !== 0 || r.timeout || r.truncated)
      throw Error("Engine provisioning command failed");
  };
  try {
    if (fs.existsSync(dest)) verify(dest);
    else {
      const extract = path.join(tmp, "extracted");
      fs.mkdirSync(extract);
      for (const a of assets) {
        const r = await fetch(a.url, { signal: AbortSignal.timeout(180000) });
        if (!r.ok || !r.body) throw Error("Engine download failed");
        const fd = fs.openSync(path.join(tmp, a.name), "wx", 0o600);
        let size = 0;
        try {
          for await (const bytes of r.body) {
            size += bytes.length;
            if (size > 150 * 1024 * 1024)
              throw Error("Oversized release asset");
            fs.writeSync(fd, bytes);
          }
        } finally {
          fs.closeSync(fd);
        }
        if (digest(fs.readFileSync(path.join(tmp, a.name))) !== a.sha)
          throw Error("Release checksum differs");
        await command("tar", [
          "-xzf",
          path.join(tmp, a.name),
          "-C",
          extract,
          "--no-same-owner",
          "--no-same-permissions",
          a.member,
        ]);
        if (a.binary) {
          fs.copyFileSync(
            path.join(extract, a.member),
            path.join(extract, a.binary),
          );
          fs.chmodSync(path.join(extract, a.binary), 0o555);
          fs.rmSync(path.join(extract, a.member), { force: true });
        } else
          fs.renameSync(
            path.join(extract, a.member),
            path.join(extract, "sysml.library"),
          );
      }
      // Only reviewed binaries and the verified library enter the installed profile.
      const ready = path.join(tmp, "ready");
      fs.mkdirSync(ready);
      for (const n of ["sysml", "sysmlv2", "sysml.library"])
        fs.renameSync(path.join(extract, n), path.join(ready, n));
      verify(ready);
      fs.renameSync(ready, dest);
    }
    await command("docker", ["pull", ENGINE_IMAGE]);
    console.log(
      JSON.stringify({
        event: "engine-profiles-installed",
        directory: dest,
        engines: ["opensysml@0.10.1", "sysml-toolkit@0.10.2"],
        image: ENGINE_IMAGE,
      }),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--directory")
    throw Error("Usage: node scripts/install-engines.ts --directory PATH");
  await installEngines(process.argv[3]);
}
