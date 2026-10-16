import * as fs from "node:fs";
const file = process.env.TEST_REMOTE_STATE;
const remote = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { submissions: [], pipelines: [], builds: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(remote));
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const stage = () => process.env.TEST_STAGE ?? "pending";
const params = (record) =>
  Object.entries(record.parameters).map(([name, value]) => ({
    name,
    value:
      process.env.TEST_FOREIGN_BINDING && name === "ADAPTER_SOURCE_REVISION"
        ? "foreign"
        : value,
  }));
const actions = (r) => [{ parameters: params(r) }];
const job = "https://jenkins.test/job/research/job/check/";
let observedHeads = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url),
    method = init.method ?? "GET";
  if (
    u.host === "flexo.test" &&
    method === "GET" &&
    u.pathname.includes("/branches/")
  )
    return new Response(
      "<" +
        url +
        "> <https://mms.openmbee.org/rdf/ontology/commit> <https://flexo.test/orgs/research/repos/model/commits/" +
        (process.env.TEST_ADVANCING_SOURCE
          ? ["a", "b", "c"][Math.min(observedHeads++, 2)]
          : process.env.TEST_HEAD) +
        "> .",
    );
  const kind =
    u.host === "gitlab.test"
      ? "gitlab"
      : u.host === "jenkins.test"
        ? "jenkins"
        : null;
  if (!kind) throw Error("Unexpected external host");
  if (method === "POST") {
    if (process.env.TEST_REJECT === kind) return json({}, 403);
    if (
      kind === "gitlab" &&
      u.pathname === "/api/v4/projects/research%2Fmodel/trigger/pipeline"
    ) {
      const input = JSON.parse(init.body);
      if (input.token !== "synthetic-trigger")
        throw Error("Wrong trigger credential");
      const record = {
        id: remote.pipelines.length + 1,
        ref: input.ref,
        parameters: input.variables,
      };
      remote.pipelines.push(record);
      remote.submissions.push({ kind, id: record.id });
      save();
      if (process.env.TEST_SLOW_GITLAB) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        remote.slow_done = true;
        save();
      }
      if (process.env.TEST_LOSE_RESPONSE) throw Error("Accepted response lost");
      return json({ id: record.id, ref: record.ref }, 201);
    }
    if (
      kind === "jenkins" &&
      u.pathname === "/job/research/job/check/buildWithParameters"
    ) {
      if (!init.headers.Authorization?.startsWith("Basic "))
        throw Error("Missing Jenkins credential");
      const record = {
        id: remote.builds.length + 1,
        number: remote.builds.length + 10,
        parameters: Object.fromEntries(new URLSearchParams(init.body)),
      };
      remote.builds.push(record);
      remote.submissions.push({ kind, id: record.id });
      save();
      if (process.env.TEST_LOSE_RESPONSE) throw Error("Accepted response lost");
      return json({}, 201, {
        location: "https://jenkins.test/queue/item/" + record.id + "/",
      });
    }
    throw Error("Unexpected mutation");
  }
  if (kind === "gitlab") {
    if (init.headers["PRIVATE-TOKEN"] !== "synthetic-read")
      throw Error("Missing separate read token");
    if (u.pathname === "/api/v4/projects/research%2Fmodel/pipelines")
      return json(
        process.env.TEST_HIDE
          ? []
          : remote.pipelines.map((r) => ({ id: r.id, ref: r.ref })),
      );
    const m = u.pathname.match(/\/pipelines\/(\d+)(\/variables)?$/);
    if (!m) throw Error("Unknown GitLab route");
    const r = remote.pipelines.find((p) => p.id === Number(m[1]));
    if (!r) return json({}, 404);
    if (m[2])
      return json(params(r).map((p) => ({ key: p.name, value: p.value })));
    return json({
      id: r.id,
      ref: r.ref,
      sha: "a".repeat(40),
      status:
        stage() === "success"
          ? "success"
          : stage() === "failed"
            ? "failed"
            : stage() === "running"
              ? "running"
              : "pending",
    });
  }
  if (u.pathname === "/queue/api/json")
    return json({
      items: process.env.TEST_HIDE
        ? []
        : remote.builds.map((r) => ({
            id: r.id,
            task: { url: job },
            actions: actions(r),
          })),
    });
  if (u.pathname === "/job/research/job/check/api/json")
    return json({
      builds: process.env.TEST_HIDE
        ? []
        : remote.builds.map((r) => ({
            number: r.number,
            queueId: r.id,
            actions: actions(r),
          })),
    });
  const queue = u.pathname.match(/^\/queue\/item\/(\d+)\/api\/json$/);
  if (queue) {
    const r = remote.builds.find((b) => b.id === Number(queue[1]));
    if (!r || process.env.TEST_EXPIRE_QUEUE) return json({}, 404);
    return json({
      id: r.id,
      task: { url: job },
      actions: actions(r),
      ...(stage() === "pending"
        ? {}
        : { executable: { number: r.number, url: job + r.number + "/" } }),
    });
  }
  const build = u.pathname.match(/\/check\/(\d+)\/api\/json$/);
  if (build) {
    const r = remote.builds.find((b) => b.number === Number(build[1]));
    return json({
      number: r.number,
      queueId: r.id,
      actions: actions(r),
      building: stage() === "running",
      result: stage() === "success" ? "SUCCESS" : "FAILURE",
    });
  }
  throw Error("Unknown Jenkins route");
};
