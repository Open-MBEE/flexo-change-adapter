import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { Branch, ValidationRequest, digest } from "./contracts.ts";
import { readJson, canonical, type RecordData } from "./workspace.ts";
import { loadConfiguration, ConfigurationError } from "./configuration.ts";
import { lockedCommand } from "./locking.ts";
const emit = (v: unknown) => console.log(JSON.stringify(v, null, 2));
export function options(args: string[]) {
  const result: RecordData = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw Error("Unexpected positional argument");
    const key = a.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(result, key)) throw Error("Duplicate option");
    result[key] =
      args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  return result;
}
const need = (o: RecordData, k: string): string => {
  if (typeof o[k] !== "string" || !o[k])
    throw Error("Missing --" + k.replaceAll("_", "-"));
  return o[k];
};
const source = (o: RecordData) =>
  new Branch(
    need(o, "base_url"),
    need(o, "organization"),
    need(o, "repository"),
    need(o, "branch"),
  );
const branchOptions = ["base-url", "organization", "repository", "branch"];
const ruleOptions = ["rule", "rule-version"];
const commandOptions: Record<string, string[]> = {
  status: ["config"],
  check: ["config"],
  run: ["config", "once", "locked"],
  "validator-identity": [],
  "prepare-request": [...branchOptions, ...ruleOptions, "commit-uri", "output"],
  snapshot: ["request", "lock-id", "output"],
  validate: ["snapshot", "rule", "output", "external-id"],
};
export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args.shift();
  if (!command || command === "--help") {
    console.log(
      "Flexo adapter: check | run | status | validator-identity | prepare-request | snapshot | validate",
    );
    return 0;
  }
  if (!Object.hasOwn(commandOptions, command)) throw Error("Unknown command");
  if (args.includes("--help")) {
    console.log(
      "Usage: adapter " +
        command +
        " " +
        commandOptions[command]
          .filter((k) => k !== "locked")
          .map((k) => "[--" + k + (k === "once" ? "" : " VALUE") + "]")
          .join(" "),
    );
    return 0;
  }
  const o = options(args);
  for (const [key, v] of Object.entries(o)) {
    if (!commandOptions[command].includes(key.replaceAll("_", "-")))
      throw Error("Unknown option");
    if (["once", "locked"].includes(key) ? v !== true : typeof v !== "string")
      throw Error("Invalid option value");
  }
  if (["check", "run", "status"].includes(command)) {
    const configuration = loadConfiguration(
      need(o, "config"),
      command !== "status",
    );
    if (command === "check") {
      emit({ configuration: "valid", offline: true, schema_version: 1 });
      return 0;
    }
    if (command === "status") {
      const { retainedStatus } = await import("./runtime.ts");
      emit(await retainedStatus(configuration));
      return 0;
    }
    if (!o.locked)
      return lockedCommand(
        [
          configuration.database,
          path.join(configuration.state_directory, ".owner"),
          ...(configuration.feed ? [configuration.feed.path] : []),
        ],
        command,
        args,
      );
    const { runConfiguration } = await import("./runtime.ts");
    return runConfiguration(configuration, !!o.once);
  }
  if (command === "validator-identity") {
    const { validatorDigest, validatorIdentity } =
      await import("./validation.ts");
    emit({ sha256: validatorDigest(), identity: validatorIdentity() });
    return 0;
  }
  if (command === "prepare-request") {
    const { validatorDigest } = await import("./validation.ts");
    const r = new ValidationRequest(
        source(o),
        need(o, "commit_uri"),
        need(o, "rule_version"),
        digest(fs.readFileSync(need(o, "rule"))),
        validatorDigest(),
      ),
      out = need(o, "output");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, canonical(r.toDict()), { flag: "wx" });
    emit({ work_id: r.work_id, request_file: out });
    return 0;
  }
  if (command === "snapshot") {
    const { connectFlexo } = await import("./flexo.ts");
    const r = ValidationRequest.fromDict(readJson(need(o, "request"))),
      out = need(o, "output");
    if (fs.existsSync(out)) throw Error("Snapshot output exists");
    const s = await (
      await connectFlexo(r.source.base_url)
    ).snapshot(r, need(o, "lock_id"));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "model.ttl"), s.model);
    fs.writeFileSync(path.join(out, "snapshot.json"), canonical(s.metadata()), {
      flag: "wx",
    });
    emit({
      work_id: r.work_id,
      input_sha256: s.input_sha256,
      bytes: s.model.length,
      remote_writes: 0,
    });
    return 0;
  }
  if (command === "validate") {
    const { validateSnapshot } = await import("./validation.ts");
    const { Snapshot } = await import("./flexo.ts");
    const directory = need(o, "snapshot");
    const r = await validateSnapshot(
      Snapshot.fromFiles(
        Object.fromEntries(
          ["model.ttl", "snapshot.json"].map((name) => [
            name,
            fs.readFileSync(path.join(directory, name)),
          ]),
        ),
      ),
      fs.readFileSync(need(o, "rule")),
      need(o, "output"),
      o.external_id ?? "local-validation",
    );
    emit(r);
    return r.outcome === "conforming" ? 0 : 1;
  }
  throw Error("Unknown command");
}

if (process.argv[1] === fileURLToPath(new URL(import.meta.url))) {
  const task = Effect.tryPromise({
    try: () => main(),
    catch: (error) =>
      error instanceof ConfigurationError
        ? error
        : new Error("Adapter execution failed"),
  });
  const result = await Effect.runPromise(Effect.either(task));
  if (result._tag === "Left") {
    emit({
      outcome: "execution-error",
      error_type: "AdapterError",
      ...(result.left instanceof ConfigurationError
        ? { message: result.left.message }
        : {}),
    });
    process.exitCode = 2;
  } else process.exitCode = result.right;
}
