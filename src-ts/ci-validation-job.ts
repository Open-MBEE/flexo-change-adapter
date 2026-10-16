import { decodeFiles } from "./file-evidence.ts";
import { recordRequest } from "./validation-records.ts";
import { fileURLToPath } from "node:url";
import { FileEvidence } from "./file-evidence.ts";
import { executeSharedValidation } from "./shared-validation.ts";
import {
  destinationScope,
  workerIdentity,
  type NativeDestination,
  type NativeWorker,
} from "./native-ci.ts";
import { runEngineRecord } from "./engine-record.ts";
export function nativeWorker(
  d: NativeDestination,
  e: NodeJS.ProcessEnv,
): NativeWorker {
  let worker: NativeWorker;
  if (d.type === "gitlab") {
    if (
      e.GITLAB_CI !== "true" ||
      e.CI_PIPELINE_SOURCE !== "trigger" ||
      e.CI_COMMIT_BRANCH !== d.ref ||
      e.CI_SERVER_URL !== d.endpoint ||
      e.CI_JOB_NAME !== d.job
    )
      throw Error("Worker requires reviewed trigger pipeline");
    worker = {
      type: "gitlab",
      endpoint: e.CI_SERVER_URL,
      project_id: Number(e.CI_PROJECT_ID),
      project_path: e.CI_PROJECT_PATH,
      ref: e.CI_COMMIT_BRANCH,
      code_sha: e.CI_COMMIT_SHA,
      pipeline_id: Number(e.CI_PIPELINE_ID),
      job_id: Number(e.CI_JOB_ID),
      job_name: e.CI_JOB_NAME,
    };
  } else {
    if (
      e.JENKINS_URL?.replace(/\/$/, "") !== d.endpoint ||
      e.JOB_NAME !== d.job
    )
      throw Error("Worker requires configured Jenkins job");
    worker = {
      type: "jenkins",
      endpoint: d.endpoint,
      job: e.JOB_NAME,
      build_number: Number(e.BUILD_NUMBER),
    };
  }
  workerIdentity(d, worker);
  return worker;
}
export async function main() {
  const e = process.env;
  if (!e.FLEXO_EVIDENCE_DIRECTORY)
    throw Error("Shared evidence directory required");
  const scope = e.ADAPTER_STORE_SCOPE ?? "",
    id = e.ADAPTER_WORK_ID ?? "",
    input = e.ADAPTER_INPUT_DIGEST ?? "",
    store = new FileEvidence(e.FLEXO_EVIDENCE_DIRECTORY, scope),
    record = store.read("input", id);
  if (!record || destinationScope(record.destination) !== scope)
    throw Error("Missing or foreign shared validation input");
  if (
    e.ADAPTER_SOURCE_REVISION !==
    recordRequest(decodeFiles(record.files)).commit_uri
  )
    throw Error("Worker source parameter differs");
  const result = await executeSharedValidation(
    store,
    id,
    input,
    nativeWorker(record.destination, e),
    async (files, request, external) => {
      if (e.FLEXO_INSTALL_ENGINES === "1") {
        try {
          const { installEngines } =
            await import("../scripts/install-engines.ts");
          await installEngines(
            e.FLEXO_ENGINE_DIRECTORY ?? "/opt/flexo-engines",
          );
        } catch {
          /* Execution retains a non-passing installation result. */
        }
      }
      return runEngineRecord(files, request, external);
    },
  );
  console.log(JSON.stringify(result));
  return result.event === "validation-skipped-existing-claim" ||
    ["pass", "conforming"].includes(result.outcome)
    ? 0
    : ["fail", "nonconforming"].includes(result.outcome)
      ? 1
      : 2;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        JSON.stringify({
          event: "worker-execution-error",
          error_type: "WorkerError",
        }),
      );
      process.exitCode = 2;
    });
