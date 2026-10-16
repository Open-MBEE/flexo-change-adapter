import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export type RecordData = Record<string, any>;
export const now = () => new Date().toISOString();
export const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const compare = (a: string, b: string) => {
  const x = Array.from(a, (c) => c.codePointAt(0)!),
    y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
// A versioned TypeScript codec. Original Python JSON must never be reserialized to establish its identity.
export function canonical(value: unknown, indent = 2, ascii = false): Buffer {
  const quote = (s: string) => {
    const q = JSON.stringify(s);
    return ascii
      ? q.replace(
          /[\u007f-\uffff]/g,
          (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
        )
      : q;
  };
  function encode(v: any, depth: number): string {
    if (v === null) return "null";
    if (typeof v === "string") return quote(v);
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number") {
      if (
        !Number.isFinite(v) ||
        (!Number.isSafeInteger(v) && Number.isInteger(v))
      )
        throw Error("Number outside evidence codec contract");
      return JSON.stringify(v);
    }
    const isArray = Array.isArray(v);
    if (!isArray && (typeof v !== "object" || v === undefined))
      throw Error("Unsupported JSON value");
    const keys = isArray
      ? v.map((_: unknown, i: number) => i)
      : Object.keys(v).sort(compare);
    const parts = keys.map(
      (k: string | number) =>
        (isArray ? "" : quote(String(k)) + ":" + (indent ? " " : "")) +
        encode(v[k], depth + 1),
    );
    const [start, end] = isArray ? ["[", "]"] : ["{", "}"];
    return !parts.length
      ? start + end
      : indent
        ? start +
          "\n" +
          " ".repeat((depth + 1) * indent) +
          parts.join(",\n" + " ".repeat((depth + 1) * indent)) +
          "\n" +
          " ".repeat(depth * indent) +
          end
        : start + parts.join(",") + end;
  }
  return Buffer.from(encode(value, 0) + (indent ? "\n" : ""));
}
export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), ".pending-" + randomUUID());
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, canonical(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export const readJson = (file: string): RecordData =>
  JSON.parse(fs.readFileSync(file, "utf8"));
export function safeId(value: string) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    throw Error("Invalid identifier");
  return value;
}
export function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(root, e.name);
      if (e.isSymbolicLink()) throw Error("Evidence cannot contain symlinks");
      return e.isDirectory() ? files(p) : e.isFile() ? [p] : [];
    })
    .sort(compare);
}
export function verifyBundle(directory: string) {
  const root = fs.realpathSync(directory),
    manifest = readJson(path.join(root, "manifest.json"));
  if (!Array.isArray(manifest.files)) throw Error("Invalid evidence inventory");
  const expected = manifest.files.map((i: RecordData) => i.path),
    actual = files(root)
      .filter((p) => p !== path.join(root, "manifest.json"))
      .map((p) => path.relative(root, p).split(path.sep).join("/"));
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify([...expected].sort()) !== JSON.stringify(actual.sort())
  )
    throw Error("Evidence inventory differs from bundle contents");
  for (const item of manifest.files) {
    if (
      typeof item.path !== "string" ||
      item.path.startsWith("/") ||
      item.path.split("/").includes("..")
    )
      throw Error("Evidence path escapes bundle");
    const file = fs.realpathSync(path.join(root, item.path));
    if (!file.startsWith(root + path.sep))
      throw Error("Evidence path escapes bundle");
    const data = fs.readFileSync(file);
    if (data.length !== item.bytes || digest(data) !== item.sha256)
      throw Error("Evidence checksum mismatch: " + item.path);
  }
  return {
    verified: true,
    files: actual.length,
    manifest_sha256: digest(fs.readFileSync(path.join(root, "manifest.json"))),
  };
}
export function sealBundle(root: string) {
  writeJson(path.join(root, "manifest.json"), {
    schema_version: 1,
    files: files(root)
      .filter((p) => p !== path.join(root, "manifest.json"))
      .map((p) => {
        const b = fs.readFileSync(p);
        return {
          path: path.relative(root, p).split(path.sep).join("/"),
          bytes: b.length,
          sha256: digest(b),
        };
      }),
  });
}
export class Workspace {
  readonly path: string;
  constructor(directory: string) {
    this.path = path.resolve(directory);
  }
  init() {
    for (const kind of [
      "cases",
      "validations",
      "runs",
      "submissions",
      "reviews",
      "imports",
      "libraries",
      "toolchains",
    ])
      fs.mkdirSync(path.join(this.path, kind), { recursive: true });
    const c = path.join(this.path, "workspace.json");
    if (!fs.existsSync(c))
      writeJson(c, { schema_version: 1, created_at: now() });
    return { workspace: this.path, schema_version: 1 };
  }
  recordPath(kind: string, id: string) {
    return path.join(this.path, safeId(kind), safeId(id), "record.json");
  }
  get(kind: string, id: string) {
    return readJson(this.recordPath(kind, id));
  }
  list(kind: string) {
    const root = path.join(this.path, safeId(kind));
    return fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .sort()
          .filter(
            (d) =>
              !d.startsWith(".") &&
              fs.existsSync(path.join(root, d, "record.json")),
          )
          .map((d) => this.get(kind, d))
      : [];
  }
}
export function installBundle(
  output: string,
  build: (temporary: string) => void,
) {
  if (fs.existsSync(output))
    throw Error("Output already exists; retained evidence is immutable");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(output), ".bundle-"));
  try {
    build(tmp);
    sealBundle(tmp);
    verifyBundle(tmp);
    fs.renameSync(tmp, output);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export function copyBundle(source: string, output: string) {
  const before = verifyBundle(source);
  installBundle(output, (tmp) => {
    fs.cpSync(source, tmp, { recursive: true });
    if (verifyBundle(tmp).manifest_sha256 !== before.manifest_sha256)
      throw Error("Evidence changed while copying");
  });
  return before;
}
export function requireFields(value: RecordData, keys: string[]) {
  if (
    !value ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  )
    throw Error("Missing or unexpected declaration fields");
}
export function nonempty(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string" || !v.trim())
    throw Error("Nonempty " + label + " required");
}
export function timestamp(v: string) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)))
    throw Error("Timestamp must be ISO 8601 with timezone");
  return Date.parse(v);
}
