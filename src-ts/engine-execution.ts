import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJson, digest } from "./contracts.ts";
import { files, type RecordData } from "./workspace.ts";
import {
  EngineRequest,
  engineRuntimeDigest,
  checkEngineReport,
  type Diagnostic,
  type EngineReport,
} from "./engine-contracts.ts";
import { checkModelBundle, type ModelBundle } from "./model-input.ts";
export const ENGINE_IMAGE =
  "alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
export type ProcessEvidence = {
  exit: number | null;
  signal: string | null;
  timeout: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  stdout_base64: string;
  stderr_base64: string;
  started_at: string;
  finished_at: string;
  argv: string[];
};
export type ProcessRunner = (
  command: string,
  args: string[],
  options: {
    timeout_ms: number;
    max_output_bytes: number;
    env: NodeJS.ProcessEnv;
    cleanup?: () => Promise<void>;
  },
) => Promise<ProcessEvidence>;
// No shell; stop the entire process group and the container before returning.
export const runProcess: ProcessRunner = async (command, args, options) => {
  const started_at = new Date().toISOString();
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    timeout = false,
    truncated = false;
  const child = spawn(command, args, {
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(() => {
    timeout = true;
    kill();
  }, options.timeout_ms);
  const append = (which: "stdout" | "stderr", chunk: Buffer) => {
    const current = which === "stdout" ? stdout : stderr,
      remaining = Math.max(
        0,
        options.max_output_bytes - stdout.length - stderr.length,
      );
    const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
    if (which === "stdout") stdout = next;
    else stderr = next;
    if (chunk.length > remaining) {
      truncated = true;
      kill();
    }
  };
  child.stdout.on("data", (b) => append("stdout", b));
  child.stderr.on("data", (b) => append("stderr", b));
  try {
    return await new Promise<ProcessEvidence>((resolve) => {
      let settled = false;
      const finish = (exit: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exit,
          signal,
          timeout,
          truncated,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdout_base64: stdout.toString("base64"),
          stderr_base64: stderr.toString("base64"),
          started_at,
          finished_at: new Date().toISOString(),
          argv: [command, ...args],
        });
      };
      child.on("error", () => finish(null, "spawn-error"));
      child.on("close", (code, signal) => finish(code, signal));
    });
  } finally {
    clearTimeout(timer);
    await options.cleanup?.();
  }
};
export function unavailable(
  code: string,
  execution: EngineReport["execution"] = "error",
): EngineReport {
  return {
    execution,
    verdict: "inconclusive",
    checks: [
      { check: "syntax", completed: false, reason: code },
      { check: "semantic", completed: false, reason: code },
    ],
    diagnostics: [],
    error_code: code,
  };
}
function location(v: unknown) {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    throw Error("Invalid native location");
  return Number(v);
}
function modelFile(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !v.startsWith("/bundle/models/"))
    throw Error("Foreign diagnostic path");
  return v.slice("/bundle/".length);
}
export function decodeEngine(
  request: EngineRequest,
  p: ProcessEvidence,
): EngineReport {
  if (p.timeout) return unavailable("engine-timeout", "timeout");
  if (p.truncated) return unavailable("output-limit");
  if (p.signal || p.exit === null) return unavailable("engine-process-error");
  try {
    for (const stream of ["stdout", "stderr"] as const) {
      const raw = Buffer.from(
        p[(stream + "_base64") as "stdout_base64" | "stderr_base64"],
        "base64",
      );
      if (
        raw.toString("base64") !==
          p[(stream + "_base64") as "stdout_base64" | "stderr_base64"] ||
        new TextDecoder("utf-8", { fatal: true }).decode(raw) !== p[stream]
      )
        throw Error("Invalid native output encoding");
    }
    const native = JSON.parse(p.stdout);
    let diagnostics: Diagnostic[] = [],
      syntaxFailure = false,
      failed = false;
    if (request.profile.engine === "opensysml") {
      if (
        !native ||
        !["holds", "unresolved", "violated"].includes(native.status) ||
        native.exit !== p.exit ||
        ![0, 1, 2].includes(p.exit) ||
        !["checks", "diagnostics", "output", "errors"].every(
          (k) => native[k] === null || Array.isArray(native[k]),
        )
      )
        throw Error("Invalid OpenSysML report");
      if (
        (native.output ?? []).some((v: unknown) => typeof v !== "string") ||
        (native.errors ?? []).some((v: unknown) => typeof v !== "string") ||
        (native.checks ?? []).length
      )
        throw Error("Invalid bare-validation report");
      if (native.exit === 0 && native.status !== "holds")
        throw Error("Inconsistent native status");
      diagnostics = (native.diagnostics ?? []).map((d: RecordData) => {
        if (
          !["error", "warning", "info", "hint"].includes(d.severity) ||
          typeof d.message !== "string" ||
          typeof d.pass !== "string" ||
          typeof d.code !== "string"
        )
          throw Error("Invalid native diagnostic");
        return {
          severity: d.severity,
          native_severity: d.severity,
          code: d.code,
          file: modelFile(d.file),
          line: location(d.line),
          column: location(d.column),
          position_encoding: "native-one-based-column",
          message: d.message,
          stage: d.pass,
        };
      });
      syntaxFailure = diagnostics.some(
        (d) => d.stage === "syntax" && d.severity === "error",
      );
      failed = diagnostics.some((d) => d.severity === "error");
      if (p.exit !== 0 && !failed)
        return unavailable("native-analysis-incomplete");
      if (p.exit === 0 && (failed || (native.errors ?? []).length))
        throw Error("Inconsistent successful report");
    } else {
      if (
        !native ||
        !Array.isArray(native.findings) ||
        !native.summary ||
        ![0, 1].includes(p.exit)
      )
        throw Error("Invalid Toolkit report");
      const counts = { errors: 0, warnings: 0, infos: 0, hints: 0 };
      diagnostics = native.findings.map((d: RecordData) => {
        const severity = (
          {
            error: "error",
            warn: "warning",
            info: "info",
            hint: "hint",
          } as const
        )[d.severity as "error"];
        if (
          !severity ||
          !["parse", "context", "referential", "semantic"].includes(d.stage) ||
          typeof d.message !== "string" ||
          (d.rule !== null && typeof d.rule !== "string")
        )
          throw Error("Invalid native finding");
        const count = (
          {
            error: "errors",
            warning: "warnings",
            info: "infos",
            hint: "hints",
          } as const
        )[severity];
        counts[count]++;
        return {
          severity,
          native_severity: d.severity,
          code: d.rule,
          file: modelFile(d.unitName),
          line: location(d.line),
          column: location(d.col),
          position_encoding: "utf8-byte-column",
          message: d.message,
          stage: d.stage,
        };
      });
      if (canonicalJson(counts) !== canonicalJson(native.summary))
        throw Error("Native counts differ");
      syntaxFailure = diagnostics.some(
        (d) => ["parse", "context"].includes(d.stage) && d.severity === "error",
      );
      failed = diagnostics.some((d) =>
        ["error", "warning"].includes(d.severity),
      );
      if (p.exit !== (failed ? 1 : 0)) throw Error("Native exit differs");
    }
    const r: EngineReport = {
      execution: "completed",
      verdict: failed ? "fail" : "pass",
      checks: [
        { check: "syntax", completed: true, reason: null },
        {
          check: "semantic",
          completed: !syntaxFailure,
          reason: syntaxFailure ? "syntax-prevented-semantic-analysis" : null,
        },
      ],
      diagnostics,
      error_code: null,
    };
    checkEngineReport(r);
    return r;
  } catch {
    return unavailable("invalid-or-missing-native-report");
  }
}
export function verifyEngineInstallation(
  request: EngineRequest,
  directory: string,
) {
  const root = fs.realpathSync(directory),
    profile = request.profile,
    binary = path.join(
      root,
      profile.engine === "opensysml" ? "sysml" : "sysmlv2",
    );
  if (
    fs.lstatSync(binary).isSymbolicLink() ||
    digest(fs.readFileSync(binary)) !== profile.binary_sha256
  )
    throw Error("Engine binary digest differs");
  const library = path.join(root, "sysml.library");
  if (profile.engine === "sysml-toolkit") {
    const inventory = Object.fromEntries(
      files(library).map((p) => [
        path.relative(library, p).split(path.sep).join("/"),
        digest(fs.readFileSync(p)),
      ]),
    );
    if (
      !Object.keys(inventory).length ||
      digest(canonicalJson(inventory)) !== profile.library_sha256
    )
      throw Error("Engine library digest differs");
  }
  return { root, binary, library };
}
export async function executeEngine(
  request: EngineRequest,
  bundle: ModelBundle,
  directory: string,
  runner: ProcessRunner = runProcess,
) {
  const input = checkModelBundle(bundle, request.source, request.commit_uri);
  if (digest(canonicalJson(bundle)) !== request.input_sha256)
    throw Error("Engine input differs");
  if (engineRuntimeDigest() !== request.validator_sha256)
    throw Error("Queued engine wrapper unavailable");
  let process: ProcessEvidence | null = null,
    report: EngineReport;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flexo-engine-"));
  try {
    try {
      const install = verifyEngineInstallation(request, directory);
      for (const [name, value] of Object.entries(bundle.files)) {
        const file = path.join(tmp, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(value, "base64"), { mode: 0o444 });
      }
      // /bundle contains only model files; no source credentials or GitHub token enter the container.
      fs.chmodSync(tmp, 0o755);
      const name = "flexo-engine-" + randomUUID(),
        open = request.profile.engine === "opensysml";
      const args = [
        "run",
        "--rm",
        "--pull",
        "never",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "-v",
        tmp + ":/bundle:ro",
        "-v",
        install.root + ":/engines:ro",
        "-e",
        "HOME=/tmp",
      ];
      if (open) args.push("-e", "OPENSYSML_RECORD_CACHE=0");
      else
        args.push("-e", "SYSMLV2_AMBIENT=off", "-e", "SYSMLV2_LIB_CACHE=off");
      args.push(
        "--entrypoint",
        open ? "/engines/sysml" : "/engines/sysmlv2",
        ENGINE_IMAGE,
        ...(open
          ? ["-validate", "-strict", "-json", "-no-record-cache", "-jobs", "1"]
          : [
              "check",
              "--strict",
              "--format",
              "json",
              "--lib",
              "/engines/sysml.library",
            ]),
        ...input.manifest.files
          .map((f: RecordData) => "/bundle/" + f.path)
          .sort(),
      );
      const env = dockerEnvironment(tmp);
      process = await runner("docker", args, {
        timeout_ms: request.profile.timeout_seconds * 1000,
        max_output_bytes: request.profile.max_output_bytes,
        env,
        cleanup: async () => {
          await runProcess("docker", ["rm", "-f", name], {
            timeout_ms: 10000,
            max_output_bytes: 4096,
            env,
          });
        },
      });
      report = decodeEngine(request, process);
    } catch {
      report = unavailable("engine-installation-or-execution-error");
    }
    return {
      schema_version: 1,
      request: request.toDict(),
      input_content_sha256: input.content_sha256,
      profile: request.profile,
      process,
      report,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export function dockerEnvironment(home: string): NodeJS.ProcessEnv {
  const host = process.env.DOCKER_HOST;
  if (host !== undefined && !/^unix:\/\/\/[^\r\n\0]+$/.test(host))
    throw Error("Engine Docker host must be a local Unix socket");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    ...(host ? { DOCKER_HOST: host } : {}),
  };
}
