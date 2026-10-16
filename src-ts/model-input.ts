import * as fs from "node:fs";
import * as path from "node:path";
import {
  Branch,
  canonicalJson,
  checkedDigest,
  checkedId,
  digest,
} from "./contracts.ts";
import { Flexo } from "./flexo.ts";
import { parse, subjects, objects, RDF } from "./rdf.ts";
import { requireFields, type RecordData } from "./workspace.ts";
const NS = "urn:flexo-change-adapter:source:";
export const MAX_INPUT_BYTES = 1024 * 1024,
  MAX_INPUT_FILES = 128;
export function modelPath(p: unknown): string {
  if (
    typeof p !== "string" ||
    p.length > 240 ||
    !p
      .split("/")
      .every(
        (s) =>
          /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s) && s !== "." && s !== "..",
      ) ||
    !/^models\/.+\.(sysml|kerml)$/.test(p)
  )
    throw Error("Unsafe model path");
  return p;
}
function artifact(source: Branch, uri: string) {
  const prefix = source.repository_uri + "/artifacts/";
  if (typeof uri !== "string" || !uri.startsWith(prefix))
    throw Error("Foreign source artifact");
  checkedId(uri.slice(prefix.length));
  return uri;
}
function binding(graph: Buffer, source: Branch) {
  const g = parse(graph),
    roots = subjects(g, RDF + "type", NS + "TextBundle");
  if (roots.length !== 1)
    throw Error("Exactly one TextBundle binding required");
  const a = objects(g, roots[0], NS + "manifest"),
    d = objects(g, roots[0], NS + "sha256");
  if (
    a.length !== 1 ||
    a[0].termType !== "NamedNode" ||
    d.length !== 1 ||
    d[0].termType !== "Literal"
  )
    throw Error("Invalid text manifest binding");
  return {
    manifest_uri: artifact(source, a[0].value),
    manifest_sha256: checkedDigest(d[0].value),
  };
}
export function checkManifest(v: RecordData, source: Branch) {
  requireFields(v, ["format", "entrypoints", "files"]);
  if (
    v.format !== "local-sysml-text-bundle-v1" ||
    !Array.isArray(v.files) ||
    !v.files.length ||
    v.files.length > MAX_INPUT_FILES ||
    !Array.isArray(v.entrypoints) ||
    !v.entrypoints.length
  )
    throw Error("Invalid source manifest");
  const names = new Set<string>();
  let total = 0;
  for (const f of v.files) {
    requireFields(f, ["path", "role", "size", "sha256", "artifact"]);
    modelPath(f.path);
    artifact(source, f.artifact);
    checkedDigest(f.sha256);
    if (
      !["model", "dependency"].includes(f.role) ||
      names.has(f.path) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0
    )
      throw Error("Invalid source file record");
    names.add(f.path);
    total += f.size;
  }
  if (
    total > MAX_INPUT_BYTES ||
    new Set(v.entrypoints).size !== v.entrypoints.length ||
    v.entrypoints.some((p: unknown) => !names.has(modelPath(p)))
  )
    throw Error("Invalid or oversized source manifest");
  return v;
}
export type ModelBundle = {
  schema_version: 1;
  source: RecordData;
  commit_uri: string;
  lock_uri: string;
  lock_etag: string;
  graph_base64: string;
  manifest_base64: string;
  files: Record<string, string>;
};
export function checkModelBundle(
  bundle: ModelBundle,
  source: Branch,
  commit: string,
) {
  requireFields(bundle, [
    "schema_version",
    "source",
    "commit_uri",
    "lock_uri",
    "lock_etag",
    "graph_base64",
    "manifest_base64",
    "files",
  ]);
  if (
    bundle.schema_version !== 1 ||
    bundle.commit_uri !== source.checkCommit(commit) ||
    canonicalJson(bundle.source) !== canonicalJson(source.toDict())
  )
    throw Error("Bundle revision differs");
  if (!bundle.lock_uri.startsWith(source.repository_uri + "/locks/"))
    throw Error("Foreign bundle lock");
  checkedId(bundle.lock_uri.slice((source.repository_uri + "/locks/").length));
  if (
    typeof bundle.lock_etag !== "string" ||
    !bundle.lock_etag ||
    bundle.lock_etag.startsWith("W/") ||
    /[\r\n]/.test(bundle.lock_etag)
  )
    throw Error("Invalid bundle ETag");
  const decode = (v: string) => {
    if (typeof v !== "string" || v.length > MAX_INPUT_BYTES * 4)
      throw Error("Oversized encoded source");
    const raw = Buffer.from(v, "base64");
    if (raw.toString("base64") !== v) throw Error("Invalid source encoding");
    return raw;
  };
  const graph = decode(bundle.graph_base64),
    ref = binding(graph, source),
    raw = decode(bundle.manifest_base64);
  if (digest(raw) !== ref.manifest_sha256)
    throw Error("Manifest digest differs");
  const manifest = checkManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    source,
  );
  requireFields(
    bundle.files,
    manifest.files.map((f: RecordData) => f.path),
  );
  for (const f of manifest.files) {
    const bytes = decode(bundle.files[f.path]);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length !== f.size || digest(bytes) !== f.sha256)
      throw Error("Source file digest differs");
  }
  return {
    manifest,
    content_sha256: digest(
      canonicalJson({
        entrypoints: manifest.entrypoints,
        files: manifest.files
          .map(({ path, role, size, sha256 }: RecordData) => ({
            path,
            role,
            size,
            sha256,
          }))
          .sort((a: RecordData, b: RecordData) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          ),
      }),
    ),
  };
}
export async function readLimited(response: Response, max = MAX_INPUT_BYTES) {
  if (!response.body) throw Error("Missing source body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw Error("Source body too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function captureModelBundle(
  flexo: Flexo,
  source: Branch,
  commit: string,
  allowCreate = false,
): Promise<ModelBundle> {
  const id = digest(
    canonicalJson({
      source: source.toDict(),
      commit,
      provider: "flexo-text-manifest-v1",
    }),
  );
  const pinned = await flexo.pinnedGraph(
      source,
      commit,
      "text-" + id,
      allowCreate,
    ),
    ref = binding(pinned.model, source);
  const raw = await readLimited(
    await flexo.request("GET", ref.manifest_uri, [200], undefined, {
      Accept: "application/json",
    }),
  );
  if (digest(raw) !== ref.manifest_sha256)
    throw Error("Manifest digest differs");
  const manifest = checkManifest(JSON.parse(raw.toString("utf8")), source),
    files: Record<string, string> = {};
  for (const f of manifest.files)
    files[f.path] = (
      await readLimited(
        await flexo.request(
          "GET",
          artifact(source, f.artifact),
          [200],
          undefined,
          { Accept: "application/octet-stream" },
        ),
      )
    ).toString("base64");
  const bundle: ModelBundle = {
    schema_version: 1,
    source: source.toDict(),
    commit_uri: commit,
    lock_uri: pinned.lock_uri,
    lock_etag: pinned.lock_etag,
    graph_base64: pinned.model.toString("base64"),
    manifest_base64: raw.toString("base64"),
    files,
  };
  checkModelBundle(bundle, source, commit);
  return bundle;
}
export async function retainedModelBundle(
  directory: string,
  source: Branch,
  commit: string,
  prepare: () => Promise<ModelBundle>,
) {
  const key = digest(
      canonicalJson({
        source: source.toDict(),
        commit,
        provider: "flexo-text-manifest-v1",
      }),
    ),
    file = path.join(directory, key + ".json");
  if (fs.existsSync(file)) {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    checkModelBundle(b, source, commit);
    return b as ModelBundle;
  }
  const b = await prepare();
  checkModelBundle(b, source, commit);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(directory, ".input-"));
  try {
    const p = path.join(tmp, "bundle.json"),
      fd = fs.openSync(p, "wx", 0o600);
    try {
      fs.writeFileSync(fd, canonicalJson(b));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // link is create-only: competing preparations may never replace a retained capture.
    try {
      fs.linkSync(p, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const fd2 = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd2);
    } finally {
      fs.closeSync(fd2);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const retained = JSON.parse(fs.readFileSync(file, "utf8"));
  checkModelBundle(retained, source, commit);
  if (canonicalJson(retained) !== canonicalJson(b))
    throw Error("Conflicting source captures");
  return retained as ModelBundle;
}
