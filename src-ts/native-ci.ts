import type { SharedValidationTarget } from "./configuration.ts";
import {
  canonicalJson,
  checkedDigest,
  digest,
  DeliveryError,
} from "./contracts.ts";
import { transport } from "./transport.ts";
import { requireFields, type RecordData } from "./workspace.ts";
export type NativeDestination =
  | {
      type: "gitlab";
      endpoint: string;
      project: string;
      ref: string;
      job: "adapter-validate";
    }
  | { type: "jenkins"; endpoint: string; job: string };
export function destination(t: SharedValidationTarget): NativeDestination {
  return t.type === "gitlab"
    ? {
        type: "gitlab",
        endpoint: t.endpoint,
        project: t.project,
        ref: t.ref,
        job: "adapter-validate",
      }
    : { type: "jenkins", endpoint: t.endpoint, job: t.job };
}
export const destinationScope = (d: NativeDestination) =>
  digest(canonicalJson(d));
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const sha = (s: unknown) => {
  if (typeof s !== "string" || !/^[a-f0-9]{40}$/.test(s))
    throw Error("Invalid code revision");
  return s;
};
const env = (n: string) => {
  const v = process.env[n];
  if (!v || v.startsWith("op://"))
    throw Error("Resolved CI credential required");
  return v;
};
export type NativeWorker = RecordData;
export function workerIdentity(d: NativeDestination, w: NativeWorker) {
  if (w.type !== d.type || w.endpoint !== d.endpoint)
    throw Error("Foreign native worker");
  if (d.type === "gitlab") {
    requireFields(w, [
      "type",
      "endpoint",
      "project_id",
      "project_path",
      "ref",
      "code_sha",
      "pipeline_id",
      "job_id",
      "job_name",
    ]);
    if (
      !positive(w.project_id) ||
      !positive(w.pipeline_id) ||
      !positive(w.job_id) ||
      w.ref !== d.ref ||
      w.job_name !== d.job ||
      (d.project !== String(w.project_id) && d.project !== w.project_path)
    )
      throw Error("Foreign GitLab worker");
    sha(w.code_sha);
    return `gitlab:${d.endpoint}:${w.project_id}:${w.pipeline_id}:${w.job_id}`;
  }
  requireFields(w, ["type", "endpoint", "job", "build_number"]);
  if (w.job !== d.job || !positive(w.build_number))
    throw Error("Foreign Jenkins worker");
  return `jenkins:${d.endpoint}:${d.job}:${w.build_number}`;
}
export function workerUrl(d: NativeDestination, w: NativeWorker) {
  workerIdentity(d, w);
  return d.type === "gitlab"
    ? `${d.endpoint}/${w.project_path}/-/jobs/${w.job_id}`
    : jenkinsJob(d) + w.build_number + "/";
}
export function jenkinsJob(d: Extract<NativeDestination, { type: "jenkins" }>) {
  return (
    d.endpoint +
    d.job
      .split("/")
      .map((p) => "/job/" + encodeURIComponent(p))
      .join("") +
    "/"
  );
}
export const workParameters = (
  id: string,
  input: string,
  scope: string,
  commit: string,
) => ({
  ADAPTER_WORK_ID: checkedDigest(id),
  ADAPTER_INPUT_DIGEST: checkedDigest(input),
  ADAPTER_STORE_SCOPE: checkedDigest(scope),
  ADAPTER_SOURCE_REVISION: commit,
});
function checkParameters(
  values: RecordData[],
  parameters: Record<string, string>,
  key = "name",
) {
  if (!Array.isArray(values)) throw Error("Invalid native job parameters");
  for (const [name, value] of Object.entries(parameters))
    if (
      values.filter((v) => v[key] === name).length !== 1 ||
      values.find((v) => v[key] === name)?.value !== value
    )
      throw Error("Native job input differs");
}
export class NativeCI {
  readonly target: SharedValidationTarget;
  readonly destination: NativeDestination;
  constructor(target: SharedValidationTarget) {
    this.target = target;
    this.destination = destination(target);
  }
  headers(): Record<string, string> {
    const t = this.target;
    return t.type === "gitlab"
      ? { "PRIVATE-TOKEN": env(t.read_token_env) }
      : {
          Authorization:
            "Basic " +
            Buffer.from(env(t.username_env) + ":" + env(t.token_env)).toString(
              "base64",
            ),
        };
  }
  async json(url: string) {
    const r = await transport(url, { headers: this.headers() });
    if (r.status !== 200)
      throw Error("Native job inspection failed: HTTP " + r.status);
    return r.json();
  }
  base() {
    const d = this.destination;
    if (d.type !== "gitlab") throw Error("GitLab target required");
    return d.endpoint + "/api/v4/projects/" + encodeURIComponent(d.project);
  }
  ready() {
    this.headers();
    if (this.target.type === "gitlab") env(this.target.trigger_token_env);
  }
  async dispatch(parameters: Record<string, string>) {
    const d = this.destination,
      t = this.target;
    let response: Response;
    try {
      response =
        d.type === "gitlab" && t.type === "gitlab"
          ? await transport(this.base() + "/trigger/pipeline", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                token: env(t.trigger_token_env),
                ref: d.ref,
                variables: parameters,
              }),
            })
          : await transport(
              jenkinsJob(d as Extract<NativeDestination, { type: "jenkins" }>) +
                "buildWithParameters",
              {
                method: "POST",
                headers: {
                  ...this.headers(),
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(parameters).toString(),
              },
            );
    } catch {
      throw new DeliveryError("Native validation submission uncertain");
    }
    if (![200, 201, 202].includes(response.status))
      throw new DeliveryError(
        "Native validation submission failed: HTTP " + response.status,
      );
    if (d.type === "gitlab") {
      const p = await response.json();
      if (!positive(p.id) || p.ref !== d.ref)
        throw new DeliveryError("Invalid submitted pipeline");
      return String(p.id);
    }
    const location = response.headers.get("location"),
      prefix = d.endpoint + "/queue/item/";
    if (
      !location ||
      !new URL(location, d.endpoint + "/").toString().startsWith(prefix)
    )
      throw new DeliveryError("Invalid submitted queue");
    return null;
  }
  async inspect(worker: NativeWorker, parameters: Record<string, string>) {
    const d = this.destination;
    workerIdentity(d, worker);
    if (d.type === "gitlab") {
      const base = this.base(),
        job = await this.json(base + "/jobs/" + worker.job_id),
        pipeline = await this.json(base + "/pipelines/" + worker.pipeline_id),
        variables = await this.json(
          base + "/pipelines/" + worker.pipeline_id + "/variables",
        );
      checkParameters(variables, parameters, "key");
      if (
        job.id !== worker.job_id ||
        job.name !== d.job ||
        job.ref !== d.ref ||
        job.pipeline?.id !== worker.pipeline_id ||
        job.commit?.id !== worker.code_sha ||
        job.web_url !== workerUrl(d, worker) ||
        pipeline.id !== worker.pipeline_id ||
        pipeline.project_id !== worker.project_id ||
        pipeline.ref !== d.ref ||
        pipeline.sha !== worker.code_sha ||
        pipeline.source !== "trigger"
      )
        throw Error("GitLab job identity differs");
      const status = job.status;
      if (
        [
          "created",
          "pending",
          "preparing",
          "waiting_for_resource",
          "manual",
          "scheduled",
        ].includes(status)
      )
        return { completed: false, running: false, success: false };
      if (status === "running")
        return { completed: false, running: true, success: false };
      if (!["success", "failed", "canceled", "skipped"].includes(status))
        throw Error("Unknown GitLab job state");
      return { completed: true, running: false, success: status === "success" };
    }
    const build = await this.json(
      jenkinsJob(d) + worker.build_number + "/api/json",
    );
    checkParameters(
      (build.actions ?? []).flatMap((a: RecordData) =>
        Array.isArray(a.parameters) ? a.parameters : [],
      ),
      parameters,
    );
    if (
      build.number !== worker.build_number ||
      build.url !== workerUrl(d, worker) ||
      !positive(build.queueId)
    )
      throw Error("Jenkins build identity differs");
    if (build.building === true)
      return { completed: false, running: true, success: false };
    if (
      build.building !== false ||
      !["SUCCESS", "FAILURE", "ABORTED", "UNSTABLE", "NOT_BUILT"].includes(
        build.result,
      )
    )
      throw Error("Unknown Jenkins state");
    return {
      completed: true,
      running: false,
      success: build.result === "SUCCESS",
    };
  }
}
