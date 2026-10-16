import { canonicalJson, digest } from "../src-ts/contracts.ts";
import { decodeEngine } from "../src-ts/engine-execution.ts";
import { checkModelBundle } from "../src-ts/model-input.ts";
const engineMode = process.env.TEST_ENGINE_INPUTS === "yes";
function textManifest(commit) {
  const raw = Buffer.from("package Demo { part def Thing; }");
  return {
    format: "local-sysml-text-bundle-v1",
    entrypoints: ["models/main.sysml"],
    files: [
      {
        path: "models/main.sysml",
        role: "model",
        size: raw.length,
        sha256: digest(raw),
        artifact:
          "https://flexo.test/orgs/research/repos/model/artifacts/" +
          commit +
          "-source",
      },
    ],
  };
}
async function engineWorker(files, r, external) {
  const bundle = JSON.parse(files["model-bundle.json"]),
    content = checkModelBundle(bundle, r.source, r.commit_uri).content_sha256;
  const stdout = JSON.stringify(
    r.profile.engine === "opensysml"
      ? {
          status: "holds",
          exit: 0,
          checks: null,
          diagnostics: null,
          output: ["no errors"],
          errors: null,
        }
      : {
          findings: [],
          summary: { errors: 0, warnings: 0, infos: 0, hints: 0 },
        },
  );
  const process = {
    exit: 0,
    signal: null,
    timeout: false,
    truncated: false,
    stdout,
    stderr: "",
    stdout_base64: Buffer.from(stdout).toString("base64"),
    stderr_base64: "",
    started_at: "2026-10-16T12:00:00Z",
    finished_at: "2026-10-16T12:00:01Z",
    argv: ["reviewed-fixture"],
  };
  const report = decodeEngine(r, process),
    raw = Buffer.from(
      canonicalJson({
        schema_version: 1,
        request: r.toDict(),
        input_content_sha256: content,
        profile: r.profile,
        process,
        report,
      }),
    );
  return {
    result: {
      schema_version: 2,
      work_id: r.work_id,
      commit_uri: r.commit_uri,
      input_sha256: r.input_sha256,
      validator_sha256: r.validator_sha256,
      profile: r.profile,
      report,
      outcome: report.verdict,
      report_sha256: digest(raw),
      external_id: external,
    },
    evidence: {
      ...files,
      "report.json": raw,
      "report.txt": Buffer.from("engine test fixture"),
    },
  };
}
// External transport fixture loaded by CLI subprocesses. No real network access.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { GitHub } from "../src-ts/github-api.ts";
import { GitHubRunner } from "../src-ts/github-runner.ts";
const file = process.env.TEST_REMOTE_STATE;
const remote = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { repos: {}, locks: {}, dispatches: [], executions: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(remote));
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const sha = (v) => createHash("sha1").update(v).digest("hex");
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET",
    u = new URL(url),
    body = init.body
      ? JSON.parse(
          String(init.body).startsWith("{") ? String(init.body) : "null",
        )
      : null;
  if (u.host === "flexo.test") {
    if (method === "GET" && u.pathname.includes("/branches/"))
      return new Response(
        "<" +
          url +
          "> <https://mms.openmbee.org/rdf/ontology/commit> <https://flexo.test/orgs/research/repos/model/commits/" +
          process.env.TEST_HEAD +
          "> .",
      );
    const lock = String(url).replace(/\/graph$/, "");
    if (method === "PUT" && u.pathname.includes("/locks/")) {
      remote.locks[lock] = String(init.body)
        .match(/<https:\/\/flexo.test[^>]+>/)[0]
        .slice(1, -1);
      save();
      return new Response(null, { status: 201 });
    }
    if (engineMode && method === "GET" && u.pathname.includes("/artifacts/")) {
      (remote.artifact_reads ??= []).push(String(url));
      save();
      const id = u.pathname.split("/").at(-1),
        commit = id.replace(/-(manifest|source)$/, "");
      return id.endsWith("-manifest")
        ? new Response(JSON.stringify(textManifest(commit)))
        : new Response("package Demo { part def Thing; }");
    }
    if (engineMode && method === "GET" && u.pathname.endsWith("/graph")) {
      const commit = remote.locks[lock].split("/").at(-1),
        raw = JSON.stringify(textManifest(commit));
      return new Response(
        `<urn:bundle> a <urn:flexo-change-adapter:source:TextBundle>; <urn:flexo-change-adapter:source:manifest> <https://flexo.test/orgs/research/repos/model/artifacts/${commit}-manifest>; <urn:flexo-change-adapter:source:sha256> "${digest(raw)}" .`,
      );
    }
    if (method === "GET" && u.pathname.endsWith("/graph"))
      return new Response(
        fs.readFileSync(
          new URL("../examples/named-part-v1/invalid.ttl", import.meta.url),
          "utf8",
        ),
      );
    if (method === "GET" && u.pathname.includes("/locks/"))
      return remote.locks[lock]
        ? new Response(
            "<" +
              url +
              "> <https://mms.openmbee.org/rdf/ontology/commit> <" +
              remote.locks[lock] +
              "> .",
            { headers: { etag: '"pinned"' } },
          )
        : new Response(null, { status: 404 });
    throw Error("Unexpected Flexo operation");
  }
  if (u.host !== "api.github.com") throw Error("Unexpected remote host");
  const match = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (!match) throw Error("Unexpected GitHub route");
  const owner = match[1],
    repo = match[2],
    p = match[3],
    key = owner + "/" + repo;
  if ((process.env.TEST_FAIL_TARGETS ?? "").split(",").includes(repo))
    return json({}, 503);
  const r = (remote.repos[key] ??= {
    refs: {},
    blobs: {},
    trees: {},
    commits: {},
    runs: {},
  });
  if (method === "GET" && p === "")
    return json({ private: true, full_name: key });
  if (method === "POST" && p === "/git/blobs") {
    const raw = Buffer.from(body.content, "base64"),
      id = sha(Buffer.concat([Buffer.from("blob " + raw.length + "\0"), raw]));
    r.blobs[id] = {
      encoding: "base64",
      size: raw.length,
      content: body.content,
    };
    save();
    return json({ sha: id }, 201);
  }
  if (method === "GET" && p.startsWith("/git/blobs/"))
    return json(r.blobs[p.split("/").at(-1)]);
  if (method === "POST" && p === "/git/trees") {
    const id = sha(JSON.stringify(body));
    r.trees[id] = { tree: body.tree };
    save();
    return json({ sha: id }, 201);
  }
  if (method === "GET" && p.startsWith("/git/trees/"))
    return json(r.trees[p.split("/").at(-1)]);
  if (method === "POST" && p === "/git/commits") {
    const id = sha(JSON.stringify(body));
    r.commits[id] = { sha: id, tree: { sha: body.tree } };
    save();
    return json({ sha: id }, 201);
  }
  if (method === "GET" && p.startsWith("/git/commits/"))
    return json(r.commits[p.split("/").at(-1)]);
  if (method === "POST" && p === "/git/refs") {
    if (r.refs[body.ref]) return json({}, 422);
    r.refs[body.ref] = body.sha;
    save();
    return json({}, 201);
  }
  if (method === "GET" && p.startsWith("/git/ref/")) {
    const ref = "refs/" + p.slice("/git/ref/".length);
    return r.refs[ref]
      ? json({ ref, object: { type: "commit", sha: r.refs[ref] } })
      : json({}, 404);
  }
  if (method === "GET" && p.startsWith("/actions/runs/"))
    return json(r.runs[p.split("/")[3]]);
  if (method === "POST" && p.endsWith("/dispatches")) {
    remote.dispatches.push({ repository: key, inputs: body.inputs });
    save();
    const n = remote.dispatches.length;
    const workflow = {
      repository: key,
      run_id: n,
      run_attempt: 1,
      workflow_sha: "a".repeat(40),
      workflow_file: "flexo-validate.yml",
    };
    const runner = new GitHubRunner(
      new GitHub(owner, repo, "synthetic-token"),
      "main",
      engineMode ? engineWorker : undefined,
    );
    const result = await runner.execute(
      body.inputs.work_id,
      body.inputs.input_commit,
      body.inputs.input_digest,
      workflow,
    );
    if (result.event === "validation-completed")
      remote.executions.push({ repository: key, work_id: body.inputs.work_id });
    r.runs[n] = {
      id: n,
      run_attempt: 1,
      head_sha: workflow.workflow_sha,
      event: "workflow_dispatch",
      path: ".github/workflows/flexo-validate.yml",
      status: "completed",
      conclusion: ["pass", "conforming"].includes(result.outcome)
        ? "success"
        : "failure",
    };
    save();
    if (process.env.TEST_LOSE_RESPONSE)
      throw Error("Response lost after accepted dispatch");
    return new Response(null, { status: 204 });
  }
  throw Error("Unexpected GitHub operation");
};
