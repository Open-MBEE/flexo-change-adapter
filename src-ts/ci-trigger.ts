import {
  branch,
  type Configuration,
  type TriggerAction,
} from "./configuration.ts";
import type { ActionIntent, PreparedAction } from "./journal.ts";
import { Journal } from "./journal.ts";
import { canonicalJson } from "./contracts.ts";
import { transport } from "./transport.ts";

type External =
  | { kind: "gitlab"; pipeline_id: number }
  | { kind: "jenkins"; queue_id: number; build_number?: number };
type Remote = Record<string, any>;
export type TriggerProgress = {
  state: "uncertain" | "queued" | "running" | "completed" | "failed";
  attempts: number;
  external_json: string | null;
  started_at: string;
};
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function credential(name: string) {
  const value = process.env[name];
  if (!value || value.startsWith("op://"))
    throw Error("Resolved target credential required");
  return value;
}
function parameters(intent: ActionIntent) {
  const source = JSON.parse(intent.source_json);
  return {
    ADAPTER_DELIVERY_ID: intent.id,
    ADAPTER_EVENT_ID: intent.event_id,
    ADAPTER_SOURCE_REVISION: intent.commit_uri,
    ADAPTER_SOURCE_BRANCH: branch(source).uri,
  };
}
function matchesParameters(actions: Remote[], intent: ActionIntent) {
  const parameters = actions.flatMap((a) =>
    Array.isArray(a.parameters) ? a.parameters : [],
  );
  return (
    parameters.filter(
      (p) => p.name === "ADAPTER_DELIVERY_ID" && p.value === intent.id,
    ).length === 1 &&
    parameters.filter(
      (p) =>
        p.name === "ADAPTER_SOURCE_REVISION" && p.value === intent.commit_uri,
    ).length === 1
  );
}
export const freezeTrigger = (action: TriggerAction): PreparedAction => ({
  action,
});
export function triggerStatus(
  _configuration: Configuration,
  intent: ActionIntent,
  journal: Journal,
) {
  return (
    (journal.db
      .prepare(
        "SELECT state,attempts,external_json,started_at FROM ci_deliveries WHERE id=?",
      )
      .get(intent.id) as TriggerProgress | undefined) ?? {
      state: "unprepared",
      attempts: 0,
    }
  );
}
function setProgress(
  journal: Journal,
  id: string,
  state: TriggerProgress["state"],
  external?: External,
) {
  journal.db
    .prepare(
      "UPDATE ci_deliveries SET state=?,external_json=COALESCE(?,external_json) WHERE id=?",
    )
    .run(state, external ? canonicalJson(external) : null, id);
}
function finish(
  journal: Journal,
  intent: ActionIntent,
  native: string,
  outcome: "succeeded" | "failed" | "cancelled" | "execution-error",
  url: string | null,
  external: External | null,
  codeRevision?: string,
) {
  journal.transaction(() => {
    setProgress(
      journal,
      intent.id,
      outcome === "succeeded" ? "completed" : "failed",
      external ?? undefined,
    );
    journal.finish(intent.id, {
      schema_version: 1,
      task_type: "ci-trigger",
      delivery_id: intent.id,
      event_id: intent.event_id,
      source_revision: intent.commit_uri,
      native_status: native,
      outcome,
      evidence_url: url,
      external,
      ...(codeRevision ? { code_revision: codeRevision } : {}),
    });
  });
}
async function getJson(
  url: string,
  headers: Record<string, string>,
  statuses = [200],
) {
  const response = await transport(url, { method: "GET", headers });
  if (!statuses.includes(response.status))
    throw Error("Target inspection failed");
  return response.status === 404 ? null : await response.json();
}
function gitlabBase(
  target: Extract<TriggerAction["target"], { type: "gitlab" }>,
) {
  return (
    target.endpoint + "/api/v4/projects/" + encodeURIComponent(target.project)
  );
}
async function locateGitLab(
  target: Extract<TriggerAction["target"], { type: "gitlab" }>,
  headers: Record<string, string>,
  intent: ActionIntent,
) {
  const base = gitlabBase(target);
  const pipelines = await getJson(
    base +
      "/pipelines?" +
      new URLSearchParams({
        ref: target.ref,
        source: "trigger",
        per_page: "100",
      }),
    headers,
  );
  if (!Array.isArray(pipelines) || pipelines.length > 100)
    throw Error("Invalid pipeline listing");
  const found: External[] = [];
  for (const candidate of pipelines) {
    if (!positive(candidate.id) || candidate.ref !== target.ref) continue;
    const variables = await getJson(
      base + `/pipelines/${candidate.id}/variables`,
      headers,
    );
    if (!Array.isArray(variables)) throw Error("Invalid pipeline variables");
    if (
      variables.filter(
        (v) => v.key === "ADAPTER_DELIVERY_ID" && v.value === intent.id,
      ).length === 1 &&
      variables.filter(
        (v) =>
          v.key === "ADAPTER_SOURCE_REVISION" && v.value === intent.commit_uri,
      ).length === 1
    )
      found.push({ kind: "gitlab", pipeline_id: candidate.id });
  }
  if (found.length > 1) throw Error("Ambiguous duplicate pipeline identity");
  return found[0];
}
async function inspectGitLab(
  target: Extract<TriggerAction["target"], { type: "gitlab" }>,
  headers: Record<string, string>,
  external: Extract<External, { kind: "gitlab" }>,
  intent: ActionIntent,
  journal: Journal,
) {
  const url = gitlabBase(target) + `/pipelines/${external.pipeline_id}`;
  const pipeline = await getJson(url, headers);
  const variables = await getJson(url + "/variables", headers);
  if (
    pipeline.id !== external.pipeline_id ||
    pipeline.ref !== target.ref ||
    !Array.isArray(variables) ||
    variables.filter(
      (v) => v.key === "ADAPTER_DELIVERY_ID" && v.value === intent.id,
    ).length !== 1 ||
    variables.filter(
      (v) =>
        v.key === "ADAPTER_SOURCE_REVISION" && v.value === intent.commit_uri,
    ).length !== 1
  )
    throw Error("Pipeline input binding differs");
  if (
    typeof pipeline.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pipeline.sha)
  )
    throw Error("Invalid pipeline code identity");
  if (
    [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "scheduled",
      "manual",
    ].includes(pipeline.status)
  )
    setProgress(journal, intent.id, "queued", external);
  else if (pipeline.status === "running")
    setProgress(journal, intent.id, "running", external);
  else if (
    ["success", "failed", "canceled", "skipped"].includes(pipeline.status)
  )
    finish(
      journal,
      intent,
      pipeline.status,
      pipeline.status === "success"
        ? "succeeded"
        : pipeline.status === "canceled"
          ? "cancelled"
          : "failed",
      url,
      external,
      pipeline.sha,
    );
  else throw Error("Unknown pipeline state");
}
function jobUrl(target: Extract<TriggerAction["target"], { type: "jenkins" }>) {
  return (
    target.endpoint +
    target.job
      .split("/")
      .map((part) => "/job/" + encodeURIComponent(part))
      .join("") +
    "/"
  );
}
async function locateJenkins(
  target: Extract<TriggerAction["target"], { type: "jenkins" }>,
  headers: Record<string, string>,
  intent: ActionIntent,
  queueId?: number,
): Promise<Extract<External, { kind: "jenkins" }> | undefined> {
  const url = jobUrl(target),
    found: Extract<External, { kind: "jenkins" }>[] = [];
  const queue = await getJson(
    target.endpoint +
      "/queue/api/json?tree=items[id,task[url],actions[parameters[name,value]]]",
    headers,
  );
  if (!Array.isArray(queue.items) || queue.items.length > 1000)
    throw Error("Invalid Jenkins queue");
  for (const item of queue.items)
    if (
      positive(item.id) &&
      item.task?.url === url &&
      matchesParameters(item.actions ?? [], intent)
    )
      found.push({ kind: "jenkins", queue_id: item.id });
  const job = await getJson(
    url +
      "api/json?tree=builds[number,queueId,actions[parameters[name,value]]]{0,100}",
    headers,
  );
  if (!Array.isArray(job.builds) || job.builds.length > 100)
    throw Error("Invalid Jenkins builds");
  for (const build of job.builds)
    if (
      positive(build.number) &&
      positive(build.queueId) &&
      (queueId === undefined || queueId === build.queueId) &&
      matchesParameters(build.actions ?? [], intent)
    )
      found.push({
        kind: "jenkins",
        queue_id: build.queueId,
        build_number: build.number,
      });
  const unique = new Map(found.map((f) => [f.queue_id, f]));
  if (unique.size > 1) throw Error("Ambiguous duplicate Jenkins identity");
  return [...unique.values()][0];
}
async function inspectJenkins(
  target: Extract<TriggerAction["target"], { type: "jenkins" }>,
  headers: Record<string, string>,
  external: Extract<External, { kind: "jenkins" }>,
  intent: ActionIntent,
  journal: Journal,
) {
  const url = jobUrl(target);
  if (!external.build_number) {
    const queue = await getJson(
      target.endpoint + `/queue/item/${external.queue_id}/api/json`,
      headers,
      [200, 404],
    );
    if (!queue) {
      const found = await locateJenkins(
        target,
        headers,
        intent,
        external.queue_id,
      );
      if (!found) {
        setProgress(journal, intent.id, "uncertain", external);
        throw Error("Jenkins queue expired without a correlated build");
      }
      external = found;
      if (!external.build_number) return;
    } else {
      if (
        queue.id !== external.queue_id ||
        queue.task?.url !== url ||
        !matchesParameters(queue.actions ?? [], intent)
      )
        throw Error("Jenkins queue binding differs");
      if (queue.cancelled) {
        finish(
          journal,
          intent,
          "queue-cancelled",
          "cancelled",
          target.endpoint + `/queue/item/${external.queue_id}/`,
          external,
        );
        return;
      }
      if (!queue.executable) {
        setProgress(journal, intent.id, "queued", external);
        return;
      }
      if (!positive(queue.executable.number))
        throw Error("Invalid Jenkins build number");
      external = { ...external, build_number: queue.executable.number };
      setProgress(journal, intent.id, "running", external);
    }
  }
  const buildUrl = url + external.build_number + "/",
    build = await getJson(buildUrl + "api/json", headers);
  if (
    build.number !== external.build_number ||
    build.queueId !== external.queue_id ||
    !matchesParameters(build.actions ?? [], intent)
  )
    throw Error("Jenkins build binding differs");
  if (build.building === true) {
    setProgress(journal, intent.id, "running", external);
    return;
  }
  if (
    build.building !== false ||
    !["SUCCESS", "FAILURE", "ABORTED", "UNSTABLE", "NOT_BUILT"].includes(
      build.result,
    )
  )
    throw Error("Unknown Jenkins build state");
  finish(
    journal,
    intent,
    build.result,
    build.result === "SUCCESS"
      ? "succeeded"
      : build.result === "ABORTED"
        ? "cancelled"
        : "failed",
    buildUrl,
    external,
  );
}
export async function advanceTrigger(
  _configuration: Configuration,
  journal: Journal,
  intent: ActionIntent,
) {
  const action = JSON.parse(intent.action_json) as TriggerAction,
    target = action.target;
  // Validate credentials before marking submission uncertain. No mutation is retried automatically.
  const headers: Record<string, string> =
    target.type === "gitlab"
      ? { "PRIVATE-TOKEN": credential(target.read_token_env) }
      : {
          Authorization:
            "Basic " +
            Buffer.from(
              credential(target.username_env) +
                ":" +
                credential(target.token_env),
            ).toString("base64"),
        };
  const token =
    target.type === "gitlab" ? credential(target.trigger_token_env) : null;
  let row = journal.db
    .prepare("SELECT * FROM ci_deliveries WHERE id=?")
    .get(intent.id) as TriggerProgress | undefined;
  if (!row) {
    journal.db
      .prepare(
        "INSERT INTO ci_deliveries(id,state,attempts,started_at) VALUES(?,'uncertain',1,?)",
      )
      .run(intent.id, new Date().toISOString());
    try {
      const response =
        target.type === "gitlab"
          ? await transport(gitlabBase(target) + "/trigger/pipeline", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                token,
                ref: target.ref,
                variables: parameters(intent),
              }),
            })
          : await transport(jobUrl(target) + "buildWithParameters", {
              method: "POST",
              headers: {
                ...headers,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams(parameters(intent)).toString(),
            });
      if ([400, 401, 403, 404, 405, 422].includes(response.status)) {
        finish(
          journal,
          intent,
          "submission-rejected",
          "execution-error",
          null,
          null,
        );
        return;
      }
      if (![200, 201, 202].includes(response.status)) {
        journal.failure(intent.id);
        return;
      }
      if (target.type === "gitlab") {
        const p = await response.json();
        if (!positive(p.id) || p.ref !== target.ref)
          throw Error("Invalid pipeline submission identity");
        setProgress(journal, intent.id, "queued", {
          kind: "gitlab",
          pipeline_id: p.id,
        });
      } else {
        const location = response.headers.get("location");
        if (!location) {
          journal.failure(intent.id);
          return;
        }
        const expected = target.endpoint + "/queue/item/",
          url = new URL(location, target.endpoint + "/").toString();
        if (!url.startsWith(expected))
          throw Error("Foreign Jenkins queue location");
        const id = url.slice(expected.length).match(/^(\d+)\/?$/);
        if (!id || !positive(Number(id[1])))
          throw Error("Invalid Jenkins queue location");
        setProgress(journal, intent.id, "queued", {
          kind: "jenkins",
          queue_id: Number(id[1]),
        });
      }
    } catch {
      journal.failure(intent.id); // Inspect on the next round; never resend an uncertain mutation.
    }
    return;
  }
  let external = row.external_json
    ? (JSON.parse(row.external_json) as External)
    : undefined;
  if (!external) {
    external =
      target.type === "gitlab"
        ? await locateGitLab(target, headers, intent)
        : await locateJenkins(target, headers, intent);
    if (!external) {
      journal.failure(intent.id);
      return;
    }
    setProgress(journal, intent.id, "queued", external);
  }
  if (target.type === "gitlab" && external.kind === "gitlab")
    await inspectGitLab(target, headers, external, intent, journal);
  else if (target.type === "jenkins" && external.kind === "jenkins")
    await inspectJenkins(target, headers, external, intent, journal);
  else throw Error("Foreign retained target identity");
  journal.progressed(intent.id);
}
