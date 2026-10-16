import { Branch, ValidationRequest, digest, checkedId } from "./contracts.ts";
import { canonical, requireFields, type RecordData } from "./workspace.ts";
import { parse, objects } from "./rdf.ts";
import { transport, type Transport } from "./transport.ts";
export { transport, type Transport } from "./transport.ts";
export const MMS = "https://mms.openmbee.org/rdf/ontology/";
export class FlexoError extends Error {}
export function commitBinding(raw: Uint8Array, uri: string, source: Branch) {
  try {
    const values = objects(parse(raw, uri), uri, MMS + "commit");
    if (values.length !== 1 || values[0].termType !== "NamedNode")
      throw Error();
    return source.checkCommit(values[0].value);
  } catch {
    throw new FlexoError("Invalid or foreign commit binding");
  }
}
export class Snapshot {
  readonly request: ValidationRequest;
  readonly lock_uri: string;
  readonly lock_etag: string;
  readonly model: Buffer;
  constructor(
    request: ValidationRequest,
    uri: string,
    etag: string,
    model: Uint8Array,
  ) {
    const prefix = request.source.repository_uri + "/locks/";
    if (!uri.startsWith(prefix)) throw Error("Foreign snapshot lock");
    checkedId(uri.slice(prefix.length));
    if (
      typeof etag !== "string" ||
      !etag.trim() ||
      etag.startsWith("W/") ||
      /[\r\n]/.test(etag)
    )
      throw Error("Strong lock ETag required");
    this.request = request;
    this.lock_uri = uri;
    this.lock_etag = etag;
    this.model = Buffer.from(model);
  }
  get input_sha256() {
    return digest(this.model);
  }
  metadata() {
    return {
      schema_version: 1,
      request: this.request.toDict(),
      lock_uri: this.lock_uri,
      lock_etag: this.lock_etag,
      input_sha256: this.input_sha256,
    };
  }
  static fromFiles(files: Record<string, Buffer>) {
    const m = JSON.parse(files["snapshot.json"].toString());
    requireFields(m, [
      "schema_version",
      "request",
      "lock_uri",
      "lock_etag",
      "input_sha256",
    ]);
    if (m.schema_version !== 1) throw Error("Invalid snapshot schema");
    const s = new Snapshot(
      ValidationRequest.fromDict(m.request),
      m.lock_uri,
      m.lock_etag,
      files["model.ttl"],
    );
    if (s.input_sha256 !== m.input_sha256)
      throw Error("Snapshot digest mismatch");
    return s;
  }
}
export class Flexo {
  readonly send: Transport;
  readonly headers: Record<string, string>;
  constructor(token: string, send: Transport = transport) {
    if (!token || token.startsWith("op://"))
      throw Error("Resolved in-memory token required");
    this.send = send;
    this.headers = { Authorization: "Bearer " + token, Accept: "text/turtle" };
  }
  async request(
    method: string,
    uri: string,
    statuses = [200],
    body?: string | Uint8Array,
    extra: Record<string, string> = {},
  ) {
    let r: Response;
    try {
      r = await this.send(uri, {
        method,
        headers: { ...this.headers, ...extra },
        body: body as BodyInit,
      });
    } catch {
      throw new FlexoError("Flexo transport failed");
    }
    if (!statuses.includes(r.status))
      throw new FlexoError("Flexo request failed: HTTP " + r.status);
    return r;
  }
  async head(s: Branch) {
    return commitBinding(
      Buffer.from(await (await this.request("GET", s.uri)).arrayBuffer()),
      s.uri,
      s,
    );
  }
  async snapshot(
    request: ValidationRequest,
    lockId = "ci-" + request.work_id,
    allowCreate = false,
  ) {
    const uri = request.source.repository_uri + "/locks/" + checkedId(lockId);
    let before = await this.request("GET", uri, [200, 404]);
    if (before.status === 404) {
      if (!allowCreate)
        throw new FlexoError("Pinned lock absent; explicit creation required");
      await this.request(
        "PUT",
        uri,
        [200, 201, 409, 412],
        `<> <${MMS}commit> <${request.commit_uri}> .`,
        { "Content-Type": "text/turtle", "If-None-Match": "*" },
      );
      before = await this.request("GET", uri);
    }
    if (
      commitBinding(
        Buffer.from(await before.arrayBuffer()),
        uri,
        request.source,
      ) !== request.commit_uri
    )
      throw new FlexoError("Lock references another commit");
    const etag = before.headers.get("etag");
    if (!etag || etag.startsWith("W/"))
      throw new FlexoError("Strong lock ETag required");
    const model = Buffer.from(
        await (
          await this.request("GET", uri + "/graph", [200], undefined, {
            "If-Match": etag.startsWith('"') ? etag : '"' + etag + '"',
          })
        ).arrayBuffer(),
      ),
      after = await this.request("GET", uri);
    if (
      commitBinding(
        Buffer.from(await after.arrayBuffer()),
        uri,
        request.source,
      ) !== request.commit_uri ||
      after.headers.get("etag") !== etag
    )
      throw new FlexoError("Lock changed during read");
    try {
      parse(model);
    } catch {
      throw new FlexoError("Snapshot is invalid Turtle");
    }
    return new Snapshot(request, uri, etag, model);
  }
}
export async function connectFlexo(
  base: string,
  send: Transport = transport,
  credentials = {
    token_env: "FLEXO_TOKEN",
    password_env: "FLEXO_PASSWORD",
    username_env: "FLEXO_USERNAME",
  },
) {
  let token = process.env[credentials.token_env] ?? "";
  if (!token) {
    const password = process.env[credentials.password_env] ?? "",
      username = process.env[credentials.username_env] ?? "rohan";
    if (!password || password.startsWith("op://"))
      throw Error("Load resolved in-memory credentials");
    let response: Response;
    try {
      response = await send(base + "/auth/login", {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(username + ":" + password).toString("base64"),
        },
      });
    } catch {
      throw new FlexoError("Login transport failed");
    }
    if (response.status !== 200)
      throw new FlexoError("Login failed: HTTP " + response.status);
    try {
      token = (await response.json()).token;
    } catch {
      throw new FlexoError("Invalid login response");
    }
    if (typeof token !== "string" || !token)
      throw new FlexoError("Invalid login token");
    token = token.replace(/^bearer /i, "");
  }
  return new Flexo(token, send);
}
