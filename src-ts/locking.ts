import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "./configuration.ts";

export async function lockedCommand(
  files: string[],
  command: string,
  args: string[],
) {
  const locks = [...new Set(files.map(canonicalPath))].sort();
  for (const file of locks)
    fs.mkdirSync(path.dirname(file), { recursive: true });
  const invocation = [
    ...locks.flatMap((file) => [
      "flock",
      "--nonblock",
      "--no-fork",
      file + ".watch.lock",
    ]),
    process.execPath,
    ...process.execArgv,
    fileURLToPath(new URL("./cli.ts", import.meta.url)),
    command,
    ...args,
    "--locked",
  ];
  return new Promise<number>((resolve, reject) => {
    const child = spawn(invocation[0], invocation.slice(1), {
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT"),
      terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      resolve(code ?? 130);
    });
  });
}
