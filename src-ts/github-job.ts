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
  return result.outcome === "nonconforming" ? 1 : 0;
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
