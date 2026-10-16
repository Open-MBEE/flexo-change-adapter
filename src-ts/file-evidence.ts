import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, checkedDigest, digest } from "./contracts.ts";
import type { RecordData } from "./workspace.ts";
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
// Requires one shared POSIX filesystem with atomic hard links and durable fsync.
// A completed record is published create-only; an interrupted temporary file is never a claim.
export class FileEvidence {
  readonly root: string;
  readonly scope: string;
  constructor(directory: string, scope: string) {
    checkedDigest(scope);
    this.scope = scope;
    this.root = path.resolve(directory, scope);
  }
  file(kind: string, id: string) {
    if (!["input", "claim", "result"].includes(kind))
      throw Error("Invalid evidence kind");
    return path.join(this.root, kind, checkedDigest(id) + ".json");
  }
  read(kind: string, id: string): RecordData | null {
    const file = this.file(kind, id);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES)
      throw Error("Invalid evidence record");
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_RECORD_BYTES)
      throw Error("Oversized evidence record");
    const record = JSON.parse(bytes.toString("utf8"));
    if (canonicalJson(record) !== bytes.toString())
      throw Error("Noncanonical evidence record");
    return record;
  }
  create(kind: string, id: string, record: RecordData) {
    const file = this.file(kind, id),
      bytes = Buffer.from(canonicalJson(record));
    if (bytes.length > MAX_RECORD_BYTES)
      throw Error("Evidence record too large");
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = fs.mkdtempSync(path.join(directory, ".pending-"));
    try {
      const tmp = path.join(temporary, "record"),
        fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      let created = true;
      try {
        fs.linkSync(tmp, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        created = false;
      }
      const parent = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
      return { created, record: this.read(kind, id)! };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
export function encodeFiles(files: Record<string, Buffer>) {
  if (Object.values(files).reduce((n, b) => n + b.length, 0) > 4 * 1024 * 1024)
    throw Error("Oversized validation bundle");
  return Object.fromEntries(
    Object.entries(files).map(([n, b]) => [n, b.toString("base64")]),
  );
}
export function decodeFiles(value: RecordData) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 10
  )
    throw Error("Invalid file record");
  const files: Record<string, Buffer> = {};
  let total = 0;
  for (const [name, encoded] of Object.entries(value)) {
    if (
      !/^[a-z][a-z-]*\.(json|ttl|txt)$/.test(name) ||
      typeof encoded !== "string"
    )
      throw Error("Invalid retained file");
    const raw = Buffer.from(encoded, "base64");
    total += raw.length;
    if (raw.toString("base64") !== encoded || total > 4 * 1024 * 1024)
      throw Error("Invalid or oversized retained file");
    files[name] = raw;
  }
  return files;
}
