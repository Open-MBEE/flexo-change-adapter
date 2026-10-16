import { runEngineRecord } from "./engine-record.ts";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { GitHub } from "./github-api.ts";
import { GitHubRunner, WORKFLOW } from "./github-runner.ts";
export async function main() {
  const e = process.env,
    repository = e.GITHUB_REPOSITORY ?? "",
    parts = repository.split("/");
  if (
    parts.length !== 2 ||
    e.GITHUB_ACTIONS !== "true" ||
    e.GITHUB_REF !== "refs/heads/main" ||
    e.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    e.GITHUB_WORKFLOW_REF !==
      repository + "/.github/workflows/" + WORKFLOW + "@refs/heads/main"
  )
    throw Error("Worker requires reviewed main workflow");
  const r = new GitHubRunner(
      new GitHub(parts[0], parts[1], e.GITHUB_TOKEN ?? ""),
      "main",
      async (files, request, external) => {
        const directory = e.FLEXO_ENGINE_DIRECTORY ?? "/opt/flexo-engines";
        try {
          const { installEngines } =
            await import("../scripts/install-engines.ts");
          await installEngines(directory);
        } catch {
          /* Execution retains an explicit non-passing installation result. */
        }
        return runEngineRecord(files, request, external);
      },
    ),
    result = await r.execute(
      e.FLEXO_WORK_ID ?? "",
      e.FLEXO_INPUT_COMMIT ?? "",
      e.FLEXO_INPUT_DIGEST ?? "",
      {
        repository,
        run_id: Number(e.GITHUB_RUN_ID),
        run_attempt: Number(e.GITHUB_RUN_ATTEMPT),
        workflow_sha: e.GITHUB_SHA,
        workflow_file: WORKFLOW,
      },
    );
  console.log(JSON.stringify(result));
  return result.event === "validation-skipped-existing-claim" ||
    ["conforming", "pass"].includes(result.outcome)
    ? 0
    : result.outcome === "nonconforming" || result.outcome === "fail"
      ? 1
      : 2;
}
if (process.argv[1] === fileURLToPath(new URL(import.meta.url))) {
  const result = await Effect.runPromise(
    Effect.either(
      Effect.tryPromise({
        try: main,
        catch: () => new Error("Worker execution failed"),
      }),
    ),
  );
  if (result._tag === "Left") {
    console.log(
      JSON.stringify({
        event: "worker-execution-error",
        error_type: "WorkerError",
      }),
    );
    process.exitCode = 2;
  } else process.exitCode = result.right;
}
