import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, digest } from "./contracts.ts";
import { files } from "./workspace.ts";
export function runtimeIdentity() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return {
    source_sha256: digest(
      canonicalJson(
        Object.fromEntries(
          files(path.join(root, "src-ts"))
            .filter((p) => /\.(ts|ttl)$/.test(p))
            .map((p) => [path.relative(root, p), digest(fs.readFileSync(p))]),
        ),
      ),
    ),
    lock_sha256: digest(fs.readFileSync(path.join(root, "package-lock.json"))),
    node: process.version,
    evidence_codec: "adapter-compact-ascii-v1",
  };
}
