import { createHash } from "node:crypto";
import {
  DeliveryError,
  canonicalJson,
  checkedDigest,
  checkedId,
  digest,
} from "./contracts.ts";
import { transport, type Transport } from "./transport.ts";
export class GitHubError extends DeliveryError {}
export const MAX_BYTES = 4 * 1024 * 1024,
  RECORD_FILES = new Set([
    "engine-request.json",
    "model-bundle.json",
    "report.json",
    "model.ttl",
    "rule.ttl",
    "snapshot.json",
    "claim.json",
    "report.ttl",
    "report.txt",
    "result.json",
  ]);
export function gitSha(v: string) {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v))
    throw Error("Expected Git SHA");
  return v;
}
export const bundleDigest = (files: Record<string, Buffer>) =>
  digest(
    canonicalJson(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])),
    ),
  );
export class GitHub {
  readonly owner: string;
  readonly repository: string;
  readonly path: string;
  readonly html: string;
  readonly headers: Record<string, string>;
  readonly send: Transport;
  constructor(
    owner: string,
    repository: string,
    token: string,
    send: Transport = transport,
  ) {
    this.owner = checkedId(owner);
    this.repository = checkedId(repository);
    if (!token || token.startsWith("op://"))
      throw Error("Resolved GitHub token required");
    this.path = `/repos/${owner}/${repository}`;
    this.html = `https://github.com/${owner}/${repository}`;
    this.headers = {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    };
    this.send = send;
  }
  async call(method: string, p: string, body?: unknown, statuses = [200]) {
    if (!p.startsWith(this.path + "/") && p !== this.path)
      throw Error("Request must stay in configured repository");
    let r: Response;
    try {
      r = await this.send("https://api.github.com" + p, {
        method,
        headers: {
          ...this.headers,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(
        "GitHub transport failed; mutation may have been accepted",
      );
    }
    if (!statuses.includes(r.status))
      throw new GitHubError("GitHub request failed: HTTP " + r.status);
    return r;
  }
  async requirePrivate() {
    const v = await (await this.call("GET", this.path)).json();
    if (
      v.private !== true ||
      String(v.full_name).toLowerCase() !==
        `${this.owner}/${this.repository}`.toLowerCase()
    )
      throw new GitHubError(
        "Input delivery requires configured private repository",
      );
  }
  recordRef(kind: string, id: string) {
    if (!["input", "claim", "result"].includes(kind))
      throw Error("Unknown record kind");
    return "flexo-ci-" + kind + "-" + checkedDigest(id);
  }
  async ref(kind: string, id: string) {
    const name = this.recordRef(kind, id),
      r = await this.call(
        "GET",
        this.path + "/git/ref/tags/" + name,
        undefined,
        [200, 404],
      );
    if (r.status === 404) return null;
    const v = await r.json();
    if (v.ref !== "refs/tags/" + name || v.object?.type !== "commit")
      throw new GitHubError("Unexpected record ref");
    return gitSha(v.object.sha);
  }
  async createRef(
    kind: string,
    id: string,
    commit: string,
  ): Promise<[string, boolean]> {
    const name = this.recordRef(kind, id),
      r = await this.call(
        "POST",
        this.path + "/git/refs",
        { ref: "refs/tags/" + name, sha: gitSha(commit) },
        [201, 409, 422],
      ),
      winner = await this.ref(kind, id);
    if (!winner) throw new GitHubError("No visible winner after ref creation");
    return [winner, r.status === 201 && winner === commit];
  }
  async createCommit(
    files: Record<string, Buffer>,
    message: string,
    parents: string[] = [],
  ) {
    if (
      !Object.keys(files).length ||
      Object.keys(files).some((k) => !RECORD_FILES.has(k)) ||
      Object.values(files).reduce((a, b) => a + b.length, 0) > MAX_BYTES
    )
      throw Error("Invalid or oversized CI bundle");
    const entries = [];
    for (const name of Object.keys(files).sort()) {
      const v = await (
        await this.call(
          "POST",
          this.path + "/git/blobs",
          { content: files[name].toString("base64"), encoding: "base64" },
          [201],
        )
      ).json();
      entries.push({
        path: name,
        mode: "100644",
        type: "blob",
        sha: gitSha(v.sha),
      });
    }
    const tree = await (
        await this.call(
          "POST",
          this.path + "/git/trees",
          { tree: entries },
          [201],
        )
      ).json(),
      commit = await (
        await this.call(
          "POST",
          this.path + "/git/commits",
          { message, tree: gitSha(tree.sha), parents: parents.map(gitSha) },
          [201],
        )
      ).json();
    return gitSha(commit.sha);
  }
  async files(commit: string) {
    gitSha(commit);
    const v = await (
      await this.call("GET", this.path + "/git/commits/" + commit)
    ).json();
    if (v.sha !== commit) throw new GitHubError("Foreign record commit");
    const tree = await (
        await this.call("GET", this.path + "/git/trees/" + gitSha(v.tree.sha))
      ).json(),
      entries = tree.tree;
    if (
      tree.truncated ||
      !Array.isArray(entries) ||
      !entries.length ||
      entries.length > RECORD_FILES.size
    )
      throw new GitHubError("Invalid CI tree");
    const files: Record<string, Buffer> = {};
    let total = 0;
    for (const e of entries) {
      if (
        !RECORD_FILES.has(e.path) ||
        Object.hasOwn(files, e.path) ||
        e.mode !== "100644" ||
        e.type !== "blob"
      )
        throw new GitHubError("Unexpected files");
      const sha = gitSha(e.sha),
        blob = await (
          await this.call("GET", this.path + "/git/blobs/" + sha)
        ).json();
      if (
        blob.encoding !== "base64" ||
        !Number.isInteger(blob.size) ||
        blob.size < 0 ||
        blob.size > MAX_BYTES ||
        typeof blob.content !== "string"
      )
        throw new GitHubError("Invalid blob");
      const encoded = blob.content.replace(/\s/g, "");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      )
        throw new GitHubError("Invalid base64");
      const raw = Buffer.from(encoded, "base64"),
        actual = createHash("sha1")
          .update(Buffer.from(`blob ${raw.length}\0`))
          .update(raw)
          .digest("hex");
      if (raw.length !== blob.size || actual !== sha)
        throw new GitHubError("Blob identity mismatch");
      files[e.path] = raw;
      total += raw.length;
      if (total > MAX_BYTES) throw new GitHubError("Bundle too large");
    }
    return files;
  }
}
